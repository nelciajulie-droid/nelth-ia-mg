import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { getUserGroupIds, hasPermission } from '@/lib/access-control';
import { safeParse, normalizePages, matchingPage } from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/search.py (GET /api/v1/search) — the global
 * workspace search across chats / shared chats / notes / channel messages.
 *
 * Deviation (documented): Python builds recursive CTEs + UNION ALL in SQL.
 * This port performs the same permission-scoped search in JS over rows
 * fetched from the shared SQLite DB (equivalent results, in-memory ranking).
 */

const PAGE_SIZE = 24;

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

type SearchResult = {
  id: string;
  kind: 'chat' | 'message' | 'note';
  title: string;
  context: string;
  snippet: string;
  preview: string;
  url: string;
  updated_at: number;
  shared: boolean;
  pinned: boolean;
  rank: number;
};

type SearchScope = { id: string; name: string; kind: 'folder' | 'channel' };

function termsFor(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
}

/** Python chat_search_content_query — drop filter-prefixed words. */
function chatSearchContentQuery(text: string): string {
  const prefixes = ['tag:', 'folder:', 'pinned:', 'archived:', 'shared:'];
  return text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((word) => !prefixes.some((p) => word.startsWith(p)))
    .join(' ')
    .trim();
}

function excerpt(content: string | null | undefined, query: string, length = 200): string {
  const text = content ?? '';
  const positions = termsFor(query).map((term) => text.toLowerCase().indexOf(term));
  const found = positions.filter((p) => p >= 0);
  const position = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, position - Math.floor(length / 4));
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, start + length).trim() +
    (start + length < text.length ? '…' : '')
  );
}

function chatMessageList(chat: Record<string, any>): Array<Record<string, any>> {
  const history = chat['history'];
  let messages = history && typeof history === 'object' ? history['messages'] : null;
  if (!messages || typeof messages !== 'object' || Array.isArray(messages) || !Object.keys(messages).length) {
    messages = chat['messages'];
  }
  if (!messages) return [];
  if (Array.isArray(messages)) return messages.filter((m) => m && typeof m === 'object');
  return Object.values(messages);
}

function chatPassage(data: Record<string, any>, query: string): [string, string | null] {
  const messages = chatMessageList(data).filter(
    (m) => typeof m['content'] === 'string'
  );
  const terms = termsFor(query);
  const allMatch = messages.find((m) => terms.length && terms.every((t) => (m['content'] as string).toLowerCase().includes(t)));
  const anyMatch = messages.find((m) => terms.some((t) => (m['content'] as string).toLowerCase().includes(t)));
  const match = allMatch ?? anyMatch ?? null;
  const fallback = messages[messages.length - 1] ?? {};
  return [String((match ?? fallback)['content'] ?? ''), match ? String(match['id'] ?? '') || null : null];
}

function titleRank(title: string | null | undefined, query: string): number {
  if (!query) return 3;
  const t = (title ?? '').toLowerCase();
  if (t === query.toLowerCase()) return 0;
  if (t.includes(query.toLowerCase())) return 1;
  return 3;
}

/** Does a chat's message content contain the term (case-insensitive)? */
function chatContentMatches(chatJson: Record<string, any> | null, term: string): boolean {
  if (!chatJson) return false;
  const needle = term.toLowerCase();
  for (const message of chatMessageList(chatJson)) {
    const content = message['content'];
    if (typeof content === 'string' && content.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const q = (ctx.query.get('q') ?? '').slice(0, 500);
      const kind = (ctx.query.get('kind') ?? 'all') as 'all' | 'chat' | 'message' | 'note';
      const sharing = (ctx.query.get('sharing') ?? 'all') as 'all' | 'mine' | 'shared';
      const scope = (ctx.query.get('scope') ?? '').slice(0, 200);
      const page = Math.min(100_000, Math.max(1, Number(ctx.query.get('page') ?? 1) || 1));

      // Enabled kinds (Python: chat + optional channels/notes)
      const enabled: string[] = ['chat'];
      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      if (
        (await configGet<boolean>('channels.enable', env.ENABLE_CHANNELS)) &&
        (user.role === 'admin' || (await hasPermission(user.id, 'features.channels', defaults)))
      ) {
        enabled.push('message');
      }
      if (
        (await configGet<boolean>('notes.enable', env.ENABLE_NOTES)) &&
        (user.role === 'admin' || (await hasPermission(user.id, 'features.notes', defaults)))
      ) {
        enabled.push('note');
      }

      const groups = await getUserGroupIds(user.id);

      // ----- Folders (accessible closure) -----
      const allFolders = await db.folder.findMany();
      const folderGrantRows = await db.accessGrant.findMany({
        where: {
          resource_type: 'folder',
          permission: 'read',
          OR: [
            { principal_type: 'user', principal_id: user.id },
            { principal_type: 'user', principal_id: '*' },
            { principal_type: 'group', principal_id: { in: groups } },
          ],
        },
      });
      const grantedFolderIds = new Set(folderGrantRows.map((g) => g.resource_id));
      const rootFolders = allFolders.filter(
        (f) => f.user_id === user.id || grantedFolderIds.has(f.id)
      );
      const folderIds = new Set(rootFolders.map((f) => f.id));
      // closure over children
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of allFolders) {
          if (folderIds.has(folder.id)) continue;
          if (folder.parent_id && folderIds.has(folder.parent_id)) {
            folderIds.add(folder.id);
            changed = true;
          }
        }
      }
      const folderRows = allFolders.filter((f) => folderIds.has(f.id));
      const folderMap = new Map(folderRows.map((f) => [f.id, f]));

      // ----- Channels (user's memberships) -----
      const channels =
        'message' in enabled
          ? await (async () => {
              const memberships = await db.channelMember.findMany({
                where: { user_id: user.id, is_active: true },
                select: { channel_id: true },
              });
              const channelRows = await db.channel.findMany({
                where: { id: { in: memberships.map((m) => m.channel_id) } },
              });
              return channelRows.filter(
                (c) =>
                  c.deleted_at === null &&
                  c.archived_at === null &&
                  (c.type === 'group' || c.type === 'dm')
              );
            })()
          : [];
      const channelMap = new Map(channels.map((c) => [c.id, c]));
      const channelNames: Record<string, string> = {};
      for (const c of channels) channelNames[c.id] = c.name ?? '';
      const directMessageIds = channels.filter((c) => c.type === 'dm' && !c.name).map((c) => c.id);
      if (directMessageIds.length) {
        const members = await db.channelMember.findMany({
          where: { channel_id: { in: directMessageIds }, user_id: { not: user.id } },
        });
        const participants: Record<string, string[]> = {};
        for (const channelId of directMessageIds) participants[channelId] = [];
        const otherUsers = await db.user.findMany({
          where: { id: { in: [...new Set(members.map((m) => m.user_id ?? ''))] } },
        });
        const usersById = new Map(otherUsers.map((u) => [u.id, u]));
        for (const m of members) {
          if (!m.user_id) continue;
          participants[m.channel_id]?.push(usersById.get(m.user_id)?.name ?? '');
        }
        for (const [channelId, names] of Object.entries(participants)) {
          channelNames[channelId] = names.filter(Boolean).join(', ') || user.name;
        }
      }

      // ----- Scopes -----
      const scopes: SearchScope[] = folderRows.map((f) => ({
        id: `folder:${f.id}`,
        name: f.name ?? '',
        kind: 'folder',
      }));
      scopes.push(
        ...channels.map((c) => ({
          id: `channel:${c.id}`,
          name: channelNames[c.id] ?? '',
          kind: 'channel' as const,
        }))
      );
      scopes.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));

      // Shared folders (any read grant) + descendants
      const anyGrantFolderRows = await db.accessGrant.findMany({
        where: { resource_type: 'folder', permission: 'read' },
        select: { resource_id: true },
      });
      const sharedFolderIds = new Set(anyGrantFolderRows.map((g) => g.resource_id).filter((id) => folderMap.has(id)));
      changed = true;
      while (changed) {
        changed = false;
        const children = new Set(
          folderRows.filter((f) => f.parent_id && sharedFolderIds.has(f.parent_id)).map((f) => f.id)
        );
        for (const id of children) {
          if (!sharedFolderIds.has(id)) {
            sharedFolderIds.add(id);
            changed = true;
          }
        }
      }

      let scopedFolders = new Set(folderMap.keys());
      if (scope.startsWith('folder:')) {
        const root = scope.slice('folder:'.length);
        scopedFolders = folderMap.has(root) ? new Set([root]) : new Set();
        changed = true;
        while (changed) {
          changed = false;
          for (const f of folderRows) {
            if (scopedFolders.has(f.id) || !f.parent_id || !scopedFolders.has(f.parent_id)) continue;
            scopedFolders.add(f.id);
            changed = true;
          }
        }
      }

      if (scope && !scopes.some((s) => s.id === scope)) {
        return ctx.json({ items: [], has_more: false, scopes, kinds: enabled });
      }

      // ----- Query parsing -----
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const tagIds = words.filter((w) => w.startsWith('tag:') && w !== 'tag:').map((w) => w.slice(4));
      const folderNames = words.filter((w) => w.startsWith('folder:') && w !== 'folder:').map((w) => w.slice(7));
      const flags: Record<string, boolean> = {};
      for (const word of words) {
        const idx = word.indexOf(':');
        if (idx === -1) continue;
        const name = word.slice(0, idx);
        const value = word.slice(idx + 1);
        if (['pinned', 'archived', 'shared'].includes(name) && (value === 'true' || value === 'false')) {
          flags[name] = value === 'true';
        }
      }
      const chatFiltered = Boolean(tagIds.length || folderNames.length || Object.keys(flags).length);
      const query = chatSearchContentQuery(q);
      const terms = termsFor(query);

      const sharingFilter = (owner: string | null | undefined): boolean => {
        if (sharing === 'mine') return owner === user.id;
        if (sharing === 'shared') return owner !== user.id;
        return true;
      };

      type Candidate = {
        source: 'chat' | 'shared' | 'note' | 'message';
        id: string;
        rank: number;
        updatedAt: number;
      };
      const candidates: Candidate[] = [];
      const sources: Record<string, boolean> = {};

      // ----- Shared chats with share_mode=continue -----
      const sharedChatRows = await db.sharedChat.findMany();
      const sharedChatGrantRows = await db.accessGrant.findMany({
        where: { resource_type: 'shared_chat', permission: 'read' },
      });
      const grantedSharedChatIds = new Set(
        sharedChatGrantRows
          .filter(
            (g) =>
              (g.principal_type === 'user' && (g.principal_id === user.id || g.principal_id === '*')) ||
              (g.principal_type === 'group' && groups.includes(g.principal_id))
          )
          .map((g) => g.resource_id)
      );
      const continueSharedIds = new Set(
        sharedChatRows
          .filter(
            (row) =>
              safeParse<Record<string, any>>(row.chat, {})?.['share_mode'] === 'continue' &&
              grantedSharedChatIds.has(row.chat_id)
          )
          .map((row) => row.chat_id)
      );

      // ----- Chats -----
      if (enabled.includes('chat') && (kind === 'all' || kind === 'chat') && !scope.startsWith('channel:')) {
        const chatRows = await db.chat.findMany();
        const matchedFolderIds = folderNames.length
          ? new Set(
              allFolders
                .filter((f) =>
                  folderNames.some(
                    (name) => (f.name ?? '').toLowerCase() === name.toLowerCase() && f.user_id === user.id
                  )
                )
                .map((f) => f.id)
            )
          : null;

        for (const chat of chatRows) {
          if (!(chat.user_id === user.id || (chat.folder_id && folderIds.has(chat.folder_id)) || continueSharedIds.has(chat.id))) {
            continue;
          }
          if ((chat.archived ?? false) !== (flags['archived'] ?? false)) continue;
          const meta = safeParse<Record<string, any>>(chat.meta, {}) ?? {};
          if (meta['internal'] === true) continue;
          if (!sharingFilter(chat.user_id)) continue;
          if (scope && !(chat.folder_id && scopedFolders.has(chat.folder_id))) continue;
          if (chatFiltered && chat.user_id !== user.id) continue;
          if ('pinned' in flags && (chat.pinned ?? false) !== flags['pinned']) continue;
          if ('shared' in flags) {
            const hasShare = chat.share_id !== null && chat.share_id !== undefined;
            if (hasShare !== flags['shared']) continue;
          }
          if (matchedFolderIds && !(chat.folder_id && matchedFolderIds.has(chat.folder_id))) continue;
          if (tagIds.length) {
            const tags = (meta['tags'] ?? []) as string[];
            for (const tagId of tagIds) {
              if (tagId === 'none') {
                if (tags.length) continue;
              } else if (!tags.map(String).includes(tagId)) continue;
            }
          }
          // term matching: title or message content
          const title = (chat.title ?? '').toLowerCase();
          const chatJson = safeParse<Record<string, any>>(chat.chat, {}) ?? {};
          const matches = terms.every(
            (term) => title.includes(term) || chatContentMatches(chatJson, term)
          );
          if (!matches) continue;

          const rank = query
            ? titleRank(chat.title ?? '', query)
            : (chat.pinned ?? false) && chat.user_id === user.id
              ? 0
              : 3;
          candidates.push({
            source: 'chat',
            id: chat.id,
            rank,
            updatedAt: chat.updated_at ?? 0,
          });
          sources['chat'] = true;
        }

        // Shared chat snapshots
        if (!scope && sharing !== 'mine' && !chatFiltered) {
          const liveIds = new Set(
            chatRows
              .filter(
                (chat) =>
                  chat.user_id === user.id ||
                  (chat.folder_id && folderIds.has(chat.folder_id)) ||
                  continueSharedIds.has(chat.id)
              )
              .map((chat) => chat.id)
          );
          for (const shared of sharedChatRows) {
            if (!grantedSharedChatIds.has(shared.chat_id)) continue;
            if (liveIds.has(shared.chat_id)) continue;
            if (sharing === 'shared' && shared.user_id === user.id) continue;
            const title = (shared.title ?? '').toLowerCase();
            const chatJson = safeParse<Record<string, any>>(shared.chat, {}) ?? {};
            const matches = terms.every(
              (term) => title.includes(term) || chatContentMatches(chatJson, term)
            );
            if (!matches) continue;
            candidates.push({
              source: 'shared',
              id: shared.chat_id,
              rank: titleRank(shared.title ?? '', query),
              updatedAt: shared.updated_at ?? 0,
            });
            sources['shared'] = true;
          }
        }
      }

      // ----- Notes -----
      if (enabled.includes('note') && (kind === 'all' || kind === 'note') && !scope && !chatFiltered) {
        const noteRows = await db.note.findMany();
        const noteGrantRows = await db.accessGrant.findMany({
          where: { resource_type: 'note', permission: 'read' },
        });
        const pinnedNoteIds = new Set(
          (await db.pinnedNote.findMany({ where: { user_id: user.id } })).map((p) => p.note_id)
        );
        for (const note of noteRows) {
          const accessible =
            note.user_id === user.id ||
            noteGrantRows.some(
              (g) =>
                g.resource_id === note.id &&
                ((g.principal_type === 'user' && (g.principal_id === user.id || g.principal_id === '*')) ||
                  (g.principal_type === 'group' && groups.includes(g.principal_id)))
            );
          if (!accessible) continue;
          if (!sharingFilter(note.user_id)) continue;

          const data = safeParse<Record<string, any>>(note.data, {}) ?? {};
          const body = String(
            (data['search_text'] as string) ?? data['content']?.['md'] ?? ''
          ).toLowerCase();
          const title = (note.title ?? '').toLowerCase();
          const matches = terms.every((term) => title.includes(term) || body.includes(term));
          if (!matches) continue;

          const rank = query ? titleRank(note.title ?? '', query) : pinnedNoteIds.has(note.id) ? 0 : 3;
          candidates.push({
            source: 'note',
            id: note.id,
            rank,
            updatedAt: Math.floor((note.updated_at ?? 0) / 1_000_000_000),
          });
          sources['note'] = true;
        }
      }

      // ----- Channel messages -----
      if (enabled.includes('message') && (kind === 'all' || kind === 'message') && !scope.startsWith('folder:') && !chatFiltered) {
        const ids = scope ? [scope.slice('channel:'.length)] : [...channelMap.keys()];
        const messageRows = await db.message.findMany({ where: { channel_id: { in: ids } } });
        for (const message of messageRows) {
          if (!sharingFilter(message.user_id)) continue;
          const content = (message.content ?? '').toLowerCase();
          const matches = terms.every((term) => content.includes(term));
          if (!matches) continue;
          candidates.push({
            source: 'message',
            id: message.id,
            rank: 3,
            updatedAt: Math.floor((message.updated_at ?? 0) / 1_000_000_000),
          });
          sources['message'] = true;
        }
      }

      if (!Object.keys(sources).length) {
        return ctx.json({ items: [], has_more: false, scopes, kinds: enabled });
      }

      // ----- Rank + paginate -----
      candidates.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
        return a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
      });
      const pageCandidates = candidates.slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE + 1);
      const hasMore = pageCandidates.length > PAGE_SIZE;
      const matches = pageCandidates.slice(0, PAGE_SIZE);

      const results: SearchResult[] = [];
      const appendResult = (
        id: string,
        resultKind: 'chat' | 'message' | 'note',
        title: string | null | undefined,
        context: string,
        content: string | null | undefined,
        url: string,
        updated: number,
        shared: boolean,
        pinned = false,
        rank = 3
      ) => {
        results.push({
          id,
          kind: resultKind,
          title: title || 'Untitled',
          context,
          snippet: excerpt(content, query),
          preview: excerpt(content, query, 2400),
          url,
          updated_at: updated,
          shared,
          pinned: Boolean(pinned),
          rank,
        });
      };

      // Hydrate page rows
      const chatIds = matches.filter((m) => m.source === 'chat' || m.source === 'shared').map((m) => m.id);
      const chatById = new Map(
        chatIds.length ? (await db.chat.findMany({ where: { id: { in: chatIds } } })).map((c) => [c.id, c]) : []
      );
      const sharedById = new Map(
        matches.filter((m) => m.source === 'shared').length
          ? (await db.sharedChat.findMany({ where: { chat_id: { in: matches.filter((m) => m.source === 'shared').map((m) => m.id) } } })).map((s) => [s.chat_id, s])
          : []
      );
      const noteIds = matches.filter((m) => m.source === 'note').map((m) => m.id);
      const noteById = new Map(
        noteIds.length ? (await db.note.findMany({ where: { id: { in: noteIds } } })).map((n) => [n.id, n]) : []
      );
      const messageIds = matches.filter((m) => m.source === 'message').map((m) => m.id);
      const messageById = new Map(
        messageIds.length ? (await db.message.findMany({ where: { id: { in: messageIds } } })).map((m) => [m.id, m]) : []
      );
      const messageAuthors = new Map(
        messageIds.length
          ? (await db.user.findMany({
              where: { id: { in: [...new Set((await db.message.findMany({ where: { id: { in: messageIds } } })).map((m) => m.user_id ?? ''))] } },
            })).map((u) => [u.id, u.name])
          : []
      );

      for (const match of matches) {
        if (match.source === 'chat' || match.source === 'shared') {
          const snapshot = match.source === 'shared';
          const chatRow = snapshot ? sharedById.get(match.id) : chatById.get(match.id);
          if (!chatRow) continue;
          const chatJson = safeParse<Record<string, any>>(chatRow.chat, {}) ?? {};
          const [content, messageId] = chatPassage(chatJson, query);
          const row = chatRow as any;
          const folder = snapshot ? null : row.folder_id ? folderMap.get(row.folder_id) : null;
          const context = snapshot
            ? 'Shared snapshot'
            : folder
              ? (folder.name ?? '')
              : row.user_id !== user.id
                ? 'Shared chat'
                : 'Personal chat';
          let url = (snapshot ? '/s/' : '/c/') + row.id;
          if (messageId) {
            url += `?message=${encodeURIComponent(messageId)}`;
          }
          const isShared =
            snapshot ||
            row.user_id !== user.id ||
            Boolean(row.share_id) ||
            (row.folder_id !== null && row.folder_id !== undefined && sharedFolderIds.has(row.folder_id));
          appendResult(
            `${match.source}:${row.id}`,
            'chat',
            row.title,
            context,
            content,
            url,
            match.updatedAt,
            isShared,
            !snapshot && Boolean(row.pinned) && row.user_id === user.id,
            match.rank
          );
        } else if (match.source === 'note') {
          const noteRow = noteById.get(match.id);
          if (!noteRow) continue;
          const data = safeParse<Record<string, any>>(noteRow.data, {});
          const page = matchingPage(data, query);
          const content = page['content']?.['md'] ?? '';
          const noteGrant = await db.accessGrant.findFirst({
            where: { resource_type: 'note', resource_id: noteRow.id, permission: 'read' },
          });
          const isNoteShared = noteRow.user_id !== user.id || Boolean(noteGrant);
          const pinned = await db.pinnedNote.findFirst({
            where: { note_id: noteRow.id, user_id: user.id },
          });
          appendResult(
            `note:${noteRow.id}`,
            'note',
            noteRow.title,
            noteRow.user_id !== user.id || noteGrant ? 'Shared note' : 'Personal note',
            typeof content === 'string' ? content : '',
            `/notes/${noteRow.id}?page=${encodeURIComponent(String(page['id'] ?? ''))}&search=${encodeURIComponent(query)}`,
            match.updatedAt,
            isNoteShared,
            Boolean(pinned),
            match.rank
          );
        } else {
          const message = messageById.get(match.id);
          if (!message) continue;
          const channel = channelMap.get(message.channel_id ?? '');
          if (!channel) continue;
          const url = `/channels/${channel.id}?thread=${encodeURIComponent(message.parent_id ?? message.id)}&message=${encodeURIComponent(message.id ?? '')}`;
          appendResult(
            `message:${message.id}`,
            'message',
            (message.user_id ? messageAuthors.get(message.user_id) : '') || 'Message',
            channel.type === 'dm' ? channelNames[channel.id] ?? '' : `#${channelNames[channel.id] ?? ''}`,
            message.content,
            url,
            match.updatedAt,
            true,
            false,
            match.rank
          );
        }
      }

      return ctx.json({
        items: results.map(({ rank, ...item }) => {
          void rank;
          return item;
        }),
        has_more: hasMore,
        scopes,
        kinds: enabled,
      });
    },
  },
];

void normalizePages;
