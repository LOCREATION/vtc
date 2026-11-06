// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Connexion et création de compte par code reçu par e-mail, commune aux trois
// entrées du site :
//   - espace client          v2/connexion/
//   - espace chauffeur       v2/chauffeur/connexion/
//   - administration         v2/admin/connexion/ (première connexion d'un
//                            administrateur, ou mot de passe oublié)
// Chaque page fournit les mêmes formulaires (identifiants etape-email,
// etape-code, etape-profil, email, code, prenom, nom, telephone…) et dit où
// mène la connexion. Code de 6 à 10 chiffres (la longueur se règle dans
// Supabase, la page accepte toutes ces longueurs).
// -----------------------------------------------------------------------------
// - Même parcours pour un nouveau compte et pour un compte existant : la base
//   crée le profil à la première validation du code.
// - Un nouveau code au plus toutes les 60 secondes (limite aussi appliquée par
//   Supabase), code valable une heure.
// - Le lien reçu dans l'e-mail ramène toujours sur la page de connexion de
//   l'espace client (adresse autorisée dans Supabase), qui renvoie aussitôt
//   vers la page de l'espace d'où vient la demande (« suite »).
// - Après connexion : profil à compléter la première fois (prénom, téléphone ;
//   nom aussi pour un chauffeur), puis la page demandée (« suite », seulement
//   si elle appartient au site) ou l'espace de la page.
// =============================================================================
import { supabase, profilConnecte, messageErreur } from './supabase.js';
import { RACINE } from './config.js';
import { t, langueActive, adopterLangueProfil, lienAvecLangue } from './i18n.js';
import { afficherMessage, telephoneInternational, emailValide } from './outils.js';

const $ = (id) => document.getElementById(id);
const DELAI_RENVOI_S = 60;

// Pages de connexion des espaces autres que le client (chemins sous RACINE)
const PAGES_ESPACES = { chauffeur: 'chauffeur/connexion/', admin: 'admin/connexion/' };

// Adresse « suite » de la page, si elle appartient au site (sinon null)
export function suiteDemandee() {
  const suite = new URLSearchParams(location.search).get('suite');
  if (!suite) return null;
  const url = new URL(suite, location.origin + RACINE);
  return url.origin === location.origin && url.pathname.startsWith(RACINE) ? url : null;
}

// config :
//   espace        'client' | 'chauffeur' | 'admin'
//   destination   (profil, suite) => adresse où aller une fois connecté
//   nomObligatoire  le nom de famille est demandé (chauffeur : candidature)
//   codeParrain   code de parrainage du lien d'invitation (client) : la base
//                 relie le nouveau compte à son parrain à la création
//                 (ignoré pour un compte qui existe déjà)
export function demarrerConnexion({ espace, destination, nomObligatoire = false, codeParrain = null }) {
  let emailSaisi = '';
  let minuteurRenvoi = null;
  let redirectionEnCours = false;
  let longueurPrecedente = 0;
  let verificationEnCours = false;
  const etat = { profil: null };            // profil en cours de complétion

  // -------------------------------------------------------------------------
  // Étape 1 : adresse e-mail
  // -------------------------------------------------------------------------
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

  // Envoie le code ; renvoie un message d'erreur, ou null si tout va bien.
  // Le lien de l'e-mail revient par la page du client (adresse autorisée),
  // avec la page d'où vient la demande en « suite ».
  async function envoyerCode(email) {
    const retour = new URL(`${RACINE}connexion/`, location.origin);
    if (espace === 'client') {
      const suite = new URLSearchParams(location.search).get('suite');
      if (suite) retour.searchParams.set('suite', suite);
    } else {
      retour.searchParams.set('suite', PAGES_ESPACES[espace] + location.search);
    }
    if (langueActive() === 'en') retour.searchParams.set('lang', 'en');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: retour.href,
        // Repris dans le profil à la création du compte (langue, parrain)
        data: { langue: langueActive(), ...(codeParrain ? { code_parrain: codeParrain } : {}) }
      }
    });
    if (!error) return null;
    if (error.status === 429 || /rate limit|only request this after|security purposes/i.test(error.message || '')) {
      return t('connexion.trop');
    }
    return messageErreur(error, langueActive());
  }

  // -------------------------------------------------------------------------
  // Étape 2 : code reçu
  // -------------------------------------------------------------------------
  // Ne garder que les chiffres. Code collé ou proposé par le téléphone (arrivée
  // de plusieurs chiffres d'un coup) : validation immédiate. Code tapé chiffre
  // par chiffre : la personne touche « Valider » (la longueur du code dépend du
  // réglage Supabase, la page ne peut pas deviner quand il est complet).
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

  // -------------------------------------------------------------------------
  // Après connexion : compte suspendu, profil à compléter, ou redirection
  // -------------------------------------------------------------------------
  async function apresConnexion() {
    // Déjà en route vers la suite, ou profil en cours de saisie : rien à refaire
    if (redirectionEnCours || !$('etape-profil').hidden) return;

    // Retour par le lien de l'e-mail d'une autre entrée (chauffeur,
    // administration) : cette entrée-là termine la connexion
    const suite = suiteDemandee();
    if (espace === 'client' && suite && Object.values(PAGES_ESPACES).some((page) => suite.pathname === RACINE + page)) {
      redirectionEnCours = true;
      location.replace(suite.pathname + suite.search);
      return;
    }

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
    if (espace === 'client') adopterLangueProfil(profil.langue);

    // Première connexion : prénom et téléphone indispensables (le nom aussi
    // pour un chauffeur : il figure sur les feuilles de route)
    if (!profil.prenom || !profil.telephone || (nomObligatoire && !profil.nom)) {
      $('prenom').value = profil.prenom || '';
      $('nom').value = profil.nom || '';
      $('telephone').value = profil.telephone || '';
      montrerEtape('etape-profil');
      (!profil.prenom ? $('prenom') : (nomObligatoire && !profil.nom ? $('nom') : $('telephone'))).focus();
      $('etape-profil').dataset.profil = profil.id;
      etat.profil = profil;
      return;
    }
    allerA(destination(profil, suite));
  }

  // -------------------------------------------------------------------------
  // Étape 3 : profil
  // -------------------------------------------------------------------------
  $('etape-profil').addEventListener('submit', async (e) => {
    e.preventDefault();
    const prenom = $('prenom').value.trim();
    const nom = $('nom').value.trim();
    const telephone = telephoneInternational($('telephone').value);
    erreurChamp('prenom', prenom ? null : t('profil.prenom_requis'));
    if ($('erreur-nom')) erreurChamp('nom', !nomObligatoire || nom ? null : t('profil.nom_requis'));
    erreurChamp('telephone', telephone ? null : t('profil.telephone_invalide'));
    if (!prenom || !telephone || (nomObligatoire && !nom)) return;

    occuper('bouton-profil', t('profil.enregistrement'));
    const { error } = await supabase
      .from('profils')
      .update({ prenom, nom, telephone, langue: langueActive() })
      .eq('id', $('etape-profil').dataset.profil);
    liberer('bouton-profil', t('profil.enregistrer'));
    if (error) { afficherMessage(messageErreur(error, langueActive()), 'erreur'); return; }
    allerA(destination({ ...etat.profil, prenom, nom, telephone }, suiteDemandee()));
  });

  function allerA(cible) {
    redirectionEnCours = true;
    location.replace(espace === 'client' ? lienAvecLangue(cible) : cible);
  }

  // -------------------------------------------------------------------------
  // Petits outils de la page
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Démarrage : déjà connecté (ou retour par le lien de l'e-mail) → la suite
  // -------------------------------------------------------------------------
  (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) await apresConnexion();
    // Rappel exécuté pendant le traitement de la connexion : on diffère la
    // suite (appeler la bibliothèque à l'intérieur bloquerait la connexion)
    supabase.auth.onAuthStateChange((evenement) => {
      if (evenement === 'SIGNED_IN') setTimeout(apresConnexion, 0);
    });
  })();
}
