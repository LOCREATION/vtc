// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Fonction du serveur « mollie » : recharge du portefeuille par Mollie
// -----------------------------------------------------------------------------
// Trois demandes, toutes en POST :
//   1. { action: 'creer', montant } — depuis l'espace client, client connecté
//      (son jeton dans « Authorization ») :
//        a. recharge_demander, AVEC LES DROITS DU CLIENT : la base vérifie qui
//           il est, le montant (5 € à 500 €) et le garde-fou (5 recharges en
//           attente au plus) ;
//        b. paiement créé chez Mollie avec la clé (secret MOLLIE_API_KEY) :
//           montant exact, « Recharge portefeuille LOC RÉACTION R-… », retour
//           vers la page Compte, avis vers …/functions/v1/mollie/webhook ;
//        c. recharge_mollie_ouverte (clé de service) ; réponse : l'adresse de
//           la page de paiement Mollie, où l'application envoie le client.
//   2. { action: 'verifier', recharge } — page de retour : la recharge du
//      client (ses droits), puis son état LU CHEZ MOLLIE et rapporté à la
//      base. Le client voit le résultat sans attendre l'avis de Mollie.
//   3. …/webhook (corps « id=tr_… ») — avis de Mollie. Un avis ne prouve
//      rien (n'importe qui peut appeler cette adresse) : le paiement est
//      RELU CHEZ MOLLIE avec la clé, puis rapporté à la base. Réponse 200
//      même pour un paiement inconnu ou refusé par la base ; 500 seulement
//      si Mollie ou la base ne répondent pas (Mollie renvoie l'avis plus tard).
// La clé Mollie et la clé de service ne quittent jamais le serveur : le
// navigateur ne reçoit que l'adresse de la page de paiement et l'état.
// =============================================================================

/** Lecture des variables d'environnement (Deno.env, ou une table en essai). */
export interface Env {
  get(nom: string): string | undefined;
}

type Reponse = { ok: boolean; statut: number; donnees: unknown; message: string };
type Recharge = {
  id: string; numero: string; montant: number | string; statut: string;
  methode?: string | null; mollie_id?: string | null; solde?: number | string;
};
type PaiementMollie = {
  id?: string; mode?: string; status?: string; method?: string | null;
  amount?: { value?: string; currency?: string };
  metadata?: { recharge_id?: string } | null;
  _links?: { checkout?: { href?: string } };
};

const SITE = 'https://www.vtclocreation.site/v2/';
const ORIGINES = ['https://www.vtclocreation.site', 'https://vtclocreation.site'];
const API_MOLLIE = 'https://api.mollie.com/v2';
const ID_PAIEMENT = /^tr_[A-Za-z0-9]{4,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLE_MOLLIE = /^(test|live)_[A-Za-z0-9]{20,}$/;

// Clés de Supabase : nouvelle forme (objet JSON, clé « default ») ou ancienne
function cleSupabase(env: Env, variable: string, ancienne: string): string {
  const brut = env.get(variable);
  if (brut) {
    try {
      const cles = JSON.parse(brut);
      if (cles && typeof cles.default === 'string') return cles.default;
    } catch (_) { /* ancienne forme ci-dessous */ }
  }
  return env.get(ancienne) ?? '';
}

// Le site seul peut appeler la fonction depuis un navigateur. Les en-têtes
// demandés par la bibliothèque Supabase (jeton, clé publique, version) sont
// acceptés tels qu'annoncés par le navigateur.
function entetesCors(req: Request): Record<string, string> {
  const origine = req.headers.get('Origin') ?? '';
  const demandes = (req.headers.get('Access-Control-Request-Headers') ?? '').replace(/[^a-zA-Z0-9,\- ]/g, '');
  return {
    'Access-Control-Allow-Origin': ORIGINES.includes(origine) ? origine : ORIGINES[0],
    'Access-Control-Allow-Headers': demandes || 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(req: Request, statut: number, corps: unknown): Response {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { ...entetesCors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function texte(statut: number, message: string): Response {
  return new Response(message, { status: statut, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function lire(rep: Response): Promise<unknown> {
  const brut = await rep.text();
  if (!brut) return null;
  try { return JSON.parse(brut); } catch (_) { return brut; }
}

// Fonction de la base : avec le jeton du client (ses droits) ou, sans jeton,
// avec la clé de service (fonctions réservées au serveur)
async function rpc(env: Env, nom: string, parametres: Record<string, unknown>, jetonClient?: string): Promise<Reponse> {
  const entetes: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jetonClient) {
    entetes.apikey = cleSupabase(env, 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
    entetes.Authorization = jetonClient;
  } else {
    const cle = cleSupabase(env, 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
    entetes.apikey = cle;
    // Nouvelle clé secrète : seulement dans « apikey » ; ancienne : aussi en jeton
    if (!cle.startsWith('sb_')) entetes.Authorization = `Bearer ${cle}`;
  }
  try {
    const rep = await fetch(`${env.get('SUPABASE_URL')}/rest/v1/rpc/${nom}`, {
      method: 'POST', headers: entetes, body: JSON.stringify(parametres)
    });
    const donnees = await lire(rep);
    const message = (donnees && typeof donnees === 'object' && 'message' in donnees)
      ? String((donnees as { message: unknown }).message) : `Erreur ${rep.status}`;
    return { ok: rep.ok, statut: rep.status, donnees, message };
  } catch (e) {
    return { ok: false, statut: 503, donnees: null, message: String(e) };
  }
}

async function mollie(env: Env, methode: 'GET' | 'POST', chemin: string, corps?: unknown): Promise<Reponse> {
  try {
    const rep = await fetch(`${API_MOLLIE}${chemin}`, {
      method: methode,
      headers: { Authorization: `Bearer ${env.get('MOLLIE_API_KEY') ?? ''}`, 'Content-Type': 'application/json' },
      body: corps === undefined ? undefined : JSON.stringify(corps)
    });
    const donnees = await lire(rep);
    return { ok: rep.ok, statut: rep.status, donnees, message: '' };
  } catch (e) {
    return { ok: false, statut: 503, donnees: null, message: String(e) };
  }
}

// Ce que Mollie dit du paiement, tel que la base l'attend
function etatPourLaBase(p: PaiementMollie): Record<string, unknown> {
  return {
    p_recharge: p.metadata?.recharge_id ?? null,
    p_mollie_id: p.id ?? null,
    p_statut: p.status ?? null,
    p_mode: p.mode ?? null,
    p_montant: p.amount?.value === undefined ? null : Number(p.amount.value),
    p_devise: p.amount?.currency ?? null,
    p_methode: p.method ?? null
  };
}

// Ce que le navigateur reçoit d'une recharge (jamais l'identifiant Mollie)
function publique(r: Recharge) {
  return { recharge: r.id, numero: r.numero, montant: Number(r.montant), statut: r.statut,
           methode: r.methode ?? null, solde: r.solde === undefined ? null : Number(r.solde) };
}

export async function traiter(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: entetesCors(req) });
  const cleValide = CLE_MOLLIE.test(env.get('MOLLIE_API_KEY') ?? '');
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/webhook')) return avis(req, env, cleValide);
  if (req.method !== 'POST') return json(req, 405, { erreur: 'Demande non prise en charge.' });
  if (!cleValide) {
    return json(req, 503, { erreur: 'La recharge en ligne n\'est pas encore ouverte : réessayez plus tard.' });
  }
  const jeton = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+$/.test(jeton)) return json(req, 401, { erreur: 'Connectez-vous pour recharger votre portefeuille.' });
  let corps: Record<string, unknown> | null = null;
  try { corps = await req.json(); } catch (_) { corps = null; }
  if (!corps || typeof corps !== 'object') return json(req, 400, { erreur: 'Demande illisible.' });
  if (corps.action === 'creer') return creer(req, env, jeton, corps);
  if (corps.action === 'verifier') return verifier(req, env, jeton, corps);
  return json(req, 400, { erreur: 'Demande non prise en charge.' });
}

// 1. Nouvelle recharge : la base, puis Mollie, puis le lien
async function creer(req: Request, env: Env, jeton: string, corps: Record<string, unknown>): Promise<Response> {
  const montant = Number(corps.montant);
  if (!Number.isFinite(montant)) return json(req, 400, { erreur: 'Une recharge va de 5 € à 500 €.' });

  const demande = await rpc(env, 'recharge_demander', { p_montant: Math.round(montant * 100) / 100 }, jeton);
  if (!demande.ok) {
    if (demande.statut === 401 || demande.statut === 403) {
      return json(req, 401, { erreur: 'Votre session a expiré : reconnectez-vous.' });
    }
    if (demande.statut >= 500) return json(req, 502, { erreur: 'Le service ne répond pas : réessayez dans un instant.' });
    return json(req, 400, { erreur: demande.message });
  }
  const r = demande.donnees as Recharge;

  const paiement = await mollie(env, 'POST', '/payments', {
    amount: { currency: 'EUR', value: Number(r.montant).toFixed(2) },
    description: `Recharge portefeuille LOC RÉACTION ${r.numero}`,
    redirectUrl: `${SITE}client/compte/?recharge=${r.id}`,
    webhookUrl: `${env.get('SUPABASE_URL')}/functions/v1/mollie/webhook`,
    locale: corps.langue === 'en' ? 'en_GB' : 'fr_FR',
    metadata: { recharge_id: r.id, numero: r.numero }
  });
  const p = (paiement.donnees ?? {}) as PaiementMollie;
  const lien = p._links?.checkout?.href ?? '';
  if (!paiement.ok || !ID_PAIEMENT.test(p.id ?? '') || !lien.startsWith('https://')) {
    console.error('Mollie : paiement non créé', paiement.statut, JSON.stringify(paiement.donnees));
    return json(req, 502, { erreur: 'Le service de paiement ne répond pas : réessayez dans un instant.' });
  }

  // Lien enregistré ; en cas d'échec, le premier avis de Mollie le rattache
  const ouverte = await rpc(env, 'recharge_mollie_ouverte', { p_recharge: r.id, p_mollie_id: p.id, p_mode: p.mode });
  if (!ouverte.ok) console.error('recharge_mollie_ouverte', ouverte.statut, ouverte.message);

  return json(req, 200, { lien, recharge: r.id, numero: r.numero, montant: Number(r.montant) });
}

// 2. Retour de Mollie : état relu chez Mollie, rapporté à la base
async function verifier(req: Request, env: Env, jeton: string, corps: Record<string, unknown>): Promise<Response> {
  const id = String(corps.recharge ?? '');
  if (!UUID.test(id)) return json(req, 404, { erreur: 'Recharge introuvable.' });
  const lue = await rpc(env, 'ma_recharge', { p_recharge: id }, jeton);
  if (!lue.ok) {
    if (lue.statut === 401 || lue.statut === 403) return json(req, 401, { erreur: 'Votre session a expiré : reconnectez-vous.' });
    if (lue.statut >= 500) return json(req, 502, { erreur: 'Le service ne répond pas : réessayez dans un instant.' });
    return json(req, 404, { erreur: lue.message });
  }
  let r = lue.donnees as Recharge;
  if (r.mollie_id && ID_PAIEMENT.test(r.mollie_id) && (r.statut === 'ouverte' || r.statut === 'creee')) {
    const paiement = await mollie(env, 'GET', `/payments/${r.mollie_id}`);
    const p = (paiement.donnees ?? {}) as PaiementMollie;
    if (paiement.ok && p.metadata?.recharge_id === r.id) {
      const etat = await rpc(env, 'recharge_mollie_etat', etatPourLaBase(p));
      if (etat.ok) r = { ...r, ...(etat.donnees as Recharge) };
      else console.error('recharge_mollie_etat', etat.statut, etat.message);
    }
  }
  return json(req, 200, publique(r));
}

// 3. Avis de Mollie : le paiement est relu chez Mollie avant tout
async function avis(req: Request, env: Env, cleValide: boolean): Promise<Response> {
  const id = new URLSearchParams(await req.text()).get('id') ?? '';
  if (!ID_PAIEMENT.test(id)) return texte(200, 'ignoré');
  if (!cleValide) {
    console.error('Avis Mollie reçu, mais MOLLIE_API_KEY manque');
    return texte(500, 'clé manquante');
  }
  const paiement = await mollie(env, 'GET', `/payments/${id}`);
  if (paiement.statut === 404) return texte(200, 'inconnu');
  if (!paiement.ok) return texte(502, 'Mollie injoignable');
  const p = (paiement.donnees ?? {}) as PaiementMollie;
  // Paiement sans recharge (lien de paiement fixe, terminal…) : pas pour nous
  if (!UUID.test(String(p.metadata?.recharge_id ?? ''))) return texte(200, 'ignoré');
  const etat = await rpc(env, 'recharge_mollie_etat', etatPourLaBase(p));
  if (!etat.ok) {
    console.error('recharge_mollie_etat', etat.statut, etat.message);
    return texte(etat.statut >= 500 ? 500 : 200, 'refusé par la base');
  }
  return texte(200, 'ok');
}
