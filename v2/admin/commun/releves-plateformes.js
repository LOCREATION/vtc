// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : relevés des plateformes (commun)
// -----------------------------------------------------------------------------
// Noms des plateformes et colonnes de l'export CSV des relevés, partagés par
// le module Plateformes (export de la liste) et le module Finances (fichier 7
// du dossier pour l'expert-comptable).
// =============================================================================
import { nombreCsv, dateCourte, jourHeure } from './composants.js';

export const PLATEFORMES = { bolt: 'Bolt', uber: 'Uber', heetch: 'Heetch', autre: 'Autre plateforme' };

export const COLONNES_RELEVES = [
  { titre: 'Plateforme', csv: (r) => PLATEFORMES[r.plateforme] || r.plateforme },
  { titre: 'Chauffeur', csv: (r) => r.chauffeur_nom },
  { titre: 'Du', csv: (r) => dateCourte(r.debut) },
  { titre: 'Au', csv: (r) => dateCourte(r.fin) },
  { titre: 'Courses', csv: (r) => r.nb_courses ?? '' },
  { titre: 'Trajets TTC', csv: (r) => nombreCsv(r.montant_trajets) },
  { titre: 'Frais de service', csv: (r) => nombreCsv(r.frais_service) },
  { titre: 'Taux des frais (%)', csv: (r) => nombreCsv(r.taux_frais) },
  { titre: 'Pourboires', csv: (r) => nombreCsv(r.pourboires) },
  { titre: 'Ajustements', csv: (r) => nombreCsv(r.ajustements) },
  { titre: 'Net', csv: (r) => nombreCsv(r.montant_net) },
  { titre: 'Espèces collectées', csv: (r) => nombreCsv(r.especes) },
  { titre: 'Montant viré', csv: (r) => nombreCsv(r.virement) },
  { titre: 'Référence', csv: (r) => r.reference || '' },
  { titre: 'Note', csv: (r) => r.note || '' },
  { titre: 'PDF joint', csv: (r) => (r.fichier_chemin ? 'oui' : 'non') },
  { titre: 'Saisi par', csv: (r) => r.cree_par_nom || '' },
  { titre: 'Saisi le', csv: (r) => jourHeure(r.cree_le) }
];

// Ordre chronologique (date de fin, puis chauffeur) pour la comptabilité
export function relevesChronologiques(lignes) {
  return [...lignes].sort((a, b) => (a.fin + a.chauffeur_nom + a.plateforme).localeCompare(b.fin + b.chauffeur_nom + b.plateforme));
}
