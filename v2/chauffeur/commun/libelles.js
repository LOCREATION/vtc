// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : libellés et calculs partagés par les onglets et les
// documents (statuts, modes de paiement, majorations)
// =============================================================================

export const STATUTS_COURSE = {
  planifiee: 'Réservation', recherche: 'Recherche d\'un chauffeur', a_attribuer: 'À attribuer',
  acceptee: 'Acceptée', arrivee: 'Chauffeur arrivé', en_cours: 'Client à bord',
  terminee: 'Terminée', annulee: 'Annulée'
};

export const TYPES_COURSE = { immediate: 'Immédiate', planifiee: 'Réservation', mise_a_disposition: 'Mise à disposition' };

export const MODES_PAIEMENT = {
  especes: 'Espèces', carte: 'Carte bancaire, au terminal',
  facture_mensuelle: 'Facture mensuelle du compte professionnel', solde: 'Solde du client'
};

export const STATUTS_PAIEMENT = {
  a_encaisser: 'À encaisser', encaisse: 'Encaissé', echoue: 'Impayé', rembourse: 'Remboursé', annule: 'Annulé'
};

export const ANNULEE_PAR = {
  client: 'par le client', chauffeur: 'par vous', admin: 'par LOC RÉACTION', systeme: 'automatiquement'
};

export const MAJORATIONS = { nuit: 'de nuit', dimanche: 'du dimanche', ferie: 'de jour férié' };

// Arrondi au centime (le petit décalage évite 1,005 → 1,00)
export function arrondi(montant) {
  return Math.round(((Number(montant) || 0) + Number.EPSILON) * 100) / 100;
}

// Part de la majoration dans le prix d'une course, calculée comme la base :
// prix de base × (1 + pourcentage), arrondi au centime ; jamais sur un forfait
export function majorationDe(course) {
  const pourcentage = Number(course.majoration_pourcentage) || 0;
  if (!pourcentage || course.forfait_id) return 0;
  const base = Number(course.prix_base) || 0;
  return arrondi(arrondi(base * (1 + pourcentage / 100)) - base);
}

// Chiffre d'affaires d'une course terminée : prix fixe + attente facturée
// (comme « Chiffre du jour » sur l'accueil)
export function chiffreCourse(course) {
  return arrondi((Number(course.prix_total) || 0) + (Number(course.frais_attente) || 0));
}
