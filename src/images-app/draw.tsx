/**
 * Nelth-IA Images — interface « Dessiner ».
 *
 * Canvas blanc minimal : crayon / gomme, 3 tailles, palette sobre, annuler,
 * effacer. « Ajouter au studio » exporte le PNG vers /api/v1/imagine/upload
 * → il apparaît dans Importations et sert de référence image-to-image.
 */

import * as React from 'react';
import { ArrowLeft, Eraser, Pencil, Trash2, Undo2 } from 'lucide-react';
import { cx } from './ui';

const COLORS = ['#171717', '#4D9BF5', '#B42318', '#12A150', '#F5A623', '#7C3AED'];
const SIZES = [3, 6, 12];
const CANVAS_W = 1024;
const CANVAS_H = 768;

interface Stroke {
  color: string;
  size: number;
  erase: boolean;
  points: Array<{ x: number; y: number }>;
}

export function DrawOverlay({
  onClose,
  onSave,
  saving,
}: {
  onClose(): void;
  onSave(file: File): void;
  saving: boolean;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const strokes = React.useRef<Stroke[]>([]);
  const drawing = React.useRef(false);
  const [color, setColor] = React.useState(COLORS[0]);
  const [size, setSize] = React.useState(SIZES[1]);
  const [erase, setErase] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  const repaint = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes.current) {
      if (stroke.points.length < 2) continue;
      ctx.strokeStyle = stroke.erase ? '#FFFFFF' : stroke.color;
      ctx.lineWidth = stroke.erase ? stroke.size * 2.5 : stroke.size;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }, []);

  React.useEffect(() => {
    repaint();
  }, [repaint]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push({ color, size, erase, points: [pointFromEvent(e)] });
    setDirty(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    strokes.current[strokes.current.length - 1]?.points.push(pointFromEvent(e));
    repaint();
  }

  function onPointerUp() {
    drawing.current = false;
  }

  function undo() {
    strokes.current.pop();
    setDirty(strokes.current.length > 0);
    repaint();
  }

  function clearAll() {
    strokes.current = [];
    setDirty(false);
    repaint();
  }

  function save() {
    const canvas = canvasRef.current;
    if (!canvas || !strokes.current.length) return;
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onSave(new File([blob], `dessin-${Date.now()}.png`, { type: 'image/png' }));
      },
      'image/png'
    );
  }

  return (
    <div className="images-fade fixed inset-0 z-50 flex flex-col bg-[var(--images-bg)]" role="dialog" aria-modal="true" aria-label="Dessiner">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--images-line)] px-3 sm:px-5">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-chip)] hover:text-[var(--images-ink)]"
          aria-label="Retour"
        >
          <ArrowLeft className="size-4" strokeWidth={2} />
          Retour
        </button>
        <span className="text-[15px] font-semibold text-[var(--images-ink)]">Dessiner</span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 rounded-full bg-[var(--images-btn-ink)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-btn-on-ink)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving ? 'Ajout…' : 'Ajouter au studio'}
        </button>
      </header>

      {/* Barre d'outils */}
      <div className="flex flex-wrap items-center justify-center gap-2 border-b border-[var(--images-line)] px-4 py-3">
        <div className="flex items-center gap-1 rounded-full bg-[var(--images-chip-soft)] p-[3px]">
          <button
            type="button"
            aria-label="Crayon"
            aria-pressed={!erase}
            onClick={() => setErase(false)}
            className={cx(
              'flex size-7 items-center justify-center rounded-full transition-all',
              !erase ? 'border border-[var(--images-line)] bg-[var(--images-pill)] text-[var(--images-ink)] shadow-[var(--images-shadow-btn)]' : 'text-[var(--images-muted)]'
            )}
          >
            <Pencil className="size-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label="Gomme"
            aria-pressed={erase}
            onClick={() => setErase(true)}
            className={cx(
              'flex size-7 items-center justify-center rounded-full transition-all',
              erase ? 'border border-[var(--images-line)] bg-[var(--images-pill)] text-[var(--images-ink)] shadow-[var(--images-shadow-btn)]' : 'text-[var(--images-muted)]'
            )}
          >
            <Eraser className="size-3.5" strokeWidth={2} />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              aria-label={`Taille ${s}`}
              aria-pressed={size === s}
              onClick={() => setSize(s)}
              className={cx(
                'flex size-7 items-center justify-center rounded-full transition-colors',
                size === s ? 'bg-[var(--images-chip)]' : 'hover:bg-[var(--images-hover)]'
              )}
            >
              <span
                className="rounded-full bg-[var(--images-glyph)]"
                style={{ width: s + 2, height: s + 2, opacity: size === s ? 1 : 0.55 }}
              />
            </button>
          ))}
        </div>

        <div className="mx-1 hidden h-5 w-px bg-[var(--images-line)] sm:block" />

        <div className="flex items-center gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Couleur ${c}`}
              aria-pressed={color === c}
              onClick={() => {
                setColor(c);
                setErase(false);
              }}
              className={cx(
                'size-5 rounded-full transition-transform',
                color === c && !erase ? 'scale-110 ring-2 ring-[var(--images-ink)] ring-offset-2 ring-offset-[var(--images-bg)]' : 'ring-1 ring-[var(--images-ring)]'
              )}
              style={{ background: c }}
            />
          ))}
        </div>

        <div className="mx-1 hidden h-5 w-px bg-[var(--images-line)] sm:block" />

        <button
          type="button"
          onClick={undo}
          disabled={!dirty}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-chip)] hover:text-[var(--images-ink)] disabled:opacity-40"
        >
          <Undo2 className="size-3.5" strokeWidth={2} />
          Annuler
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={!dirty}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-danger-bg)] hover:text-[var(--images-danger)] disabled:opacity-40"
        >
          <Trash2 className="size-3.5" strokeWidth={2} />
          Effacer
        </button>
      </div>

      {/* Canvas */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-8">
        <div className="w-full max-w-[760px] overflow-hidden rounded-[16px] border border-[var(--images-line)] shadow-[var(--images-shadow-card)]">
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="block h-auto w-full touch-none bg-white"
            style={{ cursor: erase ? 'cell' : 'crosshair' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        </div>
      </div>
    </div>
  );
}
