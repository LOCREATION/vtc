// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — fichiers pour l'expert-comptable
// -----------------------------------------------------------------------------
// Colonnes des exports CSV (séparateur « ; », virgule décimale, accents
// lisibles par Excel), utilisées par chaque onglet et par le dossier complet :
//   1. registre des factures et des avoirs ;
//   2. journal des encaissements ;
//   3. remboursements ;
//   4. remises d'espèces des chauffeurs ;
//   5. TVA par mois ;
//   6. sommes encore dues (à encaisser et impayés) le jour de l'export ;
//   7. relevés des plateformes (Bolt, Uber, Heetch) de la période (colonnes
//      communes avec le module Plateformes).
// « dossierComptable » rassemble ces fichiers, avec un LISEZ-MOI, dans une
// archive ZIP préparée dans la page.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import {
  dateCourte, heure, nombreCsv, contenuCsv, MODES_PAIEMENT, NATURES_PAIEMENT, STATUTS_PAIEMENT, MODES_REMBOURSEMENT,
  ORIGINES_AVOIR, siretLisible, jourParis
} from '../commun/composants.js';
import { creerZip } from '../commun/zip.js';
import { chargerTout, nomFichier } from '../commun/listes.js';
import { periodeLisible } from '../commun/periode.js';
import { COLONNES_RELEVES, relevesChronologiques } from '../commun/releves-plateformes.js';

const jourEtHeure = (instant) => (instant ? `${dateCourte(instant)} ${heure(instant)}` : '');
const signe = (ligne, montant) => (ligne.type === 'avoir' ? -Number(montant) : Number(montant));
// Montant à deux décimales, virgule française (« 14,20 ») ; vide si absent
export const montantCsv = (x) => (x === null || x === undefined || x === '' ? '' : Number(x).toFixed(2).replace('.', ','));

// État du règlement d'une facture (registre)
export function etatFacture(f) {
  const p = f.paiement;
  const credite = Number(f.credite || 0);
  if (credite > 0 && credite >= Number(f.montant_ttc)) return 'Entièrement créditée';
  if (!p) return Number(f.montant_ttc) > 0 ? 'Sans paiement' : 'Course gratuite';
  if (p.statut === 'encaisse' && Number(p.rembourse) > 0) return `Encaissée, remboursée en partie (${montantCsv(p.rembourse)} €)`;
  return (STATUTS_PAIEMENT[p.statut] || { libelle: p.statut }).libelle;
}

// 1. Registre des factures et des avoirs (avoirs en montants négatifs)
export const COLONNES_REGISTRE = [
  { titre: 'Date', csv: (l) => dateCourte(l.date_emission) },
  { titre: 'Pièce', csv: (l) => l.numero },
  { titre: 'Type', csv: (l) => (l.type === 'avoir' ? 'Avoir' : 'Facture') },
  { titre: 'Objet', csv: (l) => (l.type === 'avoir' ? ORIGINES_AVOIR[l.detail] || l.detail : l.detail === 'course' ? 'Course' : 'Frais d\'annulation') },
  { titre: 'Facture corrigée', csv: (l) => l.facture_numero || '' },
  { titre: 'Destinataire', csv: (l) => l.destinataire_nom },
  { titre: 'SIRET du destinataire', csv: (l) => (l.compte_pro_siret ? siretLisible(l.compte_pro_siret) : '') },
  { titre: 'TVA du destinataire', csv: (l) => l.compte_pro_tva || '' },
  { titre: 'Course', csv: (l) => l.course_numero },
  { titre: 'Date de la course', csv: (l) => jourEtHeure(l.prise_en_charge_le) },
  { titre: 'Montant HT', csv: (l) => montantCsv(signe(l, l.montant_ht)) },
  { titre: 'Taux de TVA (%)', csv: (l) => nombreCsv(l.taux_tva) },
  { titre: 'TVA', csv: (l) => montantCsv(signe(l, l.montant_tva)) },
  { titre: 'Montant TTC', csv: (l) => montantCsv(signe(l, l.montant_ttc)) },
  { titre: 'Mode de règlement', csv: (l) => (l.type === 'avoir'
    ? (l.remboursement ? `Remboursement : ${(MODES_REMBOURSEMENT[l.remboursement.mode] || l.remboursement.mode).toLowerCase()}` : 'Somme annulée')
    : l.paiement ? MODES_PAIEMENT[l.paiement.mode] || l.paiement.mode : '') },
  { titre: 'État', csv: (l) => (l.type === 'avoir' ? '' : etatFacture(l)) },
  { titre: 'Encaissée le', csv: (l) => (l.type === 'facture' && l.paiement && l.paiement.encaisse_le ? dateCourte(l.paiement.encaisse_le) : '') },
  { titre: 'Motif (avoir)', csv: (l) => l.motif || '' }
];

// 2. Paiements (journal des encaissements, sommes dues, impayés, annulés)
export const COLONNES_PAIEMENTS = [
  { titre: 'Encaissé le', csv: (p) => jourEtHeure(p.encaisse_le) },
  { titre: 'Course', csv: (p) => p.course_numero },
  { titre: 'Date de la course', csv: (p) => jourEtHeure(p.prise_en_charge_le) },
  { titre: 'Nature', csv: (p) => NATURES_PAIEMENT[p.nature] || p.nature },
  { titre: 'Facture', csv: (p) => p.facture_numero || '' },
  { titre: 'Client', csv: (p) => p.client_nom },
  { titre: 'Entreprise', csv: (p) => p.compte_pro || '' },
  { titre: 'Chauffeur', csv: (p) => p.chauffeur_nom || '' },
  { titre: 'Mode', csv: (p) => MODES_PAIEMENT[p.mode] || p.mode },
  { titre: 'Montant TTC', csv: (p) => montantCsv(p.montant) },
  { titre: 'Statut', csv: (p) => (STATUTS_PAIEMENT[p.statut] || { libelle: p.statut }).libelle },
  { titre: 'Remboursé', csv: (p) => montantCsv(p.rembourse) },
  { titre: 'Annulé par avoir', csv: (p) => montantCsv(p.annule) },
  { titre: 'Encaissé par', csv: (p) => p.encaisse_par_nom || '' },
  { titre: 'Espèces gardées par', csv: (p) => (p.mode === 'especes' && p.encaisse_le ? p.especes_chez || 'Reçues au bureau' : '') },
  { titre: 'Référence', csv: (p) => p.reference_externe || '' },
  { titre: 'Échéance (relevé)', csv: (p) => (p.echeance ? dateCourte(p.echeance) : '') },
  { titre: 'Dû depuis le', csv: (p) => dateCourte(p.cree_le) },
  { titre: 'Motif', csv: (p) => p.motif || '' }
];

// 3. Remboursements
export const COLONNES_REMBOURSEMENTS = [
  { titre: 'Date', csv: (r) => jourEtHeure(r.cree_le) },
  { titre: 'Montant', csv: (r) => montantCsv(r.montant) },
  { titre: 'Mode', csv: (r) => MODES_REMBOURSEMENT[r.mode] || r.mode },
  { titre: 'Motif', csv: (r) => r.motif },
  { titre: 'Avoir', csv: (r) => r.avoir_numero || '' },
  { titre: 'Course', csv: (r) => r.course_numero },
  { titre: 'Client', csv: (r) => r.client_nom },
  { titre: 'Entreprise', csv: (r) => r.compte_pro || '' },
  { titre: 'Paiement remboursé', csv: (r) => `${NATURES_PAIEMENT[r.paiement_nature] || r.paiement_nature}, ${(MODES_PAIEMENT[r.paiement_mode] || r.paiement_mode).toLowerCase()}` },
  { titre: 'Montant du paiement', csv: (r) => montantCsv(r.paiement_montant) },
  { titre: 'Par', csv: (r) => r.cree_par_nom || '' }
];

// 4. Remises d'espèces
export const COLONNES_REMISES = [
  { titre: 'Reçu', csv: (r) => r.numero },
  { titre: 'Date', csv: (r) => jourEtHeure(r.cree_le) },
  { titre: 'Chauffeur', csv: (r) => r.chauffeur_nom },
  { titre: 'Montant', csv: (r) => montantCsv(r.montant) },
  { titre: 'Reçue par', csv: (r) => r.recue_par_nom || '' },
  { titre: 'Note', csv: (r) => r.note || '' },
  { titre: 'Annulée le', csv: (r) => jourEtHeure(r.annulee_le) },
  { titre: 'Annulée par', csv: (r) => r.annulee_par_nom || '' },
  { titre: 'Motif de l\'annulation', csv: (r) => r.motif_annulation || '' }
];

// 5. TVA par mois (lignes de admin_tva)
export const COLONNES_TVA = [
  { titre: 'Mois', csv: (m) => m.periode },
  { titre: 'Factures HT', csv: (m) => montantCsv(m.factures.ht) },
  { titre: 'Factures TVA', csv: (m) => montantCsv(m.factures.tva) },
  { titre: 'Factures TTC', csv: (m) => montantCsv(m.factures.ttc) },
  { titre: 'Avoirs HT', csv: (m) => montantCsv(m.avoirs.ht) },
  { titre: 'Avoirs TVA', csv: (m) => montantCsv(m.avoirs.tva) },
  { titre: 'Avoirs TTC', csv: (m) => montantCsv(m.avoirs.ttc) },
  { titre: 'Chiffre d\'affaires HT', csv: (m) => montantCsv(m.ca_ht) },
  { titre: 'TVA facturée', csv: (m) => montantCsv(m.tva_facturee) },
  { titre: 'Encaissé TTC (hors pourboires)', csv: (m) => montantCsv(m.encaisse.ttc) },
  { titre: 'TVA des encaissements', csv: (m) => montantCsv(m.encaisse.tva) },
  { titre: 'Remboursé TTC', csv: (m) => montantCsv(m.rembourse.ttc) },
  { titre: 'TVA des remboursements', csv: (m) => montantCsv(m.rembourse.tva) },
  { titre: 'Base HT sur encaissements', csv: (m) => montantCsv(m.base_exigible) },
  { titre: 'TVA sur encaissements', csv: (m) => montantCsv(m.tva_exigible) },
  { titre: 'Pourboires (hors TVA)', csv: (m) => montantCsv(m.pourboires) }
];

// Lignes du registre dans l'ordre chronologique (pièce par pièce)
export function chronologique(lignes) {
  return [...lignes].sort((a, b) => (a.date_emission === b.date_emission
    ? (a.type === b.type ? a.numero.localeCompare(b.numero) : a.type === 'facture' ? -1 : 1)
    : a.date_emission < b.date_emission ? -1 : 1));
}

// Mois entiers compris dans une période (« 2026-10 », …)
export function moisEntiers(du, au) {
  const mois = [];
  let [a, m] = du.split('-').map(Number);
  if (Number(du.slice(8)) !== 1) { m += 1; if (m > 12) { m = 1; a += 1; } }
  for (;;) {
    const code = `${a}-${String(m).padStart(2, '0')}`;
    const fin = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);   // dernier jour du mois
    if (fin > au) break;
    mois.push(code);
    m += 1; if (m > 12) { m = 1; a += 1; }
  }
  return mois;
}

// TVA des mois entiers d'une période (une demande par année concernée)
export async function tvaDesMois(du, au) {
  const mois = moisEntiers(du, au);
  const annees = [...new Set(mois.map((m) => Number(m.slice(0, 4))))];
  const lignes = [];
  for (const annee of annees) {
    const { data, error } = await supabase.rpc('admin_tva', { p_annee: annee });
    if (error) throw error;
    lignes.push(...data.mois.filter((m) => mois.includes(m.periode)));
  }
  return lignes;
}

// ---------------------------------------------------------------------------
// Dossier complet pour l'expert-comptable (ZIP)
// ---------------------------------------------------------------------------
export async function dossierComptable(du, au) {
  const periode = { p_debut: du, p_fin: au };
  const [registre, encaisses, remboursements, remises, aEncaisser, impayes, tva, releves] = await Promise.all([
    chargerTout('admin_lister_factures', { p_type: 'tout', ...periode }),
    chargerTout('admin_lister_paiements', { p_vue: 'encaisses', ...periode }),
    chargerTout('admin_lister_remboursements', periode),
    supabase.rpc('admin_lister_remises', periode).then(({ data, error }) => { if (error) throw error; return data; }),
    chargerTout('admin_lister_paiements', { p_vue: 'a_encaisser' }),
    chargerTout('admin_lister_paiements', { p_vue: 'impayes' }),
    tvaDesMois(du, au),
    supabase.rpc('admin_lister_releves', periode).then(({ data, error }) => { if (error) throw error; return data; })
  ]);
  const aujourdhui = jourParis();
  const dossier = nomFichier('dossier-comptable-loc-reaction', du, au);
  const fichiers = [
    { nom: '1-registre-factures-et-avoirs.csv', colonnes: COLONNES_REGISTRE, lignes: chronologique(registre.lignes) },
    { nom: '2-journal-des-encaissements.csv', colonnes: COLONNES_PAIEMENTS, lignes: [...encaisses.lignes].reverse() },
    { nom: '3-remboursements.csv', colonnes: COLONNES_REMBOURSEMENTS, lignes: [...remboursements.lignes].reverse() },
    { nom: '4-remises-especes-des-chauffeurs.csv', colonnes: COLONNES_REMISES, lignes: [...remises.lignes].reverse() },
    ...(tva.length ? [{ nom: '5-tva-par-mois.csv', colonnes: COLONNES_TVA, lignes: tva }] : []),
    { nom: `6-sommes-dues-au-${aujourdhui}.csv`, colonnes: COLONNES_PAIEMENTS, lignes: [...aEncaisser.lignes, ...impayes.lignes] },
    { nom: '7-releves-des-plateformes.csv', colonnes: COLONNES_RELEVES, lignes: relevesChronologiques(releves.lignes) }
  ];
  const rp = releves.totaux;
  const t = registre.totaux;
  const lisezMoi = [
    'LOC RÉACTION S.A.S — dossier pour l\'expert-comptable',
    `Période : ${periodeLisible(du, au)} (du ${dateCourte(du)} au ${dateCourte(au)}), préparé le ${dateCourte(aujourdhui)}.`,
    '',
    'Fichiers (CSV, séparateur « ; », virgule décimale, dates JJ/MM/AAAA, heure de Paris) :',
    `1. Registre des factures et des avoirs : ${t.factures.nb} factures et ${t.avoirs.nb} avoirs émis sur la période,`,
    '   dans l\'ordre chronologique. Les avoirs sont en montants négatifs et indiquent la facture qu\'ils corrigent.',
    `   Total net : ${montantCsv(t.net.ht)} € HT, ${montantCsv(t.net.tva)} € de TVA, ${montantCsv(t.net.ttc)} € TTC.`,
    `2. Journal des encaissements : ${encaisses.total} paiements encaissés sur la période (date d'encaissement),`,
    '   avec leur mode (espèces, carte au terminal, virement des comptes professionnels) et leur facture.',
    `3. Remboursements : ${remboursements.total} sur la période, avec leur mode et l'avoir correspondant.`,
    `4. Remises d'espèces : espèces remises au bureau par les chauffeurs (${remises.nb} reçus sur la période ; les remises annulées figurent avec leur motif).`,
    tva.length
      ? `5. TVA par mois : ${tva.length} mois entier${tva.length > 1 ? 's' : ''} de la période. TVA facturée (factures moins avoirs) et TVA sur les encaissements (sommes encaissées moins remboursées).`
      : '5. TVA par mois : non jointe, la période ne contient aucun mois entier (la TVA se calcule par mois).',
    `6. Sommes encore dues le ${dateCourte(aujourdhui)} : paiements à encaisser et impayés, toutes dates confondues.`,
    `7. Relevés des plateformes (Bolt, Uber, Heetch) qui se terminent dans la période : ${releves.total} relevé${releves.total > 1 ? 's' : ''},`,
    `   ${montantCsv(rp.trajets)} € de trajets payés par les passagers (TTC), ${montantCsv(rp.frais)} € de frais de service retenus,`,
    `   ${montantCsv(rp.especes)} € d'espèces collectées par les chauffeurs, ${montantCsv(rp.virement)} € virés par les plateformes.`,
    '',
    'À savoir :',
    '- Transport de personnes : TVA à 10 %. Pour une prestation de services, la TVA est due à l\'encaissement,',
    '  sauf option pour les débits : la colonne « TVA sur encaissements » est celle qui se déclare d\'ordinaire.',
    '- Pourboires : hors TVA, reversés intégralement aux chauffeurs.',
    '- Courses des plateformes : chiffre d\'affaires de l\'entreprise au même titre que les courses en direct ;',
    '  les frais de service sont la commission retenue par la plateforme (traitement de la TVA à confirmer).',
    '- Numérotation : factures FA-AAAA-NNNNNN et avoirs AV-AAAA-NNNNNN, continues par année (contrôlées par la plateforme).',
    '- Un autre format (fichier des écritures comptables, plan de comptes particulier) peut être préparé sur demande.'
  ].join('\r\n');
  const zip = creerZip([
    { nom: `${dossier}/LISEZ-MOI.txt`, contenu: '﻿' + lisezMoi },
    ...fichiers.map((f) => ({ nom: `${dossier}/${f.nom}`, contenu: contenuCsv(f.colonnes, f.lignes) }))
  ]);
  return { zip, nom: `${dossier}.zip`, fichiers: fichiers.length + 1 };
}
