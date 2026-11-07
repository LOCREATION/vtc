// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Sécurité »
// -----------------------------------------------------------------------------
//   - E-mail de connexion et dernière connexion (lus auprès du service de
//     connexion de Supabase : getUser, toujours à jour) ;
//   - « Changer d'adresse e-mail », par code :
//       1. nouvelle adresse → un code y est envoyé (auth.updateUser) ;
//       2. code reçu à la nouvelle adresse → vérifié (auth.verifyOtp, type
//          « email_change ») ;
//       3. si Supabase demande la double confirmation (réglage « Secure email
//          change », actif par défaut) : un second code, envoyé à l'adresse
//          actuelle, termine le changement.
//     « Renvoyer le code » (après 60 s), « Annuler ». Un changement commencé
//     puis laissé (page fermée) se reprend : « Saisir le code ». Le profil
//     suit tout seul (déclencheur synchroniser_contact de la base) ;
//   - « Se déconnecter des autres appareils » (auth.signOut, portée
//     « others ») : ce téléphone reste connecté ; les autres ne peuvent plus
//     renouveler leur connexion (au plus tard dans l'heure).
// Réglage Supabase nécessaire : le modèle d'e-mail « Change email address »
// contient le code ({{ .Token }}) ; sans service d'envoi installé (Brevo),
// Supabase n'écrit qu'aux adresses de l'équipe du projet.
// Ancre : #compte-securite.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { t, langueActive } from '../../commun/i18n.js';
import { el, dateHeure, afficherMessage, emailValide } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
const ATTENTE_RENVOI_S = 60;            // délai avant « Renvoyer le code »
const CODE = /^\d{6,10}$/;              // longueur du code réglée dans Supabase (6 à 10 chiffres)

// apresChangement : appelé une fois l'adresse changée (le profil se relit)
export function creerSectionSecurite({ apresChangement = null } = {}) {
  // etape : 'adresse' (nouvelle adresse), 'code' (code de la nouvelle
  // adresse), 'code_actuel' (second code, adresse actuelle)
  const etat = { utilisateur: null, etape: 'adresse', nouvelle: null, minuteur: null, restant: 0 };

  const champ = (id, libelle, attributs, aide = null) => el('div', { classe: 'champ', id: `${id}-bloc` },
    el('label', { for: id, texte: libelle }),
    el('input', { id, classe: 'saisie', ...attributs, 'aria-describedby': `${id}-erreur` }),
    aide ? el('p', { classe: 'aide', texte: aide }) : null,
    el('p', { classe: 'erreur-champ', id: `${id}-erreur`, hidden: true }));

  const formulaire = el('form', { classe: 'formulaire-client formulaire-lieu', id: 'compte-email-formulaire', novalidate: true, hidden: true,
    'aria-labelledby': 'compte-email-titre' },
    el('h3', { id: 'compte-email-titre', texte: t('securite.changer_email') }),
    champ('compte-email-nouveau', t('securite.nouvel_email'), { type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: '254' },
      t('securite.nouvel_email_aide')),
    el('p', { classe: 'alerte alerte-info', id: 'compte-email-envoye', role: 'status', hidden: true }),
    champ('compte-email-code', t('securite.code'), { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '10' }),
    el('div', { classe: 'actions-client' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-email-annuler', texte: t('compte.annuler'), onclick: fermer }),
      el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'compte-email-valider', texte: t('securite.recevoir_code') })),
    el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'compte-email-renvoyer', hidden: true, onclick: renvoyer }));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); valider(); });
  formulaire.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') marquer(e.target.id, null); });

  const section = el('section', { classe: 'bloc-client', id: 'compte-securite', 'aria-labelledby': 'compte-titre-securite' },
    el('h2', { id: 'compte-titre-securite', texte: t('securite.titre') }),
    el('dl', { classe: 'lignes-client', id: 'compte-securite-infos' }),
    el('div', { classe: 'alerte alerte-info attente-email', id: 'compte-email-attente', hidden: true },
      el('span', { id: 'compte-email-attente-texte' }),
      el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'compte-email-reprendre', texte: t('securite.saisir_code'),
        onclick: () => ouvrir(etat.utilisateur && etat.utilisateur.new_email) })),
    el('div', { classe: 'actions-client actions-larges', id: 'compte-securite-actions' },
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-changer-email', texte: t('securite.changer_email'),
        onclick: () => ouvrir() }),
      el('button', { type: 'button', classe: 'bouton bouton-secondaire', id: 'compte-deconnecter-autres', texte: t('securite.deconnecter_autres'),
        onclick: deconnecterAutres })),
    formulaire,
    el('p', { classe: 'aide-client', texte: t('securite.aide') }));

  // -------------------------------------------------------------------------
  // Lecture : le service de connexion (l'adresse du profil peut avoir un
  // temps de retard sur un changement en cours)
  // -------------------------------------------------------------------------
  async function charger() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    etat.utilisateur = data.user || {};
    afficherInfos();
  }

  function afficherInfos() {
    const u = etat.utilisateur || {};
    const ligne = (libelle, valeur) => [el('dt', { texte: libelle }), el('dd', { texte: valeur })];
    $('compte-securite-infos').replaceChildren(
      ...ligne(t('securite.email'), u.email || t('compte.non_renseigne')),
      ...ligne(t('securite.derniere_connexion'), u.last_sign_in_at
        ? dateHeure(u.last_sign_in_at, { dateStyle: 'long', timeStyle: 'short' }) : t('securite.inconnue')));
    // Changement commencé puis laissé : il se reprend avec le code reçu
    const attente = !!u.new_email && formulaire.hidden;
    $('compte-email-attente').hidden = !attente;
    if (attente) $('compte-email-attente-texte').textContent = t('securite.en_attente', { email: u.new_email });
  }

  // -------------------------------------------------------------------------
  // Changement d'adresse
  // -------------------------------------------------------------------------
  function marquer(id, message) {
    const champSaisie = $(id);
    const erreur = $(`${id}-erreur`);
    if (!champSaisie || !erreur) return;
    champSaisie.setAttribute('aria-invalid', message ? 'true' : 'false');
    erreur.textContent = message || '';
    erreur.hidden = !message;
  }

  // nouvelle : adresse d'un changement déjà commencé (on passe au code)
  function ouvrir(nouvelle = null) {
    formulaire.hidden = false;
    $('compte-securite-actions').hidden = true;
    $('compte-email-attente').hidden = true;
    marquer('compte-email-nouveau', null);
    marquer('compte-email-code', null);
    $('compte-email-code').value = '';
    if (nouvelle) {
      etat.nouvelle = nouvelle;
      montrerEtape('code');
      demarrerRenvoi(0);
    } else {
      etat.nouvelle = null;
      $('compte-email-nouveau').value = '';
      montrerEtape('adresse');
    }
  }

  function fermer() {
    clearInterval(etat.minuteur);
    formulaire.hidden = true;
    $('compte-securite-actions').hidden = false;
    afficherInfos();
  }

  function montrerEtape(etape) {
    etat.etape = etape;
    const adresse = etape === 'adresse';
    $('compte-email-nouveau-bloc').hidden = !adresse;
    $('compte-email-code-bloc').hidden = adresse;
    $('compte-email-envoye').hidden = adresse;
    $('compte-email-renvoyer').hidden = adresse;
    $('compte-email-valider').textContent = t(adresse ? 'securite.recevoir_code' : 'securite.confirmer');
    if (etape === 'code') $('compte-email-envoye').textContent = t('securite.code_envoye', { email: etat.nouvelle });
    if (etape === 'code_actuel') $('compte-email-envoye').textContent = t('securite.code_actuel', { email: etat.utilisateur.email });
    $(adresse ? 'compte-email-nouveau' : 'compte-email-code').focus();
  }

  // « Renvoyer le code » : disponible après 60 secondes
  function demarrerRenvoi(secondes = ATTENTE_RENVOI_S) {
    clearInterval(etat.minuteur);
    etat.restant = secondes;
    const bouton = $('compte-email-renvoyer');
    const majBouton = () => {
      bouton.disabled = etat.restant > 0;
      bouton.textContent = etat.restant > 0 ? t('securite.renvoyer_dans', { s: etat.restant }) : t('securite.renvoyer');
    };
    majBouton();
    if (secondes <= 0) return;
    etat.minuteur = setInterval(() => {
      etat.restant -= 1;
      majBouton();
      if (etat.restant <= 0) clearInterval(etat.minuteur);
    }, 1000);
  }

  // Réponses du service de connexion → texte dans la langue de la page
  function erreurEnvoi(erreur) {
    const code = (erreur && erreur.code) || '';
    const message = (erreur && erreur.message) || '';
    if (code === 'email_exists' || /already (been )?registered|already exists/i.test(message)) return t('securite.email_pris');
    if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || erreur.status === 429) return t('securite.trop_de_codes');
    if (code === 'email_address_not_authorized') return t('securite.envoi_impossible');
    if (code === 'email_address_invalid' || code === 'validation_failed' || /invalid format|valid email/i.test(message)) return t('securite.email_invalide');
    return messageErreur(erreur, langueActive());
  }

  async function valider() {
    const bouton = $('compte-email-valider');
    if (etat.etape === 'adresse') {
      const nouvelle = $('compte-email-nouveau').value.trim().toLowerCase();
      if (!emailValide(nouvelle)) { marquer('compte-email-nouveau', t('securite.email_invalide')); $('compte-email-nouveau').focus(); return; }
      if (nouvelle === String(etat.utilisateur.email || '').toLowerCase()) {
        marquer('compte-email-nouveau', t('securite.email_identique'));
        $('compte-email-nouveau').focus();
        return;
      }
      bouton.disabled = true;
      const { data, error } = await supabase.auth.updateUser({ email: nouvelle },
        { emailRedirectTo: new URL(`${RACINE}client/?onglet=compte`, location.origin).href });
      bouton.disabled = false;
      if (error) { marquer('compte-email-nouveau', erreurEnvoi(error)); return; }
      // Le service garde l'adresse actuelle et note la nouvelle (new_email) :
      // un « Annuler » laisse le changement en attente, repris par « Saisir le code »
      if (data && data.user) etat.utilisateur = data.user;
      etat.nouvelle = nouvelle;
      $('compte-email-code').value = '';
      montrerEtape('code');
      demarrerRenvoi();
      return;
    }

    // Code de la nouvelle adresse, puis (double confirmation) de l'actuelle
    const code = $('compte-email-code').value.replace(/\s/g, '');
    if (!CODE.test(code)) { marquer('compte-email-code', t('securite.code_format')); $('compte-email-code').focus(); return; }
    bouton.disabled = true;
    const email = etat.etape === 'code' ? etat.nouvelle : etat.utilisateur.email;
    const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email_change' });
    bouton.disabled = false;
    if (error) { marquer('compte-email-code', t('securite.code_errone')); $('compte-email-code').select(); return; }
    if (!data || !data.session) {
      // Première confirmation acceptée : le second code termine le changement
      $('compte-email-code').value = '';
      montrerEtape('code_actuel');
      return;
    }
    const nouvelle = etat.nouvelle;
    fermer();
    await charger().catch(() => {});
    afficherMessage(t('securite.email_change', { email: nouvelle }), 'succes');
    if (apresChangement) await apresChangement();
  }

  async function renvoyer() {
    const bouton = $('compte-email-renvoyer');
    bouton.disabled = true;
    const { error } = await supabase.auth.resend({ type: 'email_change', email: etat.nouvelle });
    if (error) {
      afficherMessage(erreurEnvoi(error), 'erreur');
      demarrerRenvoi(error.status === 429 ? ATTENTE_RENVOI_S : 0);
      return;
    }
    afficherMessage(t('securite.code_renvoye'), 'succes');
    demarrerRenvoi();
  }

  // -------------------------------------------------------------------------
  // Autres appareils
  // -------------------------------------------------------------------------
  async function deconnecterAutres() {
    const bouton = $('compte-deconnecter-autres');
    bouton.disabled = true;
    const { error } = await supabase.auth.signOut({ scope: 'others' });
    bouton.disabled = false;
    if (error) { afficherMessage(messageErreur(error, langueActive()), 'erreur'); return; }
    afficherMessage(t('securite.autres_ok'), 'succes');
  }

  return { section, charger, fermer };
}
