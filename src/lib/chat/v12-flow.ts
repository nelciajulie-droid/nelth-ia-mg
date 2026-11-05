import type { ApiUser } from '@/lib/auth';
import {
  insertNewChat,
  getChatById,
  updateChatById,
  getChatMessagesMapByChatId,
  getMessageList,
  getOutputText,
  upsertMessageToChatByIdAndMessageId,
} from '@/lib/models/chats';
import { emitSocketEvent } from './socket-events';
import {
  ReasoningAccumulator,
  NativeReasoningAccumulator,
  nativeReasoningOutputItems,
  parseCompleteOutput,
  stripReasoningTags,
} from './reasoning';

/**
 * Open WebUI v0.12.5 chat completion flow — port of main.py `chat_completion`
 * (message_ids / user_message bookkeeping, lines 1255-1694) + the essential
 * middleware pipeline (load_messages_from_db, stream → socket events, title
 * generation, persistence).
 *
 * The ORIGINAL frontend sends:
 *   { stream, model, params, message_ids: [{model_id, message_id}],
 *     parent_id, user_message, session_id (socket id), chat_id?, id,
 *     background_tasks, ... }
 * …and expects: HTTP JSON response + content streamed over Socket.IO
 * ('events' → room user:{user_id}, envelope {chat_id, message_id, data}).
 */

const nowSec = () => Math.floor(Date.now() / 1000);

function isSavedChatId(id: string | null | undefined): boolean {
  return !!id && !id.startsWith('local-') && !id.startsWith('channel:');
}

function isTemporaryChatId(id: string | null | undefined): boolean {
  return !!id && (id.startsWith('local-') || id.startsWith('temporary-'));
}

/** Flatten string | content-blocks to plain text (Python get_content_from_message). */
function flattenContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p && typeof p === 'object' && p.type === 'text' ? String(p.text ?? '') : ''))
      .join('');
  }
  return String(content);
}

function messageContent(m: any): string {
  if (!m || typeof m !== 'object') return '';
  // Raw content (document blocks intact) — see persistAssistant(): the
  // processed `content` replaces generated documents with "📎 …" markers
  // for the UI, and structured `output` items hold the processed text too.
  // Sending the processed text back to the model strips it of the very
  // code/files it produced (next turn: "Voici la version claire…" — the
  // model no longer has its own code and re-announces it without it).
  const raw = typeof m?.meta?.llm_content === 'string' ? m.meta.llm_content : '';
  if (raw.trim()) return raw;
  const out = getOutputText(m.output);
  const base = out || flattenContent(m.content);
  // Legacy messages persisted before llm_content existed: at least name the
  // generated files so the model knows they exist in the conversation.
  if (Array.isArray(m.files) && m.files.length) {
    const names = m.files
      .map((f: any) => (f && typeof f.name === 'string' ? f.name : null))
      .filter((n: any): n is string => !!n);
    if (names.length) {
      return `${base}\n\n[Fichiers générés précédemment et joints à ce message : ${names.join(', ')}]`;
    }
  }
  return base;
}

// Python config.py DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE (verbatim).
const TITLE_TEMPLATE = `### Task:
Generate a concise title summarizing the chat history.
### Guidelines:
- The title should clearly represent the main theme or subject of the conversation.
- Keep it short: 2-4 words is best.
- Do not use emojis, quotation marks, or special formatting.
- Write the title in the chat's primary language; default to English if multilingual.
- Prioritize accuracy over creativity.
- Your entire response must consist solely of the JSON object, without any introductory or concluding text.
- The output must be a single, raw JSON object, without any markdown code fences or other encapsulating text.
- Ensure no conversational text, affirmations, or explanations precede or follow the raw JSON output, as this will cause direct parsing failure.
### Output:
JSON format: { "title": "your concise title here" }
### Examples:
- { "title": "Stock Trends" },
- { "title": "Chocolate Chip Cookies" },
- { "title": "Music Streaming" },
- { "title": "Remote Work" }
### Chat History:
<chat_history>
{{MESSAGES:END:2}}
</chat_history>`;

type ModelRoute = {
  type: 'openai' | 'ollama';
  model: string;
  baseUrl: string;
  apiKey: string;
};

export async function handleChatCompletionV12(user: ApiUser, form: any): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data === null ? 'null' : data === undefined ? 'null' : data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  // FastAPI `return None` parity for the UI path.
  const nullJson = () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });

  // ------------------------------------------------------------------ 1. Parse
  // Legacy GLM model ids → Kilo gateway equivalents (the built-in z-ai
  // engine was removed; chats created with the old models keep working).
  const { normalizeKiloModelId } = await import('@/lib/kilo-llm');
  const modelId: string = normalizeKiloModelId(form.model);
  let messageIds: any[] | null = form.message_ids ?? null;
  if (Array.isArray(messageIds)) {
    delete form.id;
  } else if (messageIds && typeof messageIds === 'object') {
    messageIds = Object.entries(messageIds).map(([k, v]) => ({ model_id: k, message_id: v }));
    delete form.id;
  } else {
    messageIds = [{ model_id: modelId, message_id: form.id ?? null }];
    delete form.id;
  }
  const userMessage = form.user_message ?? form.parent_message ?? null;
  let chatId: string = typeof form.chat_id === 'string' ? form.chat_id : '';
  const isNewChat = 'parent_id' in form && form.parent_id === null && !form.chat_id;
  delete form.parent_id;
  delete form.new_chat;
  const sessionId: string | null = typeof form.session_id === 'string' ? form.session_id : null;
  const backgroundTasks = form.background_tasks ?? {};
  const assistantMessageId: string | null = messageIds[0]?.message_id ?? null;
  const userMessageId: string | null = userMessage?.id ?? null;

  // Serverless realtime transport — requested by the loader.js bridge when
  // the browser cannot reach a socket.io service (Vercel & co). The whole
  // socket-event flow (status, streaming deltas, sources, titles, done) is
  // serialized into the HTTP response as SSE lines instead of being emitted
  // over a socket hop that does not exist.
  const sseEventsRequested = form.__sse_events === true;
  delete form.__sse_events;
  const sseBuffer: unknown[] = [];
  let sseSink: ((envelope: unknown) => void) | null = null;

  if (isNewChat) chatId = crypto.randomUUID();

  const emit = (data: unknown) => {
    const envelope = { chat_id: chatId, message_id: assistantMessageId, data };
    if (sseSink) {
      // SSE event transport: write into the response stream — instant and
      // ordered, no socket hop (there is no socket service to reach).
      sseSink(envelope);
      return Promise.resolve();
    }
    if (sseEventsRequested) {
      // Event fired before the response stream opened (auto web-search
      // status…): buffer it — flushed in order when the stream starts.
      sseBuffer.push(envelope);
      return Promise.resolve();
    }
    return emitSocketEvent(`user:${user.id}`, envelope);
  };

  // Paced-reasoning-reveal timer (driven inside the streaming flow, cleared
  // on every exit path below): a live setInterval would keep the serverless
  // function's event loop alive after the response ends.
  let revealTimerHandle: ReturnType<typeof setInterval> | null = null;
  const stopRevealTicker = () => {
    if (revealTimerHandle !== null) {
      clearInterval(revealTimerHandle);
      revealTimerHandle = null;
    }
  };

  // ------------------------------------------------- 2. Chat bookkeeping (DB)
  let historyMap: Record<string, any> | null = null;
  if (isSavedChatId(chatId) && userMessageId && userMessage) {
    const allAssistantIds = messageIds.map((e) => e?.message_id).filter(Boolean);
    const um: Record<string, any> = {
      ...userMessage,
      childrenIds: allAssistantIds,
      user_id: user.id,
      user: { id: user.id, name: user.name },
    };

    if (isNewChat) {
      const historyMessages: Record<string, any> = { [userMessageId]: um };
      for (const entry of messageIds) {
        if (entry?.message_id) {
          historyMessages[entry.message_id] = {
            id: entry.message_id,
            parentId: userMessageId,
            childrenIds: [],
            role: 'assistant',
            content: '',
            done: false,
            model: entry.model_id,
            timestamp: nowSec(),
            ...(entry.modelIdx != null ? { modelIdx: entry.modelIdx } : {}),
          };
        }
      }
      await insertNewChat(chatId, user.id, {
        chat: {
          id: chatId,
          title: 'New Chat',
          models: messageIds.map((e) => e?.model_id).filter(Boolean),
          history: {
            currentId: allAssistantIds[0] ?? userMessageId,
            messages: historyMessages,
          },
          messages: [{ role: 'user', content: flattenContent(userMessage.content) }],
          files: form.files ?? [],
          tags: [],
          timestamp: Date.now(),
        },
        folder_id: form.folder_id ?? null,
      } as any);
      historyMap = historyMessages;
    } else {
      // Follow-up turn: verify ownership, then append the turn to history.
      const chat = await getChatById(chatId);
      if (!chat || (chat.user_id !== user.id && user.role !== 'admin')) {
        return json({ detail: 'You do not have permission to access this resource. Please contact your administrator for assistance.' }, 403);
      }
      const chatJson: any = (chat.chat as any) ?? {};
      const history: any = chatJson.history ?? {};
      const messagesMap: Record<string, any> = { ...(history.messages ?? {}) };
      messagesMap[userMessageId] = um;
      for (const entry of messageIds) {
        if (entry?.message_id) {
          messagesMap[entry.message_id] = {
            id: entry.message_id,
            parentId: userMessageId,
            childrenIds: [],
            role: 'assistant',
            content: '',
            done: false,
            model: entry.model_id,
            timestamp: nowSec(),
            ...(entry.modelIdx != null ? { modelIdx: entry.modelIdx } : {}),
          };
        }
      }
      history.messages = messagesMap;
      history.currentId = allAssistantIds[0] ?? history.currentId ?? null;
      await updateChatById(chatId, { history });
      historyMap = messagesMap;
    }
  }

  // ---- The whole completion flow (search → upstream → streaming) is
  // wrapped in a function so the serverless SSE response stream can open
  // BEFORE it runs (see the early-stream block at the end of this handler):
  // every status event ("Recherche web en cours"…) then reaches the browser
  // in real time while the phases run, instead of being buffered and
  // bundled with the first content chunk after a 10-30s silent wait.
  const runCompletionFlow = async (): Promise<Response> => {
  // ---------------------------------------- 3. Build LLM messages (middleware)
  let llmMessages: { role: string; content: string }[];
  if (historyMap && userMessageId) {
    // load_messages_from_db: chain up to user_message_id (getMessageList walks
    // parentId links newest→oldest, then we reverse).
    let map = historyMap;
    if (!isNewChat) {
      const stored = await getChatMessagesMapByChatId(chatId);
      if (stored && Object.keys(stored as any).length) map = stored as any;
    }
    const chain = getMessageList(map as any, userMessageId).reverse();
    // In-flight assistant placeholders (this turn's targets) are dropped, as
    // before. Any OTHER empty assistant message is an interrupted/killed
    // generation (serverless function timeout, crash…) — it is NOT silently
    // removed: the model is told a response existed but was interrupted, so
    // it does not re-deliver from scratch ("Voici la version claire…" with
    // no code — the code it wrote died with the function before persist).
    const inFlightIds = new Set(
      messageIds.map((e: any) => e?.message_id).filter((id: any): id is string => !!id)
    );
    llmMessages = chain
      .map((m: any) => {
        if (m.role === 'assistant' && !messageContent(m)) {
          return inFlightIds.has(m.id)
            ? null
            : {
                role: 'assistant',
                content:
                  "[La génération de cette réponse précédente a été interrompue avant sa sauvegarde — aucun contenu n'est disponible.]",
              };
        }
        return { role: m.role, content: messageContent(m) };
      })
      .filter((m: any): m is { role: string; content: string } => m !== null);
  } else {
    llmMessages = (form.messages ?? []).map((m: any) => ({
      role: m.role,
      content: flattenContent(m.content),
    }));
    if (!llmMessages.length && userMessage) {
      llmMessages = [{ role: 'user', content: flattenContent(userMessage.content) }];
    }
  }
  console.log(
    '[v12-flow] llm context:',
    llmMessages.map((m) => `${m.role}:${m.content.length}`).join(' | ')
  );

  // File-generation intent gate — captured HERE, before the web-search
  // middleware prepends fetched page contents to the last user message
  // (augmented text would false-positive on "fichier/pdf/download" words
  // coming from the web pages, not from the user). Downloadable file cards
  // are created ONLY when the user EXPLICITLY asked for a file/download/
  // export in their own words this turn; otherwise the model's code/document
  // blocks stay fully INLINE in the conversation (normal code blocks the
  // user can read and copy — the "landing page → surprise .html file"
  // complaint).
  const rawLastUserText: string = (() => {
    for (let i = llmMessages.length - 1; i >= 0; i--) {
      if (llmMessages[i]?.role === 'user') return llmMessages[i].content || '';
    }
    return flattenContent(userMessage?.content);
  })();
  let userAskedForFile = false;
  try {
    const { FILE_REQUEST_RE } = await import('@/lib/document-generation');
    userAskedForFile = FILE_REQUEST_RE.test(rawLastUserText || '');
  } catch {
    userAskedForFile = false;
  }
  console.log(
    '[v12-flow] document extraction gate:',
    userAskedForFile ? 'EXPLICIT file request → extract' : 'no file request → keep inline'
  );

  // System prompt (params.system / model-level params come through form.params)
  const systemPrompt = form.params?.system;
  if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
    llmMessages = [{ role: 'system', content: systemPrompt }, ...llmMessages];
  }

  // Platform capability prompt (TS-port extension): tells the model it CAN
  // generate real downloadable documents (```document filename="..." blocks)
  // — converted to PDF/DOCX/… files by the completion pipeline below. Without
  // this the LLM defaults to "I can't create files, copy/paste this template".
  {
    const { CAPABILITY_SYSTEM_PROMPT } = await import('@/lib/document-generation');
    const hasCapabilityPrompt = llmMessages.some(
      (m) => m.role === 'system' && m.content.includes('DOCUMENT CREATION CAPABILITY')
    );
    if (!hasCapabilityPrompt) {
      if (llmMessages.length && llmMessages[0].role === 'system') {
        llmMessages[0] = { role: 'system', content: `${llmMessages[0].content}\n\n---\n\n${CAPABILITY_SYSTEM_PROMPT}` };
      } else {
        llmMessages.unshift({ role: 'system', content: CAPABILITY_SYSTEM_PROMPT });
      }
    }
  }

  // ---------------------------------------- 3.3bis Agent skills (Claude.ai
  // style, two layers of progressive disclosure):
  //  1. DETERMINISTIC PRE-SELECTION: the user's own words are scored against
  //     the skill library (hint regexes + curated keywords); the 1-3
  //     clearly-matching skills are injected IN FULL into THIS turn's
  //     context before the first token — no model decision required. This
  //     is what makes "créer-moi une landing page ultra moderne" reliably
  //     load frontend-design + landing-page-creation even on weak free
  //     models that never emit the USE_SKILL marker on their own.
  //  2. MODEL-DRIVEN FALLBACK (USE_SKILL protocol): the manifest (names +
  //     descriptions only) still rides every request; if the task matches a
  //     skill the pre-selector missed, the model can begin with
  //     USE_SKILL(name) and the gates below restart with that pack injected.
  // Either way, only the matched skills' full instructions ever enter the
  // context — the rest of the library stays out.
  let skillsActive = false;
  // Skills actually loaded this turn (persisted in message meta for UI/audit).
  const usedSkills: string[] = [];
  const preSelectedNames: string[] = [];
  {
    const { getSkillManifestPrompt } = await import('@/lib/skills/registry');
    const { preselectSkills, buildPreLoadedSkillsMessage } = await import('@/lib/skills/selector');
    // rawLastUserText: the user's own words (web-search augmentation would
    // false-positive the selectors with page keywords).
    const isImageModel =
      modelId === 'stable-diffusion-xl' || modelId.startsWith('image_generation.');
    const preSelected = isImageModel ? [] : await preselectSkills(rawLastUserText);
    preSelectedNames.push(...preSelected.map((s) => s.name));
    const skillManifest = await getSkillManifestPrompt(rawLastUserText, preSelectedNames);
    if (skillManifest) {
      skillsActive = true;
      const hasSkillsPrompt = llmMessages.some(
        (m) => m.role === 'system' && m.content.includes('AGENT SKILLS')
      );
      if (!hasSkillsPrompt) {
        if (llmMessages.length && llmMessages[0].role === 'system') {
          llmMessages[0] = { role: 'system', content: `${llmMessages[0].content}\n\n---\n\n${skillManifest}` };
        } else {
          llmMessages.unshift({ role: 'system', content: skillManifest });
        }
      }
    }
    if (preSelected.length) {
      usedSkills.push(...preSelectedNames);
      // Insert right after the LAST user message — the tool-result position
      // (like Claude reading the SKILL.md after deciding it is relevant).
      // Lives only in this turn's request: never persisted into history.
      let insertAt = llmMessages.length;
      for (let i = llmMessages.length - 1; i >= 0; i--) {
        if (llmMessages[i]?.role === 'user') {
          insertAt = i + 1;
          break;
        }
      }
      llmMessages.splice(insertAt, 0, await buildPreLoadedSkillsMessage(preSelected));
      console.log(
        `[v12-flow] skills pre-selected for this turn: ${preSelected
          .map((s) => `${s.name}(${s.score})`)
          .join(', ')}`
      );
      // Visible chip per skill — the same status protocol as the USE_SKILL
      // path (the frontend renders "Skill « x » chargé").
      for (const s of preSelected) {
        const label = s.label || s.name;
        await emit({
          type: 'status',
          data: { action: 'skill', description: `Skill « ${label} » chargé`, done: false },
        });
        await emit({
          type: 'status',
          data: { action: 'skill', description: `Skill « ${label} » chargé`, done: true },
        });
      }
    }
  }

  // ------------------------------------ 3.4 Web search (explicit toggle OR auto).
  // Python middleware: features.web_search → search engine + context/citation
  // injection into the last user message. The TS port uses the built-in
  // fallback chain (DDG Lite POST → DDG HTML GET → 4get yonderly) — see
  // lib/retrieval/web-search.ts. Citations ride the final completion event
  // (`sources`) and the persisted assistant message.
  //
  // Auto engagement (TS-port extension, mirrors the original's "let the model
  // decide" engagement mode): when the toggle is OFF, a lightweight call to
  // the built-in free model decides whether the message needs fresh web data
  // (news/prices/weather/releases/…). If yes, the exact same search chain,
  // context injection and citations run — the user never has to touch the
  // globe button. Gated by `web.search.auto` (default true) and the same
  // enable/permission checks as the explicit toggle.
  const isSdModel = modelId === 'stable-diffusion-xl' || modelId.startsWith('image_generation.');
  let webCitations: any[] | null = null;
  const wantsWebSearch =
    form.features?.web_search === true &&
    form.features?.image_generation !== true &&
    !isSdModel;
  console.log('[v12-flow] features =', JSON.stringify(form.features ?? null), '| model =', modelId, '| wantsWebSearch =', wantsWebSearch);

  const lastUserContent = (): string =>
    [...llmMessages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const webSearchAllowed = async (): Promise<boolean> => {
    const { configGet } = await import('@/lib/config');
    const { hasPermission } = await import('@/lib/access-control');
    const { DEFAULT_USER_PERMISSIONS } = await import('@/lib/constants');
    const webSearchEnabled = await configGet<boolean>('web.search.enable', false);
    if (!webSearchEnabled) return false;
    if (user.role === 'admin') return true;
    const defaultPermissions = await configGet<any>('user.permissions', DEFAULT_USER_PERMISSIONS);
    return hasPermission(user.id, 'features.web_search', defaultPermissions);
  };

  /** Run the search chain + context/citation injection (shared by the
   *  explicit toggle and the auto engagement path). */
  const performWebSearch = async (query: string, runningLabel: string): Promise<void> => {
    await emit({
      type: 'status',
      data: { action: 'web_search', description: runningLabel, query, done: false },
    });
    try {
      const { configGet } = await import('@/lib/config');
      const { searchWeb, webResultsToContext, loadWebPages, loadWebImages } = await import('@/lib/retrieval/web-search');
      const resultCountRaw = await configGet<number>('web.search.result_count', 3);
      const resultCount = Math.min(10, Math.max(1, Math.floor(Number(resultCountRaw) || 3)));
      const { results } = await searchWeb(query, resultCount);
      if (results.length) {
        // Web loader (Python parity): unless bypassed, fetch the top result
        // pages and use their real content instead of the thin snippets —
        // snippets alone are just page descriptions for news/listing pages.
        // The og/twitter page images (source-card thumbnails in the Sources
        // panel, ChatGPT style) ride along in the same phase: a parallel
        // bounded fetch of every result's <head> meta tags.
        let pageTexts: Map<string, string> | undefined;
        let pageImages = new Map<string, string>();
        const bypassLoader = await configGet<boolean>('web.search.bypass_web_loader', false);
        if (!bypassLoader) {
          await emit({
            type: 'status',
            data: { action: 'web_search', description: 'Lecture des sources', query, done: false },
          });
          const loaderTimeout = await configGet<number>('web.loader.timeout', 10_000);
          const loaderConcurrent = await configGet<number>('web.loader.concurrent_requests', 5);
          const [texts, images] = await Promise.all([
            loadWebPages(results, {
              maxPages: 3,
              maxCharsPerPage: 3000,
              timeoutMs: Math.min(30_000, Math.max(3000, Number(loaderTimeout) || 10_000)),
              concurrent: Math.min(6, Math.max(1, Number(loaderConcurrent) || 3)),
            }).catch(() => undefined),
            loadWebImages(results, {
              timeoutMs: 6000,
              concurrent: 6,
            }).catch(() => new Map<string, string>()),
          ]);
          pageTexts = texts;
          if (images) pageImages = images;
        } else {
          pageImages = await loadWebImages(results, { timeoutMs: 6000, concurrent: 6 }).catch(
            () => new Map<string, string>()
          );
        }
        // Inject the sources into the last user message (Python parity).
        for (let li = llmMessages.length - 1; li >= 0; li--) {
          if (llmMessages[li].role === 'user') {
            llmMessages[li].content = `${webResultsToContext(results, pageTexts)}\n\n${llmMessages[li].content}`;
            break;
          }
        }
        // v0.12.5 citation shape (Citation.svelte + inline reference pills).
        // `metadata[0].name` is the pill label (ChatGPT Search style: the
        // domain) and `external: true` keeps the merge code from replacing
        // it with the raw URL. The full page title rides along for the
        // sources panel, and document[0] carries the excerpt.
        const hostOf = (u: string): string => {
          try {
            return new URL(u).hostname.replace(/^www\./, '');
          } catch {
            return u;
          }
        };
        webCitations = results.map((r) => {
          const domain = hostOf(r.url);
          // Excerpt: the loaded page text when it reads like prose, the
          // search-engine snippet otherwise. Some sites extract as glued
          // navigation menus ("ComparaisonMéthodologieÀ propos…") — detect
          // them by their high lower→UPPER collision rate and fall back to
          // the (always clean) engine snippet.
          let excerpt = (pageTexts?.get(r.url) || r.snippet || r.title).slice(0, 600);
          {
            const collisions = (excerpt.match(/[a-zà-ÿ][A-ZÀ-Ý]/g) ?? []).length;
            const menuScore = collisions / Math.max(1, excerpt.length / 100);
            if (menuScore > 2 && r.snippet) excerpt = r.snippet.slice(0, 600);
          }
          const image = pageImages.get(r.url);
          return {
            source: { name: domain, url: r.url },
            document: [excerpt],
            metadata: [
              {
                source: r.url,
                // metadata.name is the inline pill label (ChatGPT Search
                // style: the domain). `external` stays ABSENT on purpose:
                // the frontend's merge step then copies the URL into the
                // merged source.name, which is what makes the native
                // sources row (favicon circles + "N Sources" pill) render —
                // its filter keeps only sources whose name starts with
                // "http" (see Citation.svelte / Cuk4Euq-.js).
                name: domain,
                title: r.title || domain,
                snippet: excerpt,
                // og/twitter image — the source-card thumbnail in the
                // ChatGPT-style Sources panel.
                ...(image ? { image } : {}),
              },
            ],
          };
        });
        // Attach the sources to the in-flight assistant message BEFORE the
        // LLM starts streaming. The frontend's chat:completion event handler
        // stores `sources` on the message on ANY event (done or not — see the
        // compiled handler: `sources && !message.sources && (message.sources
        // = sources)`), so the citation tokenizer resolves [N] markers to
        // real domains and renders the inline favicon+domain pills IN REAL
        // TIME while the answer streams — no plain "[3]" text until done.
        await emit({
          type: 'chat:completion',
          data: { done: false, sources: webCitations },
        });
        // Citation instructions: the model must mark factual claims with
        // [N] / [N,M] markers referencing the numbered <source> blocks — the
        // frontend's native citation tokenizer renders them as inline
        // favicon+domain badges (see DbVOp8ZX.js / Citation.svelte).
        const hasCapabilityPrompt = llmMessages.some(
          (m) => m.role === 'system' && m.content.includes('CITATION INSTRUCTIONS')
        );
        if (!hasCapabilityPrompt) {
          const citationPrompt = `\n\n---\n\nCITATION INSTRUCTIONS (mandatory):
You have been provided with numbered web sources in <source number="N" ...> blocks.
Attach a citation marker to each factual claim that is DIRECTLY supported by these sources:
- [N] when one source supports the claim; [N,M] when several sources support the SAME claim.
- Place each marker IMMEDIATELY AFTER the specific claim it supports — this may be in the MIDDLE of a paragraph, right after a list item, or just before the sentence's final period. Never systematically close every sentence or paragraph with a marker.
- A claim with no supporting source gets NO marker (your own analysis, opinions, math and conversation summaries are not cited). Never invent sources.
- One source may support several different claims — cite it at each of them. Several sources supporting one claim merge into a single [N,M] group.
- Never write markers inside code blocks, tables' headers, or headings. Do NOT add a bibliography or source list at the end — the interface renders sources automatically.`;
          if (llmMessages.length && llmMessages[0].role === 'system') {
            llmMessages[0] = { role: 'system', content: `${llmMessages[0].content}${citationPrompt}` };
          } else {
            llmMessages.unshift({ role: 'system', content: citationPrompt.trim() });
          }
        }
        await emit({
          type: 'status',
          data: {
            action: 'web_search',
            description: `${results.length} résultats trouvés`,
            query,
            urls: results.map((r) => r.url),
            done: true,
          },
        });
      }
    } catch (e) {
      console.error('[v12-flow] web search failed', e);
      await emit({
        type: 'status',
        data: { action: 'web_search', description: 'Recherche web indisponible', query, done: true },
      });
    }
  };

  if (wantsWebSearch) {
    if (await webSearchAllowed()) {
      const query = lastUserContent();
      if (query) await performWebSearch(query, 'Recherche web en cours');
    }
  } else if (!isSdModel && form.features?.image_generation !== true) {
    // ---- Auto engagement: the model decides, the user doesn't have to. ----
    const { configGet } = await import('@/lib/config');
    const autoEnabled = await configGet<boolean>('web.search.auto', true);
    if (autoEnabled && (await webSearchAllowed())) {
      const query = lastUserContent();
      if (query) {
        const { decideAutoWebSearch } = await import('@/lib/chat/auto-web-search');
        const decision = await decideAutoWebSearch(llmMessages);
        console.log(
          '[v12-flow] auto web search decision =',
          decision ? JSON.stringify(decision) : 'null (no decision)'
        );
        if (decision?.search && decision.query) {
          // Same status label as the explicit toggle — the user shouldn't be
          // able to tell an auto engagement apart from a manual one.
          await performWebSearch(decision.query, 'Recherche web en cours');
        }
      }
    }
  }

  // ------------------------------------ 3.5 Image generation (features toggle /
  // built-in SD model). Python main.py: features.image_generation →
  // generate_image + __event_emitter__ chat:message:files; the TS port adds
  // the built-in `stable-diffusion-xl` model that routes here directly.
  const wantsImageGeneration = form.features?.image_generation === true || isSdModel;
  if (wantsImageGeneration) {
    const { configGet } = await import('@/lib/config');
    const { ERROR_MESSAGES } = await import('@/lib/constants');
    const enabled = await configGet<boolean>('image_generation.enable', true);
    if (!enabled) {
      if (sessionId && chatId) {
        await emit({ type: 'chat:message:error', data: { error: { content: ERROR_MESSAGES.ACCESS_PROHIBITED }, done: true } });
        return nullJson();
      }
      return json({ detail: ERROR_MESSAGES.ACCESS_PROHIBITED }, 403);
    }

    const prompt = [...llmMessages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // Image→image: when this turn's user message carries image attachments,
    // they become the sources of the multipart image-to-image Nelthai job
    // (JSON bodies are rejected by that endpoint — sources ride as multipart
    // file parts, see lib/imagine/nelthai.ts).
    let sourceImages: import('@/lib/imagine/nelthai').NelthaiImageSource[] = [];
    try {
      const { resolveImageSources } = await import('@/lib/image-generation');
      const lastFormMessage = Array.isArray(form.messages) ? form.messages[form.messages.length - 1] : null;
      const attached = [
        ...(Array.isArray(userMessage?.files) ? userMessage.files : []),
        ...(Array.isArray(lastFormMessage?.files) ? lastFormMessage.files : []),
      ];
      sourceImages = await resolveImageSources(attached);
    } catch {
      /* attachments unreadable → plain text→image */
    }
    if (sourceImages.length) {
      console.log(`[v12-flow] image-to-image with ${sourceImages.length} source image(s)`);
    }

    // Live phase label: the status row text cycles through the Nelthai job
    // phases — 'Generating image…' at submit, then 'Generating image ·
    // sending | generating | image' on every phase change (the generating
    // card in the UI parses the suffix as its live label).
    const imagePhaseStatus = (phase: string | null) =>
      emit({
        type: 'status',
        data: {
          action: 'image_generation',
          description: phase ? `Generating image · ${phase}` : 'Generating image…',
          done: false,
        },
      });
    await imagePhaseStatus(null);
    try {
      const { generateAndSaveImage } = await import('@/lib/image-generation');
      const size = await configGet<string>('image_generation.size', '1024x1024');
      const file = await generateAndSaveImage(user, prompt, size, { chat_id: chatId }, {
        onPhase: (phase) => {
          void imagePhaseStatus(phase);
        },
        sourceImages,
      });
      const files = [{ type: 'image', url: file.url, name: file.name }];

      await emit({ type: 'chat:message:files', data: { files } });

      if (isSavedChatId(chatId) && assistantMessageId) {
        await upsertMessageToChatByIdAndMessageId(chatId, assistantMessageId, {
          parentId: userMessageId,
          role: 'assistant',
          content: '',
          done: true,
          model: modelId,
          files,
          meta: { response_ended_at: nowSec() },
        } as any);
      }

      // Title from the prompt (no task model configured for image-only chats).
      if (isSavedChatId(chatId) && backgroundTasks.title_generation && !isTemporaryChatId(chatId)) {
        const chat = await getChatById(chatId);
        if (chat && (chat.title === 'New Chat' || !chat.title)) {
          const title = prompt.trim().slice(0, 100) || 'Image';
          await updateChatById(chatId, { title });
          await emit({ type: 'chat:title', data: title });
        }
      }

      await emit({ type: 'chat:completion', data: { done: true, content: '' } });
      await emit({ type: 'chat:list', data: { chat_id: chatId, folder_id: form.folder_id ?? null } });
      await emit({ type: 'status', data: { done: true } });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error('[v12-flow] image generation failed', e);
      if (sessionId && chatId) {
        await emit({ type: 'chat:message:error', data: { error: { content: detail }, done: true } });
        return nullJson();
      }
      return json({ detail }, 400);
    }
    return nullJson();
  }

  // --------------------------------------------------- 4. Resolve and call
  const { resolveModelRoute } = await import('@/lib/models-registry');
  const {
    isKiloModel,
    kiloModelWantsThinking,
    kiloAvailable,
    KILO_GATEWAY_BASE_URL,
    KILO_GATEWAY_API_KEY,
    KILO_REASONING_MODEL_ID,
  } = await import('@/lib/kilo-llm');
  const isKilo = isKiloModel(modelId);
  if (isKilo && !kiloAvailable()) {
    return json({ detail: `Model ${modelId} not found (Kilo gateway not configured)` }, 404);
  }
  const route: ModelRoute | null = isKilo
    ? { type: 'openai', model: modelId, baseUrl: KILO_GATEWAY_BASE_URL, apiKey: KILO_GATEWAY_API_KEY }
    : await resolveModelRoute(modelId);
  if (!route) {
    return json(
      { detail: `Model ${modelId} not found` },
      404
    );
  }

  const params = form.params ?? {};
  const reqBody: Record<string, any> = {
    model: route.model,
    messages: llmMessages,
    stream: form.stream ?? false,
  };
  for (const key of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'stop', 'seed']) {
    const v = (params as any)[key] ?? (form as any)[key];
    if (v !== undefined && v !== null) reqBody[key] = v;
  }
  if (form.stream === true) {
    reqBody.stream_options = { ...(reqBody.stream_options ?? {}), include_usage: true };
  }
  if (isKilo) {
    // OpenRouter-style reasoning controls: the thinking model streams its
    // chain-of-thought in `delta.reasoning`; the standard model keeps it off.
    const thinking = kiloModelWantsThinking(modelId);
    reqBody.reasoning = { enabled: thinking };
    reqBody.include_reasoning = thinking;
  }

  let url: string;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (route.type === 'openai') {
    url = `${route.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    if (route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
  } else {
    url = `${route.baseUrl}/api/chat`;
    reqBody.options = {
      temperature: reqBody.temperature,
      top_p: reqBody.top_p,
      num_predict: reqBody.max_tokens,
      presence_penalty: reqBody.presence_penalty,
      frequency_penalty: reqBody.frequency_penalty,
      stop: reqBody.stop,
      seed: reqBody.seed,
    };
    for (const k of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'stop', 'seed']) {
      delete reqBody[k];
    }
  }

  // Task tracking (TaskManager port): the ORIGINAL frontend polls
  // GET /api/tasks/chat/{chat_id} and stops generation through
  // POST /api/tasks/chat/{chat_id}/stop — the controller below makes `stop`
  // abort this very fetch.
  const { registerTask, completeTask } = await import('@/lib/task-manager');
  const task = registerTask({
    userId: user.id,
    chatId: chatId || '',
    messageId: assistantMessageId,
    model: modelId,
  });
  const taskSignal = task.controller.signal;
  const finishTask = () => completeTask(task.id);

  // Shared upstream caller (flow scope): used by pass 1 AND the agent-skill
  // pass 2 (runStreamBody / the SSE API path re-call it with the injected
  // skill messages).
  const timeoutSignal = AbortSignal.timeout(600_000);
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, taskSignal]) : timeoutSignal;
  const callUpstream = (body: Record<string, any>) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

  let upstream: Response;
  /** Request-send timestamp — anchors the thinking duration (Kilo-style
   *  gateways buffer the whole chain-of-thought server-side; without this
   *  anchor the measured span is ~0s → "Thought for less than a second"). */
  const upstreamStartedAt = Date.now();
  try {
    upstream = await callUpstream(reqBody);

    // Provider flakiness guard (observed on the free dots-studio model with
    // web-search context): the gateway SOMETIMES answers 400 "bad request"
    // from the upstream provider although the request is perfectly valid —
    // the same body succeeds on a retry and the built-in reasoning model
    // handles these large payloads reliably. One retry on the same model,
    // then a transparent fallback to the reasoning model, so the answer (and
    // its citations) always reach the user instead of a dead error bubble.
    if (isKilo && upstream.status === 400) {
      const probe = await upstream.clone().text().catch(() => '');
      if (/bad request|Provider returned error/i.test(probe)) {
        console.warn('[v12-flow] gateway 400 provider flake — retrying the same model');
        upstream = await callUpstream(reqBody);
        if (upstream.status === 400) {
          const probe2 = await upstream.clone().text().catch(() => '');
          if (/bad request|Provider returned error/i.test(probe2) && modelId !== KILO_REASONING_MODEL_ID) {
            console.warn('[v12-flow] gateway 400 persists — falling back to the built-in reasoning model');
            upstream = await callUpstream({
              ...reqBody,
              model: KILO_REASONING_MODEL_ID,
              reasoning: { enabled: true },
              include_reasoning: true,
            });
          }
        }
      }
    }
  } catch (e) {
    finishTask();
    if (taskSignal.aborted) {
      // User pressed stop — mirror the original behavior: the generation is
      // cancelled, the partial assistant message stays as-is.
      if (sessionId && chatId) {
        await emit({
          type: 'chat:completion',
          data: { done: true, content: '', status: 'aborted' },
        });
        return nullJson();
      }
      return json({ detail: 'Task aborted' }, 499);
    }
    const detail = e instanceof Error ? e.message : 'Connection error';
    if (sessionId && chatId) {
      await emit({ type: 'chat:message:error', data: { error: { content: detail }, done: true } });
      return nullJson();
    }
    return json({ detail }, 502);
  }

  if (!upstream.ok) {
    finishTask();
    const errText = await upstream.text().catch(() => '');
    if (sessionId && chatId) {
      await emit({
        type: 'chat:message:error',
        data: { error: { content: errText.slice(0, 500) || `Upstream error ${upstream.status}` }, done: true },
      });
      return nullJson();
    }
    return new Response(errText || JSON.stringify({ detail: `Upstream error ${upstream.status}` }), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Title generation — Python background_tasks parity, hardened for
  // serverless: on hosts that hard-kill functions at a max duration (Vercel:
  // 60s by default), a post-stream title call never runs — the chat would
  // stay "New Chat" forever (observed in production: every long landing-page
  // generation killed at exactly 60.3s, title never generated). Kicked off
  // here — concurrent with the main generation, completes in seconds — it
  // always lands in time. Gated on the chat still being untitled so
  // follow-up turns never churn an existing title.
  const titlePromise: Promise<string | null> = (async () => {
    if (!isSavedChatId(chatId) || !backgroundTasks.title_generation || isTemporaryChatId(chatId)) {
      return null;
    }
    try {
      const chat = await getChatById(chatId);
      if (chat && chat.title !== 'New Chat' && chat.title) return null;
      const title = await generateChatTitle(route, llmMessages);
      if (title) {
        await updateChatById(chatId, { title });
        await emit({ type: 'chat:title', data: title });
        return title;
      }
    } catch {
      /* best-effort */
    }
    return null;
  })();

  const persistAssistant = async (
    content: string,
    usage: any,
    done = true,
    output?: any[] | null,
    files?: any[] | null,
    rawContent?: string | null
  ) => {
    if (!isSavedChatId(chatId) || !assistantMessageId) return;
    // rawContent: the full generated text BEFORE document-block extraction
    // (```document … → downloadable file cards). `content` is the processed
    // text the UI shows (blocks replaced by "📎 …" markers). meta.llm_content
    // keeps the raw text so the NEXT turn's LLM context still contains the
    // code/documents the model produced — see messageContent().
    const llmContent =
      rawContent && rawContent.trim() && rawContent !== content ? rawContent.slice(0, 100_000) : null;
    await upsertMessageToChatByIdAndMessageId(chatId, assistantMessageId, {
      parentId: userMessageId,
      role: 'assistant',
      content,
      done,
      model: modelId,
      ...(output && output.length ? { output } : {}),
      ...(usage ? { usage } : {}),
      ...(files && files.length ? { files } : {}),
      ...(webCitations ? { sources: webCitations } : {}),
      ...(done || llmContent || usedSkills.length
        ? {
            meta: {
              ...(done ? { response_ended_at: nowSec() } : {}),
              ...(llmContent ? { llm_content: llmContent } : {}),
              ...(usedSkills.length ? { used_skills: usedSkills } : {}),
            },
          }
        : {}),
    });
  };

  // Document generation (TS-port extension, ChatGPT-like file output):
  // ```document filename="..." blocks in the completed content are converted
  // into real downloadable files (pdf/docx/xlsx/html/md/txt/csv/json) attached
  // to the assistant message. Returns the cleaned content + generated files.
  // Content WITHOUT blocks still passes through sanitizeInventedDownloadLinks:
  // models sometimes answer a file request with a fabricated download URL
  // (e.g. https://www.nelth-ai.com/export/excel/x.xlsx — unregistered domain,
  // user gets DNS_PROBE_FINISHED_NXDOMAIN) instead of a document block.
/**
   * Citation-marker hygiene for the final assistant content.
   *
   * The native frontend tokenizer turns [N] / [N,M] markers into inline
   * favicon+domain badges when message.sources exists. This keeps the markers
   * honest: ids outside the actual source range are dropped (per-id), groups
   * that end up empty disappear, and when NO web sources were collected every
   * marker is stripped (a hallucinated [2] on a plain answer would otherwise
   * render as a dead badge).
   */
  const sanitizeCitationMarkers = (content: string): string => {
    const count = webCitations?.length ?? 0;
    if (!/\[\d/.test(content)) return content;
    return content.replace(/(\[\d+(?:\s*,\s*\d+)*\])(?!\()/g, (_full, group: string) => {
      if (!count) return '';
      const ids = group
        .slice(1, -1)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= count);
      if (!ids.length) return '';
      const unique = [...new Set(ids)];
      return `[${unique.join(',')}]`;
    });
  };

  // File-generation intent gate: see rawLastUserText above — computed from
  // the RAW user question (before web-search augmentation). processGenerated
  // Documents only extracts file blocks when userAskedForFile.
  const processGeneratedDocuments = async (
    content: string
  ): Promise<{ content: string; files: any[] }> => {
    let safeContent = content;
    try {
      const { extractDocumentBlocks, generateDocumentFiles, sanitizeInventedDownloadLinks } =
        await import('@/lib/document-generation');
      const { blocks, stripped } = extractDocumentBlocks(safeContent, {
        extract: userAskedForFile,
      });
      if (!blocks.length) {
        // No document block extracted (none emitted, or no explicit user
        // request → blocks kept inline) — at least strip hallucinated links.
        safeContent = sanitizeInventedDownloadLinks(
          userAskedForFile ? safeContent : stripped
        );
        return { content: sanitizeCitationMarkers(safeContent), files: [] };
      }
      const files = await generateDocumentFiles(user, blocks, {
        chat_id: chatId || undefined,
        message_id: assistantMessageId ?? undefined,
        model: modelId,
      });
      if (!files.length) {
        return { content: sanitizeCitationMarkers(stripped), files: [] };
      }
      return { content: sanitizeCitationMarkers(stripped), files };
    } catch (e) {
      console.error('[v12-flow] document generation failed', e);
      return { content: safeContent, files: [] };
    }
  };

  // ------------------------------------------------------- 5a. Non-streaming
  if (!(form.stream ?? false)) {
    let data: any;
    if (route.type === 'openai') {
      data = await upstream.json();
    } else {
      // ollama non-stream JSON
      data = await upstream.json();
      data = {
        id: crypto.randomUUID(),
        object: 'chat.completion',
        created: nowSec(),
        model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: data?.message?.content ?? '' }, finish_reason: 'stop' }],
      };
    }
    let content = data?.choices?.[0]?.message?.content ?? '';

    // Agent skills lazy-loading (non-streaming): a leading USE_SKILL(name)
    // marker restarts the completion with that pack's instructions injected —
    // same protocol as the streaming gate in 5b.
    if (skillsActive && content) {
      const { SKILL_MARKER_RE, getSkillByName, buildSkillInjectionMessages, stripSkillMarkers } =
        await import('@/lib/skills/registry');
      const m = SKILL_MARKER_RE.exec(content);
      if (m) {
        const skill = getSkillByName(m[1]);
        if (skill && !usedSkills.includes(skill.name)) {
          usedSkills.push(skill.name);
          await emit({
            type: 'status',
            data: { action: 'skill', description: `Skill « ${skill.label || skill.name} » chargé`, done: false },
          });
          try {
            const res2 = await callUpstream({
              ...reqBody,
              messages: await buildSkillInjectionMessages(llmMessages, skill),
            });
            if (res2.ok) {
              const data2 = await res2.json();
              const content2 =
                (route.type === 'openai'
                  ? data2?.choices?.[0]?.message?.content
                  : data2?.message?.content) ?? '';
              if (content2) {
                content = content2;
                if (data2?.choices?.[0]?.message) data = data2;
              }
            }
          } catch (e) {
            console.error('[v12-flow] skill pass-2 failed', e);
          }
          await emit({
            type: 'status',
            data: { action: 'skill', description: `Skill « ${skill.label || skill.name} » chargé`, done: true },
          });
        } else if (skill) {
          // Pre-selected skill — its instructions are already in context, so
          // pass-1 was generated WITH the skill loaded: keep the content, the
          // marker is stripped just below.
          console.log(`[v12-flow] skill marker for already-loaded "${skill.name}" — keeping pass-1 content`);
        }
      }
      content = stripSkillMarkers(content);
    }

    // Reasoning tags → structured output items (frontend collapsible block).
    let reasoningOutput = parseCompleteOutput(content);
    if (reasoningOutput.length) {
      content = stripReasoningTags(content);
      if (data?.choices?.[0]?.message) data.choices[0].message.content = content;
      data.output = reasoningOutput;
    } else {
      // Native reasoning (Kilo gateway & OpenRouter-style providers): the
      // chain-of-thought arrives in `message.reasoning`, separate from the
      // content → structured output items.
      const native = data?.choices?.[0]?.message?.reasoning;
      if (typeof native === 'string' && native.trim()) {
        // Anchor: reasoning started when the request was sent (the gateway
        // buffered the chain-of-thought server-side), ended when the complete
        // response arrived.
        reasoningOutput = nativeReasoningOutputItems(native, content, upstreamStartedAt, Date.now());
        if (reasoningOutput.length) {
          data.output = reasoningOutput;
          if (data?.choices?.[0]?.message) {
            delete data.choices[0].message.reasoning;
            delete data.choices[0].message.reasoning_details;
          }
        }
      }
    }
    // Document blocks → downloadable file cards on the assistant message.
    const rawContent = content;
    const docResult = await processGeneratedDocuments(content);
    content = docResult.content;
    if (data?.choices?.[0]?.message) data.choices[0].message.content = content;
    if (docResult.files.length) data.files = docResult.files;

    await persistAssistant(
      content,
      data?.usage ?? null,
      true,
      reasoningOutput.length ? reasoningOutput : null,
      docResult.files.length ? docResult.files : null,
      rawContent
    );
    if (sessionId && chatId) {
      if (docResult.files.length) {
        await emit({ type: 'chat:message:files', data: { files: docResult.files } });
      }
      await emit({
        type: 'chat:completion',
        data: {
          ...data,
          done: true,
          ...(webCitations ? { sources: webCitations } : {}),
        },
      });
    }
    finishTask();
    await titlePromise; // emitted early (chat:title) — make sure it settled

    // API clients (no session): surface the citations on the JSON body too —
    // the UI flow receives them through the chat:completion socket event.
    return json({ ...data, ...(webCitations ? { sources: webCitations } : {}) });
  }

  // --------------------------------------- 5b. Streaming + session (UI flow)
  if (sessionId) {
    const runStreamBody = async (): Promise<Response> => {
    const completionId = crypto.randomUUID();
    let aggregate = '';
    let usage: any = null;

    // Reasoning tag detection (Python tag_output_handler port): plain-choices
    // deltas until a tag appears, then structured `output` snapshots.
    const reasoning = new ReasoningAccumulator();
    let lastStructuredEmit = 0;
    const emitStructured = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastStructuredEmit < 120) return;
      lastStructuredEmit = now;
      const output = reasoning.snapshot(now);
      if (output.length) {
        await emit({
          type: 'chat:completion',
          data: { id: completionId, done: false, output },
        });
      }
    };

    // Native reasoning channel (Kilo gateway / OpenRouter-style providers):
    // `delta.reasoning` carries the chain-of-thought separately from the
    // content — full structured `output` snapshots from the first chunk on.
    const nativeReasoning = new NativeReasoningAccumulator();
    let lastNativeEmit = 0;
    const emitNative = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastNativeEmit < 120) return;
      lastNativeEmit = now;
      const output = nativeReasoning.snapshot(now);
      if (output.length) {
        await emit({
          type: 'chat:completion',
          data: { id: completionId, done: false, output },
        });
      }
    };

    // Thinking-phase UX (Kilo-style gateways buffer the whole chain-of-thought
    // server-side — verified live: the entire reasoning arrives in one burst
    // at the exact moment the content starts): announce the block immediately
    // so the user sees "Thinking…" during the silent phase instead of staring
    // at nothing, and anchor the duration to the request send so the final
    // "Réflexion pendant N secondes" reflects the real thinking time.
    if (isKilo && reqBody.reasoning?.enabled === true) {
      nativeReasoning.announceThinking(upstreamStartedAt);
      await emitNative(true);
    }

    // Paced reveal driver: when the reasoning burst lands, re-emit it
    // progressively (~1-1.5s) so the user watches the thinking text type out
    // o1-style instead of a block that fills in a single frame. Incremental
    // providers are unaffected — the reveal catches up with the buffer within
    // a tick or two. The interval self-stops once the reveal is complete; the
    // transport wrappers guarantee it is cleared on exit.
    const startRevealTicker = () => {
      if (revealTimerHandle !== null) return;
      revealTimerHandle = setInterval(() => {
        if (!nativeReasoning.revealPending) {
          stopRevealTicker();
          return;
        }
        nativeReasoning.advanceReveal();
        emitNative(true).catch(() => {});
      }, 90);
    };

    // Incremental persistence (serverless hardening): hosts that hard-kill
    // functions at a max duration (Vercel 60s by default) never reach the
    // final persist below — the streamed answer the user just WATCHED for a
    // minute would vanish from the DB, and the next turn's LLM context loses
    // the model's own code entirely (production repro: assistant message
    // stayed done:false / content:'' after a 60.3s kill → next turn the model
    // re-announced "Voici la version claire…" without the code). Checkpoint
    // the partial content every few seconds with done:false so an
    // interrupted generation leaves its trace: reload shows the partial
    // answer, and turn N+1's context includes what was produced.
    let lastCheckpoint = 0;
    const CHECKPOINT_INTERVAL_MS = 5000;
    const checkpointPartial = async (): Promise<void> => {
      if (!isSavedChatId(chatId) || !assistantMessageId) return;
      let partial = aggregate;
      try {
        if (nativeReasoning.active) {
          partial = getOutputText(nativeReasoning.snapshot(Date.now()) as any) || aggregate;
        } else {
          const snap = reasoning.snapshot(Date.now()) as any;
          partial = getOutputText(snap) || aggregate;
        }
      } catch {
        partial = aggregate;
      }
      if (!partial.trim()) return;
      try {
        await upsertMessageToChatByIdAndMessageId(chatId, assistantMessageId, {
          parentId: userMessageId,
          role: 'assistant',
          content: partial,
          done: false,
          model: modelId,
          // Skills used this turn ride the checkpoints too — a serverless
          // kill mid-generation still leaves the audit trail in meta.
          ...(usedSkills.length ? { meta: { used_skills: usedSkills } } : {}),
        } as any);
      } catch {
        /* best-effort checkpoint */
      }
    };

    // Agent-skills streaming gate (lazy loading): holds the FIRST tokens —
    // content and reasoning alike — until the USE_SKILL decision is known:
    //   marker found → pass 1 stops, the pack's full instructions are injected
    //                 and the completion restarts (pass-2 block below); the
    //                 user only sees a status chip, never the marker.
    //   no marker   → the buffered tokens are released through the normal
    //                 machinery and the answer streams as usual.
    let skillGate: import('@/lib/skills/registry').SkillGate | null = null;
    if (skillsActive) {
      const { SkillGate, skillNames } = await import('@/lib/skills/registry');
      // Pre-selected skills are excluded from the gate's valid names: if the
      // model still opens with USE_SKILL(<pre-selected>), the marker is
      // treated as unknown → stripped, and the pass continues seamlessly
      // (the skill is already in context — no restart, no double injection).
      const selectable = new Set(
        [...skillNames()].filter((n) => !preSelectedNames.includes(n))
      );
      skillGate = new SkillGate(selectable);
    }

    const processReasoningDelta = async (reasoningDelta: string): Promise<void> => {
      const wasActive = nativeReasoning.active;
      nativeReasoning.pushReasoning(reasoningDelta);
      // Burst detected (hidden text pending) → drive the paced reveal; the
      // first slice is revealed immediately so the switch frame already
      // shows text instead of an empty block.
      if (nativeReasoning.revealPending) {
        nativeReasoning.advanceReveal();
        startRevealTicker();
      }
      await emitNative(!wasActive); // first chunk → force the switch
    };

    const processContentDelta = async (delta: string): Promise<void> => {
      aggregate += delta;
      if (nativeReasoning.active) {
        // Structured snapshots only (plain deltas would double-append).
        nativeReasoning.pushContent(delta);
        // Safety: content pushes also advance the paced reveal — the reveal
        // must never stall behind a starved timer (tab throttling, freeze).
        if (nativeReasoning.revealPending) nativeReasoning.advanceReveal();
        await emitNative();
      } else {
        if (nativeReasoning.announced) {
          // Reasoning never arrived (unexpected on a thinking model) — retract
          // the synthetic "Thinking…" placeholder: an empty-output event
          // clears D.output on the frontend, then plain deltas resume.
          nativeReasoning.clearAnnouncement();
          await emit({
            type: 'chat:completion',
            data: { id: completionId, done: false, output: [] },
          });
        }
        const r = reasoning.push(delta);
        if (r.mode === 'structured') {
          // Full-output snapshots only (plain deltas would double-append).
          if (r.switched) {
            lastStructuredEmit = 0;
            await emitStructured(true);
          } else {
            await emitStructured();
          }
        } else if (r.plainDelta) {
          await emit({
            type: 'chat:completion',
            data: {
              id: completionId,
              done: false,
              choices: [{ index: 0, delta: { content: r.plainDelta } }],
            },
          });
        }
      }
    };

    const handleUpstreamLine = async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payloadStr = trimmed.slice(5).trim();
      if (!payloadStr || payloadStr === '[DONE]') return;
      let obj: any;
      try {
        obj = JSON.parse(payloadStr);
      } catch {
        return;
      }
      if (route.type === 'openai') {
        if (obj?.usage) usage = obj.usage;
        const delta: string = obj?.choices?.[0]?.delta?.content ?? '';
        const reasoningDelta: string =
          (typeof obj?.choices?.[0]?.delta?.reasoning === 'string'
            ? obj.choices[0].delta.reasoning
            : '') ||
          (typeof obj?.choices?.[0]?.delta?.reasoning_content === 'string'
            ? obj.choices[0].delta.reasoning_content
            : '');
        if (reasoningDelta) {
          if (skillGate && !skillGate.decided) {
            skillGate.pendingReasoning += reasoningDelta;
          } else {
            await processReasoningDelta(reasoningDelta);
          }
        }
        if (delta) {
          if (skillGate && !skillGate.decided) {
            const action = skillGate.push(delta);
            if (action === 'plain') {
              // Marker definitively absent → release the held prefix
              // (buffered reasoning first, then content) and stream on.
              const pending = skillGate.pendingReasoning;
              skillGate.pendingReasoning = '';
              if (pending) await processReasoningDelta(pending);
              const flush = skillGate.flushPlain();
              if (flush) await processContentDelta(flush);
            }
            // 'skill' → restart flagged (the pass-2 block takes over);
            // 'buffered' → keep holding, nothing user-visible yet.
          } else if (!skillGate?.restart) {
            await processContentDelta(delta);
          }
          // skillGate.restart → swallow the rest of pass 1.
        }
      } else {
        // ollama NDJSON line (no gate — local models)
        const content: string = obj?.message?.content ?? '';
        if (obj?.done) usage = obj;
        if (content) {
          aggregate += content;
          const r = reasoning.push(content);
          if (r.mode === 'structured') {
            if (r.switched) {
              lastStructuredEmit = 0;
              await emitStructured(true);
            } else {
              await emitStructured();
            }
          } else if (r.plainDelta) {
            await emit({
              type: 'chat:completion',
              data: {
                id: completionId,
                done: false,
                choices: [{ index: 0, delta: { content: r.plainDelta } }],
              },
            });
          }
        }
      }
    };

    const consumeUpstream = async (response: Response): Promise<'completed' | 'restarted'> => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            await handleUpstreamLine(line);
            if (skillGate?.restart) return 'restarted';
          }
          // No checkpoint while the gate is undecided — the held prefix may
          // be a USE_SKILL marker (not user-visible content).
          if (
            Date.now() - lastCheckpoint >= CHECKPOINT_INTERVAL_MS &&
            !(skillGate && !skillGate.decided)
          ) {
            lastCheckpoint = Date.now();
            await checkpointPartial();
          }
        }
        if (buffer.trim()) await handleUpstreamLine(buffer);
      } catch (e) {
        if (skillGate?.restart) return 'restarted';
        if (taskSignal.aborted) {
          // User pressed Stop: keep the partial assistant message, no error
          // banner (matches the original behavior — the frontend marks the
          // message done from the stop flow itself).
          console.log('[v12-flow] generation aborted by user');
        } else {
          console.error('[v12-flow] stream error', e);
          await emit({
            type: 'chat:message:error',
            data: { error: { content: 'Chat completion stream failed' }, done: true },
          });
        }
        return 'completed';
      }
      return 'completed';
    };

    // Pass 1 (gated). A USE_SKILL(name) first line restarts the completion
    // with that ONE pack's full instructions injected after the model's own
    // marker message — a tool-call round trip. The 19 other packs never
    // enter the context (Claude.ai-style lazy loading).
    const pass1 = await consumeUpstream(upstream);
    // Stream ended before the gate could decide (very short answer, no
    // marker): release the held tokens through the normal machinery.
    if (pass1 === 'completed' && skillGate && !skillGate.decided) {
      const pending = skillGate.pendingReasoning;
      skillGate.pendingReasoning = '';
      if (pending) await processReasoningDelta(pending);
      const flush = skillGate.flushPlain();
      if (flush) await processContentDelta(flush);
    }
    if (pass1 === 'restarted' && skillGate?.skillName) {
      const { getSkillByName, buildSkillInjectionMessages } = await import('@/lib/skills/registry');
      const skill = getSkillByName(skillGate.skillName);
      if (skill) {
        usedSkills.push(skill.name);
        try {
          await upstream.body?.cancel();
        } catch {
          /* pass 1 already ending */
        }
        const skillLabel = skill.label || skill.name;
        await emit({
          type: 'status',
          data: { action: 'skill', description: `Skill « ${skillLabel} » chargé`, done: false },
        });
        try {
          let res2 = await callUpstream({
            ...reqBody,
            messages: await buildSkillInjectionMessages(llmMessages, skill),
          });
          if (isKilo && res2.status === 400) {
            const probe = await res2.clone().text().catch(() => '');
            if (/bad request|Provider returned error/i.test(probe)) {
              console.warn('[v12-flow] skill pass-2 gateway 400 flake — retrying');
              res2 = await callUpstream({
                ...reqBody,
                messages: await buildSkillInjectionMessages(llmMessages, skill),
              });
            }
          }
          if (!res2.ok) {
            const errText = await res2.text().catch(() => '');
            await emit({
              type: 'chat:message:error',
              data: { error: { content: errText.slice(0, 500) || `Upstream error ${res2.status}` }, done: true },
            });
            await persistAssistant(aggregate, usage, true, null, null, null);
            finishTask();
            await titlePromise;
            return nullJson();
          }
          skillGate = null; // pass 2 streams freely (no gate)
          await consumeUpstream(res2);
        } catch (e) {
          if (!taskSignal.aborted) {
            console.error('[v12-flow] skill pass-2 failed', e);
            await emit({
              type: 'chat:message:error',
              data: { error: { content: 'Chat completion stream failed' }, done: true },
            });
          }
        } finally {
          await emit({
            type: 'status',
            data: { action: 'skill', description: `Skill « ${skillLabel} » chargé`, done: true },
          });
        }
      }
    }

    // Final reasoning snapshot (closes open reasoning items with duration).
    const nativeFinish = nativeReasoning.finish();
    if (nativeReasoning.announced && !nativeFinish.usedStructured) {
      // No reasoning ever arrived (empty response on a thinking model) —
      // retract the synthetic placeholder so the finished message never
      // keeps a stuck "Thinking…" block.
      nativeReasoning.clearAnnouncement();
      await emit({
        type: 'chat:completion',
        data: { id: completionId, done: false, output: [] },
      });
    }
    let finalOutput: any[] | null;
    let finalContent: string;
    if (nativeFinish.usedStructured) {
      finalOutput = nativeFinish.output;
      finalContent = nativeFinish.content;
    } else {
      const finalReasoning = reasoning.finish();
      finalOutput = finalReasoning.usedStructured ? finalReasoning.output : null;
      finalContent = finalReasoning.usedStructured ? finalReasoning.content : aggregate;
    }

    // Agent-skill marker hygiene: the gate consumed the leading USE_SKILL
    // marker; strip any late/mid-text leak so neither the UI nor the next
    // turn's LLM context ever sees the protocol.
    if (finalContent.includes('USE_SKILL')) {
      const { stripSkillMarkers } = await import('@/lib/skills/registry');
      finalContent = stripSkillMarkers(finalContent);
    }

    // Document blocks → downloadable file cards (before the final completion
    // event so the cards render together with the finished message).
    const rawFinalContent = finalContent;
    const docResult = await processGeneratedDocuments(finalContent);
    finalContent = docResult.content;
    if (finalOutput?.length) {
      // Keep structured output items in sync with the cleaned content.
      finalOutput = finalOutput.map((item: any) =>
        item && item.type === 'text' && typeof item.content === 'string'
          ? { ...item, content: finalContent }
          : item
      );
    }
    if (docResult.files.length) {
      await emit({ type: 'chat:message:files', data: { files: docResult.files } });
    }

    await persistAssistant(
      finalContent,
      usage,
      true,
      finalOutput,
      docResult.files.length ? docResult.files : null,
      rawFinalContent
    );
    finishTask();

    // Title generation ran EARLY (concurrently with the stream — see
    // titlePromise above): it survives serverless function kills and never
    // churns an existing title. Just await it so the done event can carry it.
    const title = await titlePromise;

    await emit({
      type: 'chat:completion',
      data: {
        done: true,
        ...(finalOutput
          ? { output: finalOutput, content: finalContent }
          : { content: finalContent }),
        ...(docResult.files.length ? { files: docResult.files } : {}),
        ...(title ? { title } : {}),
        ...(usage ? { usage } : {}),
        ...(webCitations ? { sources: webCitations } : {}),
      },
    });
    await emit({ type: 'chat:list', data: { chat_id: chatId, folder_id: form.folder_id ?? null } });

    return nullJson();
    };

    return await runStreamBody();
  }

  // ------------------------- 5c. Streaming, no session (API clients): SSE out
  const encoder = new TextEncoder();
  let aggregate = '';
  let usage: any = null;
  let lastSseCheckpoint = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      try {
        // Agent-skills gate for API clients (same lazy loading as the UI
        // flow 5b): the first tokens are held until USE_SKILL(name) is
        // confirmed absent; a marker restarts the completion with the pack's
        // instructions injected, and pass 2 streams out instead.
        let gate: import('@/lib/skills/registry').SkillGate | null = null;
        if (skillsActive) {
          const { SkillGate, skillNames } = await import('@/lib/skills/registry');
          gate = new SkillGate(skillNames());
        }
        let pendingRaw = '';
        let restartName: string | null = null;

        const consumePass = async (response: Response): Promise<'completed' | 'restarted'> => {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return 'completed';
            const text = decoder.decode(value, { stream: true });
            // Incremental persistence — same serverless hardening as the UI
            // flow (5b): checkpoint the partial content so a function kill
            // leaves the generated text in the DB instead of nothing.
            if (
              isSavedChatId(chatId) &&
              assistantMessageId &&
              aggregate.trim() &&
              !(gate && !gate.decided) &&
              Date.now() - lastSseCheckpoint >= 5000
            ) {
              lastSseCheckpoint = Date.now();
              try {
                await upsertMessageToChatByIdAndMessageId(chatId, assistantMessageId, {
                  parentId: userMessageId,
                  role: 'assistant',
                  content: aggregate,
                  done: false,
                  model: modelId,
                  // Skills audit trail on checkpoints (serverless kills).
                  ...(usedSkills.length ? { meta: { used_skills: usedSkills } } : {}),
                } as any);
              } catch {
                /* best-effort checkpoint */
              }
            }
            if (route.type === 'openai') {
              let chunkContent = '';
              for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:') && trimmed !== 'data: [DONE]') {
                  try {
                    const obj = JSON.parse(trimmed.slice(5).trim());
                    chunkContent += obj?.choices?.[0]?.delta?.content ?? '';
                    if (obj?.usage) usage = obj.usage;
                  } catch { /* ignore */ }
                }
              }
              if (gate && !gate.decided) {
                const action = gate.push(chunkContent);
                if (action === 'skill') {
                  restartName = gate.skillName;
                  try {
                    await reader.cancel();
                  } catch { /* pass 1 already ending */ }
                  return 'restarted';
                }
                if (action === 'plain') {
                  // Marker definitively absent → release the held raw prefix.
                  send(pendingRaw + text);
                  pendingRaw = '';
                } else {
                  pendingRaw += text; // keep holding the raw SSE lines
                }
              } else {
                send(text);
              }
              aggregate += chunkContent;
            } else {
              buffer += text;
              let idx: number;
              while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;
                try {
                  const obj = JSON.parse(line);
                  const content = obj?.message?.content ?? '';
                  aggregate += content;
                  send(
                    `data: ${JSON.stringify({
                      model: modelId,
                      created: nowSec(),
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: obj.done ? {} : { role: 'assistant', content },
                          finish_reason: obj.done ? 'stop' : null,
                        },
                      ],
                    })}\n\n`
                  );
                  if (obj.done) send('data: [DONE]\n\n');
                } catch { /* skip */ }
              }
            }
          }
        };

        const pass1 = await consumePass(upstream);
        // Stream ended before the gate could decide → release the held raw
        // prefix (aggregate already includes it — 5c parses as it goes).
        if (pass1 === 'completed' && gate && !gate.decided && pendingRaw) {
          send(pendingRaw);
          pendingRaw = '';
        }
        if (pass1 === 'restarted' && restartName) {
          const { getSkillByName, buildSkillInjectionMessages } = await import('@/lib/skills/registry');
          const skill = getSkillByName(restartName);
          if (skill) {
            // A marker for a pre-selected skill means it is ALREADY in
            // llmMessages — restart WITHOUT re-injecting it (no duplicate).
            const alreadyLoaded = usedSkills.includes(skill.name);
            if (!alreadyLoaded) usedSkills.push(skill.name);
            aggregate = ''; // the held pass-1 prefix (marker) is dropped
            let res2: Response | null = null;
            try {
              const messages2 = alreadyLoaded
                ? llmMessages
                : await buildSkillInjectionMessages(llmMessages, skill);
              res2 = await callUpstream({ ...reqBody, messages: messages2 });
              if (isKilo && res2.status === 400) {
                const probe = await res2.clone().text().catch(() => '');
                if (/bad request|Provider returned error/i.test(probe)) {
                  console.warn('[v12-flow] 5c skill pass-2 gateway 400 flake — retrying');
                  res2 = await callUpstream({
                    ...reqBody,
                    messages: alreadyLoaded
                      ? llmMessages
                      : await buildSkillInjectionMessages(llmMessages, skill),
                  });
                }
              }
            } catch (e) {
              console.error('[v12-flow] 5c skill pass-2 failed', e);
            }
            if (res2 && res2.ok) {
              gate = null; // pass 2 streams freely
              await consumePass(res2);
            } else {
              controller.error(new Error(`Upstream error ${res2?.status ?? 502}`));
              return;
            }
          }
        }
        controller.close();
        await persistAssistant(aggregate, usage);
      } catch (e) {
        console.error('[v12-flow] SSE passthrough error', e);
        try {
          controller.error(e);
        } catch { /* already closed */ }
      } finally {
        finishTask();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
  }; // end runCompletionFlow

  // ------------------------------------------- Serverless SSE early stream
  // Bridge mode (loader.js / serverless hosts): open the HTTP response
  // stream BEFORE the completion flow runs. The auto web-search decision
  // and the search/loader phases can take 10-30s — with the stream already
  // open, each status event ("Recherche web en cours", "Lecture des sources",
  // "N résultats trouvés"…) is written to the wire the moment it fires, so
  // the browser shows the same live progress a native socket connection
  // would. All further events (deltas, sources, title, done) flow through
  // the same sink for the whole duration of the completion.
  if (sseEventsRequested && sessionId) {
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (envelope: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
          } catch {
            closed = true;
          }
        };
        sseSink = enqueue;
        // Safety flush for events that could only exist if a phase ran
        // before this point (impossible today — the sink is live before
        // runCompletionFlow starts; harmless belt-and-suspenders).
        for (const env of sseBuffer.splice(0)) enqueue(env);
        try {
          const res = await runCompletionFlow();
          // A non-200 result is a mid-flow HTTP error (model not found,
          // image generation disabled…) that native mode would have
          // returned as the fetch response. The SSE response is already a
          // 200 stream — surface it as the message error event instead,
          // which the compiled frontend renders natively.
          if (res && res.status !== 200) {
            const raw = await res.clone().text().catch(() => '');
            let detail = raw;
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object' && 'detail' in parsed) detail = String((parsed as any).detail);
            } catch {
              /* raw text */
            }
            enqueue({ chat_id: chatId, message_id: assistantMessageId, data: { type: 'chat:message:error', data: { error: { content: detail || `Error ${res.status}` }, done: true } } });
            enqueue({ chat_id: chatId, message_id: assistantMessageId, data: { type: 'status', data: { done: true } } });
          }
        } catch (e) {
          console.error('[v12-flow] SSE transport error', e);
          const detail = e instanceof Error ? e.message : String(e);
          enqueue({ chat_id: chatId, message_id: assistantMessageId, data: { type: 'chat:message:error', data: { error: { content: detail }, done: true } } });
        } finally {
          closed = true;
          sseSink = null;
          // A live reveal ticker would hold the serverless function's event
          // loop open past the response end — always clear it here.
          stopRevealTicker();
          try {
            controller.close();
          } catch {
            /* client already gone */
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
  }

  // Native socket transport (self-hosted topology): same guarantee — the
  // paced-reveal ticker must never outlive the completion flow.
  try {
    return await runCompletionFlow();
  } finally {
    stopRevealTicker();
  }
}

// ---------------------------------------------------------------------------
// Title generation (routers/tasks.py generate_title + config.py template)
// ---------------------------------------------------------------------------

async function generateChatTitle(route: ModelRoute, messages: { role: string; content: string }[]): Promise<string | null> {
  try {
    const last2 = messages.filter((m) => m.role !== 'system').slice(-2);
    const history = last2.map((m) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${m.content}`).join('\n');
    const prompt = TITLE_TEMPLATE.replace('{{MESSAGES:END:2}}', history.slice(0, 4000));

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const url = route.type === 'openai' ? `${route.baseUrl.replace(/\/+$/, '')}/chat/completions` : `${route.baseUrl}/api/chat`;
    if (route.type === 'openai' && route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
    const body: Record<string, any> =
      route.type === 'openai'
        ? { model: route.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 1000 }
        : { model: route.model, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: 1000 } };
    // Kilo gateway models → reasoning off for titles (faster + cheaper).
    const { isKiloModel } = await import('@/lib/kilo-llm');
    if (isKiloModel(route.model)) {
      body.reasoning = { enabled: false };
      body.include_reasoning = false;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let content: string =
      data?.choices?.[0]?.message?.content ?? data?.message?.content ?? '';
    if (!content) return null;

    // Python: title_string[find('{'):rfind('}')+1] → JSONCodec.loads().get('title')
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(content.slice(start, end + 1));
        if (parsed?.title) return String(parsed.title);
      } catch { /* fall through */ }
    }
    // Fallback: first 100 chars of the user message (Python 3693-3694)
    const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
    return userMsg ? userMsg.slice(0, 100) + (userMsg.length > 100 ? '...' : '') : null;
  } catch {
    return null;
  }
}
