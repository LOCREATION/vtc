// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Conversation d'une course entre le client et le chauffeur
// -----------------------------------------------------------------------------
// Utilisée par le suivi du client (client/course/) et par la course du
// chauffeur (chauffeur/course/) :
//   - bouton « Messages » avec le nombre de messages non lus ;
//   - fenêtre de conversation (sur téléphone : panneau qui monte du bas) :
//     messages du plus ancien au plus récent, heure, « Lu » sous ses propres
//     messages lus, messages de LOC RÉACTION signalés ;
//   - réponses rapides selon le rôle (« J'arrive dans 5 minutes »…) et message
//     libre (2 000 caractères au plus) ;
//   - un message reçu pendant que la fenêtre est fermée : nombre de non lus,
//     vibration du téléphone et message bref ; fenêtre ouverte : les messages
//     reçus sont marqués « lus ».
// La base n'accepte un message que pendant la course (acceptée, chauffeur
// arrivé, client à bord) et 24 heures après sa fin (migration 21) : ensuite
// la conversation se lit, et la page invite à passer par le support.
// Nouveaux messages : temps réel de Supabase, et relecture de secours toutes
// les 10 secondes (réseau mobile instable) tant que la conversation est
// ouverte ; une fois fermée, le temps réel seul suffit (message de LOC
// RÉACTION), sans interroger la base toutes les 10 secondes pour rien.
// =============================================================================
import { supabase, messageErreur } from './supabase.js';
import { el, afficherMessage, dateHeure } from './outils.js';
import { t, langueActive } from './i18n.js';

const STATUTS_OUVERTS = ['acceptee', 'arrivee', 'en_cours'];
const DUREE_APRES_FIN_MS = 24 * 3600 * 1000;
const RELECTURE_MS = 10000;
const RACCOURCIS = {
  chauffeur: ['discussion.r_chauffeur_1', 'discussion.r_chauffeur_2', 'discussion.r_chauffeur_3', 'discussion.r_chauffeur_4'],
  client: ['discussion.r_client_1', 'discussion.r_client_2', 'discussion.r_client_3', 'discussion.r_client_4']
};

// La conversation accepte-t-elle encore un message ?
export function discussionOuverte(course) {
  if (!course) return false;
  if (STATUTS_OUVERTS.includes(course.statut)) return true;
  return course.statut === 'terminee' && !!course.terminee_le
    && Date.now() - new Date(course.terminee_le).getTime() < DUREE_APRES_FIN_MS;
}

// role : 'client' ou 'chauffeur' ; moi : identifiant du compte connecté ;
// place : élément où mettre le bouton « Messages » ; avant : bouton de
// « place » devant lequel le mettre (facultatif, sinon à la fin) ;
// interlocuteur : (course) => prénom de l'autre personne
export function creerDiscussion({ role, moi, place, avant = null, interlocuteur }) {
  const etat = { course: null, messages: [], canal: null, minuteur: null, nonLus: 0, dejaVus: new Set(), premiere: true, envoi: false,
                 lecture: false, relireEncore: false };

  // ---------------------------------------------------------------------------
  // Bouton et fenêtre
  // ---------------------------------------------------------------------------
  const pastille = el('span', { classe: 'discussion-pastille', id: 'discussion-non-lus', hidden: true });
  const bouton = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-discussion', id: 'ouvrir-discussion', hidden: true },
    el('span', { texte: t('discussion.ouvrir') }), pastille);
  bouton.addEventListener('click', ouvrir);
  if (avant) place.insertBefore(bouton, avant);
  else place.append(bouton);

  const titre = el('h2', { id: 'discussion-titre', texte: t('discussion.ouvrir') });
  const fil = el('ol', { classe: 'discussion-fil', id: 'discussion-fil', role: 'log', 'aria-live': 'polite', 'aria-labelledby': 'discussion-titre' });
  const vide = el('p', { classe: 'discussion-vide', id: 'discussion-vide', texte: t('discussion.vide') });
  const raccourcis = el('div', { classe: 'discussion-raccourcis', id: 'discussion-raccourcis' },
    ...RACCOURCIS[role].map((cle) => {
      const b = el('button', { type: 'button', classe: 'discussion-raccourci', texte: t(cle) });
      b.addEventListener('click', () => envoyer(t(cle)));
      return b;
    }));
  const saisie = el('textarea', { id: 'discussion-texte', classe: 'saisie', rows: '1', maxlength: '2000', 'aria-label': t('discussion.votre_message'),
                                  placeholder: t('discussion.votre_message'), enterkeyhint: 'send' });
  const envoyerBouton = el('button', { type: 'submit', classe: 'bouton bouton-principal', id: 'discussion-envoyer', texte: t('discussion.envoyer') });
  const formulaire = el('form', { classe: 'discussion-saisie', id: 'discussion-formulaire', novalidate: true }, saisie, envoyerBouton);
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); envoyer(saisie.value); });
  // Touche « Envoyer » du clavier du téléphone (Entrée) : envoie au lieu d'aller à la ligne
  saisie.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); envoyer(saisie.value); }
  });
  // Le champ grandit avec le texte (4 lignes au plus)
  saisie.addEventListener('input', () => {
    saisie.style.height = 'auto';
    saisie.style.height = `${Math.min(saisie.scrollHeight, 120)}px`;
  });
  const fermee = el('p', { classe: 'discussion-fermee', id: 'discussion-fermee', hidden: true, texte: t('discussion.fermee') });
  const fermerBouton = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'fermer-discussion', texte: t('discussion.fermer') });
  fermerBouton.addEventListener('click', () => fenetre.close());
  const fenetre = el('dialog', { classe: 'discussion', id: 'discussion', 'aria-labelledby': 'discussion-titre' },
    el('header', { classe: 'discussion-entete' }, titre, fermerBouton),
    el('div', { classe: 'discussion-corps' }, vide, fil),
    el('div', { classe: 'discussion-bas' }, raccourcis, formulaire, fermee));
  document.body.append(fenetre);

  function ouvrir() {
    if (!fenetre.open) fenetre.showModal();
    afficher();
    descendre();
    marquerLus();
  }

  function descendre() {
    const corps = fenetre.querySelector('.discussion-corps');
    corps.scrollTop = corps.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Lecture, affichage, lecture des messages reçus
  // ---------------------------------------------------------------------------
  // Une seule lecture à la fois (temps réel, relecture de secours et envoi
  // peuvent se croiser) ; une demande pendant une lecture en relance une après.
  async function relire() {
    if (!etat.course) return;
    if (etat.lecture) { etat.relireEncore = true; return; }
    etat.lecture = true;
    try {
      await lireUneFois();
    } finally {
      etat.lecture = false;
    }
    if (etat.relireEncore) {
      etat.relireEncore = false;
      await relire();
    }
  }

  async function lireUneFois() {
    const course = etat.course;
    const { data, error } = await supabase.from('messages').select('id, auteur_id, contenu, lu_le, cree_le')
      .eq('course_id', course.id).order('cree_le', { ascending: true }).limit(300);
    if (error || !etat.course || etat.course.id !== course.id) return;   // réseau coupé : la prochaine relecture rattrapera
    const avant = etat.messages.length;
    const nouveaux = (data || []).filter((m) => !etat.dejaVus.has(m.id) && m.auteur_id !== moi);
    etat.messages = data || [];
    etat.messages.forEach((m) => etat.dejaVus.add(m.id));
    etat.nonLus = etat.messages.filter((m) => m.auteur_id !== moi && !m.lu_le).length;
    // Message reçu fenêtre fermée (pas au premier affichage de la page) :
    // vibration et message bref, au nom de l'auteur (l'autre personne, ou LOC RÉACTION)
    if (!etat.premiere && nouveaux.length && !fenetre.open) {
      const dernier = nouveaux[nouveaux.length - 1];
      const deLEquipe = dernier.auteur_id !== course.client_id && dernier.auteur_id !== course.chauffeur_id;
      const prenom = deLEquipe ? t('discussion.equipe') : (interlocuteur(course) || t('discussion.equipe'));
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
      afficherMessage(t('discussion.nouveau', { prenom }), 'info');
    }
    etat.premiere = false;
    afficher();
    ajusterRelecture();
    if (fenetre.open) {
      if (etat.messages.length > avant) descendre();
      marquerLus();
    }
  }

  async function marquerLus() {
    const aLire = etat.messages.filter((m) => m.auteur_id !== moi && !m.lu_le).map((m) => m.id);
    if (!aLire.length) return;
    const maintenant = new Date().toISOString();
    const { error } = await supabase.from('messages').update({ lu_le: maintenant }).in('id', aLire);
    if (error) return;
    etat.messages.forEach((m) => { if (aLire.includes(m.id)) m.lu_le = maintenant; });
    etat.nonLus = 0;
    afficherBouton();
  }

  function heure(instant) {
    const jour = (d) => dateHeure(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
    return jour(instant) === jour(new Date())
      ? dateHeure(instant, { hour: '2-digit', minute: '2-digit' })
      : dateHeure(instant, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function afficherBouton() {
    const c = etat.course;
    const visible = !!c && !!c.chauffeur_id && (discussionOuverte(c) || etat.messages.length > 0);
    bouton.hidden = !visible;
    pastille.hidden = !etat.nonLus;
    pastille.textContent = etat.nonLus > 9 ? '9+' : String(etat.nonLus);
    bouton.setAttribute('aria-label', etat.nonLus
      ? `${t('discussion.ouvrir')}, ${t(etat.nonLus > 1 ? 'discussion.non_lus' : 'discussion.non_lu', { n: etat.nonLus })}`
      : t('discussion.ouvrir'));
  }

  function afficher() {
    afficherBouton();
    const c = etat.course;
    const prenom = c ? interlocuteur(c) : '';
    titre.textContent = prenom ? t('discussion.titre', { prenom }) : t('discussion.ouvrir');
    const ouverte = discussionOuverte(c);
    raccourcis.hidden = !ouverte;
    formulaire.hidden = !ouverte;
    fermee.hidden = ouverte;
    vide.hidden = etat.messages.length > 0;
    // Dernier de mes messages lu par l'autre : « Lu » dessous
    const miens = etat.messages.filter((m) => m.auteur_id === moi);
    const dernierLu = [...miens].reverse().find((m) => m.lu_le);
    fil.replaceChildren(...etat.messages.map((m) => {
      const auteur = m.auteur_id === moi ? 'moi' : (c && (m.auteur_id === c.client_id || m.auteur_id === c.chauffeur_id) ? 'autre' : 'equipe');
      return el('li', { classe: 'discussion-message', dataset: { auteur } },
        auteur === 'equipe' ? el('span', { classe: 'discussion-auteur', texte: t('discussion.equipe') }) : null,
        el('p', { classe: 'discussion-bulle', texte: m.contenu || '' }),
        el('span', { classe: 'discussion-heure' },
          heure(m.cree_le),
          auteur === 'moi' && dernierLu && dernierLu.id === m.id ? ` · ${t('discussion.lu')}` : ''));
    }));
  }

  // ---------------------------------------------------------------------------
  // Envoi
  // ---------------------------------------------------------------------------
  async function envoyer(texte) {
    const contenu = (texte || '').trim();
    if (!contenu || etat.envoi || !etat.course) return;
    if (contenu.length > 2000) { afficherMessage(t('discussion.trop_long'), 'erreur'); return; }
    etat.envoi = true;
    envoyerBouton.disabled = true;
    const { error } = await supabase.from('messages').insert({ course_id: etat.course.id, auteur_id: moi, contenu });
    etat.envoi = false;
    envoyerBouton.disabled = false;
    if (error) {
      // Refus de la base : conversation fermée entre-temps (course finie depuis 24 h…)
      afficherMessage(/row-level security/i.test(error.message || '') ? t('discussion.refus') : messageErreur(error, langueActive()), 'erreur');
      return;
    }
    if (contenu === saisie.value.trim()) {
      saisie.value = '';
      saisie.style.height = 'auto';
    }
    await relire();
  }

  // ---------------------------------------------------------------------------
  // Suivi de la course
  // ---------------------------------------------------------------------------
  // À appeler à chaque mise à jour de la course (statut, chauffeur)
  function majCourse(course) {
    const changement = !etat.course || etat.course.id !== course.id;
    etat.course = course;
    if (changement) demarrer();
    else {
      afficher();
      ajusterRelecture();
    }
  }

  function demarrer() {
    arreter();
    etat.messages = [];
    etat.dejaVus = new Set();
    etat.premiere = true;
    etat.canal = supabase.channel(`discussion-${etat.course.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `course_id=eq.${etat.course.id}` }, () => relire())
      .subscribe();
    relire();
  }

  // Relecture de secours toutes les 10 secondes, seulement tant que la
  // conversation est ouverte (pendant la course et 24 heures après)
  function ajusterRelecture() {
    const ouverte = discussionOuverte(etat.course);
    if (ouverte && !etat.minuteur) etat.minuteur = setInterval(relire, RELECTURE_MS);
    if (!ouverte && etat.minuteur) {
      clearInterval(etat.minuteur);
      etat.minuteur = null;
    }
  }

  function arreter() {
    clearInterval(etat.minuteur);
    etat.minuteur = null;
    if (etat.canal) supabase.removeChannel(etat.canal);
    etat.canal = null;
  }

  return { majCourse, arreter, ouvrir, relire };
}
