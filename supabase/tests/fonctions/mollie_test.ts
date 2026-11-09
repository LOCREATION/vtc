// =============================================================================
// LOC RÉACTION S.A.S — Tests de la fonction du serveur « mollie »
// -----------------------------------------------------------------------------
// Hors ligne : la base (PostgREST) et Mollie sont simulées en remplaçant
// fetch ; chaque essai vérifie ce que la fonction envoie (adresses, clés,
// montants) et ce qu'elle répond. Aucune dépendance extérieure.
// Lancer : deno test --allow-env supabase/tests/fonctions/mollie_test.ts
// =============================================================================
import { traiter, type Env } from '../../functions/mollie/traitement.ts';

const URL_BASE = 'https://rolfbdmrhwslwxluhfwr.supabase.co';
const RECHARGE = '11111111-2222-4333-8444-555555555555';
const JETON = 'Bearer eyJ.jeton.client';

function env(valeurs: Record<string, string>): Env {
  return { get: (nom: string) => valeurs[nom] };
}
const ENV_NOUVELLES_CLES = env({
  SUPABASE_URL: URL_BASE,
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_essai' }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_essai' }),
  MOLLIE_API_KEY: 'test_abcdefghijklmnopqrstuvwxyz12'
});
const ENV_ANCIENNES_CLES = env({
  SUPABASE_URL: URL_BASE,
  SUPABASE_ANON_KEY: 'eyJ.anon',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service',
  MOLLIE_API_KEY: 'live_abcdefghijklmnopqrstuvwxyz12'
});

function egal(a: unknown, b: unknown, libelle: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${libelle} : obtenu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)}`);
  }
}
function vrai(condition: boolean, libelle: string) {
  if (!condition) throw new Error(libelle);
}

type Appel = { url: string; methode: string; entetes: Record<string, string>; corps: unknown };
type Scenario = (appel: Appel) => { statut: number; corps?: unknown } | undefined;

// fetch simulé : chaque appel est noté puis servi par le scénario
function simuler(scenario: Scenario): Appel[] {
  const appels: Appel[] = [];
  globalThis.fetch = (async (entree: string | URL | Request, init?: RequestInit) => {
    const entetes: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { entetes[k] = v; });
    let corps: unknown = init?.body ?? null;
    if (typeof corps === 'string') { try { corps = JSON.parse(corps); } catch (_) { /* texte */ } }
    const appel = { url: String(entree), methode: init?.method ?? 'GET', entetes, corps };
    appels.push(appel);
    const reponse = scenario(appel);
    if (!reponse) throw new Error(`appel inattendu : ${appel.methode} ${appel.url}`);
    return new Response(reponse.corps === undefined ? null : JSON.stringify(reponse.corps), { status: reponse.statut });
  }) as typeof fetch;
  return appels;
}

function demande(corps: unknown, options: { jeton?: string | null; chemin?: string; origine?: string } = {}) {
  const entetes: Record<string, string> = { 'Content-Type': 'application/json', Origin: options.origine ?? 'https://www.vtclocreation.site' };
  if (options.jeton !== null) entetes.Authorization = options.jeton ?? JETON;
  return new Request(`${URL_BASE}/functions/v1/${options.chemin ?? 'mollie'}`, {
    method: 'POST', headers: entetes, body: typeof corps === 'string' ? corps : JSON.stringify(corps)
  });
}

const PAIEMENT_OUVERT = {
  id: 'tr_essaiAbc123', mode: 'test', status: 'open', method: null,
  amount: { value: '20.00', currency: 'EUR' }, metadata: { recharge_id: RECHARGE, numero: 'R-2026-000001' },
  _links: { checkout: { href: 'https://www.mollie.com/checkout/select-method/essaiAbc123' } }
};

Deno.test('préliminaire du navigateur (OPTIONS) : autorisé pour le site seulement', async () => {
  simuler(() => undefined);
  const rep = await traiter(new Request(`${URL_BASE}/functions/v1/mollie`, { method: 'OPTIONS', headers: { Origin: 'https://www.vtclocreation.site' } }), ENV_NOUVELLES_CLES);
  egal(rep.status, 204, 'statut');
  egal(rep.headers.get('Access-Control-Allow-Origin'), 'https://www.vtclocreation.site', 'origine');
  const autre = await traiter(new Request(`${URL_BASE}/functions/v1/mollie`, { method: 'OPTIONS', headers: { Origin: 'https://pirate.example' } }), ENV_NOUVELLES_CLES);
  egal(autre.headers.get('Access-Control-Allow-Origin'), 'https://www.vtclocreation.site', 'autre origine : jamais reprise');
});

Deno.test('sans clé Mollie : recharge fermée, rien n\'est demandé à la base', async () => {
  const appels = simuler(() => undefined);
  const rep = await traiter(demande({ action: 'creer', montant: 20 }), env({ SUPABASE_URL: URL_BASE }));
  egal(rep.status, 503, 'statut');
  vrai((await rep.json()).erreur.includes('pas encore ouverte'), 'message');
  egal(appels.length, 0, 'aucun appel');
});

Deno.test('sans jeton du client : refusé', async () => {
  const appels = simuler(() => undefined);
  const rep = await traiter(demande({ action: 'creer', montant: 20 }, { jeton: null }), ENV_NOUVELLES_CLES);
  egal(rep.status, 401, 'statut');
  egal(appels.length, 0, 'aucun appel');
});

Deno.test('recharge : base avec les droits du client, paiement Mollie exact, lien rattaché avec la clé de service', async () => {
  const appels = simuler((a) => {
    if (a.url === `${URL_BASE}/rest/v1/rpc/recharge_demander`) return { statut: 200, corps: { id: RECHARGE, numero: 'R-2026-000001', montant: 20 } };
    if (a.url === 'https://api.mollie.com/v2/payments') return { statut: 201, corps: PAIEMENT_OUVERT };
    if (a.url === `${URL_BASE}/rest/v1/rpc/recharge_mollie_ouverte`) return { statut: 204 };
  });
  const rep = await traiter(demande({ action: 'creer', montant: 20, langue: 'fr' }), ENV_NOUVELLES_CLES);
  egal(rep.status, 200, 'statut');
  egal(await rep.json(), { lien: PAIEMENT_OUVERT._links.checkout.href, recharge: RECHARGE, numero: 'R-2026-000001', montant: 20 }, 'réponse');
  egal(appels.length, 3, 'trois appels');
  const [base, paiement, lien] = appels;
  egal(base.entetes.authorization, JETON, 'base : jeton du client');
  egal(base.entetes.apikey, 'sb_publishable_essai', 'base : clé publique');
  egal(base.corps, { p_montant: 20 }, 'base : montant');
  egal(paiement.methode, 'POST', 'Mollie : création');
  egal(paiement.entetes.authorization, 'Bearer test_abcdefghijklmnopqrstuvwxyz12', 'Mollie : clé');
  egal(paiement.corps, {
    amount: { currency: 'EUR', value: '20.00' },
    description: 'Recharge portefeuille LOC RÉACTION R-2026-000001',
    redirectUrl: `https://www.vtclocreation.site/v2/client/compte/?recharge=${RECHARGE}`,
    webhookUrl: `${URL_BASE}/functions/v1/mollie/webhook`,
    locale: 'fr_FR',
    metadata: { recharge_id: RECHARGE, numero: 'R-2026-000001' }
  }, 'Mollie : paiement demandé');
  egal(lien.entetes.apikey, 'sb_secret_essai', 'lien : clé de service');
  vrai(!('authorization' in lien.entetes), 'lien : nouvelle clé secrète jamais en jeton');
  egal(lien.corps, { p_recharge: RECHARGE, p_mollie_id: 'tr_essaiAbc123', p_mode: 'test' }, 'lien : paiement rattaché');
});

Deno.test('recharge refusée par la base : message de la base, Mollie jamais appelé', async () => {
  const appels = simuler((a) => {
    if (a.url.endsWith('/rpc/recharge_demander')) return { statut: 400, corps: { code: 'P0001', message: 'Une recharge va de 5 € à 500 €.' } };
  });
  const rep = await traiter(demande({ action: 'creer', montant: 4 }), ENV_NOUVELLES_CLES);
  egal(rep.status, 400, 'statut');
  egal((await rep.json()).erreur, 'Une recharge va de 5 € à 500 €.', 'message');
  egal(appels.length, 1, 'un seul appel');
});

Deno.test('jeton expiré : « reconnectez-vous »', async () => {
  simuler((a) => (a.url.endsWith('/rpc/recharge_demander') ? { statut: 401, corps: { message: 'JWT expired' } } : undefined));
  const rep = await traiter(demande({ action: 'creer', montant: 20 }), ENV_NOUVELLES_CLES);
  egal(rep.status, 401, 'statut');
  vrai((await rep.json()).erreur.includes('reconnectez-vous'), 'message');
});

Deno.test('Mollie refuse ou ne répond pas : 502, aucun lien', async () => {
  const appels = simuler((a) => {
    if (a.url.endsWith('/rpc/recharge_demander')) return { statut: 200, corps: { id: RECHARGE, numero: 'R-2026-000002', montant: 15 } };
    if (a.url === 'https://api.mollie.com/v2/payments') return { statut: 422, corps: { detail: 'The amount is lower than the minimum' } };
  });
  const rep = await traiter(demande({ action: 'creer', montant: 15 }), ENV_NOUVELLES_CLES);
  egal(rep.status, 502, 'statut');
  vrai(!('lien' in (await rep.json())), 'aucun lien');
  egal(appels.length, 2, 'lien jamais rattaché');
});

Deno.test('retour du client : état relu chez Mollie et rapporté à la base (payée)', async () => {
  const appels = simuler((a) => {
    if (a.url.endsWith('/rpc/ma_recharge')) {
      return { statut: 200, corps: { id: RECHARGE, numero: 'R-2026-000001', montant: 20, statut: 'ouverte', methode: null, mollie_id: 'tr_essaiAbc123', solde: 0 } };
    }
    if (a.url === 'https://api.mollie.com/v2/payments/tr_essaiAbc123') {
      return { statut: 200, corps: { ...PAIEMENT_OUVERT, status: 'paid', method: 'creditcard' } };
    }
    if (a.url.endsWith('/rpc/recharge_mollie_etat')) {
      return { statut: 200, corps: { id: RECHARGE, numero: 'R-2026-000001', montant: 20, statut: 'payee', methode: 'creditcard', solde: 20 } };
    }
  });
  const rep = await traiter(demande({ action: 'verifier', recharge: RECHARGE }), ENV_NOUVELLES_CLES);
  egal(rep.status, 200, 'statut');
  egal(await rep.json(), { recharge: RECHARGE, numero: 'R-2026-000001', montant: 20, statut: 'payee', methode: 'creditcard', solde: 20 },
       'réponse (sans identifiant Mollie)');
  egal(appels[0].entetes.authorization, JETON, 'recharge lue avec les droits du client');
  egal(appels[1].methode, 'GET', 'Mollie relu');
  egal(appels[2].corps, { p_recharge: RECHARGE, p_mollie_id: 'tr_essaiAbc123', p_statut: 'paid', p_mode: 'test',
                          p_montant: 20, p_devise: 'EUR', p_methode: 'creditcard' }, 'état rapporté tel que lu chez Mollie');
  egal(appels[2].entetes.apikey, 'sb_secret_essai', 'état rapporté avec la clé de service');
});

Deno.test('retour du client : recharge déjà close, Mollie n\'est pas rappelé ; recharge d\'un autre : introuvable', async () => {
  let appels = simuler((a) => (a.url.endsWith('/rpc/ma_recharge')
    ? { statut: 200, corps: { id: RECHARGE, numero: 'R-2026-000001', montant: 20, statut: 'payee', methode: 'creditcard', mollie_id: 'tr_essaiAbc123', solde: 20 } }
    : undefined));
  let rep = await traiter(demande({ action: 'verifier', recharge: RECHARGE }), ENV_NOUVELLES_CLES);
  egal((await rep.json()).statut, 'payee', 'état');
  egal(appels.length, 1, 'un seul appel');
  appels = simuler((a) => (a.url.endsWith('/rpc/ma_recharge') ? { statut: 400, corps: { code: 'P0001', message: 'Recharge introuvable.' } } : undefined));
  rep = await traiter(demande({ action: 'verifier', recharge: RECHARGE }), ENV_NOUVELLES_CLES);
  egal(rep.status, 404, 'statut');
  rep = await traiter(demande({ action: 'verifier', recharge: 'pas-un-identifiant' }), ENV_NOUVELLES_CLES);
  egal(rep.status, 404, 'identifiant invalide');
});

Deno.test('avis de Mollie : paiement relu chez Mollie, état rapporté, réponse 200', async () => {
  const appels = simuler((a) => {
    if (a.url === 'https://api.mollie.com/v2/payments/tr_essaiAbc123') return { statut: 200, corps: { ...PAIEMENT_OUVERT, status: 'paid', method: 'applepay' } };
    if (a.url.endsWith('/rpc/recharge_mollie_etat')) return { statut: 200, corps: { statut: 'payee' } };
  });
  const rep = await traiter(demande('id=tr_essaiAbc123', { jeton: null, chemin: 'mollie/webhook' }), ENV_ANCIENNES_CLES);
  egal(rep.status, 200, 'statut');
  egal(appels.length, 2, 'Mollie puis la base');
  egal(appels[0].entetes.authorization, 'Bearer live_abcdefghijklmnopqrstuvwxyz12', 'Mollie : clé live');
  egal(appels[1].entetes.apikey, 'eyJ.service', 'base : ancienne clé de service');
  egal(appels[1].entetes.authorization, 'Bearer eyJ.service', 'base : ancienne clé aussi en jeton');
  egal((appels[1].corps as Record<string, unknown>).p_methode, 'applepay', 'moyen de paiement transmis');
});

Deno.test('avis de Mollie : faux identifiant, paiement inconnu, sans recharge, refus de la base → 200 ; panne → 5xx', async () => {
  let appels = simuler(() => undefined);
  let rep = await traiter(demande('id=pas_un_paiement', { jeton: null, chemin: 'mollie/webhook' }), ENV_NOUVELLES_CLES);
  egal([rep.status, appels.length], [200, 0], 'identifiant invalide : ignoré sans appel');

  appels = simuler((a) => (a.url.includes('/v2/payments/') ? { statut: 404, corps: { status: 404 } } : undefined));
  rep = await traiter(demande('id=tr_inconnu1234', { jeton: null, chemin: 'mollie/webhook' }), ENV_NOUVELLES_CLES);
  egal(rep.status, 200, 'paiement inconnu');

  appels = simuler((a) => (a.url.includes('/v2/payments/') ? { statut: 200, corps: { ...PAIEMENT_OUVERT, metadata: null } } : undefined));
  rep = await traiter(demande('id=tr_essaiAbc123', { jeton: null, chemin: 'mollie/webhook' }), ENV_NOUVELLES_CLES);
  egal([rep.status, appels.length], [200, 1], 'paiement sans recharge (lien fixe) : ignoré, base jamais appelée');

  simuler((a) => {
    if (a.url.includes('/v2/payments/')) return { statut: 200, corps: { ...PAIEMENT_OUVERT, status: 'paid', amount: { value: '2.00', currency: 'EUR' } } };
    if (a.url.endsWith('/rpc/recharge_mollie_etat')) return { statut: 400, corps: { code: 'P0001', message: 'Montant payé différent : rien n\'est crédité.' } };
  });
  rep = await traiter(demande('id=tr_essaiAbc123', { jeton: null, chemin: 'mollie/webhook' }), ENV_NOUVELLES_CLES);
  egal(rep.status, 200, 'refus de la base : pas de nouvel avis');

  simuler((a) => (a.url.includes('/v2/payments/') ? { statut: 503 } : undefined));
  rep = await traiter(demande('id=tr_essaiAbc123', { jeton: null, chemin: 'mollie/webhook' }), ENV_NOUVELLES_CLES);
  egal(rep.status, 502, 'Mollie injoignable : Mollie renverra l\'avis');

  simuler((a) => {
    if (a.url.includes('/v2/payments/')) return { statut: 200, corps: { ...PAIEMENT_OUVERT, status: 'paid' } };
    if (a.url.endsWith('/rpc/recharge_mollie_etat')) return { statut: 503, corps: { message: 'indisponible' } };
  });
  rep = await traiter(demande('id=tr_essaiAbc123', { jeton: null, chemin: 'mollie/webhook' }), ENV_NOUVELLES_CLES);
  egal(rep.status, 500, 'base indisponible : Mollie renverra l\'avis');

  rep = await traiter(demande('id=tr_essaiAbc123', { jeton: null, chemin: 'mollie/webhook' }), env({ SUPABASE_URL: URL_BASE }));
  egal(rep.status, 500, 'clé manquante : Mollie renverra l\'avis');
});
