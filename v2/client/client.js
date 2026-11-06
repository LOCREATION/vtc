// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : les trois onglets et la cloche des notifications
// -----------------------------------------------------------------------------
// Onglets Accueil, Activité, Compte : une seule page, sans rechargement.
// L'onglet est gardé dans l'adresse (?onglet=activite) avec la langue
// (?lang=en) : un rechargement rouvre le même, et le bouton Retour du
// téléphone revient à l'onglet précédent. Chaque onglet a son dossier
// (accueil/, activite/, compte/) et n'est chargé qu'à sa première ouverture.
// Personne non connectée : connexion (connexion/), puis retour ici.
// Compte chauffeur ou d'administration : un lien vers son propre espace.
// Notifications : la cloche ouvre le panneau commun ; un lien vers une course
// ouvre son suivi (client/course/), « /client/activite/ » l'onglet Activité,
// « /client/compte/#compte-solde » l'onglet Compte à cette section,
// « /client/demandes/?id=… » la demande dans « Mes demandes au support ».
// « Mes demandes au support » (commun/support.js) : panneau ouvert par-dessus
// la page, depuis Compte, la page d'une course (« Signaler un problème »), une
// notification, ou l'adresse : ?demande=<id> (lien d'une notification),
// ?signaler=<id de la course> (nouvelle demande sur cette course).
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../commun/supabase.js';
import { RACINE } from '../commun/config.js';
import { t, appliquerTraductions, adopterLangueProfil, langueActive, lienAvecLangue } from '../commun/i18n.js';
import { el, afficherMessage } from '../commun/outils.js';
import { installerPanneauNotifications } from '../commun/panneau-notifications.js';
import { adresseDuLien } from '../commun/notifications.js';
import { installerSupport } from '../commun/support.js';
import '../commun/pwa.js';

const $ = (id) => document.getElementById(id);
const etat = { profil: null, onglet: 'accueil', notifications: null, support: null };
const IDENTIFIANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ONGLETS = {
  accueil: () => import('./accueil/accueil.js'),
  activite: () => import('./activite/activite.js'),
  compte: () => import('./compte/compte.js')
};
const modulesCharges = {};

// Ce que reçoivent les onglets
const contexte = {
  get profil() { return etat.profil; },
  majProfil(champs) { etat.profil = { ...etat.profil, ...champs }; },
  ouvrirOnglet: (code) => ouvrirOnglet(code),
  // options : { demande } (une demande), { nouvelle: true, course } (nouvelle
  // demande, course facultative), rien (la liste)
  ouvrirSupport: (options) => (etat.support ? etat.support.ouvrir(options) : null),
  deconnecter,
  // Langue choisie dans Compte : la page se recharge dans cette langue
  changerLangue(langue) {
    const adresse = new URL(location.href);
    adresse.searchParams.set('lang', langue);
    location.replace(adresse.pathname + adresse.search);
  }
};

appliquerTraductions();
demarrer().catch((erreur) => afficherMessage(messageErreur(erreur, langueActive()), 'erreur'));

async function demarrer() {
  const { data: { session } } = await supabase.auth.getSession();
  etat.profil = session ? await profilConnecte() : null;
  if (!etat.profil) {
    const suite = `client/${location.search}`;
    location.replace(lienAvecLangue(`${RACINE}connexion/?suite=${encodeURIComponent(suite)}`));
    return;
  }
  adopterLangueProfil(etat.profil.langue);
  document.title = t('client.titre');

  // Compte d'un autre espace : le lien vers le sien
  if (etat.profil.role !== 'client') {
    const chauffeur = etat.profil.role === 'chauffeur';
    $('autre-espace-texte').textContent = t(chauffeur ? 'client.role_chauffeur' : 'client.role_admin');
    $('autre-espace-lien').textContent = t(chauffeur ? 'client.vers_chauffeur' : 'client.vers_admin');
    $('autre-espace-lien').href = `${RACINE}${chauffeur ? 'chauffeur/' : 'admin/'}`;
    $('autre-espace').hidden = false;
    return;
  }

  $('espace').hidden = false;
  $('onglets').hidden = false;
  document.body.classList.add('avec-onglets');
  document.querySelectorAll('#onglets .onglet-bas').forEach((lien) => { lien.href = adresseOnglet(lien.dataset.onglet); });
  $('cloche').hidden = false;
  etat.notifications = installerPanneauNotifications({
    cloche: $('cloche'), pastille: $('cloche-non-lues'), moi: etat.profil.id, suivreLien
  });
  etat.support = installerSupport({ moi: etat.profil.id, role: 'client',
    apresLecture: () => etat.notifications && etat.notifications.relire() });
  // Demande au support dans l'adresse (lue avant que l'onglet ne la réécrive)
  const adresse = new URLSearchParams(location.search);
  const demande = adresse.get('demande');
  const signaler = adresse.get('signaler');
  await ouvrirOnglet(ongletDeLAdresse(), { historique: 'remplacer' });
  if (demande && IDENTIFIANT.test(demande)) etat.support.ouvrir({ demande });
  else if (signaler && IDENTIFIANT.test(signaler)) etat.support.ouvrir({ nouvelle: true, course: signaler });
}

// ---------------------------------------------------------------------------
// Onglets
// ---------------------------------------------------------------------------
function ongletDeLAdresse() {
  const code = new URLSearchParams(location.search).get('onglet');
  return code && Object.prototype.hasOwnProperty.call(ONGLETS, code) ? code : 'accueil';
}

// Adresse d'un onglet : la langue seule est gardée
function adresseOnglet(code) {
  const parametres = new URLSearchParams();
  const langue = new URLSearchParams(location.search).get('lang');
  if (langue) parametres.set('lang', langue);
  if (code !== 'accueil') parametres.set('onglet', code);
  const requete = parametres.toString();
  return location.pathname + (requete ? `?${requete}` : '');
}

// historique : « ajouter » (clic sur un onglet), « remplacer » (ouverture de
// la page), « aucun » (bouton Retour du téléphone)
async function ouvrirOnglet(code, { historique = 'ajouter' } = {}) {
  etat.onglet = code;
  document.querySelectorAll('#espace > .vue').forEach((vue) => { vue.hidden = vue.dataset.onglet !== code; });
  document.querySelectorAll('#onglets .onglet-bas').forEach((lien) => {
    if (lien.dataset.onglet === code) lien.setAttribute('aria-current', 'page');
    else lien.removeAttribute('aria-current');
  });
  const adresse = adresseOnglet(code);
  if (historique === 'ajouter' && adresse !== location.pathname + location.search) history.pushState({ onglet: code }, '', adresse);
  else if (historique === 'remplacer') history.replaceState({ onglet: code }, '', adresse + location.hash);
  window.scrollTo(0, 0);

  const conteneur = $(`vue-${code}`);
  try {
    modulesCharges[code] = modulesCharges[code] || await ONGLETS[code]();
    // Onglet rouvert : ses informations sont relues (une course a pu avancer)
    await modulesCharges[code].afficher(conteneur, contexte);
  } catch (erreur) {
    // L'onglet est reconstruit à la prochaine ouverture (ou par « Réessayer »)
    delete conteneur.dataset.pret;
    const reessayer = el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: t('client.reessayer') });
    reessayer.addEventListener('click', () => ouvrirOnglet(code, { historique: 'aucun' }));
    conteneur.replaceChildren(el('div', { classe: 'feuille' },
      el('p', { classe: 'alerte', role: 'alert', texte: messageErreur(erreur, langueActive()) }), reessayer));
  }
}

document.querySelectorAll('#onglets .onglet-bas').forEach((lien) => {
  lien.addEventListener('click', (e) => {
    // Ouverture dans un nouvel onglet du navigateur : laisser faire
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    ouvrirOnglet(lien.dataset.onglet);
  });
});
window.addEventListener('popstate', () => { if (etat.profil && etat.profil.role === 'client') ouvrirOnglet(ongletDeLAdresse(), { historique: 'aucun' }); });

// ---------------------------------------------------------------------------
// Notifications : ce qu'ouvre un lien
// ---------------------------------------------------------------------------
async function suivreLien(lien) {
  const chemin = lien.split(/[?#]/)[0];
  if (chemin === '/client/' || chemin === '/client') {
    await ouvrirOnglet('accueil');
    return;
  }
  if (chemin === '/client/activite/') {
    await ouvrirOnglet('activite');
    return;
  }
  // Onglet Compte, à la section de l'ancre (« /client/compte/#compte-solde »)
  if (chemin === '/client/compte/') {
    await ouvrirOnglet('compte');
    const ancre = (lien.split('#')[1] || '').trim();
    const section = /^compte-[a-z-]{2,40}$/.test(ancre) ? document.getElementById(ancre) : null;
    if (section) section.scrollIntoView({ block: 'start' });
    return;
  }
  if (chemin === '/client/demandes/') {
    const demande = new URLSearchParams(lien.split('?')[1] || '').get('id');
    await contexte.ouvrirSupport(demande && IDENTIFIANT.test(demande) ? { demande } : {});
    return;
  }
  const adresse = adresseDuLien(lien);
  if (adresse) location.href = adresse.startsWith('/') ? lienAvecLangue(adresse) : adresse;
}

// ---------------------------------------------------------------------------
// Déconnexion (onglet Compte)
// ---------------------------------------------------------------------------
async function deconnecter() {
  await supabase.auth.signOut();
  // Réseau coupé pendant la déconnexion : la session reste ouverte sur ce
  // téléphone ; on le dit plutôt que de laisser croire qu'elle est fermée
  const { data: { session } } = await supabase.auth.getSession();
  if (session) throw new Error(t('erreur.reseau'));
  location.replace(lienAvecLangue(RACINE));
}
