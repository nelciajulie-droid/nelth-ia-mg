import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Open WebUI — TS",
  description:
    "Open WebUI v0.12.5 TypeScript port — a full-featured chat interface for LLMs with RAG, knowledge bases, and model management. 100% Vercel-native, zero Python runtime.",
  keywords: ["Open WebUI", "LLM", "chat", "RAG", "Next.js", "TypeScript", "Ollama", "OpenAI"],
  authors: [{ name: "Open WebUI TS Port" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Open WebUI — TS",
    description: "TypeScript port of Open WebUI v0.12.5 — Vercel-native, zero Python",
    siteName: "Open WebUI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Open WebUI — TS",
    description: "TypeScript port of Open WebUI v0.12.5 — Vercel-native, zero Python",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
