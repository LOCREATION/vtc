// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// La cloche et le panneau des notifications (espace chauffeur, espace client)
// -----------------------------------------------------------------------------
// - Cloche de la barre du haut, avec le nombre de notifications non lues
//   (temps réel, relecture de secours toutes les 30 secondes :
//   commun/notifications.js).
// - Panneau (sur téléphone : monte du bas) : les 100 dernières, les non lues
//   marquées d'un point doré. Toucher une notification la marque « lue » et
//   ouvre ce dont elle parle, par la fonction suivreLien(lien) de l'espace
//   (un onglet de la même page, ou une autre page).
// - « Tout marquer comme lu » ; « Effacer les lues » (les non lues restent).
// - Le panneau s'ouvre par-dessus la page : rien de ce qui tourne dans la page
//   ne s'arrête (service du chauffeur, suivi d'une course…).
// Textes en français et en anglais (commun/i18n.js) ; l'espace chauffeur
// impose le français. Couleurs claires par défaut, de nuit dans l'espace
// chauffeur (.theme-nuit, commun/panneau-notifications.css).
// =============================================================================
import { el, afficherMessage, dateHeure } from './outils.js';
import { messageErreur } from './supabase.js';
import { t, langueActive } from './i18n.js';
import {
  MAXIMUM_NOTIFICATIONS, lireNotifications, marquerLue, toutMarquerLu, effacerLues, surveillerNonLues
} from './notifications.js';

const TYPES = ['course', 'paiement', 'document', 'alerte', 'info'];

// cloche : bouton de la barre du haut ; pastille : son nombre de non lues ;
// moi : identifiant de la personne connectée ; suivreLien(lien) : ouvre ce
// dont parle une notification (appelée panneau fermé)
export function installerPanneauNotifications({ cloche, pastille, moi, suivreLien }) {
  const etat = { notifications: [], chargement: false, chargerEncore: false };
  const erreurLisible = (e) => messageErreur(e, langueActive());

  // ---------------------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------------------
  const liste = el('ol', { classe: 'notifs-liste', id: 'notifs-liste', 'aria-labelledby': 'notifs-titre' });
  const vide = el('p', { classe: 'notifs-vide', id: 'notifs-vide', hidden: true, texte: t('notifs.vide') });
  const erreur = el('p', { classe: 'alerte', id: 'notifs-erreur', role: 'alert', hidden: true });
  const toutLu = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'notifs-tout-lu', texte: t('notifs.tout_lu') });
  const effacer = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'notifs-effacer', texte: t('notifs.effacer') });
  const fermer = el('button', { type: 'button', classe: 'bouton bouton-texte', id: 'notifs-fermer', texte: t('notifs.fermer') });
  const panneau = el('dialog', { classe: 'notifs', id: 'notifs', 'aria-labelledby': 'notifs-titre' },
    el('header', { classe: 'notifs-entete' }, el('h2', { id: 'notifs-titre', texte: t('notifs.titre') }), fermer),
    el('div', { classe: 'notifs-actions', id: 'notifs-actions' }, toutLu, effacer),
    el('div', { classe: 'notifs-corps' }, erreur, vide, liste));
  document.body.append(panneau);

  fermer.addEventListener('click', () => panneau.close());
  // Toucher le fond sombre autour du panneau le ferme aussi
  panneau.addEventListener('click', (e) => { if (e.target === panneau) panneau.close(); });
  cloche.addEventListener('click', ouvrir);

  toutLu.addEventListener('click', () => agir(toutLu, () => toutMarquerLu(moi), t('notifs.tout_lu_ok')));
  effacer.addEventListener('click', () => agir(effacer, () => effacerLues(moi), t('notifs.effacer_ok')));

  // ---------------------------------------------------------------------------
  // Nombre de non lues sur la cloche
  // ---------------------------------------------------------------------------
  const surveillance = surveillerNonLues(moi, (n) => {
    pastille.hidden = n === 0;
    pastille.textContent = n >= MAXIMUM_NOTIFICATIONS ? `${MAXIMUM_NOTIFICATIONS - 1}+` : String(n);
    cloche.setAttribute('aria-label', n === 0 ? t('notifs.titre') : t(n > 1 ? 'notifs.aria_n' : 'notifs.aria_une', { n }));
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
      erreur.textContent = erreurLisible(e);
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
    const type = TYPES.includes(n.type) ? n.type : 'info';
    const bouton = el('button', { type: 'button', classe: 'notif', dataset: { lue: n.lu_le ? 'oui' : 'non', type } },
      n.lu_le ? null : el('span', { classe: 'visuellement-cache', texte: t('notifs.non_lue') }),
      el('span', { classe: 'notif-entete' },
        el('span', { classe: 'notif-type', texte: t(`notifs.type_${type}`) }),
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
        afficherMessage(erreurLisible(e), 'erreur');
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
      afficherMessage(erreurLisible(e), 'erreur');
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
  const brut = String(texte || '');
  return langueActive() === 'fr' ? brut.replace(/ ([!?;:»])/g, ' $1').replace(/« /g, '« ') : brut;
}

// « Aujourd'hui, 13:20 », « Hier, 18:02 », « 3 nov., 09:14 »
function quand(instant) {
  const jour = (d) => dateHeure(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const heure = dateHeure(instant, { hour: '2-digit', minute: '2-digit' });
  const aujourdhui = new Date();
  if (jour(instant) === jour(aujourdhui)) return t('notifs.aujourdhui', { heure });
  if (jour(instant) === jour(new Date(aujourdhui.getTime() - 86400000))) return t('notifs.hier', { heure });
  const memeAnnee = dateHeure(instant, { year: 'numeric' }) === dateHeure(aujourdhui, { year: 'numeric' });
  return dateHeure(instant, memeAnnee
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
