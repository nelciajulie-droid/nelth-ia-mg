import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { ERROR_MESSAGES, env } from '@/lib/constants';
import { hasPermission, getUserGroupIds } from '@/lib/access-control';
import {
  getNoteById,
  getNotesByUserId,
  getAllNotes,
  getPinnedNotesByUserId,
  getPinnedNoteIds,
  insertNewNote,
  updateNoteById,
  toggleNotePinnedById,
  deleteNoteById,
  normalizePages,
  matchingPage,
  getContentFiles,
  getNoteFiles,
  NotePageConflict,
  setAccessGrants,
  validateAccessGrants,
  filterAllowedAccessGrants,
  hasAccessGrant,
  getAccessibleResourceIds,
  hasPublicWriteAccessGrant,
  toUserResponse,
  getUsersByIds,
  safeParse,
  nowSec,
  EM,
} from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/notes.py (/api/v1/notes).
 *
 * Deviations (documented):
 *  - Socket room notifications (sio.emit / close_room / leave_room_for_users)
 *    are no-ops — no socket runtime.
 *  - has_access_to_note_files performs a pragmatic check: file ownership or
 *    an access_grant row on the file (the full knowledge/channel/chat traversal
 *    of utils/access_control/files.py is out of scope for this router).
 *  - Note chats are created/queried directly against the `chat` table.
 */

const BYPASS_ADMIN_ACCESS_CONTROL = (process.env.BYPASS_ADMIN_ACCESS_CONTROL ??
  process.env.ENABLE_ADMIN_WORKSPACE_CONTENT_ACCESS ??
  'True').toLowerCase() === 'true';

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

async function checkNotesAccess(user: { id: string; role: string }): Promise<void> {
  const enabled = await configGet<boolean>('notes.enable', env.ENABLE_NOTES);
  if (!enabled) err(403, EM.FEATURE_DISABLED('Notes'));
  const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
  if (user.role !== 'admin' && !(await hasPermission(user.id, 'features.notes', defaults))) {
    err(401, ERROR_MESSAGES.UNAUTHORIZED);
  }
}

function truncateNoteData(data: Record<string, any> | null, maxLength = 1000, query = ''): Record<string, any> | null {
  if (!data) return data;
  const page = matchingPage(data, query);
  const md = String(page['content']?.['md'] ?? '');
  return {
    content: { md: md.slice(0, maxLength) },
    page_count: (data['pages'] ?? [null]).length,
    page_id: page['id'],
    page_title: page['title'],
  };
}

/** Simplified has_access_to_note_files (see header deviations). */
async function hasAccessToNoteFiles(
  note: { data: Record<string, any> | null } | null,
  entries: Array<Record<string, any>> | null,
  user: { id: string; role: string }
): Promise<boolean> {
  if (entries !== null && !Array.isArray(entries)) return false;
  const addedIds = new Set((entries ?? []).map((e) => e?.id).filter(Boolean) as string[]);
  const existingIds = new Set(getNoteFiles(note?.data ?? null).map((f) => f.id));
  const additions = [...addedIds].filter((id) => !existingIds.has(id));
  if (!additions.length || user.role === 'admin') return true;

  for (const fileId of additions) {
    const file = await db.file.findUnique({ where: { id: fileId } });
    if (!file) return false;
    if (file.user_id === user.id) continue;
    const grant = await db.accessGrant.findFirst({
      where: {
        resource_type: 'file',
        resource_id: fileId,
        permission: 'read',
        OR: [
          { principal_type: 'user', principal_id: '*' },
          { principal_type: 'user', principal_id: user.id },
          { principal_type: 'group', principal_id: { in: await getUserGroupIds(user.id) } },
        ],
      },
    });
    if (!grant) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internal (note) chats — direct chat-table access
// ---------------------------------------------------------------------------

type ChatRow = {
  id: string;
  user_id: string | null;
  title: string | null;
  chat: string | null;
  created_at: number | null;
  updated_at: number | null;
  share_id: string | null;
  archived: boolean | null;
  pinned: boolean | null;
  meta: string | null;
  variables: string | null;
  folder_id: string | null;
};

function chatRowToResponse(row: ChatRow) {
  return {
    id: row.id,
    user_id: row.user_id ?? '',
    title: row.title ?? '',
    chat: safeParse<Record<string, any>>(row.chat, {}) ?? {},
    updated_at: row.updated_at ?? 0,
    created_at: row.created_at ?? 0,
    share_id: row.share_id ?? null,
    archived: row.archived ?? false,
    pinned: row.pinned ?? false,
    meta: safeParse<Record<string, any>>(row.meta, {}) ?? {},
    variables: safeParse<Record<string, any>>(row.variables, {}) ?? {},
    folder_id: row.folder_id ?? null,
  };
}

async function getInternalChatsByNoteId(noteId: string, userId: string): Promise<ChatRow[]> {
  // JSON-path filter mirroring the Python semantics (internal is truthy when
  // stored as 1/true/True; type and note_id match the note) — Postgres jsonb.
  const internalTrue = `(NULLIF(meta, '')::jsonb ->> 'internal') IN ('1', 'true', 'True')`;
  const typeIsNote = `NULLIF(meta, '')::jsonb ->> 'type' = 'note'`;
  const noteIdMatch = `NULLIF(meta, '')::jsonb ->> 'note_id' = $2`;
  const rows = (await db.$queryRawUnsafe(
    `SELECT id, user_id, title, chat, created_at, updated_at, share_id, archived, pinned, meta, variables, folder_id
     FROM chat
     WHERE user_id = $1 AND ${internalTrue}
       AND ${typeIsNote} AND ${noteIdMatch}
     ORDER BY updated_at DESC, created_at DESC`,
    userId,
    noteId
  )) as ChatRow[];
  return rows;
}

function noteChatSystemPrompt(noteId: string): string {
  return (
    `CONTEXT:\nCurrent note id: ${noteId}\n` +
    'This chat is attached to the current note.\n' +
    'For edit requests like make this concise, rewrite, enhance, shorten, or update: call view_note then replace_note_content.\n' +
    'Do not say an edit is done unless replace_note_content succeeds.'
  );
}

async function insertNoteChat(
  chatId: string,
  userId: string,
  noteId: string
): Promise<ReturnType<typeof chatRowToResponse> | null> {
  const now = nowSec();
  await db.chat.create({
    data: {
      id: chatId,
      user_id: userId,
      title: 'Chat',
      chat: JSON.stringify({
        id: chatId,
        title: 'Chat',
        models: [''],
        params: { system: noteChatSystemPrompt(noteId) },
        history: { messages: {}, currentId: null },
        messages: [],
        tags: [],
      }),
      meta: JSON.stringify({ internal: true, type: 'note', note_id: noteId }),
      created_at: now,
      updated_at: now,
      last_read_at: now,
    },
  });
  const row = await db.chat.findUnique({ where: { id: chatId } });
  return row ? chatRowToResponse(row as unknown as ChatRow) : null;
}

/** Normalize params (drop note_id, refresh system) on read. */
async function normalizeNoteChat(row: ChatRow, noteId: string) {
  const chat = safeParse<Record<string, any>>(row.chat, {}) ?? {};
  const params = { ...((chat['params'] as Record<string, any>) ?? {}) };
  let changed = false;
  if ('note_id' in params) {
    delete params['note_id'];
    changed = true;
  }
  const system = noteChatSystemPrompt(noteId);
  if (params['system'] !== system) {
    params['system'] = system;
    changed = true;
  }
  if (changed) {
    const nextChat = { ...chat, params };
    await db.chat.update({
      where: { id: row.id },
      data: { chat: JSON.stringify(nextChat) },
    });
    return chatRowToResponse({ ...row, chat: JSON.stringify(nextChat) });
  }
  return chatRowToResponse(row);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET / — static segments first
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);

      const pageRaw = ctx.query.get('page');
      let skip: number | null = null;
      let limit: number | null = null;
      if (pageRaw !== null && pageRaw !== undefined && pageRaw !== '') {
        limit = 60;
        skip = (Number(pageRaw) - 1) * limit;
      }

      const notes = await getNotesByUserId(user.id, 'read', skip, limit);
      if (!notes.length) return ctx.json([]);

      const users = new Map((await getUsersByIds([...new Set(notes.map((n) => n.user_id))])).map((u) => [u.id, u]));
      const pinnedNoteIds = new Set(await getPinnedNoteIds(user.id));

      return ctx.json(
        notes
          .filter((note) => users.has(note.user_id))
          .map((note) => ({
            ...note,
            is_pinned: pinnedNoteIds.has(note.id),
            data: truncateNoteData(note.data),
            user: toUserResponse(users.get(note.user_id) as any),
          }))
      );
    },
  },

  // GET /pinned
  {
    method: 'GET',
    path: 'pinned',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);

      const notes = await getPinnedNotesByUserId(user.id, 'read');
      if (!notes.length) return ctx.json([]);

      const users = new Map((await getUsersByIds([...new Set(notes.map((n) => n.user_id))])).map((u) => [u.id, u]));
      return ctx.json(
        notes
          .filter((note) => users.has(note.user_id))
          .map((note) => ({
            ...note,
            is_pinned: true,
            data: truncateNoteData(note.data),
            user: toUserResponse(users.get(note.user_id) as any),
          }))
      );
    },
  },

  // GET /search
  {
    method: 'GET',
    path: 'search',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);

      const query = ctx.query.get('query');
      const viewOption = ctx.query.get('view_option');
      const permission = ctx.query.get('permission');
      const orderBy = ctx.query.get('order_by');
      const direction = ctx.query.get('direction');
      const page = Number(ctx.query.get('page') ?? 1) || 1;
      const skip = (page - 1) * 60;
      const limit = 60;

      const userGroupIds = await getUserGroupIds(user.id);
      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;

      let notes = bypass
        ? await getAllNotes()
        : await getNotesByUserId(user.id, (permission as 'read' | 'write') ?? 'write');
      void userGroupIds;

      if (query) {
        const words = query.split(/\s+/).filter((w) => w.replace(/-/g, ''));
        for (const raw of words) {
          const word = raw.replace(/-/g, '').toLowerCase();
          if (!word) continue;
          notes = notes.filter((note) => {
            const title = (note.title ?? '').replace(/-/g, '').replace(/ /g, '').toLowerCase();
            const data = normalizePages(note.data);
            const text = String(
              data['search_text'] ?? data['content']?.['md'] ?? ''
            )
              .replace(/-/g, '')
              .replace(/ /g, '')
              .toLowerCase();
            return title.includes(word) || text.includes(word);
          });
        }
      }
      if (viewOption === 'created') notes = notes.filter((n) => n.user_id === user.id);
      else if (viewOption === 'shared') notes = notes.filter((n) => n.user_id !== user.id);

      const orderKey = orderBy ?? 'updated_at';
      const dir = direction === 'asc' ? 1 : -1;
      notes = [...notes].sort((a, b) => {
        const av = (a as any)[orderKey] ?? 0;
        const bv = (b as any)[orderKey] ?? 0;
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });

      const total = notes.length;
      const items = notes.slice(skip, skip + limit);
      const pinnedNoteIds = new Set(await getPinnedNoteIds(user.id));
      const owners = new Map((await getUsersByIds([...new Set(items.map((n) => n.user_id))])).map((u) => [u.id, u]));

      return ctx.json({
        items: items.map((note) => ({
          ...note,
          is_pinned: pinnedNoteIds.has(note.id),
          data: truncateNoteData(note.data, 1000, query ?? ''),
          user: toUserResponse(owners.get(note.user_id) ?? ({} as any)),
        })),
        total,
      });
    },
  },

  // POST /create — static segment before :id routes
  {
    method: 'POST',
    path: 'create',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const form = await ctx.body<{
        title?: string;
        data?: Record<string, any> | null;
        meta?: Record<string, any> | null;
        access_grants?: any[] | null;
      }>();

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      const allowedGrants = await filterAllowedAccessGrants(
        defaults,
        user.id,
        user.role,
        form.access_grants ?? null,
        'note'
      );

      if (!(await hasAccessToNoteFiles(null, getNoteFiles(form.data ?? null), user))) {
        err(403, EM.DEFAULT());
      }

      try {
        const note = await insertNewNote(user.id, {
          title: String(form.title ?? ''),
          data: form.data ?? null,
          meta: form.meta ?? null,
          access_grants: allowedGrants,
        });
        if (!note) err(400, EM.DEFAULT());
        return ctx.json(note);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error(e);
        err(400, EM.DEFAULT());
      }
    },
  },

  // GET /:id
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const note = await getNoteById(ctx.params.id);
      if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        user.role !== 'admin' &&
        user.id !== note.user_id &&
        !(await hasAccessGrant(user.id, 'note', note.id, 'read'))
      ) {
        err(403, EM.DEFAULT());
      }

      const writeAccess =
        user.role === 'admin' ||
        user.id === note.user_id ||
        (await hasAccessGrant(user.id, 'note', note.id, 'write')) ||
        hasPublicWriteAccessGrant(note.access_grants as any);

      const pinnedNoteIds = new Set(await getPinnedNoteIds(user.id));
      return ctx.json({
        ...note,
        is_pinned: pinnedNoteIds.has(note.id),
        write_access: writeAccess,
      });
    },
  },

  // GET /:id/chats — 2 static segments must precede... only :id/chat exists; keep chats first
  {
    method: 'GET',
    path: ':id/chats',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const id = ctx.params.id;
      const note = await getNoteById(id);
      if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        user.role !== 'admin' &&
        user.id !== note.user_id &&
        !(await hasAccessGrant(user.id, 'note', note.id, 'read'))
      ) {
        err(403, EM.DEFAULT());
      }
      const chats = await getInternalChatsByNoteId(note.id, user.id);
      const normalized: any[] = [];
      for (const chat of chats) {
        normalized.push(await normalizeNoteChat(chat, note.id));
      }
      return ctx.json(normalized);
    },
  },

  // GET /:id/chat
  {
    method: 'GET',
    path: ':id/chat',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const id = ctx.params.id;
      const note = await getNoteById(id);
      if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        user.role !== 'admin' &&
        user.id !== note.user_id &&
        !(await hasAccessGrant(user.id, 'note', note.id, 'read'))
      ) {
        err(403, EM.DEFAULT());
      }

      const chats = await getInternalChatsByNoteId(note.id, user.id);
      const chat = chats[0];
      if (chat) {
        return ctx.json(await normalizeNoteChat(chat, note.id));
      }

      const chatId = crypto.randomUUID();
      const created = await insertNoteChat(chatId, user.id, note.id);
      if (!created) err(400, EM.DEFAULT());
      return ctx.json(created);
    },
  },

  // POST /:id/chat
  {
    method: 'POST',
    path: ':id/chat',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const id = ctx.params.id;
      const note = await getNoteById(id);
      if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        user.role !== 'admin' &&
        user.id !== note.user_id &&
        !(await hasAccessGrant(user.id, 'note', note.id, 'read'))
      ) {
        err(403, EM.DEFAULT());
      }
      const chatId = crypto.randomUUID();
      const created = await insertNoteChat(chatId, user.id, note.id);
      if (!created) err(400, EM.DEFAULT());
      return ctx.json(created);
    },
  },

  // POST /:id/pages/update
  {
    method: 'POST',
    path: ':id/pages/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<any>();
      return ctx.json(await updateNote(ctx, ctx.params.id, { page_operation: form }, user));
    },
  },

  // POST /:id/update
  {
    method: 'POST',
    path: ':id/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<any>();
      return ctx.json(await updateNote(ctx, ctx.params.id, form, user));
    },
  },

  // POST /:id/access/update
  {
    method: 'POST',
    path: ':id/access/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const id = ctx.params.id;
      const form = await ctx.body<{ access_grants?: any[] }>();
      const note = await getNoteById(id);
      if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        user.role !== 'admin' &&
        user.id !== note.user_id &&
        !(await hasAccessGrant(user.id, 'note', note.id, 'write'))
      ) {
        err(403, EM.DEFAULT());
      }

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      const grants = await validateAccessGrants(defaults, user.id, user.role, form.access_grants ?? [], 'note');
      await setAccessGrants('note', id, grants);

      const updated = await getNoteById(id);
      const pinnedNoteIds = new Set(await getPinnedNoteIds(user.id));
      return ctx.json({ ...updated, is_pinned: pinnedNoteIds.has(id) });
    },
  },

  // POST /:id/pin
  {
    method: 'POST',
    path: ':id/pin',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const id = ctx.params.id;
      const note = await getNoteById(id);
      if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        user.role !== 'admin' &&
        user.id !== note.user_id &&
        !(await hasAccessGrant(user.id, 'note', note.id, 'read'))
      ) {
        err(403, EM.DEFAULT());
      }

      const updated = await toggleNotePinnedById(id, user.id);
      const pinnedNoteIds = new Set(await getPinnedNoteIds(user.id));
      return ctx.json({ ...updated, is_pinned: pinnedNoteIds.has(id) });
    },
  },

  // DELETE /:id/delete
  {
    method: 'DELETE',
    path: ':id/delete',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkNotesAccess(user);
      const id = ctx.params.id;
      const note = await getNoteById(id);
      if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        user.role !== 'admin' &&
        user.id !== note.user_id &&
        !(await hasAccessGrant(user.id, 'note', note.id, 'write'))
      ) {
        err(403, EM.DEFAULT());
      }

      try {
        await deleteNoteById(id);
        return ctx.json(true);
      } catch (e) {
        console.error(e);
        err(400, EM.DEFAULT());
      }
    },
  },
];

/** Shared update handler for /:id/update and /:id/pages/update. */
async function updateNote(ctx: Ctx, id: string, form: any, user: { id: string; role: string }) {
  await checkNotesAccess(user);
  const note = await getNoteById(id);
  if (!note) err(404, ERROR_MESSAGES.NOT_FOUND);

  if (
    user.role !== 'admin' &&
    user.id !== note.user_id &&
    !(await hasAccessGrant(user.id, 'note', note.id, 'write'))
  ) {
    err(403, EM.DEFAULT());
  }

  if (form.data) {
    const contentFiles = getContentFiles(form.data['content'] ?? null);
    if (!(await hasAccessToNoteFiles(note, contentFiles, user))) {
      err(403, EM.DEFAULT());
    }
  }

  try {
    if (form.page_generation !== null && form.page_generation !== undefined) {
      throw new Error('Page generation is managed by collaboration');
    }
    const updated = await updateNoteById(id, {
      title: form.title ?? null,
      data: form.data ?? null,
      meta: form.meta ?? null,
      page_id: form.page_id ?? null,
      page_revision: form.page_revision ?? null,
      page_generation: form.page_generation ?? null,
      page_operation: form.page_operation ?? null,
    });
    if (!updated) err(400, EM.DEFAULT());

    const pinnedNoteIds = new Set(await getPinnedNoteIds(user.id));
    return { ...updated, is_pinned: pinnedNoteIds.has(updated.id) };
  } catch (e) {
    if (e instanceof NotePageConflict) err(409, String(e.message));
    if (e instanceof HttpError) throw e;
    if (e instanceof Error) err(400, String(e.message));
    console.error(e);
    err(400, EM.DEFAULT());
  }
}

void getAccessibleResourceIds;
