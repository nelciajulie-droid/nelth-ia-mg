/**
 * Voice event protocol — typed server→client events (SSE channel).
 *
 * STT is CLIENT-side (@untemps/react-vocal, Web Speech API): interim /
 * final transcripts and speech events live in the browser and NEVER ride
 * this channel. The server side carries the assistant turn only:
 * LLM tokens + Edge TTS audio + lifecycle.
 */

export type VoiceEvent =
  | { type: 'session.ready'; sessionId: string; ts: number; payload: { language: string; voice: string; sttEngine: string; llmModel: string; ttsProvider: string; chatId: string | null } }
  | { type: 'vad.interruption_detected'; sessionId: string; ts: number }
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
