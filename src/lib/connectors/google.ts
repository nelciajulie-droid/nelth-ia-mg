/**
 * Google APIs — shared OAuth (offline refresh-token) client used by the
 * built-in connectors (Gmail, Calendar, Drive, Contacts).
 *
 * Credentials (all three required) are read from the environment:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * When they are absent the built-in connectors fall back to DEMO MODE
 * (simulated data, clearly flagged in every result). Add them on Vercel
 * (Project → Settings → Environment Variables) to go live:
 *   1. Google Cloud Console → APIs & Services → enable Gmail, Calendar,
 *      Drive and People APIs for the project;
 *   2. OAuth consent screen → add the scopes:
 *      https://www.googleapis.com/auth/gmail.modify
 *      https://www.googleapis.com/auth/calendar
 *      https://www.googleapis.com/auth/drive.readonly
 *      https://www.googleapis.com/auth/contacts.readonly
 *   3. OAuth client (Web) → copy client id/secret;
 *   4. Authorize once with access_type=offline&prompt=consent and copy the
 *      refresh_token into the environment.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface CachedToken {
  token: string;
  exp: number;
}

let cached: CachedToken | null = null;

/** True when the three Google OAuth environment variables are present. */
export function googleCredsConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

/** Refresh-token flow → short-lived access token (null when unavailable). */
export async function getGoogleAccessToken(): Promise<string | null> {
  if (!googleCredsConfigured()) return null;
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID as string,
        client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN as string,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('[google-auth] token refresh failed', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data: any = await res.json();
    const token = data?.access_token;
    if (typeof token !== 'string' || !token) return null;
    cached = { token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return token;
  } catch (e) {
    console.error('[google-auth] token refresh error', e);
    return null;
  }
}

export interface GoogleApiResult {
  ok: boolean;
  status: number;
  data: any;
}

/** Authenticated call to a Google REST endpoint (full URL). */
export async function googleApi(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000
): Promise<GoogleApiResult | null> {
  const token = await getGoogleAccessToken();
  if (!token) return null; // credentials absent → caller uses demo mode
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e: any) {
    const reason = e?.name === 'TimeoutError' ? 'timed out' : String(e?.message ?? e);
    return { ok: false, status: 0, data: { error: { message: reason } } };
  }
}

// ---------------------------------------------------------------------------
// Gmail (REST v1)
// ---------------------------------------------------------------------------

interface GmailHeaderMsg {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

function headerOf(msg: GmailHeaderMsg, name: string): string {
  const h = (msg.payload?.headers ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/** Normalize a Gmail message to the connector's email shape. */
export function gmailMessageToEmail(msg: GmailHeaderMsg): Record<string, any> {
  return {
    id: msg.id,
    from: headerOf(msg, 'From'),
    to: headerOf(msg, 'To'),
    subject: headerOf(msg, 'Subject'),
    snippet: msg.snippet ?? '',
    date: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : headerOf(msg, 'Date'),
    unread: (msg.labelIds ?? []).includes('UNREAD'),
    labels: msg.labelIds ?? [],
  };
}

export async function gmailSearch(
  query: string,
  maxResults: number
): Promise<GoogleApiResult | null> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?` +
    `q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  return googleApi(url);
}

export async function gmailGetMessage(id: string): Promise<GoogleApiResult | null> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
  return googleApi(url);
}

/** RFC 2822 message → base64url raw payload for messages.send. */
export function buildRawEmail(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf-8').toString('base64url');
}

export async function gmailSend(to: string, subject: string, body: string): Promise<GoogleApiResult | null> {
  return googleApi('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: buildRawEmail(to, subject, body) }),
  });
}

// ---------------------------------------------------------------------------
// Google Calendar (REST v3) — primary calendar
// ---------------------------------------------------------------------------

export async function calendarListEvents(
  timeMinIso: string,
  timeMaxIso: string,
  maxResults: number
): Promise<GoogleApiResult | null> {
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    `timeMin=${encodeURIComponent(timeMinIso)}&timeMax=${encodeURIComponent(timeMaxIso)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=${maxResults}`;
  return googleApi(url);
}

export async function calendarCreateEvent(event: Record<string, any>): Promise<GoogleApiResult | null> {
  return googleApi('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify(event),
  });
}

// ---------------------------------------------------------------------------
// Google Drive (REST v3)
// ---------------------------------------------------------------------------

export async function driveSearch(
  query: string,
  maxResults: number
): Promise<GoogleApiResult | null> {
  const escaped = String(query).replace(/(['\\])/g, '\\$1');
  const url =
    `https://www.googleapis.com/drive/v3/files?` +
    `q=${encodeURIComponent(`fullText contains '${escaped}' and trashed = false`)}` +
    `&pageSize=${maxResults}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)`;
  return googleApi(url);
}

export async function driveRecent(maxResults: number): Promise<GoogleApiResult | null> {
  const url =
    `https://www.googleapis.com/drive/v3/files?` +
    `pageSize=${maxResults}&orderBy=modifiedTime%20desc&trashed=false` +
    `&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)`;
  return googleApi(url);
}

// ---------------------------------------------------------------------------
// Google Contacts (People API — contacts.readonly)
// ---------------------------------------------------------------------------

export async function contactsSearch(
  query: string,
  maxResults: number
): Promise<GoogleApiResult | null> {
  const url =
    `https://people.googleapis.com/v1/people:searchContacts?` +
    `query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers` +
    `&pageSize=${Math.min(Math.max(maxResults, 1), 50)}`;
  return googleApi(url);
}
