/**
 * Nelth-AI Documents — rendus des blocs SDR sur le papier A4.
 *
 * Chaque bloc est dessiné selon le modèle (palette + typo + échelle) avec
 * les MÊMES règles que le convertisseur PDF : titres colorés, corps à la
 * taille du modèle (pt), tableaux à en-tête accent / zébrures, citations à
 * filet accent, encadrés teintés, code mono. Le markdown inline (**gras**,
 * *italique*, `code`) est rendu typographiquement en lecture — l'édition
 * travaille sur le texte brut (marqueurs conservés).
 */

import * as React from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type {
  DocBlock,
  DocCallout,
  DocHeading,
  DocList,
  DocQuote,
  DocTable,
  DocumentTemplate,
} from '../lib/documents/core/document-schema';
import { cssFonts } from '../lib/documents/templates';
import { cx, AuthImg, Editable } from './ui';

export type CssFonts = ReturnType<typeof cssFonts>;

/** Callbacks d'édition fournis par le workspace (mutent le SDR). */
export type BlockEditor = {
  onSelect(block: DocBlock): void;
  editText(block: DocBlock, text: string): void;
  editListItem(block: DocList, itemIndex: number, text: string): void;
  editQuoteAuthor(block: DocQuote, author: string): void;
  editCalloutTitle(block: DocCallout, title: string): void;
  editCalloutText(block: DocCallout, text: string): void;
  editTableHeader(block: DocTable, col: number, value: string): void;
  editTableCell(block: DocTable, row: number, col: number, value: string): void;
  addTableRow(block: DocTable, row: number): void;
  removeTableRow(block: DocTable, row: number): void;
};

// ---------------------------------------------------------------------------
// Markdown inline — **gras**, *italique*, `code` → React nodes
// ---------------------------------------------------------------------------

const INLINE_RE = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`/g;

/** Découpe le texte en runs typographiques (gras / italique / code en ligne). */
export function inlineMarkdown(text: string, keyPrefix = 'md'): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'g');
  let last = 0;
  let seq = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${seq++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else if (m[3] !== undefined)
      out.push(
        <code key={key} className="docs-inline-code">
          {m[3]}
        </code>
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// Styles dérivés du modèle
// ---------------------------------------------------------------------------

const CALLOUT_ICON = {
  info: Info,
  warning: TriangleAlert,
  success: CircleCheck,
  danger: CircleAlert,
} as const;

const CALLOUT_COLOR = {
  info: null, // accentDark du modèle
  warning: '#92610a',
  success: '#14713c',
  danger: '#a02c22',
} as const;

function headingFontSize(level: number, tpl: DocumentTemplate): number {
  const base = tpl.typography.size;
  const [s2, s3, s4] = tpl.typography.headingScale;
  if (level === 1) return base * 2;
  if (level === 2) return base * s2;
  if (level === 3) return base * s3;
  return base * s4;
}

// ---------------------------------------------------------------------------
// Bloc
// ---------------------------------------------------------------------------

export function BlockView({
  block,
  tpl,
  fonts,
  editor,
  selected,
  bidx,
  anchorId,
}: {
  block: DocBlock;
  tpl: DocumentTemplate;
  fonts: CssFonts;
  editor: BlockEditor;
  selected: boolean;
  bidx: number;
  anchorId?: string;
}) {
  const base = tpl.typography.size;
  const leading = tpl.typography.leading;
  const p = tpl.palette;

  let inner: React.ReactNode = null;

  switch (block.t) {
    case 'heading': {
      const h = block as DocHeading;
      const size = headingFontSize(h.level, tpl);
      const color = h.level === 1 ? p.accent : h.level === 2 ? p.accentDark : p.ink;
      inner = (
        <Editable
          value={h.text}
          onCommit={(text) => editor.editText(block, text)}
          render={(t) => inlineMarkdown(t, `h${bidx}`)}
          placeholder="Titre…"
          style={{
            fontFamily: fonts.heading,
            fontSize: `${size.toFixed(2)}pt`,
            fontWeight: h.level <= 2 ? 700 : h.level === 3 ? 700 : 600,
            color: `#${color}`,
            lineHeight: 1.2,
            marginTop: `${h.level <= 2 ? 10 : 6}pt`,
            marginBottom: `${h.level === 1 ? 16 : h.level === 2 ? 8 : 6}pt`,
            letterSpacing: h.level === 1 ? '-0.01em' : undefined,
          }}
        />
      );
      break;
    }

    case 'para':
      inner = (
        <Editable
          value={block.text}
          onCommit={(text) => editor.editText(block, text)}
          multiline
          render={(t) => inlineMarkdown(t, `p${bidx}`)}
          placeholder="Paragraphe…"
          style={{
            fontSize: `${base}pt`,
            color: `#${p.ink}`,
            lineHeight: `${(1.42 * leading).toFixed(3)}`,
            marginBottom: `${7 * leading}pt`,
            whiteSpace: 'pre-wrap',
            textAlign: 'justify',
            hyphens: 'auto',
          }}
        />
      );
      break;

    case 'list': {
      const list = block as DocList;
      const ordered = list.style === 'number';
      const check = list.style === 'check';
      inner = (
        <div
          style={{ fontSize: `${base}pt`, color: `#${p.ink}`, marginBottom: `${6 * leading}pt` }}
        >
          {list.items.map((item, i) => {
            return (
              <div
                key={i}
                className="flex items-start"
                style={{ paddingLeft: `${10 + item.level * 16}pt`, marginBottom: `${3.5 * leading}pt` }}
              >
                <span
                  aria-hidden="true"
                  className="shrink-0 select-none"
                  style={{
                    width: ordered ? '18pt' : '12pt',
                    marginLeft: `-${ordered ? 18 : 12}pt`,
                    paddingTop: '0.1em',
                    color: `#${ordered ? p.accentDark : p.accent}`,
                    fontSize: ordered ? `${base}pt` : '0.9em',
                    fontWeight: ordered ? 600 : 400,
                    lineHeight: `${(1.4 * leading).toFixed(3)}`,
                  }}
                >
                  {check ? (
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" aria-hidden="true">
                      <path
                        d="M5 12.5l4.5 4.5L19 7"
                        stroke={`#${p.accent}`}
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : ordered ? (
                    `${i + 1}.`
                  ) : (
                    '\u2022'
                  )}
                </span>
                <Editable
                  value={item.text}
                  onCommit={(text) => editor.editListItem(list, i, text)}
                  multiline
                  render={(t) => inlineMarkdown(t, `li${bidx}-${i}`)}
                  className="min-w-0 flex-1"
                  style={{ lineHeight: `${(1.4 * leading).toFixed(3)}`, whiteSpace: 'pre-wrap' }}
                />
              </div>
            );
          })}
        </div>
      );
      break;
    }

    case 'table': {
      const table = block as DocTable;
      const cols = table.header.length;
      inner = (
        <div style={{ marginBottom: `${10 * leading}pt` }}>
          <table
            className="w-full"
            style={{ borderCollapse: 'collapse', fontSize: `${(base - 1).toFixed(2)}pt`, tableLayout: 'fixed' }}
          >
            <thead>
              <tr>
                {table.header.map((cell, c) => (
                  <th
                    key={c}
                    style={{
                      background: `#${p.accent}`,
                      color: '#ffffff',
                      fontWeight: 700,
                      textAlign: 'left',
                      padding: '5pt 7pt',
                      border: `0.75pt solid #${p.accent}`,
                    }}
                  >
                    <Editable
                      value={cell}
                      onCommit={(v) => editor.editTableHeader(table, c, v)}
                      style={{ color: '#ffffff', fontWeight: 700 }}
                      title="Modifier l'en-tête"
                    />
                  </th>
                ))}
                <th style={{ width: '30pt', border: 'none', padding: '0 2pt' }} aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r} className="group/trow" style={{ background: r % 2 === 1 ? `#${p.zebra}` : 'transparent' }}>
                  {Array.from({ length: cols }, (_, c) => {
                    const cell = row[c] ?? '';
                    return (
                      <td
                        key={c}
                        style={{
                          padding: '4.5pt 7pt',
                          border: `0.75pt solid #${p.hairline}`,
                          color: `#${p.ink}`,
                          verticalAlign: 'top',
                        }}
                      >
                        <Editable
                          value={cell}
                          onCommit={(v) => editor.editTableCell(table, r, c, v)}
                          style={{ lineHeight: 1.4 }}
                        />
                      </td>
                    );
                  })}
                  <td
                    style={{ border: 'none', padding: '2pt 2pt 0', verticalAlign: 'top' }}
                    aria-hidden="true"
                  >
                    <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/trow:opacity-100">
                      <button
                        type="button"
                        aria-label="Ajouter une ligne en dessous"
                        title="Ajouter une ligne en dessous"
                        onClick={() => editor.addTableRow(table, r)}
                        className="flex size-[18px] items-center justify-center rounded text-[10px] text-[var(--docs-muted)] hover:bg-[var(--docs-hover)]"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label="Supprimer la ligne"
                        title="Supprimer la ligne"
                        onClick={() => editor.removeTableRow(table, r)}
                        className="flex size-[18px] items-center justify-center rounded text-[10px] text-[var(--docs-danger)] hover:bg-[var(--docs-danger-bg)]"
                      >
                        ×
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {table.caption ? (
            <div
              style={{
                fontSize: `${(base - 2).toFixed(2)}pt`,
                color: `#${p.muted}`,
                marginTop: '4pt',
                textAlign: 'center',
                fontStyle: 'italic',
              }}
            >
              {table.caption}
            </div>
          ) : null}
        </div>
      );
      break;
    }

    case 'quote': {
      const quote = block as DocQuote;
      inner = (
        <div
          style={{
            borderLeft: `2.5pt solid #${p.accent}`,
            paddingLeft: '12pt',
            paddingRight: '6pt',
            margin: `${4 * leading}pt 0 ${14 * leading}pt`,
          }}
        >
          <Editable
            value={quote.text}
            onCommit={(text) => editor.editText(block, text)}
            multiline
            render={(t) => inlineMarkdown(t, `q${bidx}`)}
            style={{
              fontSize: `${base}pt`,
              color: `#${p.body}`,
              fontStyle: 'italic',
              lineHeight: `${(1.4 * leading).toFixed(3)}`,
              whiteSpace: 'pre-wrap',
            }}
          />
          {quote.author !== undefined && quote.author !== null ? (
            <Editable
              value={quote.author}
              onCommit={(author) => editor.editQuoteAuthor(quote, author)}
              placeholder="— Auteur"
              style={{
                fontSize: `${(base - 1.5).toFixed(2)}pt`,
                color: `#${p.muted}`,
                marginTop: '5pt',
                fontWeight: 500,
              }}
            />
          ) : null}
        </div>
      );
      break;
    }

    case 'callout': {
      const callout = block as DocCallout;
      const Icon = CALLOUT_ICON[callout.variant] ?? Info;
      const iconColor = CALLOUT_COLOR[callout.variant] ?? `#${p.accentDark}`;
      inner = (
        <div
          style={{
            background: `#${p.tint}`,
            borderLeft: `2.5pt solid #${p.accent}`,
            borderRadius: '4px',
            padding: '9pt 12pt',
            margin: `${4 * leading}pt 0 ${12 * leading}pt`,
          }}
        >
          <div className="flex items-start gap-2">
            <Icon
              className="mt-[2px] shrink-0"
              style={{ width: '13px', height: '13px', color: iconColor }}
              strokeWidth={2.2}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              {callout.title !== undefined && callout.title !== null ? (
                <Editable
                  value={callout.title}
                  onCommit={(title) => editor.editCalloutTitle(callout, title)}
                  placeholder="Titre de l'encadré…"
                  style={{
                    fontSize: `${base}pt`,
                    fontWeight: 700,
                    color: `#${p.accentDark}`,
                    marginBottom: '3pt',
                  }}
                />
              ) : null}
              <Editable
                value={callout.text}
                onCommit={(text) => editor.editCalloutText(callout, text)}
                multiline
                render={(t) => inlineMarkdown(t, `c${bidx}`)}
                style={{
                  fontSize: `${base}pt`,
                  color: `#${p.ink}`,
                  lineHeight: `${(1.4 * leading).toFixed(3)}`,
                  whiteSpace: 'pre-wrap',
                }}
              />
            </div>
          </div>
        </div>
      );
      break;
    }

    case 'code':
      inner = (
        <div style={{ margin: `${3 * leading}pt 0 ${11 * leading}pt` }}>
          {block.lang ? (
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: `${(base - 3).toFixed(2)}pt`,
                color: `#${p.muted}`,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: '3pt',
              }}
            >
              {block.lang}
            </div>
          ) : null}
          <Editable
            value={block.text}
            onCommit={(text) => editor.editText(block, text)}
            multiline
            style={{
              display: 'block',
              fontFamily: fonts.mono,
              fontSize: `${(base - 1.5).toFixed(2)}pt`,
              color: `#${p.ink}`,
              background: `#${p.zebra}`,
              border: `0.75pt solid #${p.hairline}`,
              borderRadius: '4px',
              padding: '8pt 10pt',
              lineHeight: 1.35,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
            }}
          />
        </div>
      );
      break;

    case 'divider':
      inner = (
        <hr
          style={{
            border: 'none',
            borderTop: `0.75pt solid #${p.hairline}`,
            margin: `${9 * leading}pt 0`,
          }}
        />
      );
      break;

    case 'pagebreak':
      inner = null;
      break;

    case 'image':
      inner =
        block.url.startsWith('/') ? (
          <div style={{ margin: `${4 * leading}pt 0 ${10 * leading}pt`, textAlign: 'center' }}>
            <AuthImg
              path={block.url}
              alt={block.alt ?? ''}
              className="mx-auto"
              style={{
                maxWidth: '100%',
                borderRadius: '4px',
                border: `0.75pt solid #${p.hairline}`,
              }}
              fallbackClassName="mx-auto h-[180pt] w-full rounded-[4px]"
            />
          </div>
        ) : (
          <div style={{ margin: `${4 * leading}pt 0 ${10 * leading}pt`, textAlign: 'center' }}>
            <img
              src={block.url}
              alt={block.alt ?? ''}
              draggable={false}
              className="mx-auto"
              style={{ maxWidth: '100%', borderRadius: '4px' }}
            />
          </div>
        );
      break;

    default:
      inner = null;
  }

  return (
    <div
      className={cx('docs-block', selected && 'docs-block-selected')}
      data-bidx={bidx}
      data-anchor={anchorId}
      onClick={() => editor.onSelect(block)}
    >
      {inner}
    </div>
  );
}
