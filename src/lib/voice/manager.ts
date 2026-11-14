/**
 * VoiceSessionManager — the real-time full-duplex orchestrator.
 *
 * Per voice session:
 *   • browser streams PCM16 chunks → POST /api/voice/audio → forwarded to
 *     the remote sherpa-onnx STT host (partial transcripts come back);
 *   • Silero VAD end-of-turn (or manual flush) → stt.final;
 *   • the final transcript enters the EXISTING conversation pipeline:
 *     persisted into the chat history (user message), then the LLM
 *     (Nemotron via Kilo, thinking disabled) streams tokens;
 *   • the sentence chunker emits natural segments → Edge TTS synthesizes
 *     each while the LLM keeps generating → audio reaches the browser
 *     before the full response exists;
 *   • interruption (browser barge-in VAD or the stop button) aborts the
 *     LLM, cancels TTS, drops queued audio and resets the STT turn — the
 *     microphone NEVER stops (full duplex);
 *   • assistant.finished persists the answer to the same chat.
 *
 * Concurrency/memory guards: max sessions, max audio bytes, max TTS queue
 * depth (backpressure), idle GC, hard duration cap.
 */

import type { ApiUser } from '@/lib/auth';
import {
  insertNewChat,
  getChatById,
  updateChatById,
  getChatMessagesMapByChatId,
  getMessageList,
  upsertMessageToChatByIdAndMessageId,
} from '@/lib/models/chats';
import { voiceEvent, type VoiceEvent } from './protocol';
import {
  VOICE_MAX_SESSION_DURATION_SEC,
  VOICE_MAX_AUDIO_SIZE,
  VOICE_TTS_QUEUE_MAX,
  VOICE_DEFAULT_LANGUAGE,
  VOICE_INTERRUPTION_ENABLED,
  VOICE_VAD_SILENCE_MS,
  STT_MODEL,
} from './config';
import { sttCreateSession, sttFeedAudio, sttFlush, sttReset, sttDrop } from './stt-client';
import { makeVoiceLlm } from './llm';
import { SentenceChunker } from './chunker';
import { makeTtsProvider } from './tts';
import { resolveVoice } from './voices';

const MAX_SESSIONS = 40;

const VOICE_SYSTEM_PROMPT = [
  'Tu es Nelth-IA, l\'assistante vocale de l\'application Nelth-IA.',
  'Réponds de façon naturelle et parlée, comme dans une conversation téléphonique.',
  'Réponses COURTES (1 à 4 phrases en général) — l\'utilisateur écoute, il ne lit pas.',
  'Pas de listes à puces, pas de tableaux, pas de blocs de code, pas de longues énumérations.',
  'Réponds dans la langue de l\'utilisateur (français par défaut).',
  'Si l\'utilisateur demande un travail long (document, code, tableau), propose de le préparer et résume le plan à l\'oral.',
].join(' ');

type Subscriber = (event: VoiceEvent) => void;

export type VoiceSession = {
  id: string;
  userId: string;
  sttSessionId: string | null;
  language: 'fr' | 'en';
  voice: string;
  speed: number;
  chatId: string | null;
  subscribers: Set<Subscriber>;
  createdAt: number;
  lastActivityAt: number;
  audioBytes: number;
  /** turn machine state */
  turnState: 'listening' | 'thinking' | 'speaking' | 'interrupted';
  assistantTurn: AbortController | null;
  /** guards duplicate turns while one is in flight */
  turnBusy: boolean;
  ended: boolean;
};

const sessions = new Map<string, VoiceSession>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function genId(): string {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(session: VoiceSession, event: VoiceEvent): void {
  for (const sub of session.subscribers) {
    try {
      sub(event);
    } catch {
      session.subscribers.delete(sub);
    }
  }
}

function scheduleGc(sessionId: string): void {
  const existing = timers.get(sessionId);
  if (existing) clearTimeout(existing);
  // Idle sweep every 60s; sessions die after 90s of total silence or the
  // hard duration cap. Serverless note: state lives in the running
  // instance (single warm instance / fluid compute — documented).
  const timer = setInterval(() => {
    const s = sessions.get(sessionId);
    if (!s) {
      clearInterval(timer);
      timers.delete(sessionId);
      return;
    }
    const idleMs = Date.now() - s.lastActivityAt;
    const lifeMs = Date.now() - s.createdAt;
    if (idleMs > 90_000 || lifeMs > VOICE_MAX_SESSION_DURATION_SEC * 1000) {
      clearInterval(timer);
      timers.delete(sessionId);
      endVoiceSession(sessionId, 'expired').catch(() => undefined);
    }
  }, 60_000);
  timer.unref?.();
  timers.set(sessionId, timer as any);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createVoiceSession(
  user: ApiUser,
  opts: { language?: 'fr' | 'en'; voice?: string; speed?: number; chatId?: string | null }
): Promise<VoiceSession> {
  if (sessions.size >= MAX_SESSIONS) {
    throw Object.assign(new Error('Trop de sessions vocales simultanées — réessayez dans un instant.'), { status: 429 });
  }
  const language = opts.language === 'en' ? 'en' : (VOICE_DEFAULT_LANGUAGE === 'en' ? 'en' : 'fr');
  const voice = resolveVoice(opts.voice, language);
  const speed = Math.min(2, Math.max(0.5, opts.speed ?? 1));

  let chatId = opts.chatId ?? null;
  if (chatId) {
    const chat = await getChatById(chatId);
    if (!chat || (chat as any).user_id !== user.id) chatId = null; // ownership check
  }

  let sttSessionId: string | null = null;
  try {
    const stt = await sttCreateSession(language, VOICE_VAD_SILENCE_MS);
    sttSessionId = stt.id;
  } catch (e) {
    // Session still created — audio posts will surface the error until the
    // STT host recovers (session.error carries the reason).
    console.error('[voice] STT session creation failed:', e);
  }

  const session: VoiceSession = {
    id: genId(),
    userId: user.id,
    sttSessionId,
    language,
    voice,
    speed,
    chatId,
    subscribers: new Set(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    audioBytes: 0,
    turnState: 'listening',
    assistantTurn: null,
    turnBusy: false,
    ended: false,
  };
  sessions.set(session.id, session);
  scheduleGc(session.id);

  const llm = makeVoiceLlm();
  emit(session, voiceEvent('session.ready', session.id, {
    language,
    voice,
    sttModel: STT_MODEL,
    llmModel: llm.model,
    ttsProvider: 'edge',
    chatId,
  }));
  return session;
}

export function getVoiceSession(sessionId: string, userId: string): VoiceSession | null {
  const s = sessions.get(sessionId);
  if (!s || s.userId !== userId || s.ended) return null;
  return s;
}

export function subscribe(session: VoiceSession, sub: Subscriber): () => void {
  session.subscribers.add(sub);
  return () => session.subscribers.delete(sub);
}

// ---------------------------------------------------------------------------
// Audio ingestion (full duplex — keeps flowing while the assistant speaks)
// ---------------------------------------------------------------------------

export async function ingestAudio(session: VoiceSession, pcm: Uint8Array): Promise<void> {
  session.lastActivityAt = Date.now();
  session.audioBytes += pcm.byteLength;
  if (session.audioBytes > VOICE_MAX_AUDIO_SIZE) {
    emit(session, voiceEvent('session.error', session.id, {
      stage: 'audio', message: 'Limite de taille audio de session atteinte.', recoverable: false,
    }));
    await endVoiceSession(session.id, 'audio-limit');
    return;
  }

  if (!session.sttSessionId) {
    try {
      const stt = await sttCreateSession(session.language, VOICE_VAD_SILENCE_MS);
      session.sttSessionId = stt.id;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('[voice] STT session creation failed:', reason);
      emit(session, voiceEvent('session.error', session.id, {
        stage: 'stt',
        message: `Service de reconnaissance vocale indisponible (${reason.slice(0, 140)}).`,
        recoverable: true,
      }));
      return;
    }
  }

  let result;
  try {
    result = await sttFeedAudio(session.sttSessionId, pcm);
  } catch (e) {
    console.error('[voice] STT feed failed:', e);
    session.sttSessionId = null; // force re-provision on next chunk
    return;
  }

  // 1) VAD events — relayed (speech_started matters for barge-in too).
  for (const ev of result.vad.events) {
    if (ev.type === 'speech_started') {
      // BARGE-IN: user speaks while Nelth-IA is talking → interrupt now.
      if (VOICE_INTERRUPTION_ENABLED && (session.turnState === 'speaking' || session.turnState === 'thinking')) {
        emit(session, voiceEvent('vad.interruption_detected', session.id));
        await interruptAssistant(session, 'vad');
      }
      emit(session, voiceEvent('vad.speech_started', session.id));
    } else if (ev.type === 'speech_ended') {
      emit(session, voiceEvent('vad.speech_ended', session.id));
    } else if (ev.type === 'turn_completed') {
      emit(session, voiceEvent('vad.turn_completed', session.id));
    }
  }

  // 2) Partial transcript — live UI.
  if (result.partial) {
    emit(session, voiceEvent('stt.partial', session.id, { text: result.partial }));
  }

  // 3) End of the user's turn → run the assistant turn.
  if (typeof result.final === 'string') {
    const text = result.final.trim();
    if (text.length > 0) {
      emit(session, voiceEvent('stt.final', session.id, { text }));
      void runAssistantTurn(session, text).catch(async (e) => {
        console.error('[voice] assistant turn failed:', e);
        emit(session, voiceEvent('session.error', session.id, {
          stage: 'llm', message: e instanceof Error ? e.message : 'Erreur de génération.', recoverable: true,
        }));
        session.turnState = 'listening';
        session.turnBusy = false;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Assistant turn — LLM streaming + concurrent sentence TTS
// ---------------------------------------------------------------------------

async function runAssistantTurn(session: VoiceSession, userText: string): Promise<void> {
  if (session.turnBusy) return;
  session.turnBusy = true;
  session.turnState = 'thinking';

  // 1) Ensure the conversation exists (existing history pipeline).
  let chatId = session.chatId;
  if (!chatId) {
    const id = crypto.randomUUID();
    const chat = await insertNewChat(id, session.userId, {
      chat: {
        title: userText.slice(0, 60) || 'Discussion vocale',
        models: [makeVoiceLlm().model],
      },
      // @ts-ignore — matches the existing ChatForm used by the chats router
    } as any, {});
    chatId = chat?.id ?? id;
    session.chatId = chatId;
  }

  // 2) Persist the USER message (existing conversation database).
  const userMessageId = crypto.randomUUID();
  await upsertMessageToChatByIdAndMessageId(chatId, userMessageId, {
    id: userMessageId,
    role: 'user',
    content: userText,
    done: true,
  } as any);

  // 3) Build the LLM context: system prompt + recent existing history.
  const messagesMap = await getChatMessagesMapByChatId(chatId);
  const history = getMessageList(messagesMap, userMessageId);
  const llmMessages: { role: string; content: string }[] = [{ role: 'system', content: VOICE_SYSTEM_PROMPT }];
  const recent = history.filter((m: any) => m?.role === 'user' || m?.role === 'assistant').slice(-13, -1);
  for (const m of recent) {
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.trim()) llmMessages.push({ role: m.role, content: content.slice(0, 1200) });
  }
  llmMessages.push({ role: 'user', content: userText });

  // 4) Stream the LLM while synthesizing sentences concurrently.
  const llm = makeVoiceLlm();
  const requestId = crypto.randomUUID();
  const abort = new AbortController();
  session.assistantTurn = abort;
  const chunker = new SentenceChunker();
  const tts = makeTtsProvider('edge', session.voice, { speed: session.speed });

  emit(session, voiceEvent('llm.started', session.id, { requestId, model: llm.model }));

  let ttsQueue: Promise<void> = Promise.resolve();
  let queuedSegments = 0;
  let ttsDegraded = false;
  let assistantText = '';

  const synthesizeSegment = async (sequenceId: number, text: string) => {
    if (abort.signal.aborted) return;
    emit(session, voiceEvent('tts.started', session.id, { sequenceId, text }));
    let seq = 0;
    try {
      for await (const buf of tts.synthesize(text)) {
        if (abort.signal.aborted) return;
        seq += 1;
        emit(session, voiceEvent('tts.audio_chunk', session.id, {
          sequenceId, seq, audioBase64: buf.toString('base64'), format: 'mp3',
        }));
      }
      if (seq === 0) throw new Error('TTS vide');
      emit(session, voiceEvent('tts.segment_completed', session.id, { sequenceId }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'échec TTS';
      // Edge TTS failure — NO fallback provider: report once, text remains
      // available (mission §19-F).
      if (!ttsDegraded) {
        ttsDegraded = true;
        emit(session, voiceEvent('tts.degraded', session.id, { provider: 'edge', reason: `Edge TTS indisponible (${msg.slice(0, 120)}) — aucune bascule automatique.` }));
        emit(session, voiceEvent('session.error', session.id, { stage: 'tts', message: 'Synthèse vocale indisponible — la réponse reste affichée.', recoverable: true }));
      }
    } finally {
      queuedSegments -= 1;
    }
  };

  try {
    const { text, truncated } = await llm.run(
      llmMessages,
      (token) => {
        assistantText += token;
        emit(session, voiceEvent('llm.token', session.id, { text: token }));
        for (const segment of chunker.push(token)) {
          if (queuedSegments >= VOICE_TTS_QUEUE_MAX) continue; // backpressure: text keeps flowing, TTS bounded
          queuedSegments += 1;
          ttsQueue = ttsQueue.then(() => synthesizeSegment(segment.sequenceId, segment.text));
        }
      },
      abort.signal
    );

    // Flush the trailing segment.
    for (const segment of chunker.flush()) {
      if (queuedSegments >= VOICE_TTS_QUEUE_MAX) continue;
      queuedSegments += 1;
      ttsQueue = ttsQueue.then(() => synthesizeSegment(segment.sequenceId, segment.text));
    }

    // Wait for the bounded TTS queue to drain (abort honored inside).
    await ttsQueue.catch(() => undefined);

    // 5) Persist the assistant message + close the turn.
    const assistantMessageId = crypto.randomUUID();
    const finalText = (text || assistantText).trim();
    if (finalText) {
      await upsertMessageToChatByIdAndMessageId(chatId, assistantMessageId, {
        id: assistantMessageId,
        role: 'assistant',
        content: finalText,
        done: true,
        model: llm.model,
        models: [llm.model],
      } as any);
      // Keep the branch pointer on the chat.
      await updateChatById(chatId, { current_message_id: assistantMessageId, models: [llm.model] } as any).catch(() => undefined);
    }

    if (abort.signal.aborted) {
      emit(session, voiceEvent('assistant.interrupted', session.id, { partialText: finalText }));
    } else {
      emit(session, voiceEvent('assistant.finished', session.id, {
        text: finalText, chatId, messageId: finalText ? assistantMessageId : null, truncated,
      }));
    }
  } finally {
    session.assistantTurn = null;
    session.turnBusy = false;
    session.turnState = 'listening';
  }
}

// ---------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------

export async function interruptAssistant(session: VoiceSession, source: 'vad' | 'user'): Promise<void> {
  session.lastActivityAt = Date.now();
  if (session.assistantTurn) {
    session.assistantTurn.abort();
    session.assistantTurn = null;
  }
  session.turnState = 'interrupted';
  if (session.sttSessionId) {
    await sttReset(session.sttSessionId);
  }
  emit(session, voiceEvent('vad.interruption_detected', session.id));
  emit(session, voiceEvent('assistant.interrupted', session.id, { partialText: '' }));
  session.turnState = 'listening';
  session.turnBusy = false;
}

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

export async function endVoiceSession(sessionId: string, reason: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.ended = true;
  if (session.assistantTurn) {
    session.assistantTurn.abort();
    session.assistantTurn = null;
  }
  if (session.sttSessionId) {
    await sttDrop(session.sttSessionId);
    session.sttSessionId = null;
  }
  emit(session, voiceEvent('session.ended', session.id));
  for (const sub of session.subscribers) {
    try { sub(voiceEvent('session.ended', session.id)); } catch { /* closing */ }
  }
  session.subscribers.clear();
  sessions.delete(sessionId);
  const timer = timers.get(sessionId);
  if (timer) {
    clearInterval(timer as any);
    timers.delete(sessionId);
  }
  console.log(`[voice] session ${sessionId} ended (${reason})`);
}
