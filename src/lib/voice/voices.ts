/**
 * Voice catalogue — Edge TTS neural voices (French / English) + the z-ai
 * fallback voices. Malagasy: NOT offered — neither Edge TTS nor the z-ai
 * engine exposes a certified mg-MG voice (verified against the catalogues)
 * and the mission forbids inventing language support.
 */

import { VOICE_TTS_PROVIDER } from './config';

export type VoiceOption = {
  id: string; // wire id (edge: locale name; zai: voice key)
  label: string;
  language: 'fr' | 'en';
  gender: 'female' | 'male';
  provider: 'edge' | 'zai';
};

export const VOICES: VoiceOption[] = [
  // ---- Français (Edge TTS neural) ----
  { id: 'fr-FR-DeniseNeural', label: 'Denise', language: 'fr', gender: 'female', provider: 'edge' },
  { id: 'fr-FR-EloiseNeural', label: 'Éloïse', language: 'fr', gender: 'female', provider: 'edge' },
  { id: 'fr-FR-VivienneNeural', label: 'Vivienne', language: 'fr', gender: 'female', provider: 'edge' },
  { id: 'fr-FR-HenriNeural', label: 'Henri', language: 'fr', gender: 'male', provider: 'edge' },
  { id: 'fr-FR-RemyMultilangNeural', label: 'Rémy', language: 'fr', gender: 'male', provider: 'edge' },
  // ---- English (Edge TTS neural) ----
  { id: 'en-US-AriaNeural', label: 'Aria', language: 'en', gender: 'female', provider: 'edge' },
  { id: 'en-US-JennyNeural', label: 'Jenny', language: 'en', gender: 'female', provider: 'edge' },
  { id: 'en-US-GuyNeural', label: 'Guy', language: 'en', gender: 'male', provider: 'edge' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia', language: 'en', gender: 'female', provider: 'edge' },
  // ---- z-ai engine (keyless fallback hosts) ----
  { id: 'zai:tongtong', label: 'Tongtong', language: 'fr', gender: 'female', provider: 'zai' },
  { id: 'zai:xiaochen', label: 'Xiaochen', language: 'fr', gender: 'male', provider: 'zai' },
  { id: 'zai:jam', label: 'Jam', language: 'en', gender: 'male', provider: 'zai' },
];

/** Voices actually usable with the ACTIVE provider configuration. */
export function voicesFor(provider: string, language?: 'fr' | 'en'): VoiceOption[] {
  const active = provider === 'zai' ? 'zai' : 'edge';
  // Edge blocked hosts (sandbox 429) auto-expose zai voices instead.
  const list = VOICES.filter((v) => v.provider === active);
  return language ? list.filter((v) => v.language === language) : list;
}

export function resolveVoice(requested: string | undefined, language: 'fr' | 'en'): string {
  const provider = VOICE_TTS_PROVIDER === 'zai' ? 'zai' : 'edge';
  const pool = voicesFor(provider, language);
  if (requested) {
    const hit = VOICES.find((v) => v.id === requested && v.provider === provider);
    if (hit) return hit.id;
  }
  return pool[0]?.id ?? (provider === 'zai' ? 'zai:tongtong' : language === 'fr' ? 'fr-FR-DeniseNeural' : 'en-US-AriaNeural');
}
