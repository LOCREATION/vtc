// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client, onglet Compte : section « Notifications »
// -----------------------------------------------------------------------------
// Par où LOC RÉACTION prévient le client, en plus de la cloche de
// l'application (qui garde toujours tout l'historique) :
//   - par e-mail (réservation, facture, réponses du support) ;
//   - par WhatsApp (réservation, chauffeur en route et arrivé), sur le numéro
//     du profil ;
//   - par les notifications de l'application installée sur un téléphone
//     (chauffeur en route, arrivé, messages).
// Chaque interrupteur s'enregistre aussitôt dans le profil (colonnes
// notif_email, notif_whatsapp, notif_push, modifiables par le client) ; en
// cas d'échec, il revient à sa position et le message dit pourquoi. Les
// services d'envoi (e-mail, WhatsApp, notifications) lisent ces choix avant
// chaque envoi.
// Ancre : #compte-notifications.
// =============================================================================
import { supabase, messageErreur } from '../../commun/supabase.js';
import { t, langueActive } from '../../commun/i18n.js';
import { el, afficherMessage, telephoneLisible } from '../../commun/outils.js';

const $ = (id) => document.getElementById(id);
// Colonne du profil → identifiant de l'interrupteur, textes
const CANAUX = [
  { colonne: 'notif_email', id: 'compte-notif-email', titre: 'notifs_pref.email' },
  { colonne: 'notif_whatsapp', id: 'compte-notif-whatsapp', titre: 'notifs_pref.whatsapp' },
  { colonne: 'notif_push', id: 'compte-notif-push', titre: 'notifs_pref.push' }
];

export function creerSectionPreferences({ contexte }) {
  const etat = { profil: null };

  const section = el('section', { classe: 'bloc-client', id: 'compte-notifications', 'aria-labelledby': 'compte-titre-notifications' },
    el('h2', { id: 'compte-titre-notifications', texte: t('notifs_pref.titre') }),
    el('p', { classe: 'aide-client', texte: t('notifs_pref.aide') }),
    el('ul', { classe: 'preferences-client' }, ...CANAUX.map((canal) => el('li', { classe: 'preference-client' },
      el('label', { classe: 'interrupteur', for: canal.id },
        el('span', { classe: 'interrupteur-texte' },
          el('span', { classe: 'interrupteur-titre', texte: t(canal.titre) }),
          el('span', { classe: 'interrupteur-detail', id: `${canal.id}-detail` })),
        el('input', { type: 'checkbox', role: 'switch', id: canal.id, classe: 'interrupteur-case',
          'aria-describedby': `${canal.id}-detail`, onchange: (e) => enregistrer(canal, e.target) }),
        el('span', { classe: 'interrupteur-glissiere', 'aria-hidden': 'true' }))))));

  async function charger() {
    const { data, error } = await supabase.from('profils')
      .select('email, telephone, notif_email, notif_whatsapp, notif_push').eq('id', contexte.profil.id).maybeSingle();
    if (error) throw error;
    etat.profil = data || {};
    afficher();
  }

  function afficher() {
    const p = etat.profil;
    CANAUX.forEach((canal) => { $(canal.id).checked = p[canal.colonne] !== false; });
    $('compte-notif-email-detail').textContent = t('notifs_pref.email_detail', { email: p.email || t('compte.non_renseigne') });
    $('compte-notif-whatsapp-detail').textContent = p.telephone
      ? t('notifs_pref.whatsapp_detail', { telephone: telephoneLisible(p.telephone) })
      : t('notifs_pref.whatsapp_sans_numero');
    $('compte-notif-push-detail').textContent = t('notifs_pref.push_detail');
  }

  // Enregistré aussitôt ; l'interrupteur revient en arrière si la base refuse
  async function enregistrer(canal, caseACocher) {
    const valeur = caseACocher.checked;
    caseACocher.disabled = true;
    const { error } = await supabase.from('profils').update({ [canal.colonne]: valeur }).eq('id', contexte.profil.id);
    caseACocher.disabled = false;
    if (error) {
      caseACocher.checked = !valeur;
      afficherMessage(messageErreur(error, langueActive()), 'erreur');
      return;
    }
    etat.profil[canal.colonne] = valeur;
    afficherMessage(t('notifs_pref.enregistre'), 'succes');
  }

  return { section, charger };
}
