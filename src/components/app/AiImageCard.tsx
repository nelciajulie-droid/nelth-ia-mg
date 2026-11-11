"use client";

/**
 * AI image generation card — shimmering pixel-grid placeholder with a live
 * phase label + elapsed seconds, then a cinematic reveal when the image lands
 * (grid dissolves into blur, image fades in from blur, diagonal light sweep,
 * short white flash, footer flips to "Generated").
 *
 * Two ways to end the loading state:
 *   • standalone  — `generateDuration` seconds (demo/self-contained use);
 *   • controlled  — `imageDone` flips to true the moment the generated image
 *     arrives (`generateDuration = 9999` semantics: the image arrival ends
 *     it, not the timer). The seconds counter freezes at that instant.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";

import { cn } from "@/lib/utils";

export interface AiImageCardProps {
  /** Standalone timer mode: seconds before auto-reveal. Use 9999 when the image arrival controls the end. */
  generateDuration?: number;
  /** Controlled mode: set true when the generated image has arrived. */
  imageDone?: boolean;
  imageSrc?: string;
  imageAlt?: string;
  /** Live phase label shown in the footer while generating ("sending" | "generating" | "image"…). */
  label?: string;
  showFooter?: boolean;
  className?: string;
  /** Video media (studio video items): renders <video controls loop muted> instead of <img>. */
  video?: boolean;
}

export function AiImageCard({
  generateDuration = 3,
  imageDone = false,
  imageSrc = "/fightclub1.jpeg",
  imageAlt = "AI generated image",
  label = "Generating image",
  showFooter = true,
  className,
  video = false,
}: AiImageCardProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [seconds, setSeconds] = React.useState(0);
  const [done, setDone] = React.useState(false);

  // Controlled end: the image arrival flips `done` immediately.
  React.useEffect(() => {
    if (imageDone) setDone(true);
  }, [imageDone]);

  // Chronometer — freezes the moment the state ends (image arrival or timer).
  React.useEffect(() => {
    if (done) return;
    const start = Date.now();
    const id = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (elapsed >= generateDuration) {
        setSeconds(generateDuration);
        setDone(true);
        window.clearInterval(id);
        return;
      }
      setSeconds(elapsed);
    }, 250);
    return () => window.clearInterval(id);
  }, [done, generateDuration]);

  // Shimmering pixel grid — 4px squares with a 2px gap, desynchronized
  // sinusoidal waves so the grid sparkles instead of pulsing in lockstep.
  React.useEffect(() => {
    if (done) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let animationFrameId = 0;
    let width = 0;
    let height = 0;

    const size = 4;
    const gap = 2;
    const step = size + gap;
    let cols = 0;
    let rows = 0;
    let offsets: number[][] = [];
    let speeds: number[][] = [];

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      width = parent.clientWidth;
      height = parent.clientHeight;
      if (!width || !height) return;
      // Crisper squares on high-DPI screens.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / step);
      rows = Math.ceil(height / step);
      offsets = Array.from({ length: cols }, () =>
        Array.from({ length: rows }, () => Math.random() * Math.PI * 2)
      );
      speeds = Array.from({ length: cols }, () =>
        Array.from({ length: rows }, () => 0.35 + Math.random() * 0.95)
      );
    };
    window.addEventListener("resize", resize);
    resize();

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const time = Date.now() * 0.001;
      const isDark = document.documentElement.classList.contains("dark");
      const r = isDark ? 129 : 110;
      const g = isDark ? 129 : 110;
      const b = isDark ? 137 : 120;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const wave = Math.sin(time * speeds[i][j] + offsets[i][j]);
          let opacity = 0.02;
          if (wave > 0.9) opacity = 0.1 + (wave - 0.9) * 3;
          else if (wave > 0.7) opacity = 0.05 + (wave - 0.7) * 0.5;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
          ctx.fillRect(i * step, j * step, size, size);
        }
      }
      animationFrameId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [done]);

  return (
    <div
      className={cn(
        "relative aspect-square w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
        className
      )}
    >
      {/* Shimmering grid — dissolves on reveal */}
      <AnimatePresence>
        {!done && (
          <motion.div
            key="grid"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.08, filter: "blur(14px)" }}
            transition={{ duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
          >
            <canvas ref={canvasRef} className="h-full w-full" aria-hidden />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Revealed image — fade-in from blur + diagonal light sweep */}
      <AnimatePresence>
        {done && (
          <motion.div
            key="image"
            className="absolute inset-0"
            initial={{ opacity: 0, filter: "blur(20px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(20px)" }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          >
            {video ? (
              <video
                src={imageSrc}
                aria-label={imageAlt}
                className="h-full w-full object-cover"
                controls
                loop
                muted
                playsInline
                preload="metadata"
              />
            ) : (
              <img src={imageSrc} alt={imageAlt} className="h-full w-full object-cover" />
            )}
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              initial={{ x: "-120%" }}
              animate={{ x: "120%" }}
              transition={{ duration: 1.1, ease: [0.65, 0, 0.35, 1], delay: 0.3 }}
            >
              <div className="h-full w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/35 to-transparent" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Brief white flash on reveal */}
      <AnimatePresence>
        {done && (
          <motion.div
            key="flash"
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-white"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.18, 0] }}
            transition={{ duration: 0.7, times: [0, 0.25, 1], ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      {/* Footer: label + seconds, masked gradient fading upwards */}
      {showFooter && (
        <div
          className="absolute inset-x-0 bottom-0 h-24 bg-white/40 backdrop-blur-md dark:bg-black/50"
          style={{
            maskImage: "linear-gradient(to top, black 0%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to top, black 0%, transparent 100%)",
          }}
        >
          <div className="absolute inset-x-5 bottom-3 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-900 drop-shadow-sm dark:text-white">
              {done ? "Generated" : label}
            </span>
            <span className="text-sm font-medium tabular-nums text-zinc-900/90 drop-shadow-sm dark:text-white/90">
              {seconds}s
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
