# ══════════════════════════════════════════════════════════════════════════
#  Nelth-AI — image de production (Bun, un seul conteneur, un seul port)
#
#  Le conteneur embarque l'application Next.js (port 3000) ET le service
#  socket.io (port 3001, interne) : scripts/serve.mjs supervise les deux
#  processus et garde le service de sockets vivant (redémarrage auto).
#
#  Build :   docker build -t nelth-ai .
#  Run  :    docker run -d --env-file .env -p 3000:3000 --name nelth-ai nelth-ai
# ══════════════════════════════════════════════════════════════════════════

FROM oven/bun:1 AS base
WORKDIR /app

# ── Dépendances (couche cachable) ────────────────────────────────────────
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Génération du client Prisma (nécessaire à la compilation TypeScript)
COPY prisma ./prisma
RUN bunx prisma generate

# Service socket.io : dépendances propres
COPY mini-services/socket-service/package.json mini-services/socket-service/bun.lock* ./mini-services/socket-service/
RUN cd mini-services/socket-service && bun install

# ── Code applicatif + build ──────────────────────────────────────────────
COPY . .
# .next est construit dans l'image (production) — le flag NODE_ENV est requis
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run vercel-build

# ── Runtime ──────────────────────────────────────────────────────────────
# ffmpeg : transcodage des captures micro navigateur (webm/opus → wav)
#         pour le moteur de transcription intégré (voir src/lib/audio-zai.ts).
FROM oven/bun:1 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=base /app ./
EXPOSE 3000
# bun run start → scripts/serve.mjs start → next start + socket-service
CMD ["bun", "run", "start"]
