/**
 * Voice event protocol — typed server→client events (SSE channel).
 * Client→server is plain HTTP: session / audio / interrupt / end.
 */

export type VoiceVadEventType =
  | 'vad.speech_started'
  | 'vad.speech_ended'
  | 'vad.silence_detected'
  | 'vad.interruption_detected'
  | 'vad.turn_completed';

export type VoiceEvent =
  | { type: 'session.ready'; sessionId: string; ts: number; payload: { language: string; voice: string; sttModel: string; llmModel: string; ttsProvider: string; chatId: string | null } }
  | { type: 'vad.speech_started'; sessionId: string; ts: number }
  | { type: 'vad.speech_ended'; sessionId: string; ts: number }
  | { type: 'vad.silence_detected'; sessionId: string; ts: number }
  | { type: 'vad.interruption_detected'; sessionId: string; ts: number }
  | { type: 'vad.turn_completed'; sessionId: string; ts: number }
  | { type: 'stt.partial'; sessionId: string; ts: number; payload: { text: string } }
  | { type: 'stt.final'; sessionId: string; ts: number; payload: { text: string } }
  | { type: 'llm.started'; sessionId: string; ts: number; payload: { requestId: string; model: string } }
  | { type: 'llm.token'; sessionId: string; ts: number; payload: { text: string } }
  | { type: 'tts.started'; sessionId: string; ts: number; payload: { sequenceId: number; text: string } }
  | { type: 'tts.audio_chunk'; sessionId: string; ts: number; payload: { sequenceId: number; seq: number; audioBase64: string; format: 'mp3' } }
  | { type: 'tts.segment_completed'; sessionId: string; ts: number; payload: { sequenceId: number } }
  | { type: 'tts.degraded'; sessionId: string; ts: number; payload: { provider: string; reason: string } }
  | { type: 'assistant.interrupted'; sessionId: string; ts: number; payload: { partialText: string } }
  | { type: 'assistant.finished'; sessionId: string; ts: number; payload: { text: string; chatId: string | null; messageId: string | null; truncated: boolean } }
  | { type: 'session.error'; sessionId: string; ts: number; payload: { stage: string; message: string; recoverable: boolean } }
  | { type: 'session.ended'; sessionId: string; ts: number };

export function voiceEvent(type: VoiceEvent['type'], sessionId: string, payload?: any): VoiceEvent {
  const base = { type, sessionId, ts: Date.now() } as VoiceEvent;
  if (payload !== undefined) (base as any).payload = payload;
  return base;
}
