#!/usr/bin/env bun
// Watchdog durable du stack dev Nelth (next:3000 + socket:3001).
// Pourquoi bun et pas bash : la plateforme cull les shells bash orphelins
// (leaders de session sans tty) ~1-2 min après la fin de la commande qui les
// a lancés — un watchdog bash meurt donc. Les process bun/node détachés en
// session propre survivent (cf. le stack dev lui-même, lancé par ensure-dev.sh).
// Boucle : toutes les 15 s → scripts/ensure-dev.sh (idempotent : flock + check port 3000).
const ENSURE = '/home/z/my-project/scripts/ensure-dev.sh';
const HEARTBEAT = '/tmp/nelth-dev-watchdog.heartbeat';
const TICK_MS = 15_000;

function tick() {
  try {
    const r = Bun.spawnSync(['/bin/bash', ENSURE], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    Bun.write(HEARTBEAT, `${new Date().toISOString()} exit=${r.exitCode}\n`);
  } catch (e) {
    try {
      Bun.write(HEARTBEAT, `${new Date().toISOString()} error=${e}\n`);
    } catch {}
  }
}

tick();
setInterval(tick, TICK_MS);
console.log(`[watchdog] started — tick ${TICK_MS}ms → ${ENSURE}`);
