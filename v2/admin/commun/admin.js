// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : porte d'entrée sécurisée et cadre commun des modules
// -----------------------------------------------------------------------------
// Chaque page de l'administration appelle « ouvrirAdministration() » :
//   1. pas de session → connexion par e-mail et mot de passe (ou lien vers la
//      connexion par code reçu par e-mail) ;
//   2. compte qui n'est pas administrateur → accès refusé ;
//   3. double authentification :
//        - déjà confirmée sur cette session (niveau « aal2 ») → on entre ;
//        - application déjà configurée → code à 6 chiffres de l'application ;
//        - première fois → choix du mot de passe, puis configuration de
//          l'application d'authentification (QR code ou clé à recopier) ;
//   4. affichage du menu des modules et de la page demandée.
// La base refuse de toute façon toute action d'administration sans le niveau
// « aal2 » : cette porte n'est que le parcours qui permet de l'obtenir.
// =============================================================================
import { supabase, profilConnecte, messageErreur } from '../../commun/supabase.js';
import { RACINE } from '../../commun/config.js';
import { imposerLangue } from '../../commun/i18n.js';
import { el, afficherMessage, emailValide } from '../../commun/outils.js';

imposerLangue('fr');                 // administration en français

const $ = (id) => document.getElementById(id);

// Modules construits, dans l'ordre du menu. « dossier » = chemin sous /admin/.
export const MODULES = [
  { code: 'tableau',    dossier: '',            titre: 'Tableau de bord', icone: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z' },
  { code: 'dispatch',   dossier: 'dispatch/',   titre: 'Dispatch',        icone: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  { code: 'courses',    dossier: 'courses/',    titre: 'Courses',         icone: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' },
  { code: 'chauffeurs', dossier: 'chauffeurs/', titre: 'Chauffeurs',      icone: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' },
  { code: 'flotte',     dossier: 'flotte/',     titre: 'Flotte',          icone: 'M5 16l1.6-5.2A2 2 0 0 1 8.5 9.4h7a2 2 0 0 1 1.9 1.4L19 16M4 16h16v3H4zM7 19v2M17 19v2' },
  { code: 'tarifs',     dossier: 'tarifs/',     titre: 'Tarifs et zones', icone: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01' },
  { code: 'parametres', dossier: 'parametres/', titre: 'Paramètres',      icone: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' }
];

// Lien vers un module (ou une page d'un module) de l'administration
export function lienAdmin(dossier = '') {
  return `${RACINE}admin/${dossier}`;
}

// Lien d'une notification enregistrée en base (« /admin/dispatch/ »,
// « /client/course/?id=… ») vers la bonne adresse du site
export function lienSite(chemin) {
  return RACINE + String(chemin || '').replace(/^\/+/, '');
}

function icone(chemin) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const trace = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  trace.setAttribute('d', chemin);
  svg.append(trace);
  return svg;
}

// ---------------------------------------------------------------------------
// Point d'entrée de chaque page
// ---------------------------------------------------------------------------
// Renvoie le profil de l'administrateur une fois la porte franchie.
export function ouvrirAdministration({ module }) {
  return new Promise((entrer) => {
    const porte = new Porte(module, entrer);
    porte.demarrer().catch((erreur) => porte.erreurGenerale(erreur));
  });
}

class Porte {
  constructor(module, entrer) {
    this.module = module;
    this.entrer = entrer;
    this.zone = $('porte');
    this.dejaEntre = false;
  }

  // Panneau de la porte : marque, titre, contenu
  afficher(titre, ...contenu) {
    this.zone.hidden = false;
    $('admin-cadre').hidden = true;
    this.zone.replaceChildren(el('div', { classe: 'feuille porte-feuille' },
      el('a', { classe: 'porte-marque', href: RACINE },
        el('img', { src: `${RACINE}commun/img/logo.svg`, alt: '', width: '56', height: '28' }),
        el('span', { texte: 'LOC RÉACTION' })),
      el('h1', { texte: titre }),
      ...contenu));
    const premier = this.zone.querySelector('input');
    if (premier) premier.focus();
  }

  erreurGenerale(erreur) {
    this.afficher('Administration',
      el('p', { classe: 'alerte', role: 'alert', texte: messageErreur(erreur) }),
      el('button', { type: 'button', classe: 'bouton bouton-principal', texte: 'Réessayer', onclick: () => location.reload() }));
  }

  async demarrer() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { this.connexion(); return; }
    await this.verifierCompte();
  }

  // -------------------------------------------------------------------------
  // 1. Connexion par e-mail et mot de passe
  // -------------------------------------------------------------------------
  connexion() {
    const email = el('input', { id: 'porte-email', classe: 'saisie', type: 'email', autocomplete: 'username', inputmode: 'email', required: true });
    const motDePasse = el('input', { id: 'porte-mdp', classe: 'saisie', type: 'password', autocomplete: 'current-password', required: true });
    const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
    const bouton = el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-large', texte: 'Se connecter' });
    const suite = encodeURIComponent(location.pathname.slice(RACINE.length) + location.search);
    const formulaire = el('form', { classe: 'porte-feuille', novalidate: true },
      el('div', { classe: 'champ' }, el('label', { for: 'porte-email', texte: 'Adresse e-mail' }), email),
      el('div', { classe: 'champ' }, el('label', { for: 'porte-mdp', texte: 'Mot de passe' }),
        el('div', { classe: 'champ-mot-de-passe' }, motDePasse, boutonVoir(motDePasse))),
      erreur,
      bouton,
      el('div', { classe: 'porte-liens' },
        el('p', { classe: 'aide', texte: 'Pas encore de mot de passe, ou mot de passe oublié ?' }),
        el('a', { href: `${RACINE}connexion/?suite=${suite}`, texte: 'Me connecter avec un code reçu par e-mail' })));
    formulaire.addEventListener('submit', async (e) => {
      e.preventDefault();
      erreur.hidden = true;
      if (!emailValide(email.value) || !motDePasse.value) {
        erreur.textContent = 'Saisissez votre adresse e-mail et votre mot de passe.';
        erreur.hidden = false;
        return;
      }
      bouton.disabled = true;
      bouton.textContent = 'Connexion…';
      const { error } = await supabase.auth.signInWithPassword({ email: email.value.trim().toLowerCase(), password: motDePasse.value });
      bouton.disabled = false;
      bouton.textContent = 'Se connecter';
      if (error) {
        erreur.textContent = messageConnexion(error);
        erreur.hidden = false;
        motDePasse.select();
        return;
      }
      await this.verifierCompte();
    });
    this.afficher('Administration',
      el('p', { classe: 'intro', texte: 'Espace réservé aux administrateurs de LOC RÉACTION S.A.S.' }),
      formulaire);
  }

  // -------------------------------------------------------------------------
  // 2. Compte administrateur ? puis 3. double authentification
  // -------------------------------------------------------------------------
  async verifierCompte() {
    const profil = await profilConnecte();
    if (!profil || profil.role !== 'admin' || profil.statut !== 'actif') {
      this.afficher('Accès réservé',
        el('p', { texte: 'Cet espace est réservé aux administrateurs de LOC RÉACTION. Votre compte n\'en fait pas partie.' }),
        el('div', { classe: 'actions-ligne' },
          el('a', { classe: 'bouton bouton-principal', href: RACINE, texte: 'Retour au site' }),
          el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Changer de compte', onclick: () => this.deconnecter() })));
      return;
    }
    this.profil = profil;

    const { data: niveau, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    if (niveau.currentLevel === 'aal2') { this.ouvrir(); return; }

    const { data: facteurs, error: erreurFacteurs } = await supabase.auth.mfa.listFactors();
    if (erreurFacteurs) throw erreurFacteurs;
    const application = (facteurs.totp || []).find((f) => f.status === 'verified');
    if (application) {
      this.codeApplication(application.id);
    } else {
      // Première configuration : mot de passe d'abord, sauf s'il vient
      // d'être utilisé pour se connecter (il existe donc déjà)
      const parMotDePasse = (niveau.currentAuthenticationMethods || []).some((m) => m.method === 'password');
      if (parMotDePasse) await this.configurerApplication();
      else this.choisirMotDePasse();
    }
  }

  // Code à 6 chiffres de l'application d'authentification
  codeApplication(idFacteur) {
    const code = el('input', { id: 'porte-code', classe: 'saisie saisie-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true });
    const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
    const bouton = el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-large', texte: 'Valider' });
    const formulaire = el('form', { classe: 'porte-feuille', novalidate: true },
      el('div', { classe: 'champ' }, el('label', { for: 'porte-code', texte: 'Code à 6 chiffres' }), code),
      erreur, bouton);
    const valider = async () => {
      erreur.hidden = true;
      if (!/^\d{6}$/.test(code.value)) {
        erreur.textContent = 'Saisissez les 6 chiffres affichés par l\'application.';
        erreur.hidden = false;
        return;
      }
      bouton.disabled = true;
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: idFacteur, code: code.value });
      bouton.disabled = false;
      if (error) {
        erreur.textContent = messageCode(error);
        erreur.hidden = false;
        code.select();
        return;
      }
      this.ouvrir();
    };
    code.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
      if (code.value.length === 6) valider();
    });
    formulaire.addEventListener('submit', (e) => { e.preventDefault(); valider(); });
    this.afficher('Double authentification',
      el('p', { classe: 'intro', texte: 'Ouvrez Google Authenticator ou Microsoft Authenticator sur votre téléphone et saisissez le code affiché pour « LOC RÉACTION ».' }),
      formulaire,
      el('div', { classe: 'porte-liens' },
        el('p', { classe: 'aide', texte: 'Téléphone perdu ou changé ? Un autre administrateur, ou votre prestataire technique, peut réinitialiser la double authentification de votre compte.' }),
        el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Changer de compte', onclick: () => this.deconnecter() })));
  }

  // Première configuration, étape 1 : mot de passe
  choisirMotDePasse() {
    const mdp = el('input', { id: 'porte-mdp1', classe: 'saisie', type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
    const confirmation = el('input', { id: 'porte-mdp2', classe: 'saisie', type: 'password', autocomplete: 'new-password', required: true });
    const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
    const bouton = el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-large', texte: 'Enregistrer le mot de passe' });
    const zoneCode = el('div', { classe: 'champ', hidden: true });
    const code = el('input', { id: 'porte-nonce', classe: 'saisie saisie-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '10' });
    zoneCode.append(el('label', { for: 'porte-nonce', texte: 'Code de confirmation reçu par e-mail' }), code,
      el('p', { classe: 'aide', texte: 'Par sécurité, un code vient de vous être envoyé par e-mail pour confirmer ce changement.' }));
    const formulaire = el('form', { classe: 'porte-feuille', novalidate: true },
      el('div', { classe: 'champ' }, el('label', { for: 'porte-mdp1', texte: 'Nouveau mot de passe' }),
        el('div', { classe: 'champ-mot-de-passe' }, mdp, boutonVoir(mdp)),
        el('p', { classe: 'aide', texte: 'Au moins 10 caractères, avec des lettres et des chiffres.' })),
      el('div', { classe: 'champ' }, el('label', { for: 'porte-mdp2', texte: 'Confirmez le mot de passe' }), confirmation),
      zoneCode, erreur, bouton);
    formulaire.addEventListener('submit', async (e) => {
      e.preventDefault();
      erreur.hidden = true;
      const probleme = !(mdp.value.length >= 10 && /[a-z]/i.test(mdp.value) && /\d/.test(mdp.value))
        ? 'Le mot de passe doit faire au moins 10 caractères et contenir des lettres et des chiffres.'
        : mdp.value !== confirmation.value ? 'Les deux mots de passe ne sont pas identiques.' : null;
      if (probleme) { erreur.textContent = probleme; erreur.hidden = false; return; }
      bouton.disabled = true;
      const attributs = { password: mdp.value };
      if (!zoneCode.hidden) attributs.nonce = code.value.trim();
      let { error } = await supabase.auth.updateUser(attributs);
      // Réglage « changement de mot de passe sécurisé » : confirmation par e-mail
      if (error && (error.code === 'reauthentication_needed' || /reauthenticat/i.test(error.message || '')) && zoneCode.hidden) {
        const envoi = await supabase.auth.reauthenticate();
        bouton.disabled = false;
        if (envoi.error) { erreur.textContent = messageErreur(envoi.error); erreur.hidden = false; return; }
        zoneCode.hidden = false;
        code.focus();
        return;
      }
      // Même mot de passe que celui déjà enregistré : il existe, on continue
      if (error && (error.code === 'same_password' || /should be different/i.test(error.message || ''))) error = null;
      bouton.disabled = false;
      if (error) { erreur.textContent = messageMotDePasse(error); erreur.hidden = false; return; }
      afficherMessage('Mot de passe enregistré.', 'succes');
      await this.configurerApplication();
    });
    this.afficher('Sécuriser l\'administration',
      etapes(1),
      el('p', { classe: 'intro', texte: 'Pour entrer dans l\'administration, il vous faut un mot de passe et la double authentification. Commencez par choisir votre mot de passe : il vous servira à chaque connexion.' }),
      formulaire,
      el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'J\'ai déjà un mot de passe : passer à l\'étape 2', onclick: () => this.configurerApplication() }));
  }

  // Première configuration, étape 2 : application d'authentification
  async configurerApplication() {
    this.afficher('Sécuriser l\'administration', etapes(2), el('p', { classe: 'chargement', texte: 'Préparation…' }));
    // Les essais interrompus laissent des configurations inachevées : on les retire
    const { data: facteurs } = await supabase.auth.mfa.listFactors();
    for (const f of (facteurs && facteurs.all) || []) {
      if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp', friendlyName: 'Administration LOC RÉACTION', issuer: 'LOC RÉACTION'
    });
    if (error) throw error;

    const cle = data.totp.secret;
    const code = el('input', { id: 'porte-code', classe: 'saisie saisie-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true });
    const erreur = el('p', { classe: 'alerte', role: 'alert', hidden: true });
    const bouton = el('button', { type: 'submit', classe: 'bouton bouton-principal bouton-large', texte: 'Activer la double authentification' });
    const formulaire = el('form', { classe: 'porte-feuille', novalidate: true },
      el('div', { classe: 'champ' }, el('label', { for: 'porte-code', texte: 'Code à 6 chiffres affiché par l\'application' }), code),
      erreur, bouton);
    const copier = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Copier la clé' });
    copier.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(cle); afficherMessage('Clé copiée.', 'succes'); }
      catch { afficherMessage('Copie impossible : sélectionnez la clé et copiez-la à la main.', 'erreur'); }
    });
    formulaire.addEventListener('submit', async (e) => {
      e.preventDefault();
      erreur.hidden = true;
      if (!/^\d{6}$/.test(code.value)) {
        erreur.textContent = 'Saisissez les 6 chiffres affichés par l\'application.';
        erreur.hidden = false;
        return;
      }
      bouton.disabled = true;
      const { error: probleme } = await supabase.auth.mfa.challengeAndVerify({ factorId: data.id, code: code.value });
      bouton.disabled = false;
      if (probleme) { erreur.textContent = messageCode(probleme); erreur.hidden = false; code.select(); return; }
      afficherMessage('Double authentification activée.', 'succes');
      this.ouvrir();
    });
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });

    this.afficher('Sécuriser l\'administration',
      etapes(2),
      el('ol', { classe: 'liste-etapes' },
        el('li', { texte: 'Installez Google Authenticator ou Microsoft Authenticator sur votre téléphone (gratuit).' }),
        el('li', { texte: 'Dans l\'application, touchez « + » puis « Scanner un code QR », et scannez le code ci-dessous.' }),
        el('li', { texte: 'Vous êtes sur ce même téléphone ? Touchez « Ajouter à l\'application », ou copiez la clé et choisissez « Saisir une clé de configuration ».' })),
      el('img', { classe: 'qr', src: imageQr(data.totp.qr_code), alt: 'Code QR à scanner avec l\'application d\'authentification', width: '200', height: '200' }),
      el('a', { classe: 'bouton bouton-secondaire', href: data.totp.uri, texte: 'Ajouter à l\'application' }),
      el('div', { classe: 'champ' },
        el('span', { classe: 'etiquette', texte: 'Clé de configuration' }),
        el('p', { classe: 'cle-secrete', texte: cle.replace(/(.{4})/g, '$1 ').trim() }),
        copier),
      formulaire);
  }

  // -------------------------------------------------------------------------
  // 4. Entrée : menu et page du module
  // -------------------------------------------------------------------------
  ouvrir() {
    if (this.dejaEntre) return;
    this.dejaEntre = true;
    this.zone.hidden = true;
    this.zone.replaceChildren();
    construireMenu(this.module, this.profil, () => this.deconnecter());
    $('admin-cadre').hidden = false;
    // Session fermée ailleurs (autre onglet, expiration) : retour à la porte
    supabase.auth.onAuthStateChange((evenement) => {
      if (evenement === 'SIGNED_OUT') setTimeout(() => location.reload(), 0);
    });
    this.entrer(this.profil);
  }

  async deconnecter() {
    await supabase.auth.signOut();
    location.reload();
  }
}

// Image du QR code : Supabase renvoie le dessin brut (SVG) précédé de
// « data:image/svg+xml;utf-8, ». Un caractère « # » dans le dessin couperait
// l'adresse : le dessin est donc encodé proprement.
function imageQr(qr) {
  const prefixe = 'data:image/svg+xml;utf-8,';
  return String(qr || '').startsWith(prefixe)
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.slice(prefixe.length))}`
    : qr;
}

// Bandeau des deux étapes de la première configuration
function etapes(active) {
  return el('p', { classe: 'porte-etapes' },
    el('span', { 'aria-current': active === 1 ? 'step' : null, texte: '1. Mot de passe' }),
    el('span', { 'aria-current': active === 2 ? 'step' : null, texte: '2. Application' }));
}

// Bouton « Afficher / Masquer » d'un champ mot de passe
function boutonVoir(champ) {
  const bouton = el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Afficher', 'aria-pressed': 'false' });
  bouton.addEventListener('click', () => {
    const visible = champ.type === 'password';
    champ.type = visible ? 'text' : 'password';
    bouton.textContent = visible ? 'Masquer' : 'Afficher';
    bouton.setAttribute('aria-pressed', String(visible));
  });
  return bouton;
}

// Messages d'erreur précis (la version 1 affichait « identifiants incorrects »
// sans dire pourquoi)
function messageConnexion(erreur) {
  const texte = erreur.message || '';
  if (erreur.code === 'invalid_credentials' || /invalid login credentials/i.test(texte)) {
    return 'Adresse e-mail ou mot de passe incorrect. Vous n\'avez pas encore de mot de passe ? Connectez-vous avec un code reçu par e-mail (lien ci-dessous).';
  }
  if (erreur.code === 'email_not_confirmed' || /email not confirmed/i.test(texte)) {
    return 'Adresse e-mail pas encore confirmée : connectez-vous une première fois avec un code reçu par e-mail.';
  }
  if (erreur.status === 429 || /rate limit|too many/i.test(texte)) {
    return 'Trop d\'essais à la suite : patientez quelques minutes avant de réessayer.';
  }
  return messageErreur(erreur);
}

function messageCode(erreur) {
  const texte = erreur.message || '';
  if (/invalid|expired|code/i.test(texte) && !/fetch|network/i.test(texte)) {
    return 'Code incorrect ou expiré : saisissez le code affiché en ce moment dans l\'application (il change toutes les 30 secondes).';
  }
  if (erreur.status === 429 || /rate limit|too many/i.test(texte)) {
    return 'Trop d\'essais à la suite : patientez une minute avant de réessayer.';
  }
  return messageErreur(erreur);
}

function messageMotDePasse(erreur) {
  const texte = erreur.message || '';
  if (erreur.code === 'weak_password' || /weak|at least|characters/i.test(texte)) {
    return 'Mot de passe trop faible : allongez-le et mélangez lettres, chiffres et signes.';
  }
  if (/nonce|otp|token/i.test(texte)) return 'Code de confirmation incorrect ou expiré.';
  return messageErreur(erreur);
}

// ---------------------------------------------------------------------------
// Menu des modules (fixe sur ordinateur, tiroir sur téléphone)
// ---------------------------------------------------------------------------
function construireMenu(moduleActif, profil, deconnecter) {
  const menu = $('admin-menu');
  menu.replaceChildren(
    el('a', { classe: 'marque', href: lienAdmin() },
      el('img', { src: `${RACINE}commun/img/logo.svg`, alt: '', width: '56', height: '28' }),
      el('span', { texte: 'LOC RÉACTION' })),
    el('p', { classe: 'admin-menu-titre', texte: 'Administration' }),
    ...MODULES.map((m) => {
      const lien = el('a', { classe: 'admin-lien', href: lienAdmin(m.dossier), 'aria-current': m.code === moduleActif ? 'page' : null, dataset: { module: m.code } },
        icone(m.icone), el('span', { texte: m.titre }));
      return lien;
    }),
    el('div', { classe: 'admin-utilisateur' },
      el('strong', { texte: [profil.prenom, profil.nom].filter(Boolean).join(' ') || 'Administrateur' }),
      el('span', { texte: profil.email || '' }),
      el('a', { href: RACINE, texte: 'Voir le site' }),
      el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Se déconnecter', onclick: deconnecter })));

  // Tiroir sur téléphone
  const bouton = $('admin-ouvrir-menu');
  if (!bouton) return;
  let voile = null;
  const fermer = () => {
    menu.dataset.ouvert = 'false';
    bouton.setAttribute('aria-expanded', 'false');
    if (voile) { voile.remove(); voile = null; }
  };
  const ouvrir = () => {
    menu.dataset.ouvert = 'true';
    bouton.setAttribute('aria-expanded', 'true');
    voile = el('div', { classe: 'admin-voile', onclick: fermer });
    document.body.append(voile);
    const actif = menu.querySelector('[aria-current="page"]') || menu.querySelector('a');
    if (actif) actif.focus();
  };
  bouton.replaceChildren(icone('M4 7h16M4 12h16M4 17h16'), el('span', { texte: 'Menu' }));
  bouton.addEventListener('click', () => (menu.dataset.ouvert === 'true' ? fermer() : ouvrir()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.dataset.ouvert === 'true') { fermer(); bouton.focus(); } });
}

// Pastille de compteur sur un lien du menu (ex. courses à attribuer)
export function compteurMenu(codeModule, nombre) {
  const lien = document.querySelector(`.admin-lien[data-module="${codeModule}"]`);
  if (!lien) return;
  let pastille = lien.querySelector('.admin-pastille-compte');
  if (!nombre) { if (pastille) pastille.remove(); return; }
  if (!pastille) { pastille = el('span', { classe: 'admin-pastille-compte' }); lien.append(pastille); }
  pastille.textContent = String(nombre);
  pastille.setAttribute('aria-label', `${nombre} en attente`);
}
