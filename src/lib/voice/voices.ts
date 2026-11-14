/**
 * Voice catalogue — Edge TTS neural voices (French / English).
 * Edge TTS is the ONLY provider. Malagasy: NOT offered — Edge TTS exposes
 * no certified mg-MG voice (verified against the catalogue) and the mission
 * forbids inventing language support.
 */

export type VoiceOption = {
  id: string; // wire id (edge: locale name)
  label: string;
  language: 'fr' | 'en';
  gender: 'female' | 'male';
  provider: 'edge';
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
];

/** Voices actually usable (Edge TTS only). */
export function voicesFor(_provider: string, language?: 'fr' | 'en'): VoiceOption[] {
  void _provider;
  const list = VOICES;
  return language ? list.filter((v) => v.language === language) : list;
}

export function resolveVoice(requested: string | undefined, language: 'fr' | 'en'): string {
  const pool = voicesFor('edge', language);
  if (requested) {
    const hit = VOICES.find((v) => v.id === requested);
    if (hit) return hit.id;
  }
  return pool[0]?.id ?? (language === 'fr' ? 'fr-FR-DeniseNeural' : 'en-US-AriaNeural');
}
