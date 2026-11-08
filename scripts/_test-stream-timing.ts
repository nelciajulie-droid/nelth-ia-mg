async function main() {
  const ZAI = (await import('z-ai-web-dev-sdk')).default;
  const zai = await ZAI.create();
  const t0 = Date.now();
  const stream = await zai.chat.completions.create({
    messages: [{ role: 'user', content: 'Problème complexe: un escargot grimpe un mur de 10m, monte 3m/jour, descend 2m/nuit. Quel jour atteint-il le sommet ? Réfléchis étape par étape.' }],
    stream: true,
    thinking: { type: 'enabled' },
    max_tokens: 2048,
  });
  const reader = (stream as any).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const timeline: string[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const d = obj?.choices?.[0]?.delta ?? {};
        const keys = Object.keys(d).join(',');
        const c = d.content ?? '';
        if (c) { full += c; n++; if (n === 1 || n % 40 === 0) timeline.push(`+${((Date.now()-t0)/1000).toFixed(2)}s chunk#${n} keys=[${keys}] ${JSON.stringify(c.slice(0,40))}`); }
        else timeline.push(`+${((Date.now()-t0)/1000).toFixed(2)}s NON-CONTENT delta keys=[${keys}]`);
      } catch { /* skip */ }
    }
  }
  console.log(timeline.slice(0, 12).join('\n'));
  console.log(`\n... ${n} content chunks au total`);
  console.log(`\nDÉBUT DU FLUX COMPLET (300 chars):\n${full.slice(0, 300)}`);
  const hasThink = full.includes('<think>') || full.includes('<thinking>');
  console.log(`\ncontient <think>: ${hasThink}`);
}
main().catch(e => { console.error('ERREUR:', e.message); });
