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

// ---------------------------------------------------------------------------
// Documents du chauffeur (onglet Compte)
// ---------------------------------------------------------------------------
// Pièces que le chauffeur dépose lui-même ; les pièces du véhicule
// (assurance, carte grise, contrôle technique, vignette) sont déposées par
// l'administration dans le module Flotte.
export const TYPES_DOCUMENT_CHAUFFEUR = {
  permis: 'Permis de conduire', carte_vtc: 'Carte professionnelle VTC', piece_identite: 'Pièce d\'identité',
  justificatif_domicile: 'Justificatif de domicile', registre_vtc: 'Attestation d\'inscription au registre VTC',
  autre: 'Autre document'
};
// Pièces dont la date de fin de validité est demandée (reportée sur la fiche
// à la validation pour le permis et la carte VTC)
export const DOCUMENTS_A_ECHEANCE = ['permis', 'carte_vtc', 'piece_identite'];
export const STATUTS_DOCUMENT = { en_attente: 'En cours de vérification', valide: 'Validé', refuse: 'Refusé' };

// ---------------------------------------------------------------------------
// Paie et absences (salarié)
// ---------------------------------------------------------------------------
export const STATUTS_BULLETIN = { valide: 'Disponible', envoye: 'Remis' };
export const TYPES_CONTRAT = { CDI: 'CDI', CDD: 'CDD', apprentissage: 'Contrat d\'apprentissage', avenant: 'Avenant' };
export const STATUTS_CONTRAT = { envoye: 'À signer', signe: 'Signé', termine: 'Terminé' };
export const TYPES_ABSENCE = {
  conges_payes: 'Congés payés', maladie: 'Maladie', accident_travail: 'Accident du travail',
  sans_solde: 'Congé sans solde', autre: 'Autre absence'
};
// Ce que le salarié peut demander lui-même (un arrêt maladie se transmet à
// l'administration avec l'avis d'arrêt)
export const ABSENCES_DEMANDABLES = ['conges_payes', 'sans_solde', 'autre'];
export const STATUTS_ABSENCE = { demandee: 'En attente de réponse', validee: 'Acceptée', refusee: 'Refusée' };
