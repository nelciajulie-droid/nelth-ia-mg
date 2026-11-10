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
  sanitizeConnectorIds,
  resolveConnectorSelection,
  selectionForcesWebSearch,
  connectorStatusLabel,
  buildConnectorContext,
} from '@/lib/apps/app-router';
import {
  ReasoningAccumulator,
  NativeReasoningAccumulator,
  nativeReasoningOutputItems,
  parseCompleteOutput,
  stripReasoningTags,
  REASONING_TAG_PAIRS,
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
      // Image-only legacy turns (no text, no llm_content): a NATURAL
      // assistant sentence. A mechanical bracket note as the ENTIRE turn
      // gets echoed verbatim by the model on the next "ok merci" — the
      // sentence keeps the same signal (an image exists, editable) in a
      // voice the model treats as conversation.
      if (!base.trim() && m.files.every((f: any) => f?.type === 'image')) {
        return names.length === 1
          ? `Voici l'image générée (${names[0]}). Dites-moi si vous souhaitez des ajustements.`
          : `Voici les images générées (${names.join(', ')}). Dites-moi si vous souhaitez des ajustements.`;
      }
      // Video-only legacy turns (vibes engine) — same natural-sentence
      // pattern: the model knows a video exists and can be iterated on.
      // The files carry type 'video' (older turns 'file') — the video
      // nature is read from the type / content_type / .mp4 name.
      const isVideoFile = (f: any) =>
        f?.type === 'video' ||
        String(f?.content_type ?? '').startsWith('video/') ||
        /\.mp4$/i.test(String(f?.name ?? ''));
      if (!base.trim() && m.files.every((f: any) => isVideoFile(f))) {
        return names.length === 1
          ? `Voici la vidéo générée (${names[0]}). Dites-moi si vous souhaitez des ajustements.`
          : `Voici les vidéos générées (${names.join(', ')}). Dites-moi si vous souhaitez des ajustements.`;
      }
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

/**
 * Convert resolved image sources (chat attachments / history images) into
 * the bytes-based video source: the vibes upload endpoint needs raw bytes
 * (a bare URL is rejected with MEDIA_GONE by the animate pipeline).
 */
async function videoSourceFrom(
  sources: import('@/lib/imagine/nelthai').NelthaiImageSource[]
): Promise<import('@/lib/video-generation').VideoSourceImage | undefined> {
  for (const s of sources) {
    try {
      if (s.kind === 'bytes' && s.bytes?.length) {
        return { bytes: s.bytes, contentType: s.contentType, filename: s.filename };
      }
      if (s.kind === 'url' && /^https?:\/\//i.test(s.url)) {
        const res = await fetch(s.url, { signal: AbortSignal.timeout(20_000) });
        if (res.ok) {
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length > 1024) {
            const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
            return {
              bytes,
              contentType: contentType.startsWith('image/') ? contentType : undefined,
            };
          }
        }
      }
    } catch {
      /* try the next source */
    }
  }
  return undefined;
}

/**
 * Internal-analysis narration detector. The dots-3 "note" model sometimes
 * opens its answer with its deliberation process — English meta-narration on
 * ambiguous search-augmented questions: "The user is asking…", "Looking at
 * the sources…", "Source 1 shows…", "Cette question est ambiguë…". The stream
 * holds such a prefix back and a repair call rewrites it into the direct
 * final answer. High-confidence markers only: a missed detection merely
 * keeps the cosmetic narration, a false positive still gets repaired into a
 * clean answer.
 */
const NARRATION_START_RE = new RegExp(
  '^(?:' +
    [
      "the\\s+user(?:'?s|\\s+is|\\s+was|\\s+has)?\\s*(?:is\\s+)?(?:asking|wants|needs|question|message|wrote|said)",
      'looking\\s+at\\s+(?:the|these|my|your)\\s+(?:sources?|results?|context|search)',
      'analy(?:zing|sons|sons\\s+les)\\b',
      'based\\s+on\\s+(?:the|these)\\s+(?:sources?|results?|search)',
      'sources?\\s*\\d',
      "l'utilisateur\\s+(?:demande|pose|veut|a\\s+demandé|interroge)",
      'la\\s+question\\s+(?:demande|est\\s+de|porte\\s+sur|demandait)',
      'en\\s+(?:regardant|analysant)\\s+(?:les|ces)\\s+(?:sources?|résultats)',
      'je\\s+(?:vois|lis)\\s+(?:que\\s+)?(?:les|ces)\\s+(?:sources?|résultats)',
      'i\\s+(?:see|note|can\\s+see)\\s+(?:that\\s+)?(?:the|these|sources?|multiple|several)',
      'the\\s+(?:search|web)\\s+(?:results?|sources?)\\s+(?:show|are|mention|indicate)',
      'this\\s+(?:question|query)\\s+is\\s+(?:ambiguous|asking)',
      'cette\\s+question\\s+(?:est\\s+ambiguë|peut\\s+signifier|demandait)',
      'il\\s+y\\s+a\\s+(?:deux|plusieurs)\\s+(?:façons|interprétations|sens\\s+possibles)',
    ].join('|') +
    ')',
  'i'
);

/**
 * Local narration strip — LAST-RESORT fallback when the LLM repair pass
 * fails or times out (observed on the TokenHarbor flash model: the
 * non-streaming repair call outruns the serverless time budget). The
 * flash-style narration is a leading paragraph — the real answer follows
 * right after the paragraph break. Drops the narration paragraph ONLY when
 * a substantial remainder survives; otherwise returns the input unchanged.
 */
function localStripNarration(content: string): string {
  const trimmed = content.trimStart();
  if (!NARRATION_START_RE.test(trimmed)) return content;
  let cut = trimmed.search(/\n\s*\n/); // paragraph break first
  if (cut < 0) cut = trimmed.indexOf('\n'); // single newline fallback
  if (cut < 0) return content;
  const rest = trimmed.slice(cut).replace(/^[\s\n]+/, '');
  if (rest.trim().length < 40) return content; // nothing substantial after — keep raw
  return rest;
}

/**
 * Continuation instruction for auto-continue rounds (see finalizeTruncated
 * and the __nelth_continue mode): the serverless platform caps a single
 * completion request (Vercel maxDuration 300s), and a thinking-model
 * generation of a very long code file can outrun it. A gateway output-token
 * cap (finish_reason "length") ends the same way. The interrupted round's
 * partial answer rides in the context as the model's own last message —
 * this instruction makes the continuation seamless.
 */
const CONTINUE_INSTRUCTION = `Your previous answer was interrupted mid-output by a platform limit (time budget or output-token cap) — the conversation shows exactly where it stopped. Continue EXACTLY from that point: do not repeat anything already written, do not re-introduce or summarize the answer, do not apologize or mention the interruption. If the output stopped inside a code block, continue inside that same code block and close it properly when the code ends. Emit ONLY the continuation, starting with the very next character.`;

/**
 * Notes-to-answer instruction for THINKING-ONLY auto-continue rounds: the
 * interrupted round produced chain-of-thought but no answer text (the
 * whole output-token/time budget went to reasoning). Blindly re-running
 * CONTINUE_INSTRUCTION re-thinks from scratch — the notes never ride into
 * the next round's context — and the loop stacks one « Réflexion » block
 * per round over a message that never gets an answer (prod repro
 * 2026-11-10: three stacked thinking blocks, empty message). Instead the
 * next round receives the model's own notes as its prior turn and THIS
 * instruction: convert, do not re-analyze.
 */
const NOTES_TO_ANSWER_INSTRUCTION = `These were your internal analysis notes from your previous attempt, not an answer. Write NOW the FINAL ANSWER to my original question: direct and concise, in MY language. Use your notes as your working memory — do not redo the analysis, do not restate or mention the notes, never describe your reading process. Just answer me directly.`;

/** Extract the accumulated chain-of-thought text from structured output
 * items (rounds' reasoning blocks) — the notes fed back into a continuation
 * round's LLM context and into the notes-to-answer salvage repair. */
function reasoningTextFromOutput(output: any[] | null | undefined): string {
  if (!Array.isArray(output)) return '';
  const texts: string[] = [];
  for (const item of output) {
    if (!item || item.type !== 'reasoning') continue;
    const parts = item.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text.trim()) texts.push(part.text);
    }
  }
  return texts.join('\n');
}

/** Build the assistant MESSAGE output item — the item the Open-WebUI frontend
 * renders as the answer text. A message whose `output` array exists but has
 * NO message item renders ONLY its reasoning blocks and IGNORES the content
 * field: every path that finalizes an answer over a structured history MUST
 * compose this item (thinking-only guards, salvage repairs, continuation
 * rounds that answer in plain mode). */
function assistantMessageOutputItem(text: string, idSuffix = ''): any {
  return {
    type: 'message',
    id: 'msg_final' + idSuffix,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

/**
 * Conservative prompt-size estimate for the « max tokens infinie » clamp —
 * chars/3 per text part (over-estimates prose, close for code) + 2 000 per
 * image block + 8 per message envelope. Used ONLY to keep the pinned
 * max_tokens under the model's TOTAL context window: several providers
 * (AtlasCloud serving dots-3-note-preview:free) bind prompt + completion
 * TOGETHER and 400 the whole request when the sum overflows — see the
 * context-aware clamp in the flow below.
 */
function estimatePromptTokens(messages: any[]): number {
  let tokens = 0;
  for (const m of messages ?? []) {
    tokens += 8; // role/structure envelope
    const content = m?.content;
    if (typeof content === 'string') {
      tokens += Math.ceil(content.length / 3);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') tokens += Math.ceil(part.length / 3);
        else if (part?.type === 'text' && typeof part.text === 'string')
          tokens += Math.ceil(part.text.length / 3);
        else if (part?.type === 'image_url' || part?.image_url) tokens += 2_000;
      }
    }
  }
  return tokens;
}

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

  // ------------------------------------------ 1bis. Vision attachment capture
  // (Nelth-4.0_Flash — TokenHarbor flash model). The compiled SPA inlines
  // attached images as content blocks ({type:"image_url", image_url:{url}})
  // on the user message and/or lists them in its `files` array. Text-only
  // models flatten all of that away; vision-capable models get the images
  // re-injected as `image_url` blocks right before the upstream call (after
  // every text augmentation — see the vision injection below section 4).
  const visionImageRefs: Array<{ id?: string; url?: string; type?: string; name?: string } | string> = [];
  try {
    // Dedupe key: the compiled SPA references the SAME attachment both as an
    // inline content block and in the message's `files` array — without this
    // the model would see every image twice.
    const seenVisionKeys = new Set<string>();
    const pushRef = (ref: { id?: string; url?: string; type?: string; name?: string } | string): void => {
      const key = typeof ref === 'string' ? ref : String(ref.url || ref.id || '');
      if (!key || seenVisionKeys.has(key)) return;
      seenVisionKeys.add(key);
      visionImageRefs.push(ref);
    };
    const collectImageBlocks = (content: unknown): void => {
      if (!Array.isArray(content)) return;
      for (const part of content) {
        const url =
          part && typeof part === 'object' && (part as any).type === 'image_url'
            ? (part as any).image_url?.url
            : null;
        if (typeof url === 'string' && url) pushRef(url);
      }
    };
    collectImageBlocks(userMessage?.content);
    const lastFormMsg = Array.isArray(form.messages) ? form.messages[form.messages.length - 1] : null;
    if (lastFormMsg && typeof lastFormMsg === 'object') collectImageBlocks((lastFormMsg as any).content);
    for (const file of [
      ...(Array.isArray(userMessage?.files) ? userMessage.files : []),
      ...(Array.isArray((lastFormMsg as any)?.files) ? (lastFormMsg as any).files : []),
    ]) {
      if (file && typeof file === 'object' && ((file as any).url || (file as any).id)) {
        pushRef(file as any);
      }
    }
  } catch {
    /* unreadable attachments → text-only turn */
  }

  // Serverless realtime transport — requested by the loader.js bridge when
  // the browser cannot reach a socket.io service (Vercel & co). The whole
  // socket-event flow (status, streaming deltas, sources, titles, done) is
  // serialized into the HTTP response as SSE lines instead of being emitted
  // over a socket hop that does not exist.
  const sseEventsRequested = form.__sse_events === true;
  delete form.__sse_events;
  // Auto-continue chain (see finalizeTruncated + the loader.js SSE bridge):
  // this request is a CONTINUATION round for a generation that hit the
  // serverless time budget mid-code. The context is rebuilt from the stored
  // history INCLUDING the interrupted partial answer, and every turn-level
  // phase below (skills pre-selection, web search, image funnel, title) is
  // skipped — those decisions belong to the original request.
  const isContinuation = form.__nelth_continue === true;
  delete form.__nelth_continue;
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
  if (!isContinuation && isSavedChatId(chatId) && userMessageId && userMessage) {
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
  // Phase stopwatch — the pre-first-token latency (the user-visible
  // "Réflexion" span) is the product of: DB bookkeeping → skills → auto
  // decisions → upstream first token. Every milestone logs its elapsed ms so
  // a slow phase is identifiable in one glance at the logs.
  const flowT0 = Date.now();
  const phaseMs = (label: string): string => `(+${Date.now() - flowT0}ms)`;
  // ---------------------------------------- 3. Build LLM messages (middleware)
  // Instant typing feedback (streaming UX): the user's message lands, then
  // NOTHING is visible for seconds on the free upstream — the auto-engagement
  // decisions (~2s of LLM calls) plus the gateway's first-token queue (~1.5s)
  // are silent. A shimmer "Réflexion" status row appears immediately (the
  // SSE stream is already open) and clears the moment real content or
  // reasoning starts flowing. Image turns replace it with their own phase
  // statuses; search turns with "Recherche web en cours".
  let thinkingStatusShown = false;
  const showThinkingStatus = async () => {
    if (thinkingStatusShown) return;
    thinkingStatusShown = true;
    await emit({
      type: 'status',
      data: { action: 'chat', description: 'Réflexion', done: false },
    });
  };
  const clearThinkingStatus = async () => {
    if (!thinkingStatusShown) return;
    thinkingStatusShown = false;
    await emit({
      type: 'status',
      data: { action: 'chat', description: 'Réflexion', done: true },
    });
  };
  if (sessionId) await showThinkingStatus();

  // Skills state (hoisted so the continuation branch below can seed
  // usedSkills from the interrupted round's meta before the phase 3.3bis
  // block runs).
  let skillsActive = false;
  const usedSkills: string[] = [];
  const preSelectedNames: string[] = [];
  // Connectors state (@ quick action — tool servers used this turn; rides the
  // assistant message meta next to used_skills).
  const usedConnectors: string[] = [];

  /** Continuation base — the interrupted round's partial answer (raw text
   *  for context + reasoning output items to re-emit ahead of the new
   *  round's snapshots so the first thinking block survives the frontend's
   *  full-snapshot replacement). Null on normal (non-continuation) turns. */
  let contBase: { content: string; output: any[]; fileIntent: boolean } | null = null;
  // Auto-continue chain state, persisted by finalizeTruncated in the
  // message meta and re-read here by every fresh continuation invocation
  // (each __nelth_continue request is a brand-new serverless function —
  // counters cannot live in flow memory across rounds).
  let contRoundCount = 0;
  let thinkingRoundStreak = 0;

  let llmMessages: { role: string; content: string }[];
  if (isContinuation) {
    // ---- Continuation round (auto-continue chain) --------------------------
    // Rebuild the LLM context from the STORED history including the partial
    // assistant message, re-inject the skill packs the interrupted round
    // loaded, and close with a surgical "continue exactly where you stopped"
    // instruction. Turn-level phases (search/image/skills/title) are skipped.
    if (!isSavedChatId(chatId) || !assistantMessageId) {
      return json({ detail: 'Continuation requires a saved chat and message id' }, 400);
    }
    const chat = await getChatById(chatId);
    if (!chat || (chat.user_id !== user.id && user.role !== 'admin')) {
      return json({ detail: 'You do not have permission to access this resource. Please contact your administrator for assistance.' }, 403);
    }
    const stored = (await getChatMessagesMapByChatId(chatId)) as Record<string, any> | null;
    const existing = stored?.[assistantMessageId] ?? null;
    if (!existing || existing.role !== 'assistant') {
      return json({ detail: 'Continuation target message not found' }, 404);
    }
    contBase = {
      content: messageContent(existing),
      // reasoning items only — the message item is rebuilt by the accumulator
      // (seeded with the base content) under the continuation's item id.
      output: (Array.isArray(existing.output) ? existing.output : []).filter(
        (it: any) => it && it.type !== 'message'
      ),
      // The interrupted round's file intent rides in meta — a ```document
      // block spanning the seam must still become a file card at the end.
      fileIntent: existing?.meta?.file_intent === true,
    };
    contRoundCount =
      typeof existing?.meta?.nelth_cont_round === 'number' ? existing.meta.nelth_cont_round : 0;
    thinkingRoundStreak =
      typeof existing?.meta?.nelth_thinking_rounds === 'number'
        ? existing.meta.nelth_thinking_rounds
        : 0;
    // Chain up to (but excluding) the partial assistant message itself.
    const chain = getMessageList(stored as any, assistantMessageId)
      .reverse()
      .filter((m: any) => m && m.id !== assistantMessageId && messageContent(m));
    let contMessages = chain.map((m: any) => ({ role: m.role, content: messageContent(m) }));
    // Re-inject the skill packs the interrupted round loaded — the rest of
    // the code must keep following the same instructions (100% compliance
    // across the seam, not just on the first 285 seconds).
    const prevSkills: string[] = Array.isArray(existing?.meta?.used_skills)
      ? existing.meta.used_skills.filter((s: any): s is string => typeof s === 'string')
      : [];
    if (prevSkills.length) {
      const { getSkillByName, buildSkillInjectionMessages } = await import('@/lib/skills/registry');
      for (const name of prevSkills) {
        const skill = getSkillByName(name);
        if (skill) contMessages = await buildSkillInjectionMessages(contMessages, skill);
      }
      usedSkills.push(...prevSkills);
    }
    const contNotes = reasoningTextFromOutput(contBase.output);
    if (!contBase.content.trim() && contNotes.trim()) {
      // THINKING-ONLY round behind us: the whole budget went to
      // chain-of-thought and no answer text exists. Feed the model's own
      // notes back as its prior turn with the convert instruction — a
      // fresh full budget then lands the answer instead of re-thinking
      // from scratch (the stacking-loop root cause).
      llmMessages = [
        ...contMessages,
        { role: 'assistant', content: contNotes.slice(0, 60_000) },
        { role: 'user', content: NOTES_TO_ANSWER_INSTRUCTION },
      ];
    } else {
      llmMessages = [
        ...contMessages,
        { role: 'assistant', content: contBase.content || '[début de réponse — aucun contenu reçu]' },
        { role: 'user', content: CONTINUE_INSTRUCTION },
      ];
    }
    console.log(
      `[v12-flow] continuation round ${contRoundCount + 1} (thinking streak ${thinkingRoundStreak}) — ` +
        `base ${contBase.content.length} chars, ${contBase.output.length} output items, ` +
        `notes ${contNotes.length} chars${!contBase.content.trim() && contNotes.trim() ? ' (convert mode)' : ''}, ` +
        `skills: ${prevSkills.join(', ') || 'none'}`
    );
  } else if (historyMap && userMessageId) {
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
    llmMessages.map((m) => `${m.role}:${m.content.length}`).join(' | '),
    phaseMs('context')
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
    userAskedForFile = isContinuation
      ? contBase?.fileIntent === true
      : FILE_REQUEST_RE.test(rawLastUserText || '');
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
  // Prompt diet: ~930 tokens — injected only when the turn plausibly involves
  // document/file work (generous lexical gate; when in doubt it rides). Trivial
  // turns keep a bare context and prefill proportionally faster.
  {
    const { CAPABILITY_SYSTEM_PROMPT, FILE_REQUEST_RE } = await import('@/lib/document-generation');
    const CAPABILITY_RELEVANCE_RE =
      /\b(fichier|file|pdf|docx?|word|excel|xlsx|csv|pptx?|powerpoint|slides?|pr[eé]sentation|t[eé]l[eé]charg\w*|download|export\w*|cv|lett?re|rapport|report|m[eé]moire|contrat|facture|invoice|cr[eé][ea]|g[eé]n[eè]r\w*|fais|produis|r[eé]dige|write|make|build)\b/i;
    const capabilityRelevant =
      FILE_REQUEST_RE.test(rawLastUserText || '') || CAPABILITY_RELEVANCE_RE.test(rawLastUserText || '');
    const hasCapabilityPrompt = llmMessages.some(
      (m) => m.role === 'system' && m.content.includes('DOCUMENT CREATION CAPABILITY')
    );
    if (capabilityRelevant && !hasCapabilityPrompt) {
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
  // context — the rest of the library stays out. Continuation rounds skip
  // this phase entirely: the packs are re-injected from the interrupted
  // round's meta (see the continuation branch above).
  if (!isContinuation) {
  {
    const { getSkillManifestPrompt } = await import('@/lib/skills/registry');
    const { preselectSkills, buildPreLoadedSkillsMessage } = await import('@/lib/skills/selector');
    // rawLastUserText: the user's own words (web-search augmentation would
    // false-positive the selectors with page keywords).
    const isImageModel =
      modelId === 'stable-diffusion-xl' || modelId.startsWith('image_generation.');
    const preSelected = isImageModel ? [] : await preselectSkills(rawLastUserText);
    // @ quick action — explicitly selected skills ride the form's skill_ids
    // (the compiled frontend's @ menu: Skills section + catalog plugins):
    //   "catalog:<name>" → the platform skill catalog (registry)
    //   "<uuid>"         → a workspace skill (DB — SKILL.md content)
    // They merge with the pre-selector's picks (deduped by name) and get the
    // exact same treatment: full injection after the last user message,
    // "Skill « x » chargé" chips, used_skills meta.
    const formSkillIds: string[] = Array.isArray(form.skill_ids)
      ? form.skill_ids.filter((s: any): s is string => typeof s === 'string' && !!s)
      : [];
    if (formSkillIds.length && !isImageModel) {
      const { getSkillByName } = await import('@/lib/skills/registry');
      const { getSkillById } = await import('@/lib/models/workspace');
      for (const sid of formSkillIds.slice(0, 5)) {
        if (preSelected.some((p) => p.name === sid || `catalog:${p.name}` === sid)) continue;
        let resolved: { name: string; label: string; description: string; content: string } | null = null;
        if (sid.startsWith('catalog:')) {
          const cat = getSkillByName(sid.slice('catalog:'.length));
          if (cat) {
            resolved = { name: cat.name, label: cat.label || cat.name, description: cat.description, content: cat.content };
          }
        } else {
          try {
            const dbSkill = await getSkillById(sid);
            if (dbSkill) {
              let data: any = dbSkill.data;
              if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { data = null; }
              }
              const files = data && Array.isArray(data.files) ? data.files : [];
              const root = files.find((f: any) => f && typeof f === 'object' && f.path === 'SKILL.md');
              const content = typeof root?.content === 'string' ? root.content : '';
              if (content) {
                resolved = {
                  name: dbSkill.name ?? sid,
                  label: dbSkill.name ?? sid,
                  description: dbSkill.description ?? '',
                  content,
                };
              }
            }
          } catch { /* unknown skill id — skipped */ }
        }
        if (resolved) {
          preSelected.push({
            name: resolved.name,
            label: resolved.label,
            description: resolved.description,
            content: resolved.content,
            score: 99, // explicit user choice outranks every heuristic
          });
        }
      }
      if (formSkillIds.length) {
        console.log(
          `[v12-flow] @-selected skills: ${formSkillIds.join(', ')} → loaded ${preSelected.length} pack(s)`
        );
      }
    }
    preSelectedNames.push(...preSelected.map((s) => s.name));
    // Prompt diet: the FULL skills manifest is ~5 000 prompt tokens — on
    // free-tier models that is ~8-10s of prefill before the first output
    // token, paid on EVERY message (measured in prod: Réflexion ~10s while
    // a bare-prompt call to the same model answers instantly). Work-type
    // requests (generation vocabulary / pre-selected or @-selected skills)
    // keep the complete index + examples + hint; everything else gets the
    // condensed manifest (~150 tokens) — USE_SKILL remains available either
    // way, the streaming gate resolves it against the full catalog.
    const manifestRelevant =
      preSelected.length > 0 ||
      (await import('@/lib/skills/registry')).skillsManifestRelevant(rawLastUserText);
    const skillManifest = manifestRelevant
      ? await getSkillManifestPrompt(rawLastUserText, preSelectedNames)
      : await (await import('@/lib/skills/registry')).getCondensedSkillManifest();
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
  } // end !isContinuation skills phase

  // ------------------------------------ 3.3ter-bis @ app picker (overlay).
  // The ChatGPT-style picker (loader.js) injects the selected apps as
  // STRUCTURED METADATA (connector_ids). Routing:
  //   • Gmail / Google Calendar / Google Drive → bridged onto the builtin
  //     connector tool entries (tool_ids["server:connector:*"]) so the
  //     phase below EXECUTES them (real Google APIs when GOOGLE_* is
  //     configured, flagged demo otherwise — the deployed connector
  //     architecture, reused as-is);
  //   • Web Search → forces the real web-search pipeline (3.4);
  //   • apps with no executable connector on this instance (Slack, GitHub,
  //     Notion, Outlook, OneDrive…) → one TRUE status row + an honest
  //     context note (the model tells the user how to connect them — it
  //     NEVER pretends to have accessed those accounts).
  const connectorIds = sanitizeConnectorIds(form.connector_ids);
  const connectorPicks = !isContinuation && connectorIds.length
    ? await resolveConnectorSelection(user.id, connectorIds)
    : [];
  const connectorForcesWebSearch = selectionForcesWebSearch(connectorPicks);
  if (connectorPicks.length) {
    console.log(
      `[v12-flow] connectors @-selected (picker): ${connectorPicks
        .map((p) => `${p.app.name}[${p.connection.status}]`)
        .join(', ')}`
    );
    // Bridge the executable Google apps onto the builtin connector tools —
    // the phase below resolves + executes them through the SAME pipeline
    // as the native Integrations selection.
    const TOOL_ID_BY_PICKER_APP: Record<string, string> = {
      gmail: 'server:connector:gmail',
      gcal: 'server:connector:gcalendar',
      gdrive: 'server:connector:gdrive',
    };
    if (!Array.isArray(form.tool_ids)) form.tool_ids = [];
    for (const pick of connectorPicks) {
      const toolId = TOOL_ID_BY_PICKER_APP[pick.app.id];
      if (toolId && !(form.tool_ids as string[]).includes(toolId)) {
        (form.tool_ids as string[]).push(toolId);
      }
    }
    // Status rows — the same protocol the skills use. Bridged apps get
    // their execution statuses from the connector phase below; the rest
    // surface their TRUE connection state here.
    for (const pick of connectorPicks) {
      if (TOOL_ID_BY_PICKER_APP[pick.app.id]) continue; // phase below reports it
      await emit({
        type: 'status',
        data: {
          action: 'connector',
          description: `${pick.app.name} — ${connectorStatusLabel(pick)}`,
          done: true,
        },
      });
    }
    const connectorContext = buildConnectorContext(
      connectorPicks.filter((p) => !TOOL_ID_BY_PICKER_APP[p.app.id])
    );
    if (connectorContext) {
      // Tool-result position (right after the last user message) — the same
      // placement the pre-selected skills use; conversation-only, never
      // persisted into history.
      let insertAt = llmMessages.length;
      for (let i = llmMessages.length - 1; i >= 0; i--) {
        if (llmMessages[i]?.role === 'user') {
          insertAt = i + 1;
          break;
        }
      }
      llmMessages.splice(insertAt, 0, { role: 'user', content: connectorContext });
    }
  }

  // ---------------------------------------- 3.3ter Connectors (@ quick action:
  // OpenAPI tool servers — Gmail, Calendar, …). The compiled frontend's @
  // menu lists the admin-configured connectors (GET /tools/ merges them as
  // "server:<id>" entries) and the user's direct integrations; the selection
  // rides the form as tool_ids["server:…"] + tool_servers[…]. This phase
  // turns the selection into LIVE DATA — same architecture as the web-search
  // funnel: a non-streaming decision pre-pass (the free classifier model
  // chooses which tools to call, JSON protocol — works on any model, no
  // native function-calling needed), server-side execution of the calls
  // against the connector's OpenAPI spec, then the results are injected as
  // a tool-result system message after the last user message and the MAIN
  // streaming pass answers with them.
  if (!isContinuation) {
    const formToolIds: string[] = Array.isArray(form.tool_ids)
      ? form.tool_ids.filter((t: any): t is string => typeof t === 'string' && !!t)
      : [];
    const formToolServers: any[] = Array.isArray(form.tool_servers)
      ? form.tool_servers.filter((s: any) => s && typeof s === 'object')
      : [];
    const isSd =
      modelId === 'stable-diffusion-xl' || modelId.startsWith('image_generation.');
    const serverSelections = formToolIds.filter((id) => id.startsWith('server:'));
    const wantsConnectors = (serverSelections.length > 0 || formToolServers.length > 0) && !isSd;
    if (wantsConnectors) {
      try {
        const {
          resolveFormConnectors,
          buildToolCallProtocolPrompt,
          parseToolCalls,
          executeToolCalls,
          buildConnectorResultsMessage,
        } = await import('@/lib/chat/connectors');
        type ConnectorCallResult = import('@/lib/chat/connectors').ConnectorCallResult;
        // userId wires per-user OAuth connections into the built-in Google
        // connectors (gmail/gcal/gdrive refresh tokens — connector_connection).
        const connectors = await resolveFormConnectors(formToolIds, formToolServers, user.id);
        console.log(
          `[v12-flow] connectors requested (${serverSelections.join(', ') || 'direct'}) → resolved: ${
            connectors.map((c) => `${c.name}(${c.specs.length} tools)`).join(', ') || 'none'
          }`
        );
        const collected: ConnectorCallResult[] = [];
        if (connectors.length) {
          const { kiloChatCompletion } = await import('@/lib/kilo-llm');
          let previousCallsKey = '';
          for (let round = 0; round < 2; round++) {
            // Decision pre-pass: which tools (if any) does this question need?
            const protocolPrompt = buildToolCallProtocolPrompt(connectors, collected);
            let decisionText = '';
            try {
              const decision = await kiloChatCompletion({
                messages: [
                  { role: 'system', content: protocolPrompt },
                  ...llmMessages,
                ],
                stream: false,
                max_tokens: 700,
                temperature: 0,
                thinking: false,
              });
              decisionText = String(decision?.choices?.[0]?.message?.content ?? '');
            } catch (e) {
              console.error('[v12-flow] connector decision call failed', e);
              break;
            }
            const calls = parseToolCalls(decisionText);
            if (!calls.length) break; // no tool needed — plain answer
            // Free models sometimes re-request the exact same calls in round
            // 2 (the results are already in the prompt) — identical calls add
            // pure latency, so the round is skipped instead of re-executed.
            const callsKey = JSON.stringify(
              calls.map((c) => [c.tool, c.arguments]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
            );
            if (round > 0 && callsKey === previousCallsKey) {
              console.log('[v12-flow] connector round 2: identical calls — skipped');
              break;
            }
            previousCallsKey = callsKey;
            await clearThinkingStatus(); // connector chips take over the row
            const connectorLabel = connectors.map((c) => c.name).join(', ');
            await emit({
              type: 'status',
              data: {
                action: 'connector',
                description: `Connector « ${connectorLabel} » — exécution…`,
                done: false,
              },
            });
            const results = await executeToolCalls(connectors, calls);
            collected.push(...results);
            await emit({
              type: 'status',
              data: {
                action: 'connector',
                description: `Connector « ${connectorLabel} » — ${results.length} appel(s) exécuté(s)`,
                done: true,
              },
            });
            console.log(
              `[v12-flow] connector round ${round + 1}: ${results
                .map((r) => `${r.tool}(${r.status})`)
                .join(', ')}`
            );
            // Round 2 only re-runs when the model still needs DIFFERENT data
            // (dependent calls) — the protocol prompt carries the results so
            // far and an empty tool_calls block breaks the loop.
          }
        }
        if (collected.length) {
          usedConnectors.push(...connectors.map((c) => c.name));
          // Inject the live results after the LAST user message (the
          // tool-result position) — lives only in this turn's request.
          let insertAt = llmMessages.length;
          for (let i = llmMessages.length - 1; i >= 0; i--) {
            if (llmMessages[i]?.role === 'user') {
              insertAt = i + 1;
              break;
            }
          }
          llmMessages.splice(insertAt, 0, buildConnectorResultsMessage(connectors, collected));
        }
      } catch (e) {
        console.error('[v12-flow] connectors phase failed (continuing without them)', e);
      }
    }
  } // end !isContinuation connectors phase

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
  //
  // The SAME auto engagement exists for image generation (see auto-image.ts,
  // gated by `image_generation.auto` default true): "dessine-moi…" or "fais-le
  // en bleu" trigger the Nelthai engine even with the image toggle OFF —
  // exactly the "the model decides" behavior the web search auto has. Both
  // decision calls run IN PARALLEL (see below) so the second auto adds ~zero
  // wall-clock latency.
  const isSdModel = modelId === 'stable-diffusion-xl' || modelId.startsWith('image_generation.');
  let webCitations: any[] | null = null;
  // Continuation rounds never re-run the turn-level feature decisions —
  // the interrupted request already made them (a fresh search/image call on
  // the "continue" instruction would derail the code continuation).
  const wantsWebSearch =
    !isContinuation &&
    (form.features?.web_search === true || connectorForcesWebSearch) &&
    form.features?.image_generation !== true &&
    !isSdModel;
  console.log('[v12-flow] features =', JSON.stringify(form.features ?? null), '| model =', modelId, '| wantsWebSearch =', wantsWebSearch);

  const lastUserContent = (): string =>
    [...llmMessages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const webSearchAllowed = async (): Promise<boolean> => {
    const { configGet } = await import('@/lib/config');
    const { hasPermission } = await import('@/lib/access-control');
    const { DEFAULT_USER_PERMISSIONS } = await import('@/lib/constants');
    // Default TRUE — aligned with root-handlers.ts (`enable_web_search` is
    // served to the frontend with default true) and with the pre-Supabase
    // state where the admin settings had persisted web.search.enable=true in
    // the (now removed) SQLite config table. The old `false` default made the
    // UI offer the Web Search toggle while the pipeline silently refused to
    // run it — breaking BOTH the manual toggle and the auto engagement
    // ("Recherche Web Auto", which funnels through the same check).
    const webSearchEnabled = await configGet<boolean>('web.search.enable', true);
    if (!webSearchEnabled) return false;
    if (user.role === 'admin') return true;
    const defaultPermissions = await configGet<any>('user.permissions', DEFAULT_USER_PERMISSIONS);
    return hasPermission(user.id, 'features.web_search', defaultPermissions);
  };

  /** Run the search chain + context/citation injection (shared by the
   *  explicit toggle and the auto engagement path). */
  const performWebSearch = async (query: string, runningLabel: string): Promise<void> => {
    await clearThinkingStatus(); // the search status row takes over
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
        // Framing matters for small models: bare <source> blocks before the
        // question read as "analyze these documents" — the model then dumps
        // its analysis ("The user is asking… Looking at the sources…") as
        // the answer. The explicit frame keeps the roles straight: sources
        // are CONTEXT for answering the user's question, never the task.
        for (let li = llmMessages.length - 1; li >= 0; li--) {
          if (llmMessages[li].role === 'user') {
            const retrievalDate = new Date().toISOString().slice(0, 10);
            const framedContext =
              `The following web search results were retrieved on ${retrievalDate} for the query "${query}".\n` +
              `They are CONTEXT to help you answer the user's question — not a task to analyze, summarize, or describe. Never mention the retrieval, the sources' structure, or your reading process in your answer.\n\n` +
              webResultsToContext(results, pageTexts) +
              `\n\n---\nAnswer the user's question below using the context above (cite it with [N] markers). Write the final answer only, in the user's language.\n\n`;
            llmMessages[li].content = `${framedContext}${llmMessages[li].content}`;
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
- Never write markers inside code blocks, tables' headers, or headings. Do NOT add a bibliography or source list at the end — the interface renders sources automatically.

ANSWER STYLE (mandatory): Write the FINAL ANSWER only, in the SAME LANGUAGE as the user's message. Never narrate your reasoning process, never analyze or enumerate the sources, never describe what you are reading ("The user is asking…", "Looking at the sources…", "Source 1 shows…") — those are internal steps, not the answer. Start directly with the answer to the user's question.`;
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

  // Auto engagement results — set by the parallel decision block below.
  // `autoImage`/`autoImageEdit` feed section 3.5 (the image flow then runs
  // exactly like an explicit toggle turn; `autoImageEdit` flags ITERATION
  // turns where the conversation's most recent generated image feeds the
  // image-to-image job). `autoVideo`/`autoVideoAnimate` feed section 3.4ter
  // (the vibes video engine — text→video, or image→video when an image is
  // attached / `autoVideoAnimate` flagged an "anime cette image" turn).
  // `autoVideoRatio` carries the decision model's per-prompt format pick
  // (16:9 / 1:1 / 9:16 ONLY — the best ratio for THIS video; an explicit
  // format keyword in the phrasing still outranks it, see 3.4ter).
  let autoImage = false;
  let autoImageEdit = false;
  let autoVideo = false;
  let autoVideoAnimate = false;
  let autoVideoRatio: '16:9' | '1:1' | '9:16' | undefined;

  if (wantsWebSearch) {
    if (await webSearchAllowed()) {
      const query = lastUserContent();
      if (query) await performWebSearch(query, 'Recherche web en cours');
    }
  } else if (!isSdModel && !isContinuation) {
    // ---- Auto engagement: the model decides, the user doesn't have to. ----
    // The three autos (video + image + web search) decide IN PARALLEL — the
    // added latency of each extra auto is ~zero. Priority when several claim
    // the turn: VIDEO > IMAGE > search (neither a video nor an image turn
    // streams an LLM answer, so search context would be entirely wasted).
    // The video decision runs even with the image toggle ON: a textual
    // "crée une vidéo…" outranks a sticky UI toggle.
    const { configGet } = await import('@/lib/config');
    const imageAuto = await configGet<boolean>('image_generation.auto', true);
    const imageEnabled = await configGet<boolean>('image_generation.enable', true);
    const videoAuto = await configGet<boolean>('video_generation.auto', true);
    const videoEnabled = await configGet<boolean>('video_generation.enable', true);
    const searchAuto = await configGet<boolean>('web.search.auto', true);
    const query = lastUserContent();
    const imageToggleOn = form.features?.image_generation === true;

    if (query && (imageAuto || searchAuto || videoAuto)) {
      // Cheap pre-gate: the three LLM decision calls add seconds of fixed
      // latency to EVERY turn while they mostly answer "no engagement" for
      // plain chat/coding/creative messages. A generous lexical gate skips
      // them entirely for messages with NO plausible image/video/search
      // signal — when in doubt the full machinery still runs (any question
      // mark, any interrogative/factual/generation keyword, longer texts).
      const AUTO_GATE_RE = new RegExp(
        [
          '\\?', // any question
          // interrogatives / factual intent (fr + en)
          '\\b(qui|quoi|quel(?:le|s)?|quand|o[uù]|comment|pourquoi|combien|who|what|when|where|why|how|which)\\b',
          // volatile-fact vocabulary → potential web search
          'actu(?:alit[eé]|s)?\\b|\\bnews?\\b|\\bactu\\b|aujourd|now|current|latest|derni[eè]re|recent|prix|price|m[eé]t[eé]o|weather|score|r[eé]sultat|cours|rate|pr[eé]sident|ministre|champion|pdg|ceo|sorti(?:e|s)?|released?',
          // generation vocabulary → potential image/video engagement
          'image|photo|dessin|draw|paint|illustration|logo|affiche|poster|vid[eé]o|anime|animation|movie|clip|render|3d|mockup|banni[eè]re|avatar',
        ].join('|'),
        'i'
      );
      const needsAutoDecision =
        AUTO_GATE_RE.test(query) || query.trim().length > 140 || /\b(dessine|g[eé]n[eè]re|cr[eé]e|fais(?:-en)?|montre)\b/i.test(query);
      if (!needsAutoDecision) {
        console.log('[v12-flow] auto decisions SKIPPED (trivial turn pre-gate) — streaming immediately');
      } else {
      // HARD budget on the whole decision phase: these non-streaming calls
      // gate the user-visible first token (the "Réflexion" shimmer). The
      // decision functions already carry their own 6s deadline; this outer
      // race is the belt-and-suspenders guarantee that NO hang (engine bug,
      // stuck socket…) ever delays the answer beyond 8s — decisions simply
      // default off and the turn streams.
      const decisionsT0 = Date.now();
      // Arm the budget timer lazily and CLEAR it once the race settles — a
      // lingering armed timer would hold the serverless invocation open for
      // the full 8s even after a fast decision round.
      let decisionsTimer: ReturnType<typeof setTimeout> | undefined;
      const decisionsTimeout = () =>
        new Promise<[null, null, null]>((resolve) => {
          decisionsTimer = setTimeout(() => {
            console.warn(
              `[v12-flow] auto decisions exceeded the 8s budget ${phaseMs('decisions-budget')} — defaulting all off`
            );
            resolve([null, null, null]);
          }, 8_000);
        });
      const decisionsWork = Promise.all([
        imageAuto && imageEnabled && !imageToggleOn
          ? import('@/lib/chat/auto-image').then((m) => m.decideAutoImageGeneration(llmMessages))
          : Promise.resolve(null),
        searchAuto && !imageToggleOn && (await webSearchAllowed())
          ? import('@/lib/chat/auto-web-search').then((m) => m.decideAutoWebSearch(llmMessages))
          : Promise.resolve(null),
        videoAuto && videoEnabled
          ? import('@/lib/chat/auto-video').then((m) => m.decideAutoVideoGeneration(llmMessages))
          : Promise.resolve(null),
      ]).catch(() => [null, null, null] as [null, null, null]);
      let imageDecision: any = null;
      let searchDecision: any = null;
      let videoDecision: any = null;
      try {
        [imageDecision, searchDecision, videoDecision] = await Promise.race([
          decisionsWork,
          decisionsTimeout(),
        ]);
      } finally {
        if (decisionsTimer) clearTimeout(decisionsTimer);
      }
      console.log(
        `[v12-flow] auto decisions took ${Date.now() - decisionsT0}ms`,
        '— video:',
        videoDecision ? JSON.stringify(videoDecision) : 'null',
        '| image:',
        imageDecision ? JSON.stringify(imageDecision) : 'null',
        '| search:',
        searchDecision ? JSON.stringify(searchDecision) : 'null'
      );
      autoVideo = videoDecision?.video === true;
      autoVideoAnimate = autoVideo && videoDecision?.animate === true;
      autoVideoRatio = videoDecision?.aspectRatio;
      autoImage = !autoVideo && imageDecision?.image === true;
      autoImageEdit = autoImage && imageDecision?.edit === true;
      if (!autoImage && !autoVideo && searchDecision?.search && searchDecision.query) {
        // Same status label as the explicit toggle — the user shouldn't be
        // able to tell an auto engagement apart from a manual one.
        await performWebSearch(searchDecision.query, 'Recherche web en cours');
      }
      }
    }
  }

  // ------------------------------------ 3.4ter Video generation (AUTO engagement
  // only — the compiled frontend has no video toggle; natural phrasing
  // ("crée une vidéo…", "anime cette image") routes the turn through the
  // vibes engine: text→video, or image→video when the user attached an image
  // / the decision flagged an animate turn on a previous visual).
  const wantsVideoGeneration = !isContinuation && autoVideo;
  if (wantsVideoGeneration) {
    const { configGet } = await import('@/lib/config');
    const { ERROR_MESSAGES } = await import('@/lib/constants');
    const enabled = await configGet<boolean>('video_generation.enable', true);
    if (!enabled) {
      if (sessionId && chatId) {
        await emit({ type: 'chat:message:error', data: { error: { content: ERROR_MESSAGES.ACCESS_PROHIBITED }, done: true } });
        return nullJson();
      }
      return json({ detail: ERROR_MESSAGES.ACCESS_PROHIBITED }, 403);
    }

    const prompt = [...llmMessages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // Image→video source: the user's image attachments this turn become the
    // visual to animate (the text doubles as the MOTION directive).
    let sourceImage: import('@/lib/video-generation').VideoSourceImage | undefined;
    try {
      const { resolveImageSources } = await import('@/lib/image-generation');
      const lastFormMessage = Array.isArray(form.messages) ? form.messages[form.messages.length - 1] : null;
      const attached = [
        ...(Array.isArray(userMessage?.files) ? userMessage.files : []),
        ...(Array.isArray(lastFormMessage?.files) ? lastFormMessage.files : []),
      ];
      sourceImage = await videoSourceFrom(await resolveImageSources(attached));
    } catch {
      /* attachments unreadable → plain text→video */
    }

    // Animate source (auto engagement): when the decision flagged an
    // ANIMATE turn ("anime cette image", "fais-la bouger"…) and the user
    // attached nothing, the conversation's most recent image (generated by
    // the image engine, or uploaded earlier) becomes the source — the video
    // transforms the ACTUAL previous visual instead of re-rolling from a
    // context-free prompt.
    if (!sourceImage && autoVideoAnimate && isSavedChatId(chatId) && userMessageId) {
      try {
        const chat = await getChatById(chatId);
        const map = ((chat?.chat as any)?.history as any)?.messages;
        if (map && typeof map === 'object') {
          const chain = getMessageList(map, userMessageId); // newest→oldest from this user msg
          for (const m of chain) {
            const imageFiles = (Array.isArray(m?.files) ? m.files : []).filter(
              (f: any) => f?.type === 'image' && (f?.url || f?.id)
            );
            if (m?.role === 'assistant' && imageFiles.length) {
              const { resolveImageSources } = await import('@/lib/image-generation');
              sourceImage = await videoSourceFrom(await resolveImageSources(imageFiles));
              if (sourceImage) {
                console.log(
                  `[v12-flow] auto animate — image-to-video with the previous image (${imageFiles[0]?.name ?? 'unnamed'})`
                );
              }
              break;
            }
          }
        }
      } catch {
        /* history unreadable → plain text→video */
      }
    }

    if (sourceImage) {
      console.log('[v12-flow] image-to-video (animate) with a source image');
    }

    // Text→video ratio — the decision model picked the best format for THIS
    // prompt (16:9 / 1:1 / 9:16 only); an EXPLICIT format keyword in the
    // user's phrasing always outranks the model's inference, and the keyword
    // fallback (16:9) closes the chain when the model omitted the field.
    // Image→video NEVER sends a ratio: the vibes animate engine follows the
    // SOURCE image's own ratio.
    const { detectVideoFormat } = await import('@/lib/video-generation');
    const detected = detectVideoFormat(prompt);
    const videoAspectRatio = sourceImage
      ? undefined
      : detected.aspectExplicit
        ? detected.aspectRatio
        : (autoVideoRatio ?? detected.aspectRatio);
    if (!sourceImage) {
      console.log(
        `[v12-flow] video aspect ratio — ${videoAspectRatio}` +
          (detected.aspectExplicit ? ' (explicit user format)' : autoVideoRatio ? ' (model pick)' : ' (default)')
      );
    }

    // Live phase label — same status-row contract as the image engine
    // ('Generating video · sending | rendering | finalizing'): the video
    // card layer in loader.js swaps the shimmer row for the generation card.
    // The chosen ratio rides along in parentheses ('Generating video (9:16) ·
    // rendering') so the user SEES which format was selected — and the card
    // takes the placeholder shape of that ratio right away.
    const ratioTag = sourceImage || !videoAspectRatio ? '' : ` (${videoAspectRatio})`;
    const videoPhaseStatus = (phase: string | null) =>
      emit({
        type: 'status',
        data: {
          action: 'video_generation',
          description: phase ? `Generating video${ratioTag} · ${phase}` : `Generating video${ratioTag}…`,
          done: false,
        },
      });
    await videoPhaseStatus(null);
    await clearThinkingStatus(); // the generation card's status takes over
    try {
      const { generateAndSaveVideo } = await import('@/lib/video-generation');
      const file = await generateAndSaveVideo(user, prompt, { chat_id: chatId }, {
        aspectRatio: videoAspectRatio,
        resolution: detected.resolution,
        onPhase: (phase) => {
          void videoPhaseStatus(phase);
        },
        // Transient upstream failures retry invisibly (see video-generation.ts)
        // — the status row tells the user another attempt started.
        onRetry: (attemptIndex, totalAttempts) => {
          void emit({
            type: 'status',
            data: {
              action: 'video_generation',
              description: `Nouvelle tentative de génération (${attemptIndex + 1}/${totalAttempts})…`,
              done: false,
            },
          });
        },
        sourceImage,
      });
      // type 'video' — the compiled message grid only renders
      // ["image","file"] (its each filters on those two types), so a video
      // attachment NEVER paints a native file card: the loader.js layer owns
      // the whole video display (generation card → reveal player, history
      // players). The 'file' type showed a raw "generated-video-….mp4 — 2.3 MB"
      // card while the URL resolved — that flash is gone.
      const files = [{
        type: 'video',
        url: file.url,
        name: file.name,
        content_type: file.content_type || 'video/mp4',
        size: file.size,
      }];

      // Persist BEFORE the files event: loader.js resolves the video URL
      // from the chat history the moment the turn ends — the entry must
      // already be there (first-attempt hit, no 800ms retry loops).
      if (isSavedChatId(chatId) && assistantMessageId) {
        // meta.llm_content — what the NEXT turn's LLM context sees for this
        // video turn (natural assistant sentence, image-turn parity).
        const llmContent = sourceImage
          ? `Voici la vidéo animée à partir de l'image (${file.name}). Dites-moi si vous souhaitez des ajustements.`
          : `Voici la vidéo générée (${file.name}). Dites-moi si vous souhaitez des ajustements.`;
        await upsertMessageToChatByIdAndMessageId(chatId, assistantMessageId, {
          parentId: userMessageId,
          role: 'assistant',
          content: '',
          done: true,
          model: modelId,
          files,
          meta: { response_ended_at: nowSec(), llm_content: llmContent },
        } as any);
      }

      await emit({ type: 'chat:message:files', data: { files } });

      // Title from the prompt (image-chat parity).
      if (isSavedChatId(chatId) && backgroundTasks.title_generation && !isTemporaryChatId(chatId)) {
        const chat = await getChatById(chatId);
        if (chat && (chat.title === 'New Chat' || !chat.title)) {
          const title = prompt.trim().slice(0, 100) || 'Video';
          await updateChatById(chatId, { title });
          await emit({ type: 'chat:title', data: title });
        }
      }

      await emit({ type: 'chat:completion', data: { done: true, content: '' } });
      await emit({ type: 'chat:list', data: { chat_id: chatId, folder_id: form.folder_id ?? null } });
      await emit({ type: 'status', data: { done: true } });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error('[v12-flow] video generation failed', e);
      if (sessionId && chatId) {
        await emit({ type: 'chat:message:error', data: { error: { content: detail }, done: true } });
        return nullJson();
      }
      return json({ detail }, 400);
    }
    return nullJson();
  }

  // ------------------------------------ 3.5 Image generation (features toggle /
  // built-in SD model / AUTO engagement). Python main.py: features.image_generation →
  // generate_image + __event_emitter__ chat:message:files; the TS port adds
  // the built-in `stable-diffusion-xl` model that routes here directly, and
  // the auto engagement path (decideAutoImageGeneration) for image requests
  // phrased naturally ("dessine-moi…") with the toggle OFF.
  const wantsImageGeneration =
    !isContinuation && (form.features?.image_generation === true || isSdModel || autoImage);
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

    // Iteration source (auto engagement): when the decision flagged an EDIT
    // ("fais-le en bleu", "make it blue"…) and the user attached nothing,
    // the conversation's most recent generated image becomes the
    // image-to-image source — the edit transforms the ACTUAL previous visual
    // instead of re-rolling from a context-free prompt.
    if (autoImageEdit && sourceImages.length === 0 && isSavedChatId(chatId) && userMessageId) {
      try {
        const chat = await getChatById(chatId);
        const map = ((chat?.chat as any)?.history as any)?.messages;
        if (map && typeof map === 'object') {
          const chain = getMessageList(map, userMessageId); // newest→oldest from this user msg
          for (const m of chain) {
            const imageFiles = (Array.isArray(m?.files) ? m.files : []).filter(
              (f: any) => f?.type === 'image' && (f?.url || f?.id)
            );
            if (m?.role === 'assistant' && imageFiles.length) {
              const { resolveImageSources } = await import('@/lib/image-generation');
              sourceImages = await resolveImageSources(imageFiles);
              if (sourceImages.length) {
                console.log(
                  `[v12-flow] auto edit — image-to-image with the previous generated image (${imageFiles[0]?.name ?? 'unnamed'})`
                );
              }
              break;
            }
          }
        }
      } catch {
        /* history unreadable → plain text→image */
      }
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
    await clearThinkingStatus(); // the generation card's status takes over
    try {
      const { generateAndSaveImage } = await import('@/lib/image-generation');
      const size = await configGet<string>('image_generation.size', '1024x1024');
      const file = await generateAndSaveImage(user, prompt, size, { chat_id: chatId }, {
        onPhase: (phase) => {
          void imagePhaseStatus(phase);
        },
        // Transient upstream failures retry invisibly (see image-generation.ts)
        // — the status row tells the user another attempt started instead of
        // the phase label silently cycling back.
        onRetry: (attemptIndex, totalAttempts) => {
          void emit({
            type: 'status',
            data: {
              action: 'image_generation',
              description: `Nouvelle tentative de génération (${attemptIndex + 1}/${totalAttempts})…`,
              done: false,
            },
          });
        },
        sourceImages,
      });
      const files = [{ type: 'image', url: file.url, name: file.name }];

      await emit({ type: 'chat:message:files', data: { files } });

      if (isSavedChatId(chatId) && assistantMessageId) {
        // meta.llm_content — what the NEXT turn's LLM context sees for this
        // image turn. A natural assistant sentence, NOT a mechanical bracket
        // note: small chat models echo bare annotations verbatim on the next
        // "ok merci", and the sentence keeps the edit-iteration signal (the
        // auto-image decision reads the same history) that an image exists.
        const llmContent = sourceImages.length
          ? `Voici la nouvelle version de l'image (${file.name}). Dites-moi si vous souhaitez d'autres ajustements.`
          : `Voici l'image générée (${file.name}). Dites-moi si vous souhaitez des ajustements.`;
        await upsertMessageToChatByIdAndMessageId(chatId, assistantMessageId, {
          parentId: userMessageId,
          role: 'assistant',
          content: '',
          done: true,
          model: modelId,
          files,
          meta: { response_ended_at: nowSec(), llm_content: llmContent },
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
  // Spelling tolerance (ChatGPT-like): real users often write phonetically
  // or with mistakes — the model must reconstruct the intent silently and
  // answer normally, instead of stalling on the errors or echoing them.
  // Injected AFTER the auto decisions so their prompts stay untouched, and
  // after the image section (image turns never reach here).
  {
    const misspellHint =
      "\n\nNOTE: The user may write with spelling mistakes or phonetic approximations. Silently reconstruct their intent, answer it directly, and never correct or comment on their spelling unless they explicitly ask for it. Always answer in the user's language.";
    if (llmMessages.length && llmMessages[0].role === 'system') {
      llmMessages[0] = { role: 'system', content: `${llmMessages[0].content}${misspellHint}` };
    } else {
      llmMessages.unshift({ role: 'system', content: misspellHint.trim() });
    }
  }
  const { resolveModelRoute } = await import('@/lib/models-registry');
  const {
    isKiloModel,
    kiloModelWantsThinking,
    kiloAvailable,
    kiloFallbackActive,
    KILO_GATEWAY_BASE_URL,
    KILO_GATEWAY_API_KEY,
    KILO_REASONING_MODEL_ID,
  } = await import('@/lib/kilo-llm');
  const {
    isTokenharborModel,
    tokenharborAvailable,
    TOKENHARBOR_BASE_URL,
    TOKENHARBOR_API_KEY,
  } = await import('@/lib/tokenharbor-llm');
  const isKilo = isKiloModel(modelId);
  if (isKilo && !kiloAvailable()) {
    return json({ detail: `Model ${modelId} not found (Kilo gateway not configured)` }, 404);
  }
  // Third built-in — "Nelth-4.0_Flash" (TokenHarbor deepseek-v4.1-flash):
  // multimodal fast model, no keyless fallback (a missing key 404s).
  const isTH = isTokenharborModel(modelId);
  if (isTH && !tokenharborAvailable()) {
    return json({ detail: `Model ${modelId} not found (TokenHarbor gateway not configured)` }, 404);
  }
  // Keyless fallback: no gateway key → the built-in z-ai engine answers in
  // place of the gateway (callUpstream synthesizes the OpenAI-shaped upstream
  // Response locally; the route/url below stay unused in that mode).
  const kiloFallback = isKilo && kiloFallbackActive();
  const route: ModelRoute | null = isKilo
    ? { type: 'openai', model: modelId, baseUrl: KILO_GATEWAY_BASE_URL, apiKey: KILO_GATEWAY_API_KEY }
    : isTH
      ? { type: 'openai', model: modelId, baseUrl: TOKENHARBOR_BASE_URL, apiKey: TOKENHARBOR_API_KEY }
      : await resolveModelRoute(modelId);
  if (!route) {
    return json(
      { detail: `Model ${modelId} not found` },
      404
    );
  }

  // Vision injection (Nelth-4.0_Flash): this turn's captured attachments
  // (section 1bis) become `image_url` content blocks on the LAST user
  // message. Runs HERE — after every text augmentation (web-search context,
  // skills, misspell hint) so the pipeline above stays plain-string and
  // only the final wire shape carries the images.
  if (isTH && visionImageRefs.length) {
    try {
      const { resolveImageSources } = await import('@/lib/image-generation');
      const sources = await resolveImageSources(visionImageRefs as any[]);
      const parts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
      for (const s of sources) {
        if (s.kind === 'bytes' && s.bytes?.length) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${s.contentType ?? 'image/png'};base64,${s.bytes.toString('base64')}`,
            },
          });
        } else if (s.kind === 'url' && /^https?:\/\//i.test(s.url)) {
          parts.push({ type: 'image_url', image_url: { url: s.url } });
        }
      }
      if (parts.length) {
        for (let i = llmMessages.length - 1; i >= 0; i--) {
          if (llmMessages[i]?.role === 'user') {
            (llmMessages[i] as any).content = [
              { type: 'text', text: String(llmMessages[i].content ?? '') },
              ...parts,
            ];
            console.log(
              `[v12-flow] vision turn — ${parts.length} image block(s) injected for ${modelId}`
            );
            break;
          }
        }
      }
    } catch (e) {
      console.error('[v12-flow] vision injection failed', e);
    }
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
  // True ONLY when the output cap came from the USER'S OWN params — an
  // explicit cap is a deliberate choice and is respected (no token-limit
  // auto-continue). MUST be captured BEFORE the catalog pin below: the pin
  // sets reqBody.max_tokens on EVERY built-in model, and the old
  // `reqBody.max_tokens !== undefined` read classified the pin as a user cap
  // — silently killing the finish_reason "length" auto-continue (and the
  // thinking-only chain guard) on every built-in model.
  const userCappedOutput =
    (params as any).max_tokens !== undefined || (form as any).max_tokens !== undefined;
  // « Max tokens infinie » on every built-in model: the pinned ceilings are
  // each model's CATALOG MAXIMUM (verified live on the Kilo gateway
  // /api/v1/models + OpenRouter provider endpoints, 2026-11-10) — dots-3-
  // note-preview:free 460 800 completion tokens, nemotron-3-ultra-550b-a55b:
  // free 65 536, deepseek-v4.1-flash (flash tier) 131 072. Nothing lower is
  // ever applied: without an explicit max_tokens the OpenAI-compatible
  // gateways enforce their own low default (~4k) and long code answers die
  // mid-stream with finish_reason "length". The user's own params.max_tokens
  // still wins.
  //
  // CONTEXT-AWARE CLAMP — the provider window binds prompt + completion
  // TOGETHER, and a catalog completion max can exceed the remaining room:
  // dots-3-note-preview:free is served by AtlasCloud as max_completion
  // 460 800 inside a 512 000-token TOTAL window, so the blind 460 800 pin
  // 400s any conversation whose prompt passes ~51 200 tokens (reproduced in
  // production 2026-11-10: `Provider returned error` → raw
  // {"code":400,"msg":"bad request"} from AtlasCloud, request_id
  // 9cb66f0a — NO token keyword in the body). The pin is therefore clamped
  // against a conservative estimate of THIS request's prompt minus 2 048
  // headroom, floored at 32 768 so long code answers keep their runway (the
  // finish_reason "length" auto-continue covers the rest); whatever a bad
  // estimate still lets through is caught by the self-healing ladder below.
  if (reqBody.max_tokens === undefined && (isKilo || isTH)) {
    const catalog = isTH
      ? { max: 131_072, ctx: 1_048_576 } // deepseek-v4.1-flash (TokenHarbor/AtlasCloud)
      : modelId === KILO_REASONING_MODEL_ID
        ? { max: 65_536, ctx: 1_000_000 } // nemotron-3-ultra (Nvidia)
        : { max: 460_800, ctx: 512_000 }; // dots-3-note-preview (AtlasCloud)
    const estPrompt = estimatePromptTokens(llmMessages);
    reqBody.max_tokens = Math.max(
      32_768,
      Math.min(catalog.max, catalog.ctx - estPrompt - 2_048)
    );
  }
  console.log(
    `[v12-flow] upstream request: model=${modelId} max_tokens=${
      reqBody.max_tokens ?? 'gateway-default'
    } stream=${form.stream ?? false}`,
    phaseMs('upstream-connect')
  );
  if (form.stream === true && !isTH) {
    // TokenHarbor (flash) is omitted stream_options: strict OpenAI-compatible
    // gateways may reject the field, and usage telemetry is cosmetic here.
    reqBody.stream_options = { ...(reqBody.stream_options ?? {}), include_usage: true };
  }
  if (isKilo) {
    // OpenRouter-style reasoning controls: the thinking model streams its
    // chain-of-thought in `delta.reasoning`; the standard model keeps it off.
    const thinking = kiloModelWantsThinking(modelId);
    reqBody.reasoning = { enabled: thinking };
    reqBody.include_reasoning = thinking;
  }
  if (isTH) {
    // TokenHarbor native thinking switch — the flash tier answers DIRECT:
    // chain-of-thought disabled at the model level (no reasoning deltas).
    reqBody.thinking = { type: 'disabled' };
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
  //
  // Per-CALL timeout budget (not per-flow): every upstream call gets a fresh
  // window, so a pass-2 restart, a narration repair or an auto-continue round
  // never inherits a starved countdown. The FLOW wall still binds everything:
  // each call's window is capped at the wall's remainder, and the wall leaves
  // finalization headroom — a budget abort triggers the graceful truncation
  // path (finalizeTruncated: persist the partial + the nelth:continue marker
  // for the loader.js SSE bridge, which re-requests with __nelth_continue in
  // a FRESH serverless invocation with its own full budget) instead of the
  // raw "Chat completion stream failed" banner.
  //
  // The wall MUST stay below the REAL platform limit: the route now runs
  // with maxDuration=300 (chat/completions — video/photo generation turns
  // need the full window; vercel.json parity), so the wall aligns with the
  // 285s upstream-call caps used across the pipeline. A budget abort
  // triggers the graceful truncation path (finalizeTruncated: persist the
  // partial + the nelth:continue marker for the loader.js SSE bridge, which
  // re-requests with __nelth_continue in a FRESH serverless invocation with
  // its own full budget) instead of the raw "Chat completion stream failed"
  // banner — ~15s of finalization headroom under the 300s platform kill.
  // NELTH_FLOW_BUDGET_MS (env): tuning knob / local testing (short budgets
  // exercise the auto-continue chain without waiting real minutes).
  const FLOW_WALL_MS = (() => {
    const tuned = parseInt(String(process.env.NELTH_FLOW_BUDGET_MS || ''), 10);
    if (Number.isFinite(tuned) && tuned >= 10_000) return tuned;
    return 285_000;
  })();
  const flowWallAt = Date.now() + FLOW_WALL_MS;
  let activeCallTimeout: AbortSignal | null = null; // the current call's timeout signal (truncation classification)
  /** True when the CURRENT upstream call was killed by its time budget. */
  const callTimedOut = (): boolean => activeCallTimeout?.aborted === true;
  /** Signal for one upstream call: per-call cap, flow-wall remainder, user stop. */
  const upstreamSignal = (): AbortSignal => {
    const remaining = flowWallAt - Date.now();
    const callTimeout = AbortSignal.timeout(Math.max(8_000, Math.min(285_000, remaining)));
    activeCallTimeout = callTimeout;
    return typeof AbortSignal.any === 'function'
      ? AbortSignal.any([callTimeout, taskSignal])
      : callTimeout;
  };
  /** Abortable wrapper for engines that don't take a signal (the keyless
   *  z-ai fallback): errors the stream when the budget fires so the reader
   *  loop sees the same AbortError a gateway fetch would. */
  const signalGuardedStream = (
    src: ReadableStream<Uint8Array>,
    signal: AbortSignal
  ): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const onAbort = () => {
          try {
            controller.error(new DOMException('The operation was aborted due to timeout', 'AbortError'));
          } catch { /* already errored/closed */ }
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        const reader = src.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (e) {
          try { controller.error(e); } catch { /* already errored */ }
        } finally {
          signal.removeEventListener('abort', onAbort);
          try { reader.cancel(); } catch { /* best effort */ }
        }
      },
      cancel(reason) {
        try { src.cancel(reason); } catch { /* best effort */ }
      },
    });
  // Gateway tail guard — fixes the strict-gateway 400
  //   {"error":{"message":"The last message must have role=user.",…}}
  // Some OpenAI-compatible gateways (TokenHarbor / Nelth-4.0_Flash,
  // OpenRouter-style unified routes) reject ANY payload whose last message
  // is not role=user. Our injection protocol legitimately delivers
  // tool-result-style instructions as messages AFTER the last user message
  // (skills pre-selected, USE_SKILL pass-2, connector <tool_result>) —
  // those are role:"system", so the payload tail breaks the rule and the
  // whole turn dies with the raw upstream error. Fix: re-stamp the trailing
  // contiguous system block as user-role messages (the plain-chat tool-result
  // convention — content byte-for-byte unchanged) so every gateway accepts
  // the shape. No path of ours ends with assistant (continuation and
  // narration-repair both append an explicit closing user message), but a
  // defensive final continue-message is appended should that invariant ever
  // break, instead of letting a strict gateway 400 the turn.
  const withGatewaySafeTail = (body: Record<string, any>): Record<string, any> => {
    const msgs: any[] = Array.isArray(body.messages) ? [...body.messages] : [];
    if (msgs.length) {
      let i = msgs.length - 1;
      while (i >= 0 && msgs[i]?.role === 'system') i--;
      const rebranded = msgs.length - 1 - i;
      for (let j = i + 1; j < msgs.length; j++) {
        msgs[j] = { ...msgs[j], role: 'user' };
      }
      if (rebranded > 0) {
        console.log(
          `[v12-flow] gateway tail guard — re-stamped ${rebranded} trailing system message(s) as user ("last message must have role=user")`
        );
      }
      const lastRole = msgs[msgs.length - 1]?.role;
      if (lastRole !== 'user') {
        console.warn(
          `[v12-flow] upstream payload ends with role=${String(lastRole)} — appending a neutral continue user message`
        );
        msgs.push({
          role: 'user',
          content: '(Continue and complete your answer to my previous request.)',
        });
      }
    }
    return { ...body, messages: msgs };
  };

  const callUpstream = (
    body: Record<string, any>,
    signalOverride?: AbortSignal
  ): Promise<Response> =>
    kiloFallback
      ? (async () => {
          // z-ai engine bridge: same two models, OpenAI-compatible Response —
          // reasoning flags map onto the SDK's thinking switch.
          const payload = withGatewaySafeTail(body);
          const { zaiUpstreamResponse } = await import('@/lib/zai-llm');
          const signal = upstreamSignal();
          const res = await zaiUpstreamResponse({
            messages: payload.messages ?? [],
            stream: payload.stream === true,
            temperature: payload.temperature,
            top_p: payload.top_p,
            max_tokens: payload.max_tokens,
            thinking:
              payload.reasoning?.enabled === true || payload.include_reasoning === true
                ? 'enabled'
                : 'disabled',
          });
          if (payload.stream === true && res.body) {
            return new Response(signalGuardedStream(res.body, signal), {
              status: res.status,
              headers: res.headers,
            });
          }
          return res;
        })()
      : (() => {
          const payload = withGatewaySafeTail(body);
          return fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: signalOverride ?? upstreamSignal(),
          });
        })();

  /**
   * Self-healing output ceiling (« max tokens infinie »). The pinned
   * max_tokens values are each model's catalog maximum — but the serving
   * provider may refuse values our estimate thought safe, and a strict
   * OpenAI-compatible host answers 400 with NO token keyword in the body
   * (AtlasCloud on dots-3-note-preview:free returns a bare
   * `{"code":400,"msg":"bad request"}` when prompt + max_tokens overflows
   * its window — the old text-sniffing ladder never fired on it). So the
   * ladder NO LONGER sniffs the error text: ANY 400 from a built-in gateway
   * steps the request down until something is accepted — 32 768 (generous
   * proven-working tier) → the gateway default (no max_tokens: its ~4k
   * default output is extended by the finish_reason "length" auto-continue)
   * → non-standard reasoning/thinking flags stripped (last resort for a
   * gateway that chokes on those fields). The surviving shape is mirrored
   * into reqBody so the skill pass-2, the narration repair and the
   * auto-continue rounds inherit it. A user-set params.max_tokens is also
   * stepped down on rejection — an impossible cap must not kill the turn
   * (the deliberate-cap rule governs auto-continue, not error recovery).
   * Malformed-request 400s simply burn two fast-failing retries and surface
   * as before — no behavior lost, no dead turn gained.
   */
  const callUpstreamTokenSafe = async (
    body: Record<string, any>,
    signalOverride?: AbortSignal
  ): Promise<Response> => {
    let res = await callUpstream(body, signalOverride);
    if (!(isKilo || isTH) || res.status !== 400) return res;
    const steps: Array<() => string> = [];
    if (typeof body.max_tokens === 'number' && body.max_tokens > 32_768) {
      steps.push(() => {
        body.max_tokens = 32_768;
        reqBody.max_tokens = 32_768;
        return 'max_tokens → 32 768';
      });
    }
    if (body.max_tokens !== undefined) {
      steps.push(() => {
        delete body.max_tokens;
        delete reqBody.max_tokens;
        return 'max_tokens → gateway default';
      });
    }
    if (
      body.thinking !== undefined ||
      body.reasoning !== undefined ||
      body.include_reasoning !== undefined
    ) {
      steps.push(() => {
        delete body.thinking;
        delete body.reasoning;
        delete body.include_reasoning;
        delete reqBody.thinking;
        delete reqBody.reasoning;
        delete reqBody.include_reasoning;
        return 'reasoning/thinking flags stripped';
      });
    }
    for (const apply of steps) {
      const probe = (await res.clone().text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
      console.warn(
        `[v12-flow] upstream 400 (${probe || 'no body'}) — self-healing: ${apply()}`
      );
      res = await callUpstream(body, signalOverride);
      if (res.status !== 400) return res;
    }
    return res;
  };

  /**
   * Narration repair (flow scope): one corrective call converting the model's
   * held-back internal analysis into the direct final answer. The full
   * llmMessages context rides along (web sources included) so [N] citation
   * markers stay meaningful in the rewritten answer.
   *
   * `timeoutMs` caps the attempt (TokenHarbor flash: the free gateway is slow
   * on non-streaming calls — a short cap lets the local-strip fallback land
   * quickly instead of stalling until the flow wall aborts).
   */
  const repairTimeoutSignal = (ms: number): AbortSignal => {
    const timeout = AbortSignal.timeout(ms);
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, taskSignal]) : timeout;
  };
  const repairNarration = async (narrationText: string, timeoutMs?: number): Promise<string> => {
    const messages = [
      ...llmMessages,
      { role: 'assistant', content: narrationText.slice(0, 8000) },
      {
        role: 'user',
        content:
          'These were your internal analysis notes, not an answer. Write now the FINAL ANSWER to my original question: direct and concise, in MY language. Keep the [N] citation markers where a source supports a claim. Never mention "the user", the sources, your reading process, or these notes — just answer me directly.',
      },
    ];
    // stream_options MUST go: strict OpenAI-compatible gateways reject it
    // alongside stream:false (400) — that silently killed the repair and
    // surfaced the raw narration as the fallback.
    const body: Record<string, any> = {
      ...reqBody,
      messages,
      stream: false,
      // Same ceiling as the main generation — a repaired answer can be a
      // long code file; the old hard-coded 800 truncated it mid-code.
      max_tokens: reqBody.max_tokens,
      stream_options: undefined,
    };
    delete body.stream_options;
    const repairSignal = timeoutMs ? repairTimeoutSignal(timeoutMs) : undefined;
    let res = await callUpstreamTokenSafe(body, repairSignal);
    if (!res.ok) {
      // Provider flake retry (same guard as the main call — the free dots
      // model occasionally 400s a perfectly valid request).
      await new Promise((r) => setTimeout(r, 600));
      res = await callUpstreamTokenSafe(body, repairSignal);
    }
    if (!res.ok) throw new Error(`repair upstream ${res.status}`);
    const data = await res.json().catch(() => null);
    const repaired: string = data?.choices?.[0]?.message?.content ?? '';
    return repaired.trim();
  };

  let upstream: Response;
  /** Request-send timestamp — anchors the thinking duration (Kilo-style
   *  gateways buffer the whole chain-of-thought server-side; without this
   *  anchor the measured span is ~0s → "Thought for less than a second"). */
  const upstreamStartedAt = Date.now();
  try {
    upstream = await callUpstreamTokenSafe(reqBody);

    // Provider flakiness guard (observed on the free dots-studio model with
    // web-search context): the gateway SOMETIMES answers 400 "bad request"
    // from the upstream provider although the request is perfectly valid —
    // the same body succeeds on a retry (reproduced: one turn fails twice
    // then succeeds unchanged). Up to TWO extra retries on the SAME model,
    // short backoff between attempts: the model the user picked is never
    // substituted (explicit user rule — a persisting upstream error
    // surfaces as-is instead of silently answering with a different model).
    if ((isKilo || isTH) && upstream.status === 400) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (upstream.status !== 400) break;
        const probe = await upstream.clone().text().catch(() => '');
        if (!/bad request|Provider returned error/i.test(probe)) break;
        console.warn(`[v12-flow] gateway 400 provider flake — retry ${attempt}/2 (same model)`);
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        upstream = await callUpstreamTokenSafe(reqBody);
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
    const isBudgetAbort = callTimedOut() || (e as any)?.name === 'TimeoutError' || (e as any)?.name === 'AbortError';
    const detail = isBudgetAbort
      ? 'Le modèle a mis trop de temps à répondre (limite de temps de la plateforme). Réessayez — la question reste dans la conversation.'
      : e instanceof Error
        ? e.message
        : 'Connection error';
    if (sessionId && chatId) {
      await clearThinkingStatus();
      await emit({ type: 'chat:message:error', data: { error: { content: detail }, done: true } });
      return nullJson();
    }
    return json({ detail }, 502);
  }

  if (!upstream.ok) {
    finishTask();
    const errText = await upstream.text().catch(() => '');
    if (sessionId && chatId) {
      await clearThinkingStatus();
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
    if (
      isContinuation ||
      !isSavedChatId(chatId) ||
      !backgroundTasks.title_generation ||
      isTemporaryChatId(chatId)
    ) {
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
    rawContent?: string | null,
    extraMeta?: Record<string, any> | null
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
      ...(done || llmContent || usedSkills.length || usedConnectors.length || extraMeta
        ? {
            meta: {
              ...(done ? { response_ended_at: nowSec() } : {}),
              ...(llmContent ? { llm_content: llmContent } : {}),
              ...(usedSkills.length ? { used_skills: usedSkills } : {}),
              ...(usedConnectors.length ? { used_connectors: usedConnectors } : {}),
              ...(extraMeta ?? {}),
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
      const ollamaDoneReason =
        typeof data?.done_reason === 'string' && data.done_reason ? data.done_reason : 'stop';
      data = {
        id: crypto.randomUUID(),
        object: 'chat.completion',
        created: nowSec(),
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: data?.message?.content ?? '' },
            finish_reason: ollamaDoneReason,
          },
        ],
      };
    }
    let content = data?.choices?.[0]?.message?.content ?? '';

    // « Max tokens infinie » (non-streaming API clients): finish_reason
    // "length" means an output cap cut the answer mid-word. Server-side
    // continuation — up to 3 extra rounds, each one appending seamlessly to
    // the partial (same instruction as the streaming auto-continue chain;
    // no SSE bridge here, so the loop lives in-request). An EXPLICIT user
    // cap (params.max_tokens) is a deliberate choice and is respected.
    let nonStreamContRounds = 0;
    while (
      !userCappedOutput &&
      data?.choices?.[0]?.finish_reason === 'length' &&
      String(content).trim() &&
      nonStreamContRounds < 3
    ) {
      nonStreamContRounds++;
      console.warn(
        `[v12-flow] non-streaming output-token cap — continuation round ${nonStreamContRounds}/3`
      );
      try {
        const res2 = await callUpstreamTokenSafe({
          ...reqBody,
          messages: [
            ...llmMessages,
            { role: 'assistant', content: String(content).slice(0, 60_000) },
            { role: 'user', content: CONTINUE_INSTRUCTION },
          ],
        });
        if (!res2.ok) break;
        const data2: any = await res2.json().catch(() => null);
        if (!data2) break;
        const more: string =
          (route.type === 'openai' ? data2?.choices?.[0]?.message?.content : data2?.message?.content) ??
          '';
        if (!more.trim()) break; // nothing new — model had nothing left
        content = content + more;
        if (data?.choices?.[0]?.message) data.choices[0].message.content = content;
        const fr2 =
          route.type === 'openai' ? data2?.choices?.[0]?.finish_reason : data2?.done_reason;
        if (data?.choices?.[0]) {
          data.choices[0].finish_reason = typeof fr2 === 'string' && fr2 ? fr2 : 'stop';
        }
        if (data2?.usage) data.usage = data2.usage;
      } catch (e) {
        console.error('[v12-flow] non-streaming continuation failed', e);
        break;
      }
    }

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
            const res2 = await callUpstreamTokenSafe({
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

    // Narration repair (non-streaming API clients): same dots-3 "note"
    // behavior — the model answered with its internal analysis. Detect +
    // rewrite into the direct final answer (LLM pass, then local strip).
    if (NARRATION_START_RE.test(content.trimStart())) {
      let repaired = '';
      try {
        repaired = await repairNarration(content, isTH ? 12_000 : undefined);
      } catch (e) {
        console.error('[v12-flow] narration repair failed (non-streaming)', e);
      }
      if (repaired) {
        console.log('[v12-flow] narration repaired (non-streaming) —', repaired.length, 'chars');
        content = repaired;
        if (data?.choices?.[0]?.message) data.choices[0].message.content = content;
      } else {
        const stripped = localStripNarration(content);
        if (stripped !== content) {
          console.log('[v12-flow] narration locally stripped (non-streaming) —', stripped.length, 'chars');
          content = stripped;
          if (data?.choices?.[0]?.message) data.choices[0].message.content = content;
        }
      }
    }

    // Reasoning tags → structured output items (frontend collapsible block).
    let reasoningOutput = parseCompleteOutput(content);
    if (reasoningOutput.length) {
      content = stripReasoningTags(content);
      if (data?.choices?.[0]?.message) data.choices[0].message.content = content;
      if (isTH) {
        // Flash tier: thinking is OFF — the model leaked <thinking> blocks
        // inside the content anyway. Keep the stripped answer, DROP the
        // reasoning items: no collapsible block, direct answer only.
        reasoningOutput = [];
      } else {
        data.output = reasoningOutput;
      }
    } else {
      // Native reasoning (Kilo gateway & OpenRouter-style providers): the
      // chain-of-thought arrives in `message.reasoning`, separate from the
      // content → structured output items.
      const native = data?.choices?.[0]?.message?.reasoning;
      if (!isTH && typeof native === 'string' && native.trim()) {
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
    // Thinking-only completion guard (non-streaming variant): a complete
    // response whose content is empty while reasoning exists — convert the
    // notes into the final answer instead of persisting an empty message
    // with a bare thinking block.
    if (!String(content ?? '').trim() && reasoningOutput.length) {
      const notes = reasoningTextFromOutput(reasoningOutput);
      if (notes.trim()) {
        let salvaged = '';
        try {
          salvaged = await repairNarration(notes, isTH ? 12_000 : undefined);
        } catch (e) {
          console.error('[v12-flow] thinking-only completion repair failed (non-streaming)', e);
        }
        if (salvaged.trim()) {
          console.log(
            `[v12-flow] thinking-only completion (non-streaming) — notes converted into a ${salvaged.length}-char final answer`
          );
          content = salvaged;
          if (data?.choices?.[0]?.message) data.choices[0].message.content = content;
          // Compose the MESSAGE item into the output (thought blocks + the
          // salvaged answer) — the output-driven renderer needs it, while the
          // OpenAI JSON consumers read message.content as usual.
          if (data) {
            data.output = [...reasoningOutput, assistantMessageOutputItem(salvaged)];
          }
          reasoningOutput = [...reasoningOutput, assistantMessageOutputItem(salvaged)];
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
      await clearThinkingStatus(); // non-streaming: content arrives whole
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
    // Continuation seeding: the interrupted round's partial text starts INSIDE
    // `aggregate` and the native accumulator — every emitted snapshot then
    // carries base+new (the frontend REPLACES output/content wholesale, so
    // without the seed the first event would wipe the partial code off the
    // screen), and the final done event naturally carries the full text.
    let aggregate = contBase?.content ?? '';
    let usage: any = null;

    // Reasoning tag detection (Python tag_output_handler port): plain-choices
    // deltas until a tag appears, then structured `output` snapshots.
    // Flash tier (TokenHarbor — thinking DISABLED at the model level): drop
    // mode enforces the no-thinking contract on OUR side — any <thinking>/
    // etc. block the model leaks into the content stream (hybrid models
    // occasionally disobey the wire-level switch) is stripped, never
    // structured, never rendered; the clean answer streams as plain deltas.
    const reasoning = new ReasoningAccumulator(isTH ? { dropReasoning: true } : {});
    let lastStructuredEmit = 0;
    const emitStructured = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastStructuredEmit < 120) return;
      lastStructuredEmit = now;
      const output = reasoning.snapshot(now);
      if (output.length) {
        await emit({
          type: 'chat:completion',
          data: {
            id: completionId,
            done: false,
            output: contBase ? [...contBase.output, ...output] : output,
          },
        });
      }
    };

    // Native reasoning channel (Kilo gateway / OpenRouter-style providers):
    // `delta.reasoning` carries the chain-of-thought separately from the
    // content — full structured `output` snapshots from the first chunk on.
    // Continuation rounds use a distinct item-id suffix: the round's thinking
    // renders as its own block while the (seeded) message item carries the
    // full base+new content under the round's own id.
    const nativeReasoning = new NativeReasoningAccumulator(isContinuation ? '_c' : '');
    if (contBase?.content) nativeReasoning.pushContent(contBase.content);
    let lastNativeEmit = 0;
    const emitNative = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastNativeEmit < 120) return;
      lastNativeEmit = now;
      const output = nativeReasoning.snapshot(now);
      if (output.length) {
        await emit({
          type: 'chat:completion',
          data: {
            id: completionId,
            done: false,
            output: contBase ? [...contBase.output, ...output] : output,
          },
        });
      }
    };

    // Thinking-phase UX: announce the block immediately so the user sees
    // "Réflexion" during the (possibly silent) thinking phase instead of
    // staring at nothing, and anchor the duration to the request send so the
    // final "Réflexion pendant N secondes" reflects the real thinking time.
    // With the skill gate no longer holding reasoning, incremental providers
    // stream their chain-of-thought LIVE into this block as it is produced;
    // a provider that genuinely buffers server-side still lands one burst,
    // which the paced reveal below types out progressively.
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
          ...(usedSkills.length || usedConnectors.length ? { meta: { ...(usedSkills.length ? { used_skills: usedSkills } : {}), ...(usedConnectors.length ? { used_connectors: usedConnectors } : {}) } } : {}),
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
      // Visible reasoning = live feedback: the "Réflexion" status row
      // hands over to the real thinking block.
      await clearThinkingStatus();
      await emitNative(!wasActive); // first chunk → force the switch
    };

    // Narration hold-back (dots-3 "note" behavior): on ambiguous
    // search-augmented questions the model opens with its internal analysis
    // ("The user is asking… Looking at the sources…"). Hold the first ~60
    // chars until narration vs answer is decidable: narration is fully held
    // back (the UI shows no text meanwhile) and rewritten by the repair call
    // at stream end; a clean answer is released untouched.
    let narrationBuf = '';
    // Continuation rounds start mid-code: the narration hold-back (and its
    // stream-end repair, which would rewrite base+new as one text) must never
    // engage — everything flows through untouched.
    let narrationMode: 'buffering' | 'suppressing' | 'passthrough' = isContinuation
      ? 'passthrough'
      : 'buffering';
    const narrationPush = (delta: string): string => {
      if (narrationMode === 'passthrough') return delta;
      narrationBuf += delta;
      const lead = narrationBuf.trimStart();
      if (narrationMode === 'buffering' && lead.length >= 60) {
        if (NARRATION_START_RE.test(lead)) {
          narrationMode = 'suppressing';
          console.log('[v12-flow] narration prefix detected — holding content until the repair pass');
        } else {
          narrationMode = 'passthrough';
          return narrationBuf;
        }
      }
      return '';
    };

    // Typing-smoothness valve (streaming UX): the free upstream + the SSE
    // hop deliver content in coarse bursts — measured live: 167 chars in a
    // single frame at first token, then ~50-char hops every ~200ms. That
    // reads as "flashes", not as ChatGPT-style typing. The valve re-slices
    // every outgoing content delta into ≤24-char pieces paced 24ms apart
    // (~1000 chars/s ceiling — above the model's natural rate, so it only
    // engages on bursts), with instant catch-up whenever the upstream is
    // slower than the pace (no artificial delay is ever added: the wait is
    // skipped entirely when we are already behind).
    let lastContentEmitAt = 0;
    const CONTENT_PACE_MS = 24;
    const CONTENT_PACE_CHUNK = 24;
    // One-shot first-token marker — closes the Réflexion-span measurement
    // (flowT0 → … → upstream connect → FIRST TOKEN on the wire).
    let firstTokenLogged = false;
    const emitContentDelta = async (text: string): Promise<void> => {
      if (!firstTokenLogged) {
        firstTokenLogged = true;
        console.log(`[v12-flow] first token emitted ${phaseMs('first-token')}`);
      }
      let buf = text;
      while (buf.length) {
        const wait = lastContentEmitAt + CONTENT_PACE_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const piece = buf.slice(0, CONTENT_PACE_CHUNK);
        buf = buf.slice(CONTENT_PACE_CHUNK);
        lastContentEmitAt = Date.now();
        await emit({
          type: 'chat:completion',
          data: {
            id: completionId,
            done: false,
            choices: [{ index: 0, delta: { content: piece } }],
          },
        });
      }
    };

    // Continuation-round tag routing: the plain-append shortcut must never
    // paste RAW reasoning-tag prose into the answer content. A model that
    // opens the continuation with <thinking>/… (re-thinking) needs its tags
    // PARSED — a lookahead flag flips the round into tag-accumulator mode the
    // moment the round's new content starts with a reasoning opening tag
    // (partial-chunk safe: prefix matching), the base content is seeded into
    // the accumulator, and every further delta flows through the structured
    // path — thinking blocks + clean answer, exactly like a first round.
    let contTagMode = false;
    let contRoundNewContent = '';
    const contOpensWithReasoningTag = (text: string): boolean => {
      const t = text.replace(/^\s+/, '');
      if (t.length < 2) return false;
      for (const [start] of REASONING_TAG_PAIRS) {
        const n = Math.min(start.length, t.length);
        if (t.slice(0, n) === start.slice(0, n)) return true;
      }
      return false;
    };
    const processContentDelta = async (delta: string): Promise<void> => {
      aggregate += delta;
      if (contBase && !nativeReasoning.active) {
        contRoundNewContent += delta;
        if (
          !contTagMode &&
          contRoundNewContent.length <= 4_000 &&
          contOpensWithReasoningTag(contRoundNewContent)
        ) {
          contTagMode = true;
          console.log(
            '[v12-flow] continuation round opens with a reasoning tag — routing through the tag accumulator'
          );
          // Seed the interrupted base BEFORE the round's own deltas so the
          // structured message item carries base+new (the accumulator is
          // fresh per round; without the seed the final content would drop
          // the previous rounds' partial answer).
          if (contBase.content) reasoning.push(contBase.content);
        }
        if (!contTagMode) {
        // Continuation round before any (new) reasoning: plain append — the
        // base already rides `aggregate` and the screen; no narration valve,
        // no <think> tag detection on mid-code text. Once reasoning for this
        // round arrives, the native branch takes over (snapshots carry the
        // seeded base+new content).
          await clearThinkingStatus();
          await emitContentDelta(delta);
          return;
        }
        // contTagMode: fall through to the structured accumulator paths below.
      }
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
          const visible = narrationPush(r.plainDelta);
          if (visible) {
            await clearThinkingStatus();
            await emitContentDelta(visible);
          }
        }
      }
    };

    // One-shot leak log for the flash tier (reasoning deltas dropped below).
    let thReasoningLeakLogged = false;
    /** Upstream finish_reason of the CURRENT stream ("length" = output-token
     *  cap hit — feeds the token-limit auto-continue below). */
    let upstreamFinishReason: string | null = null;
    /** Why the flow took the graceful truncation path — surfaced in the
     *  nelth:continue marker and the logs. */
    let truncationReason: 'time-budget' | 'token-limit' = 'time-budget';
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
        // finish_reason ride-along: "length" means the model STILL had more
        // to say but an output cap cut it — consumed at stream end
        // (consumeUpstream) for the auto-continue chain.
        const finishReason = obj?.choices?.[0]?.finish_reason;
        if (typeof finishReason === 'string' && finishReason) upstreamFinishReason = finishReason;
        const delta: string = obj?.choices?.[0]?.delta?.content ?? '';
        const reasoningDelta: string =
          (typeof obj?.choices?.[0]?.delta?.reasoning === 'string'
            ? obj.choices[0].delta.reasoning
            : '') ||
          (typeof obj?.choices?.[0]?.delta?.reasoning_content === 'string'
            ? obj.choices[0].delta.reasoning_content
            : '');
        if (reasoningDelta) {
          // LIVE reasoning through the skill gate: the USE_SKILL marker can
          // only ever appear in the CONTENT channel, so reasoning deltas
          // never affect the gate decision — stream them to the user the
          // moment they arrive. (The old pendingReasoning buffer held the
          // ENTIRE chain-of-thought silently through the thinking phase: a
          // thinking model produces reasoning for ~20-30s BEFORE any content
          // exists, so the user stared at a bare "Réflexion" placeholder and
          // only saw the full reasoning text in one frame when the first
          // content chunk finally decided the gate — the exact bug this fixes.)
          if (isTH) {
            // Flash tier: thinking is OFF — the free gateway/model
            // occasionally leaks delta.reasoning anyway. DROP it: the
            // chain-of-thought is never rendered, whatever the model does.
            if (!thReasoningLeakLogged) {
              thReasoningLeakLogged = true;
              console.log(
                '[v12-flow] TH flash reasoning leak — dropped (thinking is disabled for this model)'
              );
            }
          } else {
            await processReasoningDelta(reasoningDelta);
          }
        }
        if (delta) {
          if (skillGate && !skillGate.decided) {
            const action = skillGate.push(delta);
            if (action === 'plain') {
              // Marker definitively absent → release the held content prefix
              // and stream on. (Reasoning was already streamed live above —
              // nothing reasoning-side is ever held.)
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
        // done_reason parity with finish_reason ("length" = output cap).
        if (obj?.done && typeof obj?.done_reason === 'string' && obj.done_reason) {
          upstreamFinishReason = obj.done_reason;
        }
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
            const visible = narrationPush(r.plainDelta);
            if (visible) {
              await clearThinkingStatus();
              await emitContentDelta(visible);
            }
          }
        }
      }
    };

    /** Compute the round's current full text (continuation-aware: the base
     *  is seeded inside aggregate / the native accumulator, so this is always
     *  base+new — what finalizeTruncated persists and what the auto-continue
     *  round would re-load as ITS base). */
    const currentRoundText = (): string => {
      try {
        if (nativeReasoning.active) {
          return getOutputText(nativeReasoning.snapshot(Date.now()) as any) || aggregate;
        }
        const snap = reasoning.snapshot(Date.now()) as any;
        return getOutputText(snap) || aggregate;
      } catch {
        return aggregate;
      }
    };

    /**
     * Graceful time-budget truncation (serverless auto-continue).
     *
     * A thinking-model generation of a very long code file can outrun the
     * platform's maxDuration (Vercel caps a function at 300s on this plan —
     * measured repro: 53.9KB of landing-page code streamed, then the raw
     * "Chat completion stream failed" banner). The SAME graceful path now
     * covers the output-token cap: finish_reason "length" (gateway cap or
     * user params.max_tokens on an external model) triggers the identical
     * auto-continue chain — « max tokens infinie »: the answer keeps flowing
     * in fresh rounds until the model stops naturally. Instead of a banner:
     *
     *   1. emit `nelth:continue` — a bridge-private marker (an unknown event
     *      type for the compiled frontend: harmless without the bridge);
     *   2. persist the partial answer (done:false, raw text intact) so the
     *      continuation round and any reload see exactly where it stopped;
     *   3. emit the normal done event carrying the partial — the loader.js
     *      SSE bridge WITHHOLDS it and re-requests with __nelth_continue (a
     *      fresh serverless invocation with its own full budget), piping the
     *      continuation's events into the same message: the code continues in
     *      ONE message, no user action. Without the bridge (native socket
     *      topology, outdated cache) the done event simply finalizes the
     *      partial — graceful either way, never an error banner.
     */
    const finalizeTruncated = async (): Promise<Response> => {
      const nativeFinish = nativeReasoning.finish();
      let truncatedOutput: any[] | null;
      let truncatedContent: string;
      if (nativeFinish.usedStructured) {
        const nativeOut = nativeFinish.output ?? [];
        truncatedOutput = contBase ? [...contBase.output, ...nativeOut] : nativeOut;
        truncatedContent = nativeFinish.content;
      } else {
        const fr = reasoning.finish();
        const tagOut = fr.output ?? [];
        truncatedOutput = fr.usedStructured ? (contBase ? [...contBase.output, ...tagOut] : tagOut) : null;
        truncatedContent = fr.usedStructured || reasoning.dropped ? fr.content : aggregate;
      }
      console.warn(
        truncationReason === 'token-limit'
          ? `[v12-flow] output-token cap hit mid-generation (finish_reason "length") — ` +
              `truncated at ${truncatedContent.length} chars for auto-continue`
          : `[v12-flow] time budget exhausted mid-generation (${FLOW_WALL_MS}ms) — ` +
              `truncated at ${truncatedContent.length} chars for auto-continue`
      );
      // Round bookkeeping (server-side chain state): a round that ended with
      // NO answer text — only reasoning blocks — is a THINKING-ONLY round.
      // Left unchecked the auto-continue loop re-thinks from scratch every
      // round (notes never ride into the context) and stacks one « Réflexion »
      // block per round over a message that never gets its answer.
      contRoundCount += 1;
      const thinkingOnlyRound =
        !String(truncatedContent ?? '').trim() &&
        (Array.isArray(truncatedOutput) && truncatedOutput.some((it: any) => it?.type === 'reasoning'));
      thinkingRoundStreak = thinkingOnlyRound ? thinkingRoundStreak + 1 : 0;
      const chainMeta = {
        nelth_cont_round: contRoundCount,
        nelth_thinking_rounds: thinkingRoundStreak,
      };
      // Chain stop — two consecutive thinking-only rounds (a convert round
      // itself produced no answer: the model is pathologically re-analyzing)
      // or five rounds total (degenerate content-creep loop). One last
      // salvage: a repair call converts the accumulated notes into the final
      // answer; on failure the message finalizes WITHOUT the nelth:continue
      // marker so the chain ends here instead of stacking another block.
      if (thinkingRoundStreak >= 2 || contRoundCount >= 5) {
        console.warn(
          `[v12-flow] auto-continue chain stop — round ${contRoundCount}, thinking-only streak ${thinkingRoundStreak}; attempting notes salvage`
        );
        let salvaged = '';
        const notes = reasoningTextFromOutput(truncatedOutput);
        if (notes.trim()) {
          try {
            salvaged = await repairNarration(notes, isTH ? 12_000 : 25_000);
          } catch (e) {
            console.error('[v12-flow] thinking-notes salvage repair failed', e);
          }
        }
        await clearThinkingStatus();
        if (salvaged.trim()) {
          console.log(
            `[v12-flow] thinking-only chain — notes salvaged into a ${salvaged.length}-char final answer`
          );
          await emitContentDelta(salvaged);
          // Compose the MESSAGE item into the output array (thought blocks +
          // salvaged answer): the frontend renders the message item as the
          // answer text — an output array without one would render ONLY the
          // thought blocks and drop the salvaged answer.
          const salvageOutput = [...(truncatedOutput ?? []), assistantMessageOutputItem(salvaged)];
          await persistAssistant(salvaged, usage, true, salvageOutput, null, salvaged, {
            ...chainMeta,
            nelth_thinking_rounds: 0,
          });
          finishTask();
          await emit({
            type: 'chat:completion',
            data: {
              done: true,
              output: salvageOutput,
              content: salvaged,
              ...(usage ? { usage } : {}),
              ...(webCitations?.length ? { sources: webCitations } : {}),
            },
          });
          return nullJson();
        }
        // Salvage failed — finalize the partial as done (no marker, no more
        // rounds: better a short honest stop than an endless thinking loop).
        await persistAssistant(truncatedContent, usage, true, truncatedOutput, null, truncatedContent, {
          truncated: true,
          file_intent: userAskedForFile,
          ...chainMeta,
        });
        finishTask();
        await emit({
          type: 'chat:completion',
          data: {
            done: true,
            ...(truncatedOutput ? { output: truncatedOutput, content: truncatedContent } : { content: truncatedContent }),
            ...(usage ? { usage } : {}),
            ...(webCitations?.length ? { sources: webCitations } : {}),
          },
        });
        return nullJson();
      }
      await clearThinkingStatus();
      await emit({
        type: 'nelth:continue',
        data: { reason: truncationReason, contentLength: truncatedContent.length },
      });
      await emit({
        type: 'status',
        data: {
          action: 'chat',
          description:
            truncationReason === 'token-limit'
              ? 'Limite de tokens atteinte — poursuite automatique…'
              : 'Génération longue — poursuite automatique…',
          done: true,
        },
      });
      await persistAssistant(truncatedContent, usage, false, truncatedOutput, null, truncatedContent, {
        truncated: true,
        file_intent: userAskedForFile,
        ...chainMeta,
      });
      finishTask();
      await emit({
        type: 'chat:completion',
        data: {
          done: true,
          ...(truncatedOutput ? { output: truncatedOutput, content: truncatedContent } : { content: truncatedContent }),
          ...(usage ? { usage } : {}),
          ...(webCitations?.length ? { sources: webCitations } : {}),
        },
      });
      return nullJson();
    };

    const consumeUpstream = async (
      response: Response
    ): Promise<'completed' | 'restarted' | 'truncated'> => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      upstreamFinishReason = null; // per-stream: pass 2 overwrites pass 1
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
          // Time-budget abort with a substantial partial → graceful
          // truncation for the auto-continue chain (no error banner — the
          // exact "Chat completion stream failed on long code" complaint).
          // Anything else (early network failure, empty stream) keeps the
          // original error surface.
          const timedOut =
            callTimedOut() ||
            (e as any)?.name === 'TimeoutError' ||
            (e as any)?.name === 'AbortError';
          if (timedOut && currentRoundText().trim() && sessionId && chatId) {
            return 'truncated';
          }
          console.error('[v12-flow] stream error', e);
          await clearThinkingStatus();
          await emit({
            type: 'chat:message:error',
            data: { error: { content: 'Chat completion stream failed' }, done: true },
          });
        }
        return 'completed';
      }
      // Output-token cap hit cleanly (stream ended, finish_reason "length"):
      // the model still had more to say. « Max tokens infinie » — chain a
      // fresh auto-continue round instead of ending the answer mid-word.
      // An EXPLICIT user cap (params.max_tokens) is a deliberate choice and
      // is respected — no forced continuation.
      // Short streams can still be wholly held by the undecided skill gate
      // (< 160 chars) — flush it through the normal machinery FIRST so the
      // round text (and the persisted partial) carry the held prefix. The
      // post-pass flush below is idempotent (buffer already drained).
      if (skillGate && !skillGate.decided) {
        const flush = skillGate.flushPlain();
        if (flush) await processContentDelta(flush);
      }
      if (
        upstreamFinishReason === 'length' &&
        !userCappedOutput &&
        currentRoundText().trim() &&
        sessionId &&
        chatId
      ) {
        truncationReason = 'token-limit';
        return 'truncated';
      }
      return 'completed';
    };

    // Pass 1 (gated). A USE_SKILL(name) first line restarts the completion
    // with that ONE pack's full instructions injected after the model's own
    // marker message — a tool-call round trip. The 19 other packs never
    // enter the context (Claude.ai-style lazy loading).
    let pass2Truncated = false;
    const pass1 = await consumeUpstream(upstream);
    // Time budget exhausted mid-code (pass 1) → graceful truncation: the
    // auto-continue chain takes over; nothing after this point should run.
    if (pass1 === 'truncated') {
      return await finalizeTruncated();
    }
    // Stream ended before the gate could decide (very short answer, no
    // marker): release the held content tokens through the normal machinery
    // (reasoning already streamed live — nothing to release there).
    if (pass1 === 'completed' && skillGate && !skillGate.decided) {
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
          let res2 = await callUpstreamTokenSafe({
            ...reqBody,
            messages: await buildSkillInjectionMessages(llmMessages, skill),
          });
          if ((isKilo || isTH) && res2.status === 400) {
            const probe = await res2.clone().text().catch(() => '');
            if (/bad request|Provider returned error/i.test(probe)) {
              console.warn('[v12-flow] skill pass-2 gateway 400 flake — retrying');
              res2 = await callUpstreamTokenSafe({
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
          const pass2 = await consumeUpstream(res2);
          if (pass2 === 'truncated') {
            pass2Truncated = true;
          }
        } catch (e) {
          if (!taskSignal.aborted) {
            // The pass-2 call itself died (rare: TTFB longer than the budget
            // remainder). With streamed partial content this is still the
            // graceful truncation path — otherwise the original error banner.
            const timedOut =
              callTimedOut() ||
              (e as any)?.name === 'TimeoutError' ||
              (e as any)?.name === 'AbortError';
            if (timedOut && aggregate.trim() && sessionId && chatId) {
              pass2Truncated = true;
            } else {
              console.error('[v12-flow] skill pass-2 failed', e);
              await emit({
                type: 'chat:message:error',
                data: { error: { content: 'Chat completion stream failed' }, done: true },
              });
            }
          }
        } finally {
          await emit({
            type: 'status',
            data: { action: 'skill', description: `Skill « ${skillLabel} » chargé`, done: true },
          });
        }
      }
    }
    // Truncation hit during the skill pass-2 stream → same graceful path.
    if (pass2Truncated) {
      return await finalizeTruncated();
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
      // Continuation rounds: keep the interrupted rounds' reasoning items
      // ahead of this round's — the done event replaces the whole output
      // array on the frontend (and persistence) with the composed history.
      const nativeOut = nativeFinish.output ?? [];
      finalOutput = contBase ? [...contBase.output, ...nativeOut] : nativeOut;
      finalContent = nativeFinish.content;
    } else {
      const finalReasoning = reasoning.finish();
      const tagOut = finalReasoning.output ?? [];
      finalOutput = finalReasoning.usedStructured
        ? contBase
          ? [...contBase.output, ...tagOut]
          : tagOut
        : null;
      finalContent = finalReasoning.usedStructured || reasoning.dropped ? finalReasoning.content : aggregate;
    }

    // Thinking-only completion guard (no truncation involved): the round
    // ENDED cleanly (finish stop / stream end) but produced only reasoning
    // blocks — no answer text at all. Convert the notes into the final answer
    // with a repair call so the message never finalizes as a stack of
    // « Réflexion » blocks over an empty answer. The output array (this round
    // OR the previous rounds' persisted items) then gets the composed MESSAGE
    // item — without it the frontend renders the thought blocks and drops the
    // repaired answer text.
    const guardOutput = Array.isArray(finalOutput) ? finalOutput : contBase?.output;
    if (
      !finalContent.trim() &&
      Array.isArray(guardOutput) &&
      guardOutput.some((it: any) => it?.type === 'reasoning')
    ) {
      const notes = reasoningTextFromOutput(guardOutput);
      let salvaged = '';
      try {
        salvaged = await repairNarration(notes, isTH ? 12_000 : undefined);
      } catch (e) {
        console.error('[v12-flow] thinking-only completion repair failed', e);
      }
      if (salvaged.trim()) {
        console.log(
          `[v12-flow] thinking-only completion — notes converted into a ${salvaged.length}-char final answer`
        );
        finalContent = salvaged;
        finalOutput = [...guardOutput, assistantMessageOutputItem(salvaged)];
      }
    }
    // Continuation round that answered in PLAIN mode over a structured
    // history: without a composed message item the frontend keeps rendering
    // the previous rounds' reasoning blocks and NEVER shows this round's
    // answer (the persisted output lingers through the upsert merge).
    if (
      !finalOutput &&
      (contBase?.output?.length ?? 0) > 0 &&
      finalContent.trim()
    ) {
      finalOutput = [...contBase.output, assistantMessageOutputItem(finalContent)];
    }

    // Short-answer flush: an answer under the 60-char narration threshold
    // never left the hold-back buffer — the user watched a bare generating
    // state and got the whole text in one block with the done event (the
    // measured "bonjour" case: zero content deltas). Release it through the
    // paced valve so even a one-liner types out; a short NARRATION prefix
    // still routes to the repair pass below.
    if (narrationMode === 'buffering' && narrationBuf.trim()) {
      if (NARRATION_START_RE.test(narrationBuf.trimStart())) {
        narrationMode = 'suppressing';
      } else {
        narrationMode = 'passthrough';
        await clearThinkingStatus();
        await emitContentDelta(narrationBuf);
      }
      narrationBuf = '';
    }

    // Agent-skill marker hygiene: the gate consumed the leading USE_SKILL
    // marker; strip any late/mid-text leak so neither the UI nor the next
    // turn's LLM context ever sees the protocol.
    if (finalContent.includes('USE_SKILL')) {
      const { stripSkillMarkers } = await import('@/lib/skills/registry');
      finalContent = stripSkillMarkers(finalContent);
    }

    // Narration repair: the stream-time filter held the model's internal
    // analysis (English "note" narration on ambiguous search questions) out
    // of the UI the whole stream. Convert it into the clean final answer —
    // the done event below carries `content`, which REPLACES the message
    // content on the frontend, so the user goes straight from the generating
    // state to the clean answer. On repair failure the LOCAL STRIP runs
    // before the raw fallback: the flash-style narration is a leading
    // paragraph with the real answer right after it, so dropping the prefix
    // keeps the answer clean without another gateway round-trip.
    if (narrationMode === 'suppressing' && finalContent.trim()) {
      // Flash models (TokenHarbor): short cap on the LLM repair — the free
      // gateway is slow on non-streaming calls and the flow wall is mostly
      // spent by the main stream; fail fast, strip locally.
      let repaired = '';
      try {
        repaired = await repairNarration(finalContent, isTH ? 12_000 : undefined);
      } catch (e) {
        console.error('[v12-flow] narration repair failed — trying the local strip', e);
      }
      if (repaired) {
        console.log('[v12-flow] narration repaired —', repaired.length, 'chars');
        finalContent = repaired;
        finalOutput = null;
      } else {
        const stripped = localStripNarration(finalContent);
        if (stripped !== finalContent) {
          console.log(
            '[v12-flow] narration locally stripped —',
            finalContent.length,
            '→',
            stripped.length,
            'chars'
          );
          finalContent = stripped;
          finalOutput = null;
        }
      }
    }

    // Flash tier: the narration-repair round-trip (and any late leak on the
    // main stream) is itself a flash call — strip any <thinking> block the
    // repair answer carries (the streaming drop mode above covers only the
    // delta path, not the non-streaming repair content).
    if (isTH) {
      const strippedFinal = stripReasoningTags(finalContent);
      if (strippedFinal !== finalContent) {
        console.log('[v12-flow] TH flash — thinking leak stripped from final content');
        finalContent = strippedFinal;
        finalOutput = null;
      }
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

    // Last-resort clear: covers empty answers / aborted streams that never
    // emitted a single content or reasoning delta.
    await clearThinkingStatus();
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
                  ...(usedSkills.length || usedConnectors.length ? { meta: { ...(usedSkills.length ? { used_skills: usedSkills } : {}), ...(usedConnectors.length ? { used_connectors: usedConnectors } : {}) } } : {}),
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
              res2 = await callUpstreamTokenSafe({ ...reqBody, messages: messages2 });
              if ((isKilo || isTH) && res2.status === 400) {
                const probe = await res2.clone().text().catch(() => '');
                if (/bad request|Provider returned error/i.test(probe)) {
                  console.warn('[v12-flow] 5c skill pass-2 gateway 400 flake — retrying');
                  res2 = await callUpstreamTokenSafe({
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

    // Keyless fallback: the direct helper bridges to the z-ai engine when
    // the Kilo gateway is not configured.
    {
      const { isKiloModel, kiloFallbackActive, kiloGenerateTitle } = await import('@/lib/kilo-llm');
      if (route.type === 'openai' && isKiloModel(route.model) && kiloFallbackActive()) {
        return await kiloGenerateTitle(prompt);
      }
    }

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
    // TokenHarbor flash model → thinking disabled for titles (direct answer).
    const { isTokenharborModel } = await import('@/lib/tokenharbor-llm');
    if (isTokenharborModel(route.model)) {
      body.thinking = { type: 'disabled' };
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
    // Flash tier: strip any thinking leak from the title text (same contract
    // as the main flow — thinking is disabled for this model).
    if (isTokenharborModel(route.model)) content = stripReasoningTags(content);

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
