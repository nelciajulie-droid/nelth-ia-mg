import { db } from '@/lib/db';
import { getAppById } from './app-registry';
import type { AppDefinition, AppConnection } from './app-types';

/**
 * Connector routing for the chat flow (v12-flow.ts section 3.3b).
 *
 * The @ app mention picker (loader.js) injects the selected app ids as
 * structured metadata on the chat completions request (`connector_ids`).
 * This module resolves them against the registry and the user's REAL
 * connection rows, then:
 *
 *   • web_search → forces the existing web-search pipeline (real tool run:
 *     search chain, context injection, citations — see lib/retrieval/web-search.ts);
 *   • every selected connector → one visible status row (the same protocol
 *     the skills use) carrying its TRUE connection state;
 *   • the model receives a context note listing the requested connectors
 *     with their real status — it must never pretend to have accessed an
 *     unconnected account, and must not invent data for connected ones
 *     either (the pipeline surfaces connector data explicitly or not at all).
 */

export type ConnectorPick = {
  app: AppDefinition;
  connection: AppConnection;
};

type ConnectionRow = {
  id: string;
  user_id: string;
  connector_id: string;
  status: string;
  provider: string | null;
  account: string | null;
  created_at: number;
};

async function connectionRows(userId: string): Promise<Map<string, ConnectionRow>> {
  const rows = (await db.connectorConnection.findMany({
    where: { user_id: userId },
  })) as unknown as ConnectionRow[];
  return new Map(rows.map((row) => [row.connector_id, row]));
}

function connectionOf(app: AppDefinition, row: ConnectionRow | undefined): AppConnection {
  if (app.builtin) return { status: 'ready', account: null, connected_at: null };
  if (!row || row.status !== 'connected') {
    return { status: 'disconnected', account: row?.account ?? null, connected_at: null };
  }
  return { status: 'connected', account: row.account ?? null, connected_at: row.created_at ?? null };
}

/** Sanitize the ids coming from the wire (URL-safe registry ids only). */
export function sanitizeConnectorIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    if (!/^[a-z0-9_]{1,32}$/.test(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.slice(0, 8);
}

/** Resolve the selection: valid registry apps with their REAL connections. */
export async function resolveConnectorSelection(userId: string, ids: string[]): Promise<ConnectorPick[]> {
  if (!ids.length) return [];
  const rows = await connectionRows(userId);
  const picks: ConnectorPick[] = [];
  for (const id of ids) {
    const app = getAppById(id);
    if (!app) continue;
    picks.push({ app, connection: connectionOf(app, rows.get(id)) });
  }
  return picks;
}

/** True when the web_search connector is part of the selection (any status —
 * it is built-in and always ready). */
export function selectionForcesWebSearch(picks: ConnectorPick[]): boolean {
  return picks.some((pick) => pick.app.id === 'web_search');
}

/** Human status label for the visible status row. */
export function connectorStatusLabel(pick: ConnectorPick): string {
  if (pick.app.builtin) return 'prêt';
  if (pick.connection.status === 'connected') {
    return pick.connection.account ? `connecté (${pick.connection.account})` : 'connecté';
  }
  return 'non connecté';
}

/**
 * Context note injected AFTER the last user message (same position the
 * pre-selected skills use — conversation-only, never persisted): the model
 * learns which connectors the user @-mentioned, their true status, and how
 * to talk about them.
 */
export function buildConnectorContext(picks: ConnectorPick[]): string | null {
  const external = picks.filter((pick) => !pick.app.builtin);
  if (!external.length) return null;

  const lines = external.map((pick) => {
    const label =
      pick.connection.status === 'connected'
        ? pick.connection.account
          ? `connecté (${pick.connection.account})`
          : 'connecté'
        : 'NON connecté';
    const actions = pick.app.actions.map((action) => action.label).join(', ');
    return `- ${pick.app.name} (${pick.app.connector}) : ${label} — actions disponibles côté connecteur : ${actions}.`;
  });

  return [
    '[Connecteurs demandés par l’utilisateur via le sélecteur @ — statut réel vérifié côté serveur :]',
    ...lines,
    'Consignes :',
    '- Pour un connecteur NON connecté : ne prétendez JAMAIS avoir accédé à ses données. Indiquez en une phrase qu’il faut le connecter (tapez @ dans la zone de message, choisissez l’application, puis « Connecter »), puis répondez normalement au reste de la question.',
    '- Pour un connecteur connecté : n’affichez pas non plus de contenus inventés de ce compte — les données réelles arrivent par les outils du connecteur, jamais par déduction.',
    '- Ne mentionnez cette note technique que si l’utilisateur demande les applications ; sinon répondez à sa question.',
  ].join('\n');
}
