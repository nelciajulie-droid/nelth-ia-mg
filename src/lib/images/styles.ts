/**
 * Nelth-IA Images — shared catalogs: artistic styles + aspect ratios.
 *
 * With the built-in Nelthai engine the provider exposes no style/size
 * parameters, so styles are applied as documented prompt guidance and
 * aspect ratios as composition hints (see capabilities.aspectRatioMode).
 * With the OpenAI Images engine, aspect ratios map to real size parameters.
 */

export interface ImagineStyle {
  id: string;
  label: string;
  /** Prompt guidance appended when the style is selected. */
  suffix: string;
}

export const IMAGINE_STYLES: ImagineStyle[] = [
  { id: 'none', label: 'No style', suffix: '' },
  {
    id: 'photorealistic',
    label: 'Photorealistic',
    suffix: ' — style photoréaliste, photographie très détaillée, éclairage naturel, objectif 50 mm',
  },
  {
    id: 'anime',
    label: 'Anime',
    suffix: ' — style anime, trait net, couleurs vives, ambiance manga cinématique',
  },
  {
    id: '3d',
    label: '3D',
    suffix: ' — rendu 3D stylisé, éclairage global doux, matériaux détaillés, qualité animation studio',
  },
  {
    id: 'illustration',
    label: 'Illustration',
    suffix: ' — illustration aquarelle, coup de pinceau libre, palette chaleureuse, grain papier',
  },
  {
    id: 'architecture',
    label: 'Architecture',
    suffix: ' — photographie d’architecture, lignes épurées, matières minérales, lumière rasante',
  },
  {
    id: 'nature',
    label: 'Nature',
    suffix: ' — photographie nature fine art, lumière dorée, grande profondeur de champ',
  },
  {
    id: 'fashion',
    label: 'Fashion',
    suffix: ' — photographie de mode éditoriale, éclairage studio dramatique, composition magazine',
  },
  {
    id: 'product',
    label: 'Product',
    suffix: ' — photographie produit publicitaire, fond neutre, reflets maîtrisés, qualité studio',
  },
  {
    id: 'wallpaper',
    label: 'Wallpaper',
    suffix: ' — composition minimale et aérée pour fond d’écran, aplats pastel, grain subtil',
  },
  {
    id: 'art',
    label: 'Art',
    suffix: ' — peinture expressionniste abstraite, gestes amples, texture épaisse, palette ambre et indigo',
  },
];

export function imagineStyleById(id: string | null | undefined): ImagineStyle | null {
  if (!id) return null;
  return IMAGINE_STYLES.find((s) => s.id === id) ?? null;
}

/** All ratios surfaced by the studio (order = UI order). */
export const IMAGINE_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const;

/** Ratio → approximate CSS aspect (w/h) for skeleton placeholders. */
export function ratioValue(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number);
  if (!w || !h) return 1;
  return w / h;
}

/** Ratio → human composition hint folded into prompts (creative-hint mode). */
const RATIO_HINTS: Record<string, string> = {
  '1:1': 'composition carrée centrée',
  '3:2': 'composition paysage équilibrée 3:2',
  '2:3': 'composition portrait verticale 2:3',
  '4:3': 'composition paysage classique 4:3',
  '3:4': 'composition portrait classique 3:4',
  '16:9': 'composition panoramique large 16:9',
  '9:16': 'composition verticale plein écran 9:16',
  '21:9': 'composition cinéma ultra large 21:9',
};

export function ratioHint(ratio: string): string {
  return RATIO_HINTS[ratio] ?? '';
}

/** Ratio → OpenAI Images API size parameter (exact mode). */
const RATIO_TO_OPENAI_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '21:9': '1536x1024',
};

export function ratioToOpenAiSize(ratio: string): string {
  return RATIO_TO_OPENAI_SIZE[ratio] ?? '1024x1024';
}
