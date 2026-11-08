import type { NextConfig } from "next";

/**
 * Open WebUI (backend TypeScript port) — Next.js hosts the API surface
 * (/api/*, /ollama/*, /openai/*, /oauth/*) — the Python → TypeScript port of
 * open_webui (FastAPI parity) — plus the React single-page chat client
 * (src/app/page.tsx): the @ app mention picker, RAG attachments, knowledge
 * bases and settings all live in the source tree (the legacy compiled SPA
 * under public/ is retired — kept on disk for reference, excluded from
 * Vercel via .vercelignore).
 *
 * Old SPA bookmarks and OAuth login returns point at /auth (and /chat):
 * they are aliased to "/" — the React app renders the auth view when
 * signed out and the chat when signed in.
 */
const nextConfig: NextConfig = {
  output: "standalone",
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
        // Legacy SPA routes (OAuth login return "/auth", bookmarks "/chat")
        // land on the React single-page client.
        { source: "/auth", destination: "/" },
        { source: "/chat", destination: "/" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
