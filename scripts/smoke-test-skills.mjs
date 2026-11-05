// Smoke test: skill routing (preselection + manifest + USE_SKILL resolution).
// Run: cd /home/z/my-project && bun scripts/smoke-test-skills.mjs
import { preselectSkills } from '../src/lib/skills/selector';
import { getSkillManifestPrompt, getSkillByName, skillNames } from '../src/lib/skills/registry';

const cases = [
  'crée-moi un jeu de cartes',
  'fais une scène 3D avec three.js',
  'une animation GSAP au scroll',
  'fais moi un platformer comme Mario',
  'un jeu 3d immersif en WebGL',
  'crée un jeu vidéo de tower defense',
  'améliore le game feel de mon jeu, ajoute du screen shake',
  'une landing page ultra moderne',
  'bonjour ça va ?',
  'génère un PDF de facture',
];

for (const msg of cases) {
  const picked = await preselectSkills(msg);
  console.log(`\n▶ "${msg}"`);
  if (!picked.length) console.log('   (aucun skill pré-sélectionné)');
  for (const s of picked) {
    console.log(`   ✓ ${s.name} (score ${s.score}, ${Math.round(s.content.length / 1024)}K)`);
  }
}

const manifest = await getSkillManifestPrompt();
console.log(`\n— manifest: ${manifest ? manifest.length : 0} chars, ${skillNames().size} skills au total`);
console.log(manifest ? manifest.split('\n').filter((l) => l.startsWith('- threejs') || l.startsWith('- game-') || l.startsWith('- platformer')).join('\n') : '');

for (const n of ['threejs-webgl', 'game-development', 'phaser-core', 'pdf']) {
  const s = getSkillByName(n);
  console.log(`getSkillByName(${n}) → ${s ? `OK, ${s.content.length} chars` : 'INTRouVABLE'}`);
}
