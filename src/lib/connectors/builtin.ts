/**
 * Built-in connectors — the zero-setup plugin catalog behind the @ quick
 * action.
 *
 * The compiled frontend's @ menu lists what GET /api/v1/tools/ returns; the
 * tools router merges every connector below as a "server:connector:<id>"
 * entry (same family as admin-configured OpenAPI tool servers). Selecting
 * one rides the chat form as tool_ids["server:connector:<id>"], and the
 * v12-flow connectors phase resolves + executes it through
 * lib/chat/connectors.ts — which short-circuits built-ins to the LOCAL
 * handlers defined here (no HTTP tool server to reach).
 *
 * Two data modes:
 *  - GOOGLE_* credentials present  → real Google API calls (google.ts);
 *  - otherwise                     → DEMO MODE: deterministic, realistic
 *    simulated data, flagged with {_demo: true, _notice: …} so the model
 *    tells the user the connector is not yet connected for real.
 *
 * Wikipédia is always LIVE (public APIs, no credentials).
 */
import {
  googleCredsConfigured,
  gmailSearch,
  gmailGetMessage,
  gmailSend,
  gmailMessageToEmail,
  calendarListEvents,
  calendarCreateEvent,
  driveSearch,
  driveRecent,
  contactsSearch,
  type GoogleApiResult,
} from './google';

export type { GoogleApiResult };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuiltinToolParam {
  name: string;
  in: 'query' | 'body';
  required?: boolean;
  type: 'string' | 'integer' | 'boolean';
  description: string;
  enum?: string[];
  default?: string | number | boolean;
}

export interface BuiltinToolDef {
  operationId: string;
  method: 'get' | 'post';
  path: string;
  summary: string;
  description: string;
  parameters: BuiltinToolParam[];
  handler: (args: Record<string, any>) => unknown | Promise<unknown>;
}

export interface BuiltinConnectorDef {
  /** Tool id AFTER the 'server:' prefix — 'connector:gmail'. */
  id: string;
  name: string;
  description: string;
  tools: BuiltinToolDef[];
}

/** tool id in the @ menu / tool_ids array. */
export const SERVER_PREFIX = 'server:';

// ---------------------------------------------------------------------------
// OpenAPI builder (the same conversion path as admin tool servers)
// ---------------------------------------------------------------------------

export function builtinOpenapi(def: BuiltinConnectorDef): Record<string, any> {
  const paths: Record<string, any> = {};
  for (const t of def.tools) {
    const op: Record<string, any> = {
      operationId: t.operationId,
      summary: t.summary,
      description: t.description,
    };
    const queryParams = t.parameters.filter((p) => p.in === 'query');
    if (queryParams.length) {
      op.parameters = queryParams.map((p) => ({
        name: p.name,
        in: 'query',
        required: p.required ?? false,
        description: p.description,
        schema: {
          type: p.type,
          ...(p.enum ? { enum: p.enum } : {}),
          ...(p.default !== undefined ? { default: p.default } : {}),
        },
      }));
    }
    if (t.method === 'post') {
      const bodyParams = t.parameters.filter((p) => p.in === 'body');
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const p of bodyParams) {
        properties[p.name] = {
          type: p.type,
          description: p.description,
          ...(p.enum ? { enum: p.enum } : {}),
        };
        if (p.required) required.push(p.name);
      }
      op.requestBody = {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties,
              ...(required.length ? { required } : {}),
            },
          },
        },
      };
    }
    // Several tools may share a path (GET /events + POST /events) — merge.
    paths[t.path] = { ...(paths[t.path] ?? {}), [t.method]: op };
  }
  return {
    openapi: '3.1.0',
    info: { title: def.name, description: def.description, version: '1.0.0' },
    paths,
  };
}

/** operationId → local handler (used by lib/chat/connectors.ts execution). */
export function builtinHandlers(
  def: BuiltinConnectorDef
): Record<string, (args: Record<string, any>) => unknown | Promise<unknown>> {
  const map: Record<string, (args: Record<string, any>) => unknown | Promise<unknown>> = {};
  for (const t of def.tools) map[t.operationId] = t.handler;
  return map;
}

export function getBuiltinConnector(id: string): BuiltinConnectorDef | null {
  return BUILTIN_CONNECTORS.find((c) => c.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

const DEMO_NOTICE =
  'MODE DÉMO : données simulées — aucun compte Google n’est connecté à l’application. ' +
  'L’administrateur peut activer les vraies données en ajoutant GOOGLE_CLIENT_ID, ' +
  'GOOGLE_CLIENT_SECRET et GOOGLE_REFRESH_TOKEN aux variables d’environnement.';

function withDemoNotice(payload: Record<string, any>): Record<string, any> {
  return { ...payload, _demo: true, _notice: DEMO_NOTICE };
}

/** Deterministic PRNG so the same query always yields the same demo data. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function clampMax(args: Record<string, any>, fallback = 5): number {
  const n = Number(args.max_results ?? args.maxResults ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 10);
}

function strArg(args: Record<string, any>, name: string, fallback = ''): string {
  const v = args[name];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** Europe/Paris yyyy-mm-dd for a day offset from today. */
function parisDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); // yyyy-mm-dd
}

function parisDayRange(offsetDays: number): { timeMinIso: string; timeMaxIso: string } {
  const day = parisDate(offsetDays);
  return { timeMinIso: `${day}T00:00:00+01:00`, timeMaxIso: `${day}T23:59:59+01:00` };
}

function humanSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

/** Google API failure → tool_result-style error body (creds configured). */
function googleError(res: GoogleApiResult, what: string): Record<string, any> {
  const msg =
    res.data?.error?.message ?? (res.status ? `HTTP ${res.status}` : 'appel réseau échoué');
  return { error: `Google ${what} a échoué : ${msg}`, status: res.status };
}

// ---------------------------------------------------------------------------
// Demo data pools
// ---------------------------------------------------------------------------

const GMAIL_PEOPLE = [
  { name: 'Marie Dupont', email: 'marie.dupont@gmail.com' },
  { name: 'Amazon.fr', email: 'service-commandes@amazon.fr' },
  { name: 'LinkedIn', email: 'messages-noreply@linkedin.com' },
  { name: 'Orange', email: 'factures@orange.fr' },
  { name: 'Doctolib', email: 'notifications@doctolib.com' },
  { name: 'Jean Martin', email: 'jean.martin@orange.fr' },
  { name: 'Airbnb', email: 'express@airbnb.com' },
  { name: 'Netflix', email: 'info@netflix.com' },
  { name: 'Société Générale', email: 'ne-pas-repondre@societegenerale.fr' },
  { name: 'Sophie Bernard', email: 'sophie.bernard@gmail.com' },
  { name: 'Steam', email: 'noreply@steampowered.com' },
  { name: 'La Banque Postale', email: 'infos@labanquepostale.fr' },
];

function demoEmails(query: string, count: number, unread: boolean): Record<string, any>[] {
  const rnd = seeded(`gmail:${query}:${count}:${unread}`);
  const subjects = [
    `Re: ${query}`,
    `Votre demande — ${query}`,
    `${query} : confirmation et détails`,
    `Facture relative à ${query}`,
    `Invitation : ${query}`,
    `Mise à jour concernant ${query}`,
    `Votre rendez-vous (${query})`,
  ];
  const snippets = [
    `Bonjour, suite à votre demande concernant « ${query} », vous trouverez ci-dessous les informations détaillées…`,
    `Bonjour, votre demande a bien été prise en compte. Nous revenons vers vous rapidement avec une réponse…`,
    `Merci pour votre message. Voici les derniers éléments relatifs à « ${query} »…`,
    `Ceci est un rappel : l’échéance concernant « ${query} » approche, merci d’y prêter attention…`,
  ];
  const out: Record<string, any>[] = [];
  for (let i = 0; i < count; i++) {
    const person = GMAIL_PEOPLE[Math.floor(rnd() * GMAIL_PEOPLE.length)];
    const daysAgo = Math.floor(rnd() * 21);
    const date = new Date(Date.now() - daysAgo * 864e5 - Math.floor(rnd() * 20) * 36e5);
    out.push({
      id: `demo-${Math.floor(rnd() * 1e9).toString(36)}`,
      from: `${person.name} <${person.email}>`,
      subject: subjects[Math.floor(rnd() * subjects.length)],
      snippet: snippets[Math.floor(rnd() * snippets.length)],
      date: date.toISOString(),
      unread,
      labels: unread ? ['INBOX', 'UNREAD'] : ['INBOX'],
    });
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return out;
}

const CAL_TEMPLATES = [
  { title: 'Réunion d’équipe — point hebdo', start: '09:00', end: '09:45', location: 'Salle Athéna' },
  { title: 'Déjeuner client', start: '12:30', end: '14:00', location: 'Le Bistrot Parisien' },
  { title: 'Atelier produit — roadmap', start: '15:00', end: '16:30', location: 'Google Meet' },
  { title: 'Rendez-vous dentiste', start: '18:00', end: '18:45', location: 'Cabinet Dr Petit' },
  { title: 'Sport — musculation', start: '19:00', end: '20:00', location: 'Basic-Fit' },
  { title: 'Retour d’expérience — slides', start: '10:30', end: '11:30', location: 'Bureau' },
  { title: 'Appel fournisseur', start: '16:00', end: '16:30', location: 'Téléphone' },
  { title: 'Revue de code', start: '11:00', end: '12:00', location: 'Visio' },
];

function demoEvents(range: string, max: number): Record<string, any> {
  const rnd = seeded(`cal:${range}:${parisDate(0)}`);
  const days = range === 'tomorrow' ? [1] : range === 'week' ? [0, 1, 2, 3, 4, 5, 6] : [0];
  const events: Record<string, any>[] = [];
  for (const day of days) {
    const picked = CAL_TEMPLATES.filter(() => rnd() > 0.35).slice(0, 3);
    if (!picked.length) picked.push(CAL_TEMPLATES[Math.floor(rnd() * CAL_TEMPLATES.length)]);
    for (const t of picked) {
      events.push({
        id: `demo-${day}-${t.start.replace(':', '')}`,
        title: t.title,
        date: parisDate(day),
        start_time: t.start,
        end_time: t.end,
        location: t.location,
        organizer: 'moi@gmail.com',
      });
    }
  }
  return withDemoNotice({
    range,
    calendar: 'Agenda principal',
    events: events.slice(0, max),
    total: events.length,
  });
}

const DRIVE_BASE_FILES = [
  { name: 'Rapport annuel 2025.pdf', mime: 'application/pdf', size: 2418592 },
  { name: 'Budget familial 2026.xlsx', mime: 'application/vnd.google-apps.spreadsheet', size: 147456 },
  { name: 'Contrat de location.pdf', mime: 'application/pdf', size: 839680 },
  { name: 'Présentation client — v3.pptx', mime: 'application/vnd.google-apps.presentation', size: 5242880 },
  { name: 'Notes réunion 12-02.txt', mime: 'text/plain', size: 4096 },
  { name: 'Photo profil.jpg', mime: 'image/jpeg', size: 1048576 },
  { name: 'Sauvegarde code.zip', mime: 'application/zip', size: 15728640 },
  { name: 'Attestation assurance.pdf', mime: 'application/pdf', size: 262144 },
];

function demoDriveFiles(query: string, max: number, recent: boolean): Record<string, any> {
  const rnd = seeded(`drive:${query}:${max}:${recent}`);
  const generated = [
    `${query} — notes.docx`,
    `${query}_v2.pdf`,
    `Présentation ${query}.pptx`,
    `${query}.zip`,
    `Rapport ${query}.pdf`,
  ].map((name) => ({
    name,
    mime: name.endsWith('.pdf')
      ? 'application/pdf'
      : name.endsWith('.pptx')
        ? 'application/vnd.google-apps.presentation'
        : name.endsWith('.zip')
          ? 'application/zip'
          : 'application/vnd.google-apps.document',
    size: Math.floor(rnd() * 5_000_000) + 50_000,
  }));
  const pool = recent
    ? DRIVE_BASE_FILES
    : [...generated, ...DRIVE_BASE_FILES.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))];
  const files = pool.slice(0, max).map((f) => {
    const daysAgo = Math.floor(rnd() * 30);
    return {
      ...f,
      size_human: humanSize(f.size),
      modified: new Date(Date.now() - daysAgo * 864e5).toISOString(),
      owner: 'moi@gmail.com',
    };
  });
  return withDemoNotice({
    query: recent ? null : query,
    files,
    total: files.length,
  });
}

const CONTACT_POOL = [
  { name: 'Marie Dupont', email: 'marie.dupont@gmail.com', phone: '+33 6 12 34 56 78', label: 'Mobile' },
  { name: 'Jean Martin', email: 'jean.martin@orange.fr', phone: '+33 7 98 76 54 32', label: 'Mobile' },
  { name: 'Sophie Bernard', email: 'sophie.bernard@societegenerale.fr', phone: '+33 1 42 68 53 00', label: 'Travail' },
  { name: 'Dr Laurent Petit', email: 'cabinet.dr.petit@doctolib.fr', phone: '+33 1 45 67 89 01', label: 'Travail' },
  { name: 'Papa', email: 'famille.martin@sfr.fr', phone: '+33 6 55 44 33 22', label: 'Mobile' },
  { name: 'Lucas Petit', email: 'lucas.petit@gmail.com', phone: '', label: 'Mobile' },
  { name: 'Service client Orange', email: 'service.client@orange.fr', phone: '3900', label: 'Autre' },
  { name: 'Nadia Benali', email: 'nadia.benali@gmail.com', phone: '+33 6 22 11 00 99', label: 'Mobile' },
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function demoContacts(query: string, max: number): Record<string, any> {
  const q = normalize(query);
  let matches = CONTACT_POOL.filter(
    (c) => normalize(c.name).includes(q) || normalize(c.email).includes(q)
  );
  if (!matches.length) {
    const rnd = seeded(`contacts:${query}`);
    const first = ['Camille', 'Thomas', 'Élodie', 'Farid', 'Clara'];
    const last = ['Moreau', 'Girard', 'Fontaine', 'Lefèvre', 'Marchand'];
    matches = Array.from({ length: Math.min(max, 3) }, (_, i) => ({
      name: `${first[Math.floor(rnd() * first.length)]} ${last[Math.floor(rnd() * last.length)]}`,
      email: `${query.toLowerCase().replace(/\s+/g, '.')}@gmail.com`,
      phone: `+33 6 ${Math.floor(10 + rnd() * 89)} ${Math.floor(10 + rnd() * 89)} ${Math.floor(10 + rnd() * 89)} ${Math.floor(10 + rnd() * 89)}`,
      label: 'Mobile',
      _synthesized: i,
    }));
  }
  return withDemoNotice({ query, contacts: matches.slice(0, max), total: matches.length });
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const gmailDef: BuiltinConnectorDef = {
  id: 'connector:gmail',
  name: 'Gmail',
  description:
    'Rechercher, lire et envoyer des e-mails Gmail. (Mode démo : données simulées tant qu’aucun compte Google n’est connecté.)',
  tools: [
    {
      operationId: 'search_emails',
      method: 'get',
      path: '/search',
      summary: 'Recherche dans la boîte Gmail',
      description:
        'Recherche des e-mails par mots-clés (expéditeur, objet, contenu). Renvoie les messages trouvés avec objet, extrait et date.',
      parameters: [
        { name: 'query', in: 'query', required: true, type: 'string', description: 'Mots-clés de recherche (ex: « facture orange »).' },
        { name: 'max_results', in: 'query', type: 'integer', description: 'Nombre maximum d’e-mails (1 à 10, 5 par défaut).', default: 5 },
      ],
      handler: async (args) => {
        const query = strArg(args, 'query', 'messages récents');
        const max = clampMax(args);
        if (googleCredsConfigured()) {
          const list = await gmailSearch(query, max);
          if (!list) return withDemoNotice({ query, emails: demoEmails(query, max, false) });
          if (!list.ok) return googleError(list, 'Gmail (recherche)');
          const ids: { id: string }[] = Array.isArray(list.data?.messages) ? list.data.messages.slice(0, max) : [];
          const emails = await Promise.all(
            ids.map(async (m) => {
              const detail = await gmailGetMessage(m.id);
              return detail?.ok ? gmailMessageToEmail(detail.data) : { id: m.id, error: 'détails indisponibles' };
            })
          );
          return { query, emails, total: list.data?.resultSizeEstimate ?? emails.length, mode: 'live' };
        }
        return withDemoNotice({ query, emails: demoEmails(query, max, false), total: max });
      },
    },
    {
      operationId: 'list_unread_emails',
      method: 'get',
      path: '/unread',
      summary: 'Liste les e-mails non lus',
      description: 'Renvoie les e-mails non lus les plus récents de la boîte de réception.',
      parameters: [
        { name: 'max_results', in: 'query', type: 'integer', description: 'Nombre maximum d’e-mails (1 à 10, 5 par défaut).', default: 5 },
      ],
      handler: async (args) => {
        const max = clampMax(args);
        if (googleCredsConfigured()) {
          const list = await gmailSearch('is:unread', max);
          if (!list) return withDemoNotice({ emails: demoEmails('is:unread', max, true) });
          if (!list.ok) return googleError(list, 'Gmail (non lus)');
          const ids: { id: string }[] = Array.isArray(list.data?.messages) ? list.data.messages.slice(0, max) : [];
          const emails = await Promise.all(
            ids.map(async (m) => {
              const detail = await gmailGetMessage(m.id);
              return detail?.ok ? gmailMessageToEmail(detail.data) : { id: m.id, error: 'détails indisponibles' };
            })
          );
          return { emails, total: emails.length, mode: 'live' };
        }
        return withDemoNotice({ emails: demoEmails('non lus importants', max, true) });
      },
    },
    {
      operationId: 'send_email',
      method: 'post',
      path: '/send',
      summary: 'Envoie un e-mail',
      description: 'Envoie un e-mail depuis le compte Gmail connecté.',
      parameters: [
        { name: 'to', in: 'body', required: true, type: 'string', description: 'Adresse du destinataire.' },
        { name: 'subject', in: 'body', required: true, type: 'string', description: 'Objet de l’e-mail.' },
        { name: 'body', in: 'body', required: true, type: 'string', description: 'Corps du message (texte brut).' },
      ],
      handler: async (args) => {
        const to = strArg(args, 'to');
        const subject = strArg(args, 'subject', '(sans objet)');
        const body = strArg(args, 'body');
        if (!to) return { error: 'Paramètre « to » manquant.' };
        if (googleCredsConfigured()) {
          const res = await gmailSend(to, subject, body);
          if (!res) return withDemoNotice({ sent: false, to, subject, note: 'Identifiants Google indisponibles — envoi simulé refusé.' });
          if (!res.ok) return googleError(res, 'Gmail (envoi)');
          return { sent: true, to, subject, message_id: res.data?.id, mode: 'live' };
        }
        return withDemoNotice({
          sent: true,
          to,
          subject,
          message_id: `demo-${Date.now().toString(36)}`,
          note: 'Envoi SIMULÉ — aucun e-mail réel n’a été transmis.',
        });
      },
    },
  ],
};

const calendarDef: BuiltinConnectorDef = {
  id: 'connector:gcalendar',
  name: 'Google Calendar',
  description:
    'Consulter les événements de l’agenda et créer des rendez-vous. (Mode démo : données simulées tant qu’aucun compte Google n’est connecté.)',
  tools: [
    {
      operationId: 'list_events',
      method: 'get',
      path: '/events',
      summary: 'Liste les événements de l’agenda',
      description:
        'Renvoie les événements d’aujourd’hui (par défaut), de demain ou des 7 prochains jours, avec horaires et lieux.',
      parameters: [
        { name: 'range', in: 'query', type: 'string', description: 'Période : today, tomorrow ou week.', enum: ['today', 'tomorrow', 'week'], default: 'today' },
        { name: 'max_results', in: 'query', type: 'integer', description: 'Nombre maximum d’événements (1 à 10, 5 par défaut).', default: 5 },
      ],
      handler: async (args) => {
        const range = ['today', 'tomorrow', 'week'].includes(String(args.range)) ? String(args.range) : 'today';
        const max = clampMax(args);
        if (googleCredsConfigured()) {
          const timeMin = range === 'tomorrow' ? parisDayRange(1).timeMinIso : range === 'week' ? parisDayRange(0).timeMinIso : parisDayRange(0).timeMinIso;
          const timeMax =
            range === 'tomorrow'
              ? parisDayRange(1).timeMaxIso
              : range === 'week'
                ? parisDayRange(7).timeMaxIso
                : parisDayRange(0).timeMaxIso;
          const res = await calendarListEvents(timeMin, timeMax, max);
          if (!res) return demoEvents(range, max);
          if (!res.ok) return googleError(res, 'Calendar (liste)');
          const items: any[] = Array.isArray(res.data?.items) ? res.data.items : [];
          return {
            range,
            calendar: 'Agenda principal',
            events: items.map((e) => ({
              id: e.id,
              title: e.summary,
              start: e.start?.dateTime ?? e.start?.date,
              end: e.end?.dateTime ?? e.end?.date,
              location: e.location ?? '',
              description: e.description ?? '',
            })),
            total: items.length,
            mode: 'live',
          };
        }
        return demoEvents(range, max);
      },
    },
    {
      operationId: 'create_event',
      method: 'post',
      path: '/events',
      summary: 'Crée un événement dans l’agenda',
      description: 'Ajoute un rendez-vous à l’agenda du compte connecté.',
      parameters: [
        { name: 'title', in: 'body', required: true, type: 'string', description: 'Titre de l’événement.' },
        { name: 'date', in: 'body', required: true, type: 'string', description: 'Date au format YYYY-MM-DD.' },
        { name: 'start_time', in: 'body', required: true, type: 'string', description: 'Heure de début au format HH:MM.' },
        { name: 'end_time', in: 'body', type: 'string', description: 'Heure de fin au format HH:MM (1h après le début par défaut).' },
        { name: 'description', in: 'body', type: 'string', description: 'Description de l’événement.' },
        { name: 'location', in: 'body', type: 'string', description: 'Lieu de l’événement.' },
      ],
      handler: async (args) => {
        const title = strArg(args, 'title');
        const date = strArg(args, 'date');
        const start = strArg(args, 'start_time');
        if (!title || !date || !start) {
          return { error: 'Paramètres requis manquants : title, date (YYYY-MM-DD), start_time (HH:MM).' };
        }
        const startTime = /^\d{2}:\d{2}$/.test(start) ? start : '09:00';
        let endTime = strArg(args, 'end_time');
        if (!/^\d{2}:\d{2}$/.test(endTime)) {
          const [h, m] = startTime.split(':').map(Number);
          const end = new Date(2000, 0, 1, h + 1, m);
          endTime = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
        }
        const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : parisDate(1);
        if (googleCredsConfigured()) {
          const res = await calendarCreateEvent({
            summary: title,
            start: { dateTime: `${dateOk}T${startTime}:00`, timeZone: 'Europe/Paris' },
            end: { dateTime: `${dateOk}T${endTime}:00`, timeZone: 'Europe/Paris' },
            ...(strArg(args, 'description') ? { description: strArg(args, 'description') } : {}),
            ...(strArg(args, 'location') ? { location: strArg(args, 'location') } : {}),
          });
          if (!res) return withDemoNotice({ created: false, note: 'Identifiants Google indisponibles — création simulée refusée.' });
          if (!res.ok) return googleError(res, 'Calendar (création)');
          return { created: true, event: { id: res.data?.id, title, date: dateOk, start_time: startTime, end_time: endTime }, mode: 'live' };
        }
        return withDemoNotice({
          created: true,
          event: {
            id: `demo-${Date.now().toString(36)}`,
            title,
            date: dateOk,
            start_time: startTime,
            end_time: endTime,
            location: strArg(args, 'location'),
          },
          note: 'Création SIMULÉE — aucun événement réel n’a été ajouté.',
        });
      },
    },
  ],
};

const driveDef: BuiltinConnectorDef = {
  id: 'connector:gdrive',
  name: 'Google Drive',
  description:
    'Rechercher et lister les fichiers du Google Drive. (Mode démo : données simulées tant qu’aucun compte Google n’est connecté.)',
  tools: [
    {
      operationId: 'search_files',
      method: 'get',
      path: '/files',
      summary: 'Recherche des fichiers Drive',
      description: 'Recherche des fichiers par nom ou contenu, avec type, taille et date de modification.',
      parameters: [
        { name: 'query', in: 'query', required: true, type: 'string', description: 'Mots-clés de recherche de fichier.' },
        { name: 'max_results', in: 'query', type: 'integer', description: 'Nombre maximum de fichiers (1 à 10, 5 par défaut).', default: 5 },
      ],
      handler: async (args) => {
        const query = strArg(args, 'query', 'documents');
        const max = clampMax(args);
        if (googleCredsConfigured()) {
          const res = await driveSearch(query, max);
          if (!res) return demoDriveFiles(query, max, false);
          if (!res.ok) return googleError(res, 'Drive (recherche)');
          const files: any[] = Array.isArray(res.data?.files) ? res.data.files : [];
          return {
            query,
            files: files.map((f) => ({ ...f, size_human: f.size ? humanSize(Number(f.size)) : '' })),
            total: files.length,
            mode: 'live',
          };
        }
        return demoDriveFiles(query, max, false);
      },
    },
    {
      operationId: 'list_recent_files',
      method: 'get',
      path: '/recent',
      summary: 'Liste les fichiers Drive récents',
      description: 'Renvoie les fichiers les plus récemment modifiés du Drive.',
      parameters: [
        { name: 'max_results', in: 'query', type: 'integer', description: 'Nombre maximum de fichiers (1 à 10, 5 par défaut).', default: 5 },
      ],
      handler: async (args) => {
        const max = clampMax(args);
        if (googleCredsConfigured()) {
          const res = await driveRecent(max);
          if (!res) return demoDriveFiles('', max, true);
          if (!res.ok) return googleError(res, 'Drive (récents)');
          const files: any[] = Array.isArray(res.data?.files) ? res.data.files : [];
          return {
            files: files.map((f) => ({ ...f, size_human: f.size ? humanSize(Number(f.size)) : '' })),
            total: files.length,
            mode: 'live',
          };
        }
        return demoDriveFiles('', max, true);
      },
    },
  ],
};

const contactsDef: BuiltinConnectorDef = {
  id: 'connector:gcontacts',
  name: 'Google Contacts',
  description:
    'Rechercher des contacts (e-mails, téléphones). (Mode démo : données simulées tant qu’aucun compte Google n’est connecté.)',
  tools: [
    {
      operationId: 'search_contacts',
      method: 'get',
      path: '/contacts',
      summary: 'Recherche dans les contacts Google',
      description: 'Recherche des contacts par nom ou adresse e-mail, avec téléphones et libellés.',
      parameters: [
        { name: 'query', in: 'query', required: true, type: 'string', description: 'Nom ou e-mail recherché.' },
        { name: 'max_results', in: 'query', type: 'integer', description: 'Nombre maximum de contacts (1 à 10, 5 par défaut).', default: 5 },
      ],
      handler: async (args) => {
        const query = strArg(args, 'query', 'contact');
        const max = clampMax(args);
        if (googleCredsConfigured()) {
          const res = await contactsSearch(query, max);
          if (!res) return demoContacts(query, max);
          if (!res.ok) return googleError(res, 'Contacts');
          const people: any[] = Array.isArray(res.data?.results) ? res.data.results : [];
          const contacts = people
            .map((r) => {
              const p = r.person ?? {};
              return {
                name: p.names?.[0]?.displayName ?? '',
                email: p.emailAddresses?.[0]?.value ?? '',
                phone: p.phoneNumbers?.[0]?.value ?? '',
                label: p.phoneNumbers?.[0]?.type ?? '',
              };
            })
            .filter((c) => c.name || c.email);
          return { query, contacts, total: contacts.length, mode: 'live' };
        }
        return demoContacts(query, max);
      },
    },
  ],
};

const WIKI_LANGS = ['fr', 'en', 'de', 'es'];
const WIKI_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Api-User-Agent': 'Nelth-IA/1.0 (chat connector)',
  // Wikimedia blocks requests without a proper User-Agent (403).
  'User-Agent': 'Nelth-IA/1.0 (chat connector; contact: admin@nelth.ai)',
};

async function wikiFetch(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: WIKI_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const wikipediaDef: BuiltinConnectorDef = {
  id: 'connector:wikipedia',
  name: 'Wikipédia',
  description: 'Recherche encyclopédique en direct (données réelles, aucune configuration requise).',
  tools: [
    {
      operationId: 'search_articles',
      method: 'get',
      path: '/search',
      summary: 'Recherche des articles Wikipédia',
      description: 'Recherche des articles par mots-clés et renvoie titres + extraits (données réelles).',
      parameters: [
        { name: 'query', in: 'query', required: true, type: 'string', description: 'Mots-clés de recherche.' },
        { name: 'language', in: 'query', type: 'string', description: 'Code langue du wiki.', enum: WIKI_LANGS, default: 'fr' },
        { name: 'max_results', in: 'query', type: 'integer', description: 'Nombre maximum d’articles (1 à 10, 5 par défaut).', default: 5 },
      ],
      handler: async (args) => {
        const query = strArg(args, 'query');
        if (!query) return { error: 'Paramètre « query » manquant.' };
        const lang = WIKI_LANGS.includes(String(args.language)) ? String(args.language) : 'fr';
        const max = clampMax(args);
        const url =
          `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json` +
          `&srsearch=${encodeURIComponent(query)}&srlimit=${max}`;
        const data = await wikiFetch(url);
        if (!data) return { error: `Recherche Wikipédia (${lang}) échouée — service injoignable.` };
        const hits: any[] = data?.query?.search ?? [];
        return {
          query,
          language: lang,
          articles: hits.map((h) => ({ title: h.title, snippet: String(h.snippet ?? '').replace(/<[^>]+>/g, ''), url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title)}` })),
          total: data?.query?.searchinfo?.totalhits ?? hits.length,
          mode: 'live',
        };
      },
    },
    {
      operationId: 'get_article_summary',
      method: 'get',
      path: '/summary',
      summary: 'Résumé d’un article Wikipédia',
      description: 'Renvoie le résumé (extract) d’un article donné par son titre exact (données réelles).',
      parameters: [
        { name: 'title', in: 'query', required: true, type: 'string', description: 'Titre exact de l’article.' },
        { name: 'language', in: 'query', type: 'string', description: 'Code langue du wiki.', enum: WIKI_LANGS, default: 'fr' },
      ],
      handler: async (args) => {
        const title = strArg(args, 'title');
        if (!title) return { error: 'Paramètre « title » manquant.' };
        const lang = WIKI_LANGS.includes(String(args.language)) ? String(args.language) : 'fr';
        const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
        const data = await wikiFetch(url);
        if (!data) return { error: `Article « ${title} » introuvable sur ${lang}.wikipedia.org.` };
        return {
          title: data.title,
          extract: data.extract,
          url: data.content_urls?.desktop?.page ?? '',
          lang,
          mode: 'live',
        };
      },
    },
  ],
};

export const BUILTIN_CONNECTORS: BuiltinConnectorDef[] = [
  gmailDef,
  calendarDef,
  driveDef,
  contactsDef,
  wikipediaDef,
];
