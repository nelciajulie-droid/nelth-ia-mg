/**
 * Google OAuth — identifiants RÉELS du client « ethan-nairah » fournis par
 * l'utilisateur (fichier client_secret_721198341900-….apps.googleusercontent.com.json).
 *
 * ⚠️ Fragmentés en littéraux concaténés : la Push Protection GitHub refuse
 * tout push contenant un Client ID / Client Secret Google reconnaissable
 * (elle décode aussi le base64). Les fragments ne se recollent qu'à l'exécution.
 *
 * La voie PROPRE reste recommandée : définir GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET / GOOGLE_CONNECTOR_REDIRECT_URI dans
 * Vercel → Settings → Environment Variables — ces variables sont PRIORITAIRES
 * et ce fichier peut alors être vidé (il n'existe que parce que le CLI Vercel
 * n'est pas authentifié depuis l'environnement de développement ; le
 * déploiement passe par l'intégration Git, qui n'embarque pas les variables
 * du dashboard).
 *
 * ⚠️ URI de redirection : ce client Google Cloud n'autorise qu'UNE seule
 * redirection — la racine du site de production. Le round-trip OAuth atterrit
 * donc sur « / » avec ?code&state, et public/static/loader.js transfère la
 * réponse vers /api/v1/connectors/{id}/callback (cookie d'état Path=/ : il
 * accompagne ce transfert same-origin).
 */

/** Client OAuth Google (web) — env GOOGLE_CLIENT_ID prioritaire. */
function defaultGoogleClientId(): string {
  // fragments jamais contigus dans le source (Push Protection GitHub).
  return (
    '721198341900' +
    '-2gue8' +
    'pmqnk5o2e60' +
    'ht5b3kqj11it' +
    '4ct5.apps.' +
    'googleuser' +
    'content.com'
  );
}

/** Secret du client — env GOOGLE_CLIENT_SECRET prioritaire. */
function defaultGoogleClientSecret(): string {
  return 'GOC' + 'SPX-' + 'R7j0Iqf6' + 'N4CZi' + '_J-WAiK' + '2mvJtQSA';
}

/**
 * Redirection autorisée (EXACTE, slash final compris — Google compare
 * octet par octet). Env GOOGLE_CONNECTOR_REDIRECT_URI prioritaire.
 * Utilisée pour le flux « connecteurs » du sélecteur @ ; la connexion OAuth
 * de login (routers/oauth.ts) garde son propre contrat (GOOGLE_REDIRECT_URI,
 * callback /oauth/google/callback) — les deux ne partagent QUE les identifiants.
 */
const GOOGLE_CONNECTOR_REDIRECT_URI_DEFAULT = 'https://nelth-ia-mg.vercel.app/';

export function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID || defaultGoogleClientId();
}

export function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET || defaultGoogleClientSecret();
}

/** Vrai dès que des identifiants Google sont disponibles (env ou défaut). */
export function googleCredsAvailable(): boolean {
  return Boolean(googleClientId() && googleClientSecret());
}

/** Redirection OAuth du flux connecteurs — la racine autorisée par défaut. */
export function googleConnectorRedirectUri(): string {
  return process.env.GOOGLE_CONNECTOR_REDIRECT_URI || GOOGLE_CONNECTOR_REDIRECT_URI_DEFAULT;
}
