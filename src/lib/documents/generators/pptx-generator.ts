import type { DocumentDoc } from '../core/document-schema';
import type { DocumentTemplate } from '../templates';

/**
 * PPTX generator — PptxGenJS (pure JS, serverless-safe).
 *
 * The SDR's `slides` drive the deck: one slide per section, NEVER every
 * paragraph on one slide. Layouts: title (deck opener), section, content
 * (title + bullets, max 6 visible + overflow continuation), closing.
 * The template palette + typography theme every slide; speaker notes from
 * slide.notes land in the PPTX notes pane.
 */

type PptxTextObject = {
  text?: string;
  options?: Record<string, unknown>;
};

const SLIDE_W = 13.333; // 16:9 inches
const SLIDE_H = 7.5;

/** Serialize slides for the pptx engine (handles overflow: >6 bullets split
 *  onto continuation slides so text never shrinks to unreadability). */
function planSlides(doc: DocumentDoc): Array<{
  title: string;
  bullets: string[];
  layout: string;
  notes?: string;
  continued?: boolean;
}> {
  const source = doc.slides?.length ? doc.slides : [];
  const planned: Array<{
    title: string;
    bullets: string[];
    layout: string;
    notes?: string;
    continued?: boolean;
  }> = [];
  for (const slide of source) {
    const bullets = slide.bullets.map((b) => b.replace(/\*\*/g, ''));
    if (bullets.length <= 6) {
      planned.push({ title: slide.title, bullets, layout: slide.layout, notes: slide.notes });
    } else {
      // Chunk long bullet lists across continuation slides.
      for (let i = 0; i < bullets.length; i += 6) {
        planned.push({
          title: i === 0 ? slide.title : `${slide.title} (suite ${Math.floor(i / 6) + 1})`,
          bullets: bullets.slice(i, i + 6),
          layout: slide.layout,
          notes: i === 0 ? slide.notes : undefined,
          continued: i > 0,
        });
      }
    }
  }
  return planned;
}

export async function generatePptxBytes(doc: DocumentDoc, tpl: DocumentTemplate): Promise<Uint8Array> {
  const mod: any = await import('pptxgenjs');
  const PptxGenJS = mod?.default ?? mod;
  if (typeof PptxGenJS !== 'function') throw new Error('pptxgenjs unavailable');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Nelth-AI';
  pptx.company = 'Nelth-AI';
  pptx.title = doc.title;
  pptx.subject = doc.title;

  const P = tpl.palette;
  const fontBody = tpl.typography.family === 'serif' ? 'Cambria' : 'Calibri';
  const fontHeading = fontBody;
  const slides = planSlides(doc).filter((s) => s.layout !== 'title' || (s.bullets.length > 0 && s.title !== doc.title));
  // ^ a parsed 'title'-layout slide with no bullets duplicates the deck
  //   opener built above — the parser marks the deck's `#` heading that way.

  // Deck title slide — full accent band + big title + subtle meta.
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: P.tint };
  titleSlide.addText(doc.title, {
    x: 0.8,
    y: 2.4,
    w: SLIDE_W - 1.6,
    h: 1.6,
    fontSize: 40,
    bold: true,
    color: P.ink,
    fontFace: fontHeading,
    align: 'left',
    valign: 'middle',
  });
  titleSlide.addShape('rect', {
    x: 0.8,
    y: 2.25,
    w: 2.2,
    h: 0.09,
    fill: { color: P.accent },
  });
  titleSlide.addText('Nelth-AI', {
    x: 0.8,
    y: 6.6,
    w: 4,
    h: 0.4,
    fontSize: 12,
    color: P.muted,
    fontFace: fontBody,
  });
  titleSlide.addNotes(`Document : ${doc.title}`);

  if (!slides.length) {
    // Degenerate deck — still a valid presentation (never empty).
    const s = pptx.addSlide();
    s.addText(doc.title, { x: 0.8, y: 3.2, w: SLIDE_W - 1.6, h: 1, fontSize: 28, bold: true, color: P.ink, fontFace: fontHeading });
    s.addText('—', { x: 0.8, y: 4.2, w: 4, h: 0.5, fontSize: 16, color: P.muted, fontFace: fontBody });
  }

  let slideNo = 1;
  for (const slide of slides) {
    slideNo += 1;
    const s = pptx.addSlide();
    s.background = { color: 'FFFFFF' };

    // Accent edge rail (every content slide) — template accent.
    s.addShape('rect', { x: 0, y: 0, w: 0.16, h: SLIDE_H, fill: { color: P.accent } });

    const isSection = slide.layout === 'section' || slide.layout === 'closing';
    const titleColor = isSection ? P.accent : P.ink;
    const titleSize = slide.layout === 'closing' ? 34 : isSection ? 30 : 26;

    s.addText(slide.title || (slide.continued ? '…' : ' '), {
      x: 0.75,
      y: 0.55,
      w: SLIDE_W - 1.5,
      h: 0.95,
      fontSize: titleSize,
      bold: true,
      color: titleColor,
      fontFace: fontHeading,
      valign: 'middle',
    });
    // Hairline under the title.
    s.addShape('rect', {
      x: 0.78,
      y: 1.55,
      w: SLIDE_W - 1.6,
      h: 0.02,
      fill: { color: P.hairline },
    });

    if (slide.bullets.length) {
      const items: PptxTextObject[] = slide.bullets.map((text) => ({
        text,
        options: {
          bullet: { characterCode: '2022', indent: 16 },
          color: P.body,
          fontSize: 17,
          fontFace: fontBody,
          paraSpaceAfter: 10,
          lineSpacingMultiple: 1.12,
        },
      }));
      s.addText(items, {
        x: 0.95,
        y: 1.9,
        w: SLIDE_W - 2.0,
        h: SLIDE_H - 2.9,
        valign: 'top',
      });
    }

    // Footer: slide number + document title.
    s.addText(`${slideNo}`, {
      x: SLIDE_W - 1.0,
      y: SLIDE_H - 0.55,
      w: 0.5,
      h: 0.3,
      fontSize: 11,
      color: P.muted,
      fontFace: fontBody,
      align: 'right',
    });
    s.addText(doc.title, {
      x: 0.95,
      y: SLIDE_H - 0.55,
      w: 8,
      h: 0.3,
      fontSize: 11,
      color: P.muted,
      fontFace: fontBody,
    });

    if (slide.notes) s.addNotes(slide.notes);
  }

  // Closing slide — accent block with a thank-you.
  const closing = pptx.addSlide();
  closing.background = { color: P.accent };
  closing.addText('Merci', {
    x: 0,
    y: 3.0,
    w: SLIDE_W,
    h: 1.4,
    fontSize: 44,
    bold: true,
    color: 'FFFFFF',
    fontFace: fontHeading,
    align: 'center',
  });
  closing.addText(`${doc.title} — généré par Nelth-AI`, {
    x: 0,
    y: 4.4,
    w: SLIDE_W,
    h: 0.5,
    fontSize: 14,
    color: 'FFFFFF',
    fontFace: fontBody,
    align: 'center',
    transparency: 18,
  });

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return new Uint8Array(out as unknown as ArrayBuffer);
}
