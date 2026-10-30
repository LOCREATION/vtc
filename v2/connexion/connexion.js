// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Connexion et inscription par code reçu par e-mail (6 à 10 chiffres : la
// longueur se règle dans Supabase, la page accepte toutes ces longueurs)
// -----------------------------------------------------------------------------
// - Même parcours pour un nouveau compte et pour un compte existant : la base
//   crée le profil « client » à la première validation du code.
// - Un nouveau code au plus toutes les 60 secondes (limite aussi appliquée par
//   Supabase), code valable une heure.
// - Le lien reçu dans l'e-mail fonctionne aussi : il ramène sur cette page,
//   déjà connecté.
// - Après connexion : retour à la page demandée (« suite »), uniquement si
//   elle appartient au site.
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../commun/supabase.js';
import { RACINE } from '../commun/config.js';
import { t, appliquerTraductions, langueActive, adopterLangueProfil, lienAvecLangue } from '../commun/i18n.js';
import { afficherMessage, telephoneInternational, emailValide } from '../commun/outils.js';
import '../commun/pwa.js';

const $ = (id) => document.getElementById(id);
const DELAI_RENVOI_S = 60;
let emailSaisi = '';
let minuteurRenvoi = null;
let redirectionEnCours = false;

appliquerTraductions();
demarrer();

async function demarrer() {
  // Déjà connecté (ou retour par le lien de l'e-mail) : on passe à la suite
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await apresConnexion();
  // Rappel exécuté pendant le traitement de la connexion : on diffère la suite
  // (appeler la bibliothèque à l'intérieur bloquerait la connexion en cours)
  supabase.auth.onAuthStateChange((evenement) => {
    if (evenement === 'SIGNED_IN') setTimeout(apresConnexion, 0);
  });
}

// ---------------------------------------------------------------------------
// Étape 1 : adresse e-mail
// ---------------------------------------------------------------------------
$('etape-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim().toLowerCase();
  if (!emailValide(email)) {
    erreurChamp('email', t('connexion.email_invalide'));
    return;
  }
  erreurChamp('email', null);
  occuper('bouton-email', t('connexion.envoi'));
  const erreur = await envoyerCode(email);
  liberer('bouton-email', t('connexion.recevoir'));
  if (erreur) { erreurChamp('email', erreur); return; }

  emailSaisi = email;
  $('code-envoye').textContent = t('connexion.code_envoye', { email });
  montrerEtape('etape-code');
  $('code').value = '';
  $('code').focus();
  lancerCompteARebours();
});

// Envoie le code ; renvoie un message d'erreur, ou null si tout va bien
async function envoyerCode(email) {
  const suite = new URLSearchParams(location.search).get('suite');
  const retour = new URL(`${RACINE}connexion/`, location.origin);
  if (suite) retour.searchParams.set('suite', suite);
  if (langueActive() === 'en') retour.searchParams.set('lang', 'en');

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: retour.href,
      data: { langue: langueActive() }      // reprise dans le profil à la création
    }
  });
  if (!error) return null;
  if (error.status === 429 || /rate limit|only request this after|security purposes/i.test(error.message || '')) {
    return t('connexion.trop');
  }
  return messageErreur(error, langueActive());
}

// ---------------------------------------------------------------------------
// Étape 2 : code reçu
// ---------------------------------------------------------------------------
// Ne garder que les chiffres ; validation automatique au 6e chiffre
// Ne garder que les chiffres. Code collé ou proposé par le téléphone (arrivée
// de plusieurs chiffres d'un coup) : validation immédiate. Code tapé chiffre
// par chiffre : la personne touche « Valider » (la longueur du code dépend du
// réglage Supabase, la page ne peut pas deviner quand il est complet).
let longueurPrecedente = 0;
let verificationEnCours = false;
$('code').addEventListener('input', () => {
  $('code').value = $('code').value.replace(/\D/g, '').slice(0, 10);
  erreurChamp('code', null);
  const longueur = $('code').value.length;
  if (longueur - longueurPrecedente >= 4 && longueur >= 6) $('etape-code').requestSubmit();
  longueurPrecedente = longueur;
});

$('etape-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (verificationEnCours) return;
  const code = $('code').value;
  if (!/^\d{6,10}$/.test(code)) {
    erreurChamp('code', t('connexion.code_invalide'));
    return;
  }
  verificationEnCours = true;
  occuper('bouton-code', t('connexion.verification'));
  const { error } = await supabase.auth.verifyOtp({ email: emailSaisi, token: code, type: 'email' });
  liberer('bouton-code', t('connexion.valider'));
  verificationEnCours = false;
  if (error) {
    erreurChamp('code', /expired|invalid/i.test(error.message || '') ? t('connexion.code_invalide') : messageErreur(error, langueActive()));
    $('code').select();
    return;
  }
  // La suite se fait dans apresConnexion (événement SIGNED_IN)
});

$('renvoyer').addEventListener('click', async () => {
  $('renvoyer').disabled = true;
  const erreur = await envoyerCode(emailSaisi);
  if (erreur) { afficherMessage(erreur, 'erreur'); $('renvoyer').disabled = false; return; }
  afficherMessage(t('connexion.code_renvoye'), 'succes');
  lancerCompteARebours();
});

$('changer').addEventListener('click', () => {
  clearInterval(minuteurRenvoi);
  montrerEtape('etape-email');
  $('email').focus();
});

function lancerCompteARebours() {
  let restant = DELAI_RENVOI_S;
  const bouton = $('renvoyer');
  bouton.disabled = true;
  bouton.textContent = t('connexion.renvoyer_dans', { s: restant });
  clearInterval(minuteurRenvoi);
  minuteurRenvoi = setInterval(() => {
    restant -= 1;
    if (restant <= 0) {
      clearInterval(minuteurRenvoi);
      bouton.disabled = false;
      bouton.textContent = t('connexion.renvoyer');
    } else {
      bouton.textContent = t('connexion.renvoyer_dans', { s: restant });
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// Après connexion : compte suspendu, profil à compléter, ou redirection
// ---------------------------------------------------------------------------
async function apresConnexion() {
  // Déjà en route vers la suite, ou profil en cours de saisie : rien à refaire
  if (redirectionEnCours || !$('etape-profil').hidden) return;
  let profil;
  try {
    profil = await profilConnecte();
  } catch (erreur) {
    afficherMessage(messageErreur(erreur, langueActive()), 'erreur');
    return;
  }
  if (!profil) return;
  if (profil.statut === 'bloque') {
    await supabase.auth.signOut();
    montrerEtape('etape-email');
    erreurChamp('email', t('connexion.compte_bloque'));
    return;
  }
  adopterLangueProfil(profil.langue);

  // Première connexion : prénom et téléphone indispensables pour commander
  if (!profil.prenom || !profil.telephone) {
    $('prenom').value = profil.prenom || '';
    $('nom').value = profil.nom || '';
    $('telephone').value = profil.telephone || '';
    montrerEtape('etape-profil');
    (profil.prenom ? $('telephone') : $('prenom')).focus();
    $('etape-profil').dataset.profil = profil.id;
    $('etape-profil').dataset.role = profil.role;
    return;
  }
  allerALaSuite(profil.role);
}

// ---------------------------------------------------------------------------
// Étape 3 : profil
// ---------------------------------------------------------------------------
$('etape-profil').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prenom = $('prenom').value.trim();
  const nom = $('nom').value.trim();
  const telephone = telephoneInternational($('telephone').value);
  erreurChamp('prenom', prenom ? null : t('profil.prenom_requis'));
  erreurChamp('telephone', telephone ? null : t('profil.telephone_invalide'));
  if (!prenom || !telephone) return;

  occuper('bouton-profil', t('profil.enregistrement'));
  const { error } = await supabase
    .from('profils')
    .update({ prenom, nom, telephone, langue: langueActive() })
    .eq('id', $('etape-profil').dataset.profil);
  liberer('bouton-profil', t('profil.enregistrer'));
  if (error) { afficherMessage(messageErreur(error, langueActive()), 'erreur'); return; }
  allerALaSuite($('etape-profil').dataset.role);
});

// Page demandée avant la connexion (si elle fait partie du site), sinon
// l'espace correspondant au rôle : chauffeur → espace chauffeur,
// administrateur → administration (double authentification demandée là-bas),
// sinon l'accueil
function allerALaSuite(role) {
  redirectionEnCours = true;
  const suite = new URLSearchParams(location.search).get('suite');
  let cible = role === 'chauffeur' ? `${RACINE}chauffeur/` : role === 'admin' ? `${RACINE}admin/` : RACINE;
  if (suite) {
    const url = new URL(suite, location.origin + RACINE);
    if (url.origin === location.origin && url.pathname.startsWith(RACINE)) cible = url.pathname + url.search;
  }
  location.replace(lienAvecLangue(cible));
}

// ---------------------------------------------------------------------------
// Petits outils de la page
// ---------------------------------------------------------------------------
function montrerEtape(id) {
  ['etape-email', 'etape-code', 'etape-profil'].forEach((etape) => { $(etape).hidden = etape !== id; });
}

function erreurChamp(champ, message) {
  const zone = $(`erreur-${champ}`);
  zone.hidden = !message;
  zone.textContent = message || '';
  $(champ).setAttribute('aria-invalid', String(!!message));
}

function occuper(id, texte) { $(id).disabled = true; $(id).textContent = texte; }
function liberer(id, texte) { $(id).disabled = false; $(id).textContent = texte; }
