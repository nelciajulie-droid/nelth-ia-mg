/**
 * Nelth-IA Images — inspiration gallery catalog.
 *
 * Curated example prompts for the discovery gallery. The preview thumbnails
 * are REAL AI-generated artworks shipped as static assets
 * (public/static/imagine/gallery/*.webp) — they are studio art direction
 * material, never presented as user-generated content. Every card's actions
 * run REAL generations with the curated prompt through the active engine.
 */

export interface GalleryEntry {
  id: string;
  category: string;
  /** Reusable prompt (French) — what "Utiliser ce prompt" fills in. */
  prompt: string;
  asset: string;
  ratio: string;
}

export interface GalleryCategory {
  id: string;
  label: string;
}

export const GALLERY_CATEGORIES: GalleryCategory[] = [
  { id: 'all', label: 'Tout' },
  { id: 'photorealistic', label: 'Photorealistic' },
  { id: 'anime', label: 'Anime' },
  { id: '3d', label: '3D' },
  { id: 'illustration', label: 'Illustrations' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'nature', label: 'Nature' },
  { id: 'fashion', label: 'Mode' },
  { id: 'product', label: 'Design produit' },
  { id: 'wallpaper', label: 'Fonds d’écran' },
  { id: 'art', label: 'Art' },
];

export const GALLERY_ENTRIES: GalleryEntry[] = [
  {
    id: 'exploratrice',
    category: 'photorealistic',
    prompt:
      'Portrait photoréaliste d’une exploratrice aguerrie dans la trentaine, chemise de terrain en lin usé, lumière dorée rasante, arrière-plan flou de savane, très détaillé',
    asset: '/static/imagine/gallery/photorealistic.webp',
    ratio: '2:3',
  },
  {
    id: 'aviatrice',
    category: 'anime',
    prompt:
      'Jeune aviatrice aux cheveux au vent sur un promontoire d’île flottante à l’aube, style anime des années 90, ciel peint à la main, nuages dramatiques',
    asset: '/static/imagine/gallery/anime.webp',
    ratio: '1:1',
  },
  {
    id: 'renard',
    category: '3d',
    prompt:
      'Renardeau 3D adorable aux oreilles démesurées assis dans une forêt bioluminescente onirique, éclairage doux, qualité animation studio',
    asset: '/static/imagine/gallery/3d.webp',
    ratio: '1:1',
  },
  {
    id: 'marche',
    category: 'illustration',
    prompt:
      'Illustration aquarelle d’un marché de village malgache animé à midi, vendeurs aux paniers tissés, charrette de zébus, baobab en arrière-plan, palette chaleureuse',
    asset: '/static/imagine/gallery/illustration.webp',
    ratio: '4:3',
  },
  {
    id: 'villa',
    category: 'architecture',
    prompt:
      'Villa moderniste organique en porte-à-faux sur une falaise océane au coucher du soleil, travertin et béton courbe, piscine à débordement fusionnant avec l’horizon, photographie d’architecture',
    asset: '/static/imagine/gallery/architecture.webp',
    ratio: '16:9',
  },
  {
    id: 'baobabs',
    category: 'nature',
    prompt:
      'Allée des baobabs géants de Madagascar au lever du soleil brumeux, rais de lumière traversant la brume, piste de terre ocre, photographie nature fine art',
    asset: '/static/imagine/gallery/nature.webp',
    ratio: '4:3',
  },
  {
    id: 'robe',
    category: 'fashion',
    prompt:
      'Photographie de mode éditoriale, mannequin portant une robe sculpturale turquoise, fond studio minimal, éclairage dramatique à source unique, plis de tissu très détaillés',
    asset: '/static/imagine/gallery/fashion.webp',
    ratio: '2:3',
  },
  {
    id: 'casque',
    category: 'product',
    prompt:
      'Casque audio premium en lévitation, graphite mat et cuivre brossé, photographie produit studio sur fond neutre doux, reflets nets, qualité publicitaire',
    asset: '/static/imagine/gallery/product.webp',
    ratio: '1:1',
  },
  {
    id: 'collines',
    category: 'wallpaper',
    prompt:
      'Paysage abstrait onirique pour fond d’écran, collines superposées violet pastel et pêche sous un grand soleil pâle, grain subtil, composition calme et aérée',
    asset: '/static/imagine/gallery/wallpaper.webp',
    ratio: '16:9',
  },
  {
    id: 'expressionnisme',
    category: 'art',
    prompt:
      'Peinture expressionniste abstraite audacieuse, vastes coups de pinceau gestuels, palette ambre, indigo profond et ivoire, texture épaisse à l’impasto',
    asset: '/static/imagine/gallery/art.webp',
    ratio: '1:1',
  },
];

export function galleryByCategory(category: string): GalleryEntry[] {
  if (category === 'all') return GALLERY_ENTRIES;
  return GALLERY_ENTRIES.filter((entry) => entry.category === category);
}
