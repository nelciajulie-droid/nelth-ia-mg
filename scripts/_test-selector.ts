import { preselectSkills } from '../src/lib/skills/selector';

async function main() {
  const tests = [
    'créer landing page ultra moderne',
    'créer moi une landing page ultra moderne',
    'creer lading page ultra moderne',
    'fais une video de presentation',
  ];
  for (const t of tests) {
    const skills = await preselectSkills(t);
    console.log(`\n=== "${t}" ===`);
    for (const s of skills) {
      console.log(`  - ${s.name} (score ${s.score}, ${s.content.length} chars)`);
    }
    if (!skills.length) console.log('  (aucun skill)');
  }
}
main();
