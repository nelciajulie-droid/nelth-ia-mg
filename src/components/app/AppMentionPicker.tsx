"use client";

/**
 * @ App mention picker — ChatGPT-style application picker for the composer.
 *
 * Typing "@" at word start (or pressing the @ toolbar button) opens the picker
 * above the composer: the REAL app registry from GET /api/v1/connectors
 * (definitions + live per-user connection status — never invented), filtered
 * as-you-type (accent-insensitive across name/id/keywords).
 *
 * Selection rides the chat completions request as STRUCTURED METADATA
 * (`connector_ids`) — v12-flow section 3.3ter-bis resolves it against the
 * registry and the user's connector_connection rows. Disconnected apps carry
 * a « Connecter » button: POST /api/v1/connectors/{id}/connect either
 * navigates to the OAuth provider or answers an actionable message
 * (env vars to set / wrong origin).
 */

import * as React from "react";
import { AtSign, Check, Loader2, Plug, RefreshCw, SearchX } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import type { ConnectorListItem } from "@/lib/apps/app-types";

/** Max mentions per message — mirrors sanitizeConnectorIds on the server. */
export const MAX_APP_MENTIONS = 8;

/** Active trigger: where the "@" started and what was typed after it. */
export interface MentionState {
  /** Index of the "@" character inside the composer text. */
  start: number;
  /** Raw query typed after the "@" (no whitespace — see mentionQueryAt). */
  query: string;
}

/**
 * Detect an active @ trigger at the caret: the nearest "@" before the cursor,
 * at word start (start-of-text or after whitespace), with no whitespace
 * between it and the caret. Email-like "user@domain" never triggers.
 */
export function mentionQueryAt(text: string, cursor: number): MentionState | null {
  const caret = Math.max(0, Math.min(cursor, text.length));
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === "@") {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null; // mid-word @ (email…)
      return { start: i, query: text.slice(i + 1, caret) };
    }
    if (/\s/.test(ch)) return null; // a space closes the mention
  }
  return null;
}

/** Fold case + accents so "recherche" finds "Recherche" and "calendrier" finds "Google Calendar". */
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** Filter the registry by the typed query (name + id + keywords). */
export function filterApps(apps: ConnectorListItem[], query: string): ConnectorListItem[] {
  const needle = fold(query.trim());
  if (!needle) return apps;
  return apps.filter((app) =>
    fold([app.name, app.id, ...app.keywords].join(" ")).includes(needle)
  );
}

// ---------------------------------------------------------------------------
// Registry hook
// ---------------------------------------------------------------------------

export function useConnectorApps() {
  const [apps, setApps] = React.useState<ConnectorListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ connectors?: ConnectorListItem[] }>("/api/v1/connectors");
      setApps(Array.isArray(data?.connectors) ? data.connectors : []);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return { apps, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// Picker panel (presentation only — state lives in the composer)
// ---------------------------------------------------------------------------

function ConnectionBadge({ app }: { app: ConnectorListItem }) {
  if (app.builtin) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700" title="Connecteur intégré — aucun compte nécessaire">
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
        Prêt
      </span>
    );
  }
  if (app.connection.status === "connected") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
        title={app.connection.account ? `Connecté — ${app.connection.account}` : "Connecté"}
      >
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
        Connecté
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500" title="Aucun compte connecté">
      <span className="size-1.5 rounded-full bg-zinc-400" aria-hidden />
      Non connecté
    </span>
  );
}

export function AppMentionPicker({
  items,
  query,
  loading,
  error,
  activeIndex,
  selectedIds,
  connectingId,
  onActiveIndexChange,
  onSelect,
  onConnect,
  onRefresh,
}: {
  /** Filtered registry rows (filterApps output). */
  items: ConnectorListItem[];
  /** Raw query typed after the "@". */
  query: string;
  loading: boolean;
  error: string | null;
  activeIndex: number;
  /** Already-mentioned app ids (checked rows). */
  selectedIds: string[];
  /** App id whose connect POST is in flight. */
  connectingId: string | null;
  onActiveIndexChange: (index: number) => void;
  onSelect: (app: ConnectorListItem) => void;
  onConnect: (app: ConnectorListItem) => void;
  onRefresh: () => void;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);

  // Keep the active row in view while navigating with the keyboard.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-active="true"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);

  return (
    <div
      id="app-mention-picker"
      role="dialog"
      aria-label="Applications — mention @"
      className="absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/10"
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-zinc-500">
          <AtSign className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
          <span className="shrink-0">Applications</span>
          {query ? (
            <span className="truncate text-zinc-400">
              — «&nbsp;{query}&nbsp;»
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRefresh}
          aria-label="Actualiser l'état des applications"
          title="Actualiser l'état des applications"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label="Applications disponibles"
        className="scrollbar-thin max-h-72 overflow-y-auto"
      >
        {loading ? (
          <div className="space-y-1 p-2" aria-live="polite">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl px-2 py-2">
                <div className="size-8 shrink-0 animate-pulse rounded-lg bg-zinc-100" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-24 animate-pulse rounded bg-zinc-100" />
                  <div className="h-2.5 w-48 animate-pulse rounded bg-zinc-100" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-zinc-400">
            <SearchX className="size-5 text-zinc-300" aria-hidden />
            <p>Applications indisponibles — {error}</p>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onRefresh}
              className="rounded-lg border border-zinc-200 px-2.5 py-1 font-medium text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-700"
            >
              Réessayer
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center text-xs text-zinc-400">
            <SearchX className="size-5 text-zinc-300" aria-hidden />
            <p>Aucune application pour «&nbsp;{query}&nbsp;»</p>
            <p className="text-[10px]">Échap pour fermer le sélecteur</p>
          </div>
        ) : (
          <ul className="p-1.5">
            {items.map((app, index) => {
              const isSelected = selectedIds.includes(app.id);
              const isActive = index === activeIndex;
              const connecting = connectingId === app.id;
              const canConnect = !app.builtin && app.connection.status !== "connected";
              return (
                <li key={app.id} role="none">
                  <div
                    id={`app-option-${app.id}`}
                    role="option"
                    aria-selected={isSelected}
                    data-active={isActive}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!isActive) onActiveIndexChange(index);
                    }}
                    onClick={() => onSelect(app)}
                    className={
                      "flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition-colors outline-none " +
                      (isActive ? "bg-emerald-50" : "hover:bg-zinc-50")
                    }
                  >
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-zinc-100 bg-white [&>svg]:size-5"
                      aria-hidden
                      dangerouslySetInnerHTML={{ __html: app.icon }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-zinc-800">
                          {app.name}
                        </span>
                        {isSelected ? (
                          <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                        ) : null}
                      </span>
                      <span className="block truncate text-[11px] leading-4 text-zinc-400">
                        {app.description}
                      </span>
                    </span>
                    <ConnectionBadge app={app} />
                    {canConnect ? (
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onConnect(app);
                        }}
                        disabled={connecting}
                        aria-label={`Connecter ${app.name}`}
                        title={`Connecter ${app.name} (OAuth)`}
                        className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-50"
                      >
                        {connecting ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Plug className="size-3.5" aria-hidden />
                        )}
                        <span className="hidden sm:inline">Connecter</span>
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-zinc-100 bg-zinc-50/70 px-3 py-1.5 text-[10px] text-zinc-400">
        <kbd className="rounded border border-zinc-200 bg-white px-1 font-sans">↑</kbd>{" "}
        <kbd className="rounded border border-zinc-200 bg-white px-1 font-sans">↓</kbd> naviguer ·{" "}
        <kbd className="rounded border border-zinc-200 bg-white px-1 font-sans">Entrée</kbd> sélectionner ·{" "}
        <kbd className="rounded border border-zinc-200 bg-white px-1 font-sans">Échap</kbd> fermer
      </div>
    </div>
  );
}
