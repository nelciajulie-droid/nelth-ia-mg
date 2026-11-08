import type { AppDefinition, ConnectorId } from './app-types';

/**
 * Application registry for the @ app mention picker — the single source of
 * truth shared by the HTTP surface (server/routers/connectors.ts) and the
 * chat-flow routing (app-router.ts).
 *
 * Icons are compact official-style brand SVGs (inline markup, no external
 * fetch — the picker must render offline of any icon CDN).
 */

const svg = (viewBox: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

// --- Official-style brand marks -------------------------------------------------

const GMAIL_ICON = svg(
  '0 0 52 40',
  `<path fill="#4285f4" d="M47.5 40H4.5A4.5 4.5 0 0 1 0 35.5v-27A4.5 4.5 0 0 1 4.5 4h3.9L26 17.05 43.6 4h3.9A4.5 4.5 0 0 1 52 8.5v27A4.5 4.5 0 0 1 47.5 40Z"/>
   <path fill="#fbbc04" d="M4.9 39.28 26 23.3l-3.85-2.7L4.9 38.4a4.55 4.55 0 0 0 0 .88Z"/>
   <path fill="#34a853" d="M4.9 4.72v34.56a4.55 4.55 0 0 0 0 .88l18.23-17.13-3.85-2.7Z"/>
   <path fill="#ea4335" d="M47.1 4.72 26 20.6l-3.85-2.7L44.98 4h2.12Z"/>
   <path fill="#c5221f" d="M47.1 4.72 26 20.6l-3.85-2.7L44.98 4h2.12Z" opacity="0" />`
);

const GDRIVE_ICON = svg(
  '0 0 87.3 78',
  `<path fill="#0066da" d="m6.6 66.85-5.1-8.85C.4 55.2.4 51.9 2.1 48.9L23.1 12.6 36.7 36H87l-.1-.15L60.8 72.9c-1.7 3-4.9 5.1-8.5 5.1H21.7c-3.7 0-6.9-2-8.6-5.1L6.6 66.85Z"/>
   <path fill="#00ac47" d="m23 12.5 6.9-11.9c1.8-3 4.9-4.9 8.5-5h20.4c3.6 0 6.8 2 8.5 5L87 36H36.5L23 12.5Z"/>
   <path fill="#ea4335" d="M66 66.9H14.1l-7.5-13 15.4-26.7L36.5 36 66 66.9Z" opacity="0" />
   <path fill="#00832d" d="m23.1 12.6 13.6 23.4H2.6c-.2 0 .4-2 1-3.2L23.1 12.6Z" opacity="0" />
   <path fill="#ffba00" d="M50.2 36H87L65.4 0c-.7-1.2-2.3-2.7-3.4-3.3L36.7 36h13.5Z"/>`
);

const GCAL_ICON = svg(
  '0 0 48 48',
  `<path fill="#fff" d="M44 6H4a2 2 0 0 0-2 2v32a2 2 0 0 0 2 2h40a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z"/>
   <path fill="#1a73e8" d="M2 10h44v4H2zm36-8h4v6h-4zM6 2h4v6H6z"/>
   <path fill="#1a73e8" d="M44 6h-7L2 41v1a2 2 0 0 0 2 2h5l37-35V8a2 2 0 0 0-2-2Z"/>
   <path fill="#1967d2" d="M46 8v32a2 2 0 0 1-2 2h-5L2 8a2 2 0 0 1 2-2h5l37 35" opacity="0" />
   <path fill="#1a73e8" d="M6 2h36a4 4 0 0 1 4 4v2H2V6a4 4 0 0 1 4-4Z"/>
   <path fill="#1a73e8" d="M2 10h6v36H4a2 2 0 0 1-2-2V10Z"/>
   <path fill="#1a73e8" d="M17 34v-9.7c0-.5.1-.9.4-1.2.3-.3.6-.5 1-.5.4 0 .8.1 1 .4l6.6 7.3v-6c0-.5.1-.9.4-1.2.3-.3.6-.4 1-.4s.7.1 1 .4c.3.3.4.7.4 1.2V34c0 .5-.1.9-.4 1.2-.3.3-.6.5-1 .5-.4 0-.8-.2-1.1-.5l-6.5-7.2V34c0 .5-.1.9-.4 1.2-.3.3-.6.4-1 .4s-.7-.1-1-.4c-.3-.3-.4-.7-.4-1.2Z"/>`
);

const SLACK_ICON = svg(
  '0 0 122.8 122.8',
  `<path fill="#e01e5a" d="M25.6 18.9a12.5 12.5 0 1 1-25 0 12.5 12.5 0 0 1 25 0Zm-3.7 20.9a12.4 12.4 0 0 1 12.4 12.4 12.4 12.4 0 0 1-12.4 12.4H12.5a12.4 12.4 0 0 1 0-24.8h9.4Z"/>
   <path fill="#36c5f0" d="M103.9 25.6a12.5 12.5 0 1 1 12.5 12.4 12.5 12.5 0 0 1-12.5-12.4Zm-49.6 0a12.5 12.5 0 1 1 12.4 12.4 12.4 12.4 0 0 1-12.4-12.4Zm24.8 0a12.5 12.5 0 1 1 12.5 12.4 12.5 12.5 0 0 1-12.5-12.4ZM66.7 54.2a12.4 12.4 0 0 1 12.4 12.4 12.4 12.4 0 0 1-12.4 12.4h-9.4a12.4 12.4 0 0 1 0-24.8h9.4Z"/>
   <path fill="#2eb67d" d="M25.6 66.6a12.4 12.4 0 0 1 12.4 12.4 12.4 12.4 0 0 1-12.4 12.5h-9.4a12.4 12.4 0 0 1 0-24.9h9.4Z"/>
   <path fill="#ecb22e" d="M25.6 97.2a12.4 12.4 0 1 1-12.4 12.4 12.5 12.5 0 0 1 12.4-12.4Z"/>
   <path fill="#ecb22e" d="M54.2 78.9a12.4 12.4 0 0 1 12.5 12.4v19.4a12.5 12.5 0 0 1-25 0V91.3a12.4 12.4 0 0 1 12.5-12.4Z"/>
   <path fill="#36c5f0" d="M41.8 66.6a12.4 12.4 0 0 1 0 24.9H32a12.4 12.4 0 0 1 0-24.9h9.8Z" opacity="0"/>
   <path fill="#2eb67d" d="M78.9 54.2a12.4 12.4 0 0 1 24.9 0v9.4a12.4 12.4 0 0 1-24.9 0v-9.4Z"/>
   <path fill="#ecb22e" d="M91.3 41.8a12.4 12.4 0 0 1-12.4-12.4V10.5a12.5 12.5 0 0 1 24.9 0V29.4a12.4 12.4 0 0 1-12.5 12.4Z"/>`
);

const GITHUB_ICON = svg(
  '0 0 98 96',
  `<path fill="#24292f" fill-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0Z"/>`
);

const NOTION_ICON = svg(
  '0 0 100 100',
  `<rect width="100" height="100" rx="14" fill="#fff"/>
   <path fill="#000" d="M26.5 27.5 55.4 50 26.5 72.5Z"/>
   <path fill="#000" d="M55.4 50 82 27.5v45L55.4 50Z" opacity=".85"/>
   <rect x="26.5" y="27.5" width="55.5" height="45" fill="none"/>
   <path fill="#000" d="M30 24h44a6 6 0 0 1 6 6v40a6 6 0 0 1-6 6H38L24 62V30a6 6 0 0 1 6-6Z" opacity="0"/>
   <path fill="#000" d="M24 24h52v6H30a6 6 0 0 0 0 0Z" opacity="0"/>
   <text x="50" y="66" font-family="Georgia,serif" font-size="44" font-weight="700" text-anchor="middle" fill="#111">N</text>`
);

const OUTLOOK_ICON = svg(
  '0 0 88 88',
  `<path fill="#0f6cbd" d="M66.6 25.7c-6.9-5.3-15.7-6.2-23.4-3.3L26.8 13.1a2 2 0 0 0-2.9 1.8v13.4l-9.7 6a2 2 0 0 0-1 1.7v28.4a2 2 0 0 0 1.2 1.8l21.9 9a17.5 17.5 0 0 0 3.3.7l-11.6-13.5V29.9L49.4 44.3l-1.6 8.9 8.8-3.2 8.8 3.2-1.6-8.9 9.3-9.5c-1.6-3.6-4.1-6.8-6.5-9.1Z"/>
   <path fill="#28a8ea" d="M66.6 25.7c-6.9-5.3-15.7-6.2-23.4-3.3L26.8 13.1a2 2 0 0 0-2.9 1.8v13.4l12.5 5.5c4.9-4.6 12.5-4.6 17.5-.1l12.7-8Z" opacity="0"/>
   <path fill="#fff" d="m64 44.4-8.8 3.2 1.6-8.9-9.3-9.5c-5-4.5-12.6-4.5-17.5.1L24 29.9v26.2L39.9 75l9-3.7-2.4-2.8V44.8l13.6-13.9L64 44.4Z" opacity="0"/>
   <path fill="#0f6cbd" d="M46.5 48.3 24 44.8v24.2l9.7 4L46.5 48.3Z" opacity="0"/>
   <rect x="44" y="34" width="40" height="28" rx="4" fill="#fff"/>
   <path fill="#0f6cbd" d="M84 38a4 4 0 0 0-4-4H48a4 4 0 0 0-4 4v.4L64 51l20-12.6V38Z"/>
   <path fill="#28a8ea" d="M44 61.6V62a4 4 0 0 0 4 4h32a4 4 0 0 0 4-4v-.4L64 49 44 61.6Z"/>
   <path fill="#28a8ea" d="m84 38.4-20 12.6 20 12.6v1.4-26.6Z" opacity="0"/>
   <path fill="#0f6cbd" d="m84 39.4-18.9 12 18.9 12v-24Z" opacity="0"/>`
);

const ONEDRIVE_ICON = svg(
  '0 0 249.6 199.7',
  `<path fill="#28a8ea" d="M100.7 53.5 62.7 119.5H25.6a25.6 25.6 0 0 1 0-51.2h54.4l20.7-14.8Z"/>
   <path fill="#0078d4" d="m199.8 158.9-27.9 40.8H71.9a45 45 0 0 1-6.9-87.4l-19.7-34a67.4 67.4 0 0 0 45.5 117.4h97.4l11.6-35.6Z"/>
   <path fill="#0364b8" d="m101.7 51.4 21.6 14.5h64a51.2 51.2 0 0 1 0 102.4h-38.5l-21.4 30.8h59.9a41.4 41.4 0 0 0 1.6-82.8 67.4 67.4 0 0 0-64.5-46.3 69.3 69.3 0 0 0-22.7-18.6Z"/>
   <path fill="#28a8ea" d="m199.8 158.9-27.9 40.8H71.9a45 45 0 0 1-6.9-87.4l-19.7-34a67.4 67.4 0 0 0 45.5 117.4h97.4l11.6-35.6Z" opacity="0"/>`
);

const WEBSEARCH_ICON = svg(
  '0 0 24 24',
  `<circle cx="12" cy="12" r="10" fill="none" stroke="#4f46e5" stroke-width="2"/>
   <path fill="none" stroke="#4f46e5" stroke-width="2" d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>`
);

// --- Registry -------------------------------------------------------------------

export const APP_REGISTRY: AppDefinition[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Recherchez, lisez et rédigez des e-mails depuis la conversation.',
    icon: GMAIL_ICON,
    connector: 'google:gmail',
    oauthProvider: 'google',
    builtin: false,
    keywords: ['mail', 'email', 'courriel', 'google', 'boîte'],
    actions: [
      { id: 'search', label: "Rechercher des e-mails", description: 'Recherche dans la boîte de réception par expéditeur, objet ou contenu.', sensitive: false },
      { id: 'read', label: 'Lire un e-mail', description: 'Lit un message spécifique et le résume dans la conversation.', sensitive: false },
      { id: 'send', label: 'Rédiger / envoyer un e-mail', description: 'Prépare et envoie un e-mail — confirmation demandée avant l’envoi.', sensitive: true },
    ],
    permissions: ['gmail.readonly', 'gmail.send'],
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    description: 'Parcourez, recherchez et lisez les fichiers de votre Drive.',
    icon: GDRIVE_ICON,
    connector: 'google:drive',
    oauthProvider: 'google',
    builtin: false,
    keywords: ['drive', 'fichiers', 'documents', 'google', 'stockage'],
    actions: [
      { id: 'search', label: 'Rechercher des fichiers', description: 'Recherche par nom ou type de fichier dans tout le Drive.', sensitive: false },
      { id: 'read', label: 'Lire un document', description: 'Extrait le contenu d’un document Drive comme contexte.', sensitive: false },
      { id: 'create', label: 'Créer un document', description: 'Crée un document dans le Drive — confirmation demandée.', sensitive: true },
    ],
    permissions: ['drive.readonly', 'drive.file'],
  },
  {
    id: 'gcal',
    name: 'Google Calendar',
    description: 'Consultez, créez et déplacez des événements d’agenda.',
    icon: GCAL_ICON,
    connector: 'google:calendar',
    oauthProvider: 'google',
    builtin: false,
    keywords: ['calendar', 'calendrier', 'agenda', 'réunion', 'rendez-vous', 'google'],
    actions: [
      { id: 'list', label: 'Consulter l’agenda', description: 'Liste les événements d’une période donnée.', sensitive: false },
      { id: 'create', label: 'Créer un événement', description: 'Ajoute un événement à l’agenda — confirmation demandée.', sensitive: true },
      { id: 'move', label: 'Déplacer / annuler', description: 'Modifie ou supprime un événement existant — confirmation demandée.', sensitive: true },
    ],
    permissions: ['calendar.readonly', 'calendar.events'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Recherchez dans les canaux et publiez des messages.',
    icon: SLACK_ICON,
    connector: 'slack:default',
    oauthProvider: 'slack',
    builtin: false,
    keywords: ['slack', 'canal', 'channel', 'message', 'équipe'],
    actions: [
      { id: 'search', label: 'Rechercher des messages', description: 'Recherche dans les canaux accessibles.', sensitive: false },
      { id: 'post', label: 'Publier un message', description: 'Envoie un message dans un canal — confirmation demandée.', sensitive: true },
    ],
    permissions: ['search:read', 'chat:write'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Recherchez des dépôts, issues et pull requests.',
    icon: GITHUB_ICON,
    connector: 'github:default',
    oauthProvider: 'github',
    builtin: false,
    keywords: ['github', 'repo', 'dépôt', 'code', 'issue', 'pr', 'pull request'],
    actions: [
      { id: 'search', label: 'Rechercher des dépôts / issues', description: 'Recherche dans les dépôts accessibles.', sensitive: false },
      { id: 'read', label: 'Lire un fichier / une issue', description: 'Extrait le contenu comme contexte de conversation.', sensitive: false },
      { id: 'comment', label: 'Commenter une issue / PR', description: 'Publie un commentaire — confirmation demandée.', sensitive: true },
    ],
    permissions: ['repo', 'read:user'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Recherchez et lisez vos pages et bases de données Notion.',
    icon: NOTION_ICON,
    connector: 'notion:default',
    oauthProvider: 'notion',
    builtin: false,
    keywords: ['notion', 'page', 'wiki', 'base', 'notes'],
    actions: [
      { id: 'search', label: 'Rechercher des pages', description: 'Recherche dans l’espace Notion connecté.', sensitive: false },
      { id: 'read', label: 'Lire une page', description: 'Extrait le contenu d’une page comme contexte.', sensitive: false },
      { id: 'create', label: 'Créer une page', description: 'Ajoute une page — confirmation demandée.', sensitive: true },
    ],
    permissions: ['read_content', 'insert_content'],
  },
  {
    id: 'outlook',
    name: 'Microsoft Outlook',
    description: 'Accédez aux e-mails de votre compte Microsoft 365.',
    icon: OUTLOOK_ICON,
    connector: 'microsoft:outlook',
    oauthProvider: 'microsoft',
    builtin: false,
    keywords: ['outlook', 'mail', 'email', 'office', 'microsoft', '365'],
    actions: [
      { id: 'search', label: 'Rechercher des e-mails', description: 'Recherche dans la boîte Outlook.', sensitive: false },
      { id: 'read', label: 'Lire un e-mail', description: 'Lit et résume un message.', sensitive: false },
      { id: 'send', label: 'Envoyer un e-mail', description: 'Envoie un e-mail — confirmation demandée.', sensitive: true },
    ],
    permissions: ['Mail.Read', 'Mail.Send'],
  },
  {
    id: 'onedrive',
    name: 'Microsoft OneDrive',
    description: 'Parcourez et lisez les fichiers de votre OneDrive.',
    icon: ONEDRIVE_ICON,
    connector: 'microsoft:onedrive',
    oauthProvider: 'microsoft',
    builtin: false,
    keywords: ['onedrive', 'fichiers', 'documents', 'microsoft', 'office'],
    actions: [
      { id: 'search', label: 'Rechercher des fichiers', description: 'Recherche dans tout le OneDrive.', sensitive: false },
      { id: 'read', label: 'Lire un document', description: 'Extrait le contenu d’un fichier comme contexte.', sensitive: false },
      { id: 'create', label: 'Créer un fichier', description: 'Enregistre un fichier dans OneDrive — confirmation demandée.', sensitive: true },
    ],
    permissions: ['Files.Read', 'Files.ReadWrite.All'],
  },
  {
    id: 'web_search',
    name: 'Web Search',
    description: 'Recherche web en direct avec sources et citations — prêt, sans compte.',
    icon: WEBSEARCH_ICON,
    connector: 'builtin:web_search',
    oauthProvider: null,
    builtin: true,
    keywords: ['web', 'recherche', 'internet', 'google', 'bing', 'actualités', 'search'],
    actions: [
      { id: 'search', label: 'Rechercher sur le web', description: 'Exécute la recherche web du serveur et cite ses sources.', sensitive: false },
    ],
    permissions: [],
  },
];

const BY_ID = new Map<string, AppDefinition>(APP_REGISTRY.map((app) => [app.id, app]));

export function getAppById(id: string): AppDefinition | null {
  return BY_ID.get(id) ?? null;
}

export function connectorIds(): ConnectorId[] {
  return APP_REGISTRY.map((app) => app.id);
}
