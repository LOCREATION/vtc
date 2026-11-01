// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : marketing — notifications groupées
// -----------------------------------------------------------------------------
// Un message envoyé d'un coup dans l'application à tous les clients, à tous
// les chauffeurs, ou à tous (comptes actifs ; chauffeurs validés) :
//   - brouillon (titre, message, destinataires), modifiable jusqu'à l'envoi ;
//     le nombre de destinataires est affiché avant d'envoyer ;
//   - envoi : une notification par personne ; ensuite la campagne ne se
//     modifie plus ; nombre de lectures suivi ;
//   - l'e-mail et WhatsApp attendent un service d'envoi : seul le canal
//     « application » est proposé.
// Lectures et actions : admin_lister_campagnes, admin_enregistrer_campagne,
// admin_envoyer_campagne ; suppression directe d'un brouillon.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { tableau, badge, boutonAction, fenetreFormulaire, confirmer, messageErreurAdmin, jourHeure, pluriel } from '../commun/composants.js';

const $ = (id) => document.getElementById(id);
const CIBLES = { clients: 'Tous les clients', chauffeurs: 'Tous les chauffeurs', tous: 'Clients et chauffeurs' };
const etat = { cibles: { tous: 0, clients: 0, chauffeurs: 0 } };

export function afficherCampagnes() {
  const nouvelle = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Nouvelle notification groupée' });
  nouvelle.addEventListener('click', () => formulaire(null));
  $('entete-actions').replaceChildren(nouvelle);
  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-campagnes' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-campagnes', texte: 'Notifications groupées' })),
      el('p', { classe: 'aide-module', texte: 'Un message envoyé d\'un coup dans l\'application : nouveau service, horaires des fêtes, offre du moment. Rédigez un brouillon, vérifiez le nombre de destinataires, puis envoyez : une notification envoyée ne se modifie plus. L\'envoi par e-mail ou WhatsApp sera possible une fois un service d\'envoi relié.' }),
      el('p', { classe: 'resume-liste', id: 'destinataires-campagnes', 'aria-live': 'polite' }),
      el('div', { id: 'liste-campagnes' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  charger();
}

async function charger() {
  const zone = $('liste-campagnes');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_campagnes');
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.cibles = data.cibles;
  $('destinataires-campagnes').textContent = `Destinataires possibles aujourd'hui : ${pluriel(data.cibles.clients, 'client', 'clients')}, ${pluriel(data.cibles.chauffeurs, 'chauffeur', 'chauffeurs')}.`;
  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Notification', valeur: (c) => el('span', {}, el('strong', { texte: c.titre }), el('span', { classe: 'secondaire campagne-texte', texte: c.message })) },
      { titre: 'Pour', valeur: (c) => CIBLES[c.cible] || c.cible },
      { titre: 'État', valeur: (c) => (c.envoyee_le
        ? el('span', {}, badge('Envoyée', 'vert'), el('span', { classe: 'secondaire', texte: `le ${jourHeure(c.envoyee_le)}${c.envoyee_par_nom ? ` par ${c.envoyee_par_nom}` : ''}` }))
        : el('span', {}, badge('Brouillon', 'or'), el('span', { classe: 'secondaire', texte: `${pluriel(etat.cibles[c.cible] || 0, 'destinataire', 'destinataires')} aujourd'hui` }))) },
      { titre: 'Lue', valeur: (c) => (c.envoyee_le
        ? `${c.lus} / ${c.nb_destinataires}${c.nb_destinataires ? ` (${Math.round((100 * c.lus) / c.nb_destinataires)} %)` : ''}` : '') },
      { titre: 'Actions', valeur: (c) => (c.envoyee_le ? '' : el('div', { classe: 'actions-ligne' },
        boutonAction('Envoyer', () => envoyer(c), 'bouton-principal'),
        boutonAction('Modifier', () => formulaire(c)),
        boutonAction('Supprimer', () => supprimer(c), 'bouton-texte'))) }
    ],
    lignes: data.lignes,
    vide: 'Aucune notification groupée pour l\'instant.'
  }));
}

async function formulaire(c) {
  const fait = await fenetreFormulaire({
    titre: c ? 'Modifier le brouillon' : 'Nouvelle notification groupée',
    intro: 'Enregistrée comme brouillon : rien n\'est envoyé tant que vous ne cliquez pas sur « Envoyer ».',
    champs: [
      { nom: 'titre', libelle: 'Titre', type: 'texte', requis: true, longueur: 120, plein: true, placeholder: 'Horaires des fêtes' },
      { nom: 'message', libelle: 'Message', type: 'zone', requis: true, longueur: 1000, plein: true },
      { nom: 'cible', libelle: 'Destinataires', type: 'choix', requis: true,
        options: Object.entries(CIBLES).map(([valeur, libelle]) => ({ valeur, libelle: `${libelle} (${etat.cibles[valeur] || 0})` })) },
      { nom: 'canal', libelle: 'Canal', type: 'choix', requis: true, options: [{ valeur: 'application', libelle: 'Notification dans l\'application' }] }
    ],
    valeurs: c ? { titre: c.titre, message: c.message, cible: c.cible, canal: c.canal } : { cible: 'clients', canal: 'application' },
    libelle: 'Enregistrer le brouillon',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_enregistrer_campagne', {
        p_campagne: c ? c.id : null, p_titre: v.titre, p_message: v.message, p_cible: v.cible, p_canal: v.canal
      });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Brouillon enregistré.', 'succes'); await charger(); }
}

async function envoyer(c) {
  const n = etat.cibles[c.cible] || 0;
  const r = await confirmer({
    titre: `Envoyer « ${c.titre} » ?`,
    texte: `${pluriel(n, 'personne la recevra', 'personnes la recevront')} dans l'application (${(CIBLES[c.cible] || c.cible).toLowerCase()}). Une notification envoyée ne se modifie plus.`,
    libelle: 'Envoyer maintenant'
  });
  if (!r) return;
  const { data, error } = await supabase.rpc('admin_envoyer_campagne', { p_campagne: c.id });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(`Notification envoyée à ${pluriel(data.destinataires, 'personne', 'personnes')}.`, 'succes');
  await charger();
}

async function supprimer(c) {
  const r = await confirmer({ titre: `Supprimer le brouillon « ${c.titre} » ?`, texte: 'Il n\'a pas été envoyé.', libelle: 'Supprimer', danger: true });
  if (!r) return;
  const { error } = await supabase.from('campagnes').delete().eq('id', c.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Brouillon supprimé.', 'succes');
  await charger();
}
