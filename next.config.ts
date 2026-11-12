import type { NextConfig } from "next";

/**
 * Open WebUI (backend TypeScript port) — Next.js hosts two things:
 *
 *   1. The API surface (/api/*, /ollama/*, /openai/*, /oauth/*) — the
 *      Python → TypeScript port of open_webui (FastAPI parity).
 *   2. The ORIGINAL, UNMODIFIED Open WebUI frontend build (public/) —
 *      produced by `npm run build` in the official open-webui repository
 *      (@sveltejs/adapter-static, fallback index.html).
 *
 * SPA fallback: non-API paths are rewritten to /index.html so SvelteKit
 * client-side routing works for /chat, /auth, /workspace, ... (deep links).
 */
const nextConfig: NextConfig = {
  output: "standalone",
  // exceljs (styled XLSX documents) is a CommonJS/Node-oriented package —
  // keep it external so the server bundle requires it from node_modules
  // instead of bundling its dynamic requires.
  serverExternalPackages: ["exceljs"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Open WebUI API parity: accept both /api/v1/files and /api/v1/files/
  // (FastAPI-style trailing slashes) without redirecting.
  skipTrailingSlashRedirect: true,
  // /api/changelog reads CHANGELOG.md from disk — include it in the
  // serverless bundle (Vercel).
  outputFileTracingIncludes: {
    "/api/changelog": ["./CHANGELOG.md"],
  },
  async rewrites() {
    return {
      beforeFiles: [
        // "/" → original SPA (public/index.html)
        { source: "/", destination: "/index.html" },
      ],
      afterFiles: [
        {
          // SPA fallback for client-side routes (/chat, /auth, /admin/...).
          // API namespaces are excluded so the catch-all route handlers win;
          // real static files (/_app/*, /favicon.png, /manifest.json, ...) are
          // served from public/ by the filesystem step BEFORE these rewrites.
          source:
            "/:path((?!api(?:/|$)|ollama(?:/|$)|openai(?:/|$)|oauth(?:/|$)|openapi(?:/|$)|docs(?:/|$)|_next(?:/|$)|_vercel(?:/|$)|ws(?:/|$)|health(?:/|$)|litellm(?:/|$)|index\\.html).*)",
          destination: "/index.html",
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
