import { decideAutoImageGeneration } from '../src/lib/chat/auto-image';

async function main() {
  const tests = [
    'créer landing page ultra moderne',
    'créer moi une landing page ultra moderne',
    'creer lading page ultra moderne',
  ];
  for (const t of tests) {
    const d = await decideAutoImageGeneration([{ role: 'user', content: t }]);
    console.log(`"${t}" →`, JSON.stringify(d));
  }
}
main();
