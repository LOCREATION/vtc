// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : mentions de la feuille de route
// -----------------------------------------------------------------------------
// Justificatif de la réservation préalable, à présenter en cas de contrôle :
// coordonnées de l'entreprise (raison sociale, SIREN, adresse, n°
// d'inscription au registre des exploitants VTC), identité et téléphone du
// client, date et heure de la réservation, date, heure et lieu de prise en
// charge ; s'y ajoutent la destination, le véhicule et le chauffeur.
// Une seule source pour l'écran de course (course/) et le document PDF
// (document/) : les deux disent toujours la même chose.
// =============================================================================
import { dateHeure, telephoneLisible } from '../../commun/outils.js';

function quand(instant) {
  return dateHeure(instant, { dateStyle: 'long', timeStyle: 'short' });
}

// Numéro lisible (« +33 6 12 34 56 78 », « +229 97 00 00 00 ») : commun/outils.js
export { telephoneLisible };

// L'exploitant (sur le document PDF, ces mentions sont dans l'en-tête)
export function mentionsExploitant(societe) {
  const s = societe || {};
  return [
    ['Exploitant', [s.raison_sociale, s.siren ? `SIREN ${s.siren}` : null].filter(Boolean).join(', ')],
    ['Adresse', [s.adresse, [s.code_postal, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ')],
    ['Registre VTC', s.registre_vtc_numero ? `n° ${s.registre_vtc_numero}` : 'Non renseigné : à saisir par LOC RÉACTION']
  ];
}

// La course : client (ou passager, pour un proche), réservation, prise en
// charge, destination, véhicule, chauffeur. « chauffeur » : nom complet et
// carte VTC, quand on les a (document PDF) ; sinon le prénom de la course.
export function mentionsCourse(course, { arrets = [], chauffeur = null } = {}) {
  const c = course;
  const lignes = [['Course', c.numero]];
  if (c.pour_proche) {
    lignes.push(['Passager', [c.beneficiaire_nom, telephoneLisible(c.beneficiaire_telephone)].filter(Boolean).join(', ')]);
    lignes.push(['Commandée par', [c.client_prenom, telephoneLisible(c.client_telephone)].filter(Boolean).join(', ')]);
  } else {
    lignes.push(['Client', [c.client_prenom, telephoneLisible(c.client_telephone)].filter(Boolean).join(', ')]);
  }
  lignes.push(['Réservée le', quand(c.cree_le)]);
  lignes.push(['Prise en charge', `${quand(c.prise_en_charge_le)}, ${c.depart_adresse}${c.depart_precision ? ` (${c.depart_precision})` : ''}`]);
  arrets.forEach((a, i) => lignes.push([arrets.length > 1 ? `Arrêt ${i + 1}` : 'Arrêt', a.adresse]));
  lignes.push(['Destination', c.arrivee_adresse]);
  lignes.push(['Véhicule', [c.vehicule_libelle, c.vehicule_immatriculation].filter(Boolean).join(', ')]);
  lignes.push(['Chauffeur', chauffeur || c.chauffeur_prenom || '']);
  return lignes;
}

// Toutes les mentions, pour l'écran de course
export function lignesFeuilleDeRoute(course, societe, options = {}) {
  return [...mentionsExploitant(societe), ...mentionsCourse(course, options)];
}
