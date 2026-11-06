// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : la cloche et le panneau des notifications
// -----------------------------------------------------------------------------
// - Cloche dans la barre du haut, avec le nombre de notifications non lues
//   (temps réel, relecture de secours toutes les 30 secondes).
// - Panneau (sur téléphone : monte du bas) : les 100 dernières, les non lues
//   marquées d'un point doré. Toucher une notification la marque « lue » et
//   ouvre ce dont elle parle : la course, l'onglet Compte à « Mes documents »,
//   l'onglet Revenus, l'accueil, une demande au support…
// - « Tout marquer comme lu » ; « Effacer les lues » (les non lues restent).
// - Le panneau s'ouvre dans la page de l'espace chauffeur : le service
//   continue (position, demandes) ; une demande qui arrive ferme le panneau
//   (chauffeur.js).
// =============================================================================
import { el, afficherMessage, dateHeure } from '../../commun/outils.js';
import { messageErreur } from '../../commun/supabase.js';
import {
  MAXIMUM_NOTIFICATIONS, lireNotifications, marquerLue, toutMarquerLu, effacerLues, adresseDuLien, surveillerNonLues
} from '../../commun/notifications.js';

const TYPES = { course: 'Course', paiement: 'Paiement', document: 'Document', alerte: 'Alerte', info: 'Information' };

// cloche : bouton de la barre du haut ; pastille : son nombre de non lues ;
// moi : identifiant du chauffeur ; contexte : ouvrirOnglet(code) de chauffeur.js
export function installerNotifications({ cloche, pastille, moi, contexte }) {
  const etat = { notifications: [], chargement: false, chargerEncore: false };

  // ---------------------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------------------
  const liste = el('ol', { classe: 'notifs-liste', id: 'notifs-liste', 'aria-labelledby': 'notifs-titre' });
  const vide = el('p', { classe: 'notifs-vide', id: 'notifs-vide', hidden: true, texte: 'Aucune notification pour le moment.' });
  const erreur = el('p', { classe: 'alerte', id: 'notifs-erreur', role: 'alert', hidden: true });
  const toutLu = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'notifs-tout-lu', texte: 'Tout marquer comme lu' });
  const effacer = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'notifs-effacer', texte: 'Effacer les lues' });
  const fermer = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'notifs-fermer', texte: 'Fermer' });
  const panneau = el('dialog', { classe: 'notifs', id: 'notifs', 'aria-labelledby': 'notifs-titre' },
    el('header', { classe: 'notifs-entete' }, el('h2', { id: 'notifs-titre', texte: 'Notifications' }), fermer),
    el('div', { classe: 'notifs-actions', id: 'notifs-actions' }, toutLu, effacer),
    el('div', { classe: 'notifs-corps' }, erreur, vide, liste));
  document.body.append(panneau);

  fermer.addEventListener('click', () => panneau.close());
  // Toucher le fond sombre autour du panneau le ferme aussi
  panneau.addEventListener('click', (e) => { if (e.target === panneau) panneau.close(); });
  cloche.addEventListener('click', ouvrir);

  toutLu.addEventListener('click', () => agir(toutLu, () => toutMarquerLu(moi), 'Toutes les notifications sont marquées comme lues.'));
  effacer.addEventListener('click', () => agir(effacer, () => effacerLues(moi), 'Notifications lues effacées.'));

  // ---------------------------------------------------------------------------
  // Nombre de non lues sur la cloche
  // ---------------------------------------------------------------------------
  const surveillance = surveillerNonLues(moi, (n) => {
    pastille.hidden = n === 0;
    pastille.textContent = n >= MAXIMUM_NOTIFICATIONS ? `${MAXIMUM_NOTIFICATIONS - 1}+` : String(n);
    cloche.setAttribute('aria-label', n === 0 ? 'Notifications' : `Notifications, ${n} non lue${n > 1 ? 's' : ''}`);
    // Panneau ouvert : la liste suit (nouvelle notification arrivée)
    if (panneau.open) charger();
  });

  async function ouvrir() {
    if (!panneau.open) panneau.showModal();
    await charger();
  }

  // Une seule lecture à la fois ; une demande pendant une lecture en relance
  // une juste après (la liste montre toujours le dernier état de la base)
  async function charger() {
    if (etat.chargement) {
      etat.chargerEncore = true;
      return;
    }
    etat.chargement = true;
    try {
      etat.notifications = await lireNotifications(moi);
      erreur.hidden = true;
      afficher();
    } catch (e) {
      erreur.textContent = messageErreur(e);
      erreur.hidden = false;
    } finally {
      etat.chargement = false;
    }
    if (etat.chargerEncore) {
      etat.chargerEncore = false;
      await charger();
    }
  }

  function afficher() {
    const n = etat.notifications;
    vide.hidden = n.length > 0;
    toutLu.disabled = !n.some((x) => !x.lu_le);
    effacer.disabled = !n.some((x) => x.lu_le);
    liste.replaceChildren(...n.map(element));
  }

  function element(n) {
    const bouton = el('button', { type: 'button', classe: 'notif', dataset: { lue: n.lu_le ? 'oui' : 'non', type: n.type } },
      n.lu_le ? null : el('span', { classe: 'visuellement-cache', texte: 'Non lue. ' }),
      el('span', { classe: 'notif-entete' },
        el('span', { classe: 'notif-type', texte: TYPES[n.type] || TYPES.info }),
        el('span', { classe: 'notif-date', texte: quand(n.cree_le) })),
      el('span', { classe: 'notif-titre', texte: typographie(n.titre) }),
      n.message ? el('span', { classe: 'notif-texte', texte: typographie(n.message) }) : null);
    bouton.addEventListener('click', () => ouvrirNotification(n));
    return el('li', {}, bouton);
  }

  // Toucher une notification : « lue », puis ce dont elle parle
  async function ouvrirNotification(n) {
    if (!n.lu_le) {
      try {
        await marquerLue(moi, n.id);
        n.lu_le = new Date().toISOString();
        surveillance.relire();
      } catch (e) {
        afficherMessage(messageErreur(e), 'erreur');
        return;
      }
    }
    if (!n.lien) {
      afficher();
      return;
    }
    panneau.close();
    await suivreLien(n.lien);
  }

  // Liens de l'espace chauffeur ouverts sans quitter la page (le service
  // continue) ; les autres (une course…) ouvrent leur page
  async function suivreLien(lien) {
    const chemin = lien.split(/[?#]/)[0];
    if (chemin === '/chauffeur/' || chemin === '/chauffeur') {
      await contexte.ouvrirOnglet('accueil');
      return;
    }
    if (chemin === '/chauffeur/revenus/') {
      await contexte.ouvrirOnglet('revenus');
      return;
    }
    if (chemin === '/chauffeur/documents/') {
      await contexte.ouvrirOnglet('compte');
      const section = document.getElementById('compte-documents');
      if (section) section.scrollIntoView({ block: 'start' });
      return;
    }
    if (chemin === '/chauffeur/demandes/') {
      const demande = new URLSearchParams(lien.split('?')[1] || '').get('id');
      await contexte.ouvrirSupport(demande ? { demande } : {});
      return;
    }
    const adresse = adresseDuLien(lien);
    if (adresse) location.href = adresse;
  }

  async function agir(bouton, action, confirmation) {
    bouton.disabled = true;
    try {
      await action();
      // La liste à jour d'abord, la confirmation ensuite
      etat.notifications = await lireNotifications(moi);
      afficher();
      surveillance.relire();
      afficherMessage(confirmation, 'succes');
    } catch (e) {
      afficherMessage(messageErreur(e), 'erreur');
      afficher();
    }
  }

  return {
    fermer() { if (panneau.open) panneau.close(); },
    relire: () => surveillance.relire()
  };
}

// Espaces insécables du français : « Merci ! » ne laisse jamais le « ! »
// seul en début de ligne (de même pour ? ; : » et après «)
function typographie(texte) {
  return String(texte || '').replace(/ ([!?;:»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
}

// « Aujourd'hui, 13:20 », « Hier, 18:02 », « 3 nov., 09:14 »
function quand(instant) {
  const jour = (d) => dateHeure(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const heure = dateHeure(instant, { hour: '2-digit', minute: '2-digit' });
  const aujourdhui = new Date();
  if (jour(instant) === jour(aujourdhui)) return `Aujourd'hui, ${heure}`;
  if (jour(instant) === jour(new Date(aujourdhui.getTime() - 86400000))) return `Hier, ${heure}`;
  const memeAnnee = dateHeure(instant, { year: 'numeric' }) === dateHeure(aujourdhui, { year: 'numeric' });
  return dateHeure(instant, memeAnnee
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
