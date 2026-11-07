#!/usr/bin/env bun
/**
 * Single-command supervisor — starts the ENTIRE Nelth-AI stack:
 *
 *   • the Next.js web app    (HTTP + SPA + /ws proxy)   — port APP_PORT (3000)
 *   • the socket.io service  (chat streaming events)    — port 3001
 *
 *   bun run dev    → next dev (hot reload) + bun --hot socket service,
 *                    combined output mirrored to dev.log
 *   bun run start  → next start + socket service (production, stdout only)
 *
 * The supervisor keeps the socket service alive (auto-restart on crash) and
 * shuts everything down cleanly on SIGINT/SIGTERM. It runs anywhere Bun runs:
 * one repo, one command, one port facing browsers — no other infrastructure
 * required. Browsers only ever see the web app origin; it proxies /ws/* to
 * the co-located socket service (see src/app/ws/[...path]/route.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOCKET_DIR = path.join(ROOT, 'mini-services', 'socket-service');
const APP_PORT = String(process.env.APP_PORT || 3000);
const SOCKET_PORT = String(process.env.SOCKET_SERVICE_PORT || 3001);

// Runtime that launched this supervisor (bun). Fall back to a plain `bun`
// lookup if started through node for some reason.
const BUN = process.execPath.includes('bun') ? process.execPath : 'bun';

const logStream =
  mode === 'dev' ? fs.createWriteStream(path.join(ROOT, 'dev.log'), { flags: 'w' }) : null;

function forward(child) {
  const fwd = (chunk) => {
    process.stdout.write(chunk);
    logStream?.write(chunk);
  };
  child.stdout.on('data', fwd);
  child.stderr.on('data', fwd);
}

let shuttingDown = false;
let appChild = null;
let socketChild = null;
let restartTimer = null;

function startSocket() {
  const args = mode === 'dev' ? ['--hot', 'index.ts'] : ['index.ts'];
  socketChild = spawn(BUN, args, {
    cwd: SOCKET_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  forward(socketChild);
  socketChild.on('exit', () => {
    if (shuttingDown) return;
    console.error(`[serve] socket-service exited — restarting in 1s (port ${SOCKET_PORT})`);
    restartTimer = setTimeout(startSocket, 1000);
  });
}

function startApp() {
  const args =
    mode === 'dev'
      ? ['run', 'next', 'dev', '-p', APP_PORT]
      : ['run', 'next', 'start', '-p', APP_PORT];
  appChild = spawn(BUN, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  forward(appChild);
  appChild.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    socketChild?.kill('SIGTERM');
    process.exit(code ?? 0);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  appChild?.kill(signal);
  socketChild?.kill(signal);
  // Grace period, then force-kill anything left.
  setTimeout(() => {
    appChild?.kill('SIGKILL');
    socketChild?.kill('SIGKILL');
    process.exit(0);
  }, 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Prisma client self-heal — the generated client must match the runtime
 * DATABASE_URL provider (sqlite ↔ postgresql). On Docker/VPS the URL is
 * only known at container start (env_file), so scripts/prisma.mjs `ensure`
 * regenerates the client when the baked-in provider mismatches. Best-effort:
 * a failure logs a warning and the stack still boots.
 */
function ensurePrismaClient() {
  try {
    const res = spawnSync(BUN, ['scripts/prisma.mjs', 'ensure'], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      console.warn('[serve] prisma ensure exited non-zero — continuing with the existing client');
    }
  } catch (err) {
    console.warn(`[serve] prisma ensure failed: ${err?.message ?? err} — continuing`);
  }
}

console.log(
  `[serve] mode=${mode} — web app on :${APP_PORT}, socket-service on :${SOCKET_PORT}`
);

ensurePrismaClient();
startSocket();
startApp();
