/**
 * LOCAL TEST HARNESS — auto-engage decision battery (dev only, never shipped).
 *
 * Two passes:
 *   A) full pipeline (classifier + guards + nets) on realistic messages;
 *   B) NET-ONLY pass — simulates the production fail-open path (classifier
 *      call dead/timed out): only the deterministic engagement nets can
 *      save the turn. This is the path the "les autos décident toujours
 *      mal" report traced back to.
 * Usage: bun scripts/_test-auto-engage.ts
 */
import { decideAutoEngagement, IMAGE_ENGAGE_RE, VIDEO_ENGAGE_RE } from '../src/lib/chat/auto-engage';

type Case = { label: string; text: string; want: { image?: boolean; video?: boolean; search?: boolean } };

const CASES: Case[] = [
  { label: 'image claire', text: 'dessine-moi un chat astronaute', want: { image: true } },
  { label: 'image claire (typo)', text: 'cre une image de maison moderne', want: { image: true } },
  { label: 'logo', text: 'fais-moi un logo pour ma boulangerie', want: { image: true } },
  { label: 'vidéo claire', text: 'crée une vidéo de danse hip hop', want: { video: true } },
  { label: 'gif', text: 'génère un gif amusant de chat', want: { video: true } },
  { label: 'search identité', text: 'qui est le président du Cameroun ?', want: { search: true } },
  { label: 'search news', text: 'quel est le dernier score du match PSG ?', want: { search: true } },
  { label: 'aucun (small talk)', text: 'bonjour, ça va aujourd’hui ?', want: {} },
  { label: 'aucun (code)', text: 'développe-moi une API REST avec Node', want: {} },
  { label: 'aucun (svg)', text: 'dessine-moi le SVG d’un chien', want: {} },
  { label: 'aucun (histoire stable)', text: 'explique-moi la théorie de la relativité', want: {} },
  { label: 'aucun (anime = série)', text: 'recommande-moi un anime à regarder ce soir', want: {} },
  { label: 'aucun (image sans création)', text: 'j’ai vu une image drôle hier sur internet', want: {} },
  { label: 'aucun (site web)', text: 'fais-moi un site vitrine moderne', want: {} },
  { label: 'image (exception maquette)', text: 'dessine une maquette de landing page', want: { image: true } },
];

/** Net-only battery — the fail-open production path (classifier dead). */
const NET_CASES: Array<{ label: string; text: string; expect: 'image' | 'video' | 'none' }> = [
  { label: 'dessine un chat', text: 'dessine-moi un chat', expect: 'image' },
  { label: 'crée une image', text: 'crée une image de fusée', expect: 'image' },
  { label: 'fais un logo', text: 'fais-moi un logo rond', expect: 'image' },
  { label: 'génère une affiche', text: 'génère une affiche de concert', expect: 'image' },
  { label: 'draw a cat', text: 'draw a cat in space', expect: 'image' },
  { label: 'crée une vidéo', text: 'crée une vidéo de danse', expect: 'video' },
  { label: 'fais un clip', text: 'fais un clip musical', expect: 'video' },
  { label: 'génère une animation', text: 'génère une animation de vagues', expect: 'video' },
  { label: 'anime cette image', text: 'anime cette image s’il te plaît', expect: 'video' },
  { label: 'make a video', text: 'make a video of a dog running', expect: 'video' },
  { label: 'anime (série, pas création)', text: 'recommande-moi un anime à regarder', expect: 'none' },
  { label: 'image sans création', text: 'j’ai vu une image drôle hier', expect: 'none' },
  { label: 'vidéo sans création', text: 'pourquoi les vidéos laguent sur mon PC ?', expect: 'none' },
  { label: 'film sans création', text: 'quel film voir ce soir ?', expect: 'none' },
];

async function main() {
  let ok = 0;
  let ko = 0;
  console.log('=== PASSE A — pipeline complet (classifier actif) ===');
  for (const c of CASES) {
    const t0 = Date.now();
    let d: any;
    try {
      d = await decideAutoEngagement([{ role: 'user', content: c.text }]);
    } catch (e) {
      d = { error: String(e) };
    }
    const ms = Date.now() - t0;
    const got = { image: !!d.image, video: !!d.video, search: !!d.search };
    const pass =
      (c.want.image === undefined || got.image === c.want.image) &&
      (c.want.video === undefined || got.video === c.want.video) &&
      (c.want.search === undefined || got.search === c.want.search);
    if (pass) ok++; else ko++;
    console.log(`${pass ? 'PASS' : 'KO  '} [${String(ms).padStart(5)}ms] ${c.label.padEnd(28)} → image=${got.image} video=${got.video} search=${got.search}`);
  }
  console.log(`Passe A : ${ok}/${ok + ko}`);

  console.log('\n=== PASSE B — NET-ONLY (classifier mort : filets seuls) ===');
  let okB = 0;
  let koB = 0;
  for (const c of NET_CASES) {
    const img = IMAGE_ENGAGE_RE.test(c.text);
    const vid = VIDEO_ENGAGE_RE.test(c.text);
    // mirrors the runtime order: video net first, image only if no video
    const got = vid ? 'video' : img ? 'image' : 'none';
    const pass = got === c.expect;
    if (pass) okB++; else koB++;
    console.log(`${pass ? 'PASS' : 'KO  '} ${c.label.padEnd(30)} → net=${got} (attendu ${c.expect})`);
  }
  console.log(`Passe B : ${okB}/${okB + koB}`);
  const totalOk = ok + okB;
  const total = ok + ko + okB + koB;
  console.log(`\n${totalOk}/${total} attendus satisfaits`);
  if (ko > 0 || koB > 0) process.exitCode = 1;
}
void main();
