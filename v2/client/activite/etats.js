// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : où se range une course (en cours, à venir, historique) et
// son état en quelques mots (onglets Accueil et Activité)
// -----------------------------------------------------------------------------
// En cours : recherche d'un chauffeur, chauffeur arrivé, client à bord ; une
// course immédiate acceptée ou en attente ; une réservation acceptée ou en
// attente dont la prise en charge est dans moins d'une heure.
// À venir : les autres réservations (réservée, en attente d'un chauffeur,
// chauffeur attribué).
// Historique : terminées et annulées.
// =============================================================================
import { t } from '../../commun/i18n.js';

const BIENTOT_MS = 60 * 60 * 1000;

export function enCours(c) {
  if (['recherche', 'arrivee', 'en_cours'].includes(c.statut)) return true;
  if (!['acceptee', 'a_attribuer'].includes(c.statut)) return false;
  return c.type === 'immediate'
    || (!!c.prise_en_charge_le && new Date(c.prise_en_charge_le).getTime() - Date.now() < BIENTOT_MS);
}

export function aVenir(c) {
  return ['planifiee', 'a_attribuer', 'acceptee'].includes(c.statut) && !enCours(c);
}

export function terminee(c) {
  return ['terminee', 'annulee'].includes(c.statut);
}

// « Chauffeur en route », « Chauffeur attribué », « Terminée »…
export function etatCourse(c) {
  // Réservation acceptée : le chauffeur est attribué (il part à l'heure prévue)
  if (c.statut === 'acceptee' && c.type !== 'immediate') return t('activite.statut_acceptee_planifiee');
  return t(`activite.statut_${c.statut}`);
}
