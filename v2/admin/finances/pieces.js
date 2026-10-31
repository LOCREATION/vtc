// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — facture et avoir imprimables
// -----------------------------------------------------------------------------
// Une facture (?facture=…) ou un avoir (?avoir=…) tel qu'émis, au format A4
// (« Imprimer ou enregistrer en PDF ») :
//   - identité exacte de LOC RÉACTION S.A.S (Paramètres, Entreprise) ;
//   - destinataire recopié à l'émission (nom, adresse ; SIRET et TVA d'une
//     entreprise cliente) ;
//   - facture : désignation de la course, quantité, prix unitaire HT, détail
//     du prix toutes taxes comprises (prix, majoration, option, remise,
//     attente), totaux HT, TVA à 10 %, TTC, règlement ;
//   - avoir : facture corrigée, objet et motif, totaux HT, TVA, TTC, et le
//     remboursement ou la somme annulée.
// Au-dessus du document (jamais imprimés) : les mentions manquantes dans
// Paramètres, les avoirs d'une facture, l'état du règlement.
// Lectures : admin_document_facture, admin_document_avoir.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  dateCourte, dateHeureComplete, messageErreurAdmin, siretLisible, ibanLisible, moisLisible, avecDe, MODES_PAIEMENT,
  ORIGINES_AVOIR, badgePaiement
} from '../commun/composants.js';
import {
  enteteDocument, blocDestinataire, barreDocument, avertissementMentions, tableauDefilant, enteteTableau, blocTotaux
} from '../commun/documents.js';

const $ = (id) => document.getElementById(id);
const MAJORATIONS = { nuit: 'Majoration de nuit', dimanche: 'Majoration du dimanche', ferie: 'Majoration de jour férié' };
const centimes = (x) => Math.round(Number(x || 0) * 100);

function preparer(retour) {
  $('onglets').hidden = true;
  $('entete-actions').replaceChildren(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(retour.lien), texte: retour.texte }));
}

function introuvable(texte) {
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte }),
    el('a', { href: lienAdmin('finances/?vue=factures'), texte: 'Retour aux factures et avoirs' })));
}

// Mentions qui manquent dans Paramètres pour une pièce complète
function manquants(s, compte) {
  return [
    !s.forme_juridique || s.capital === null || s.capital === undefined ? 'la forme juridique et le capital' : null,
    !s.adresse || !s.code_postal || !s.ville ? 'l\'adresse du siège' : null,
    !s.siret ? 'le SIRET' : null,
    !s.rcs ? 'la mention RCS (ville d\'immatriculation)' : null,
    !s.tva_intracommunautaire ? 'le n° de TVA intracommunautaire' : null,
    compte && !compte.adresse ? `l'adresse de facturation de ${compte.raison_sociale} (fiche de l'entreprise)` : null
  ].filter(Boolean);
}

// Destinataire tel que recopié sur la pièce, plus SIRET et TVA de l'entreprise cliente
function destinataire(piece, compte) {
  return blocDestinataire({
    nom: piece.destinataire_nom,
    lignes: [
      ...(piece.destinataire_adresse ? piece.destinataire_adresse.split(', ') : []),
      compte && compte.siret ? `SIRET ${siretLisible(compte.siret)}` : null,
      compte && compte.tva_intracommunautaire ? `TVA intracommunautaire ${compte.tva_intracommunautaire}` : null
    ]
  });
}

// « Transport de personnes, Berline hybride » et son détail (date, trajet, passager)
function designation(c, nature) {
  if (nature === 'frais_annulation') {
    return el('td', {}, el('strong', { texte: 'Frais d\'annulation' }),
      el('span', { classe: 'doc-detail', texte: `Course ${c.numero}, prévue le ${dateHeureComplete(c.prise_en_charge_le)}, annulée le ${dateHeureComplete(c.annulee_le)}.` }),
      el('span', { classe: 'doc-detail', texte: `${c.depart_adresse} → ${c.arrivee_adresse}` }));
  }
  const trajet = [c.depart_adresse, ...(c.arrets || []), c.arrivee_adresse].join(' → ');
  return el('td', {},
    el('strong', { texte: `Transport de personnes en VTC, ${c.categorie}${c.type === 'mise_a_disposition' ? ` : mise à disposition ${nombre(c.duree_mad_heures, 1)} h` : ''}` }),
    el('span', { classe: 'doc-detail', texte: `Course ${c.numero} du ${dateHeureComplete(c.prise_en_charge_le)}${c.forfait ? ` · forfait ${c.forfait}` : ''}` }),
    el('span', { classe: 'doc-detail', texte: `${trajet}${c.type !== 'mise_a_disposition' && Number(c.distance_km) > 0 ? ` (${nombre(c.distance_km, 1)} km estimés)` : ''}` }),
    c.pour_proche && c.beneficiaire_nom ? el('span', { classe: 'doc-detail', texte: `Passager : ${c.beneficiaire_nom}` }) : null,
    c.vehicule_libelle ? el('span', { classe: 'doc-detail', texte: `Véhicule : ${c.vehicule_libelle}${c.vehicule_immatriculation ? `, ${c.vehicule_immatriculation}` : ''}` }) : null);
}

// Détail du prix toutes taxes comprises (le prix annoncé à la commande)
function detailPrix(c, totalTtc) {
  const base = Number(c.prix_base);
  const majore = Math.round(base * (1 + Number(c.majoration_pourcentage || 0) / 100) * 100) / 100;
  const lignes = [[c.type === 'mise_a_disposition' ? 'Mise à disposition' : c.forfait ? 'Forfait' : 'Prix de la course', euros(base)]];
  if (Number(c.majoration_pourcentage) > 0) {
    lignes.push([`${MAJORATIONS[c.majoration_type] || 'Majoration'} (+${nombre(c.majoration_pourcentage, 2)} %)`, euros(majore - base)]);
  }
  if (Number(c.supplement) > 0) lignes.push(['Option chauffeuse', euros(c.supplement)]);
  if (Number(c.remise) > 0) lignes.push([`Remise${c.code_promo ? ` (code ${c.code_promo})` : ''}`, `− ${euros(c.remise)}`]);
  // Prix modifié en accord avec le client : l'écart figure sur sa ligne
  const attendu = Math.max(0, centimes(majore) + centimes(c.supplement) - centimes(c.remise));
  if (attendu !== centimes(c.prix_total)) {
    const ecart = (centimes(c.prix_total) - attendu) / 100;
    lignes.push(['Ajustement du prix convenu', `${ecart < 0 ? '− ' : ''}${euros(Math.abs(ecart))}`]);
  }
  if (Number(c.frais_attente) > 0) lignes.push([`Attente (${c.attente_min} min)`, euros(c.frais_attente)]);
  if (lignes.length === 1) return null;                 // prix seul : les totaux suffisent
  lignes.push(['Total toutes taxes comprises', euros(totalTtc)]);
  return el('section', { classe: 'doc-bloc' },
    el('h3', { texte: 'Détail du prix (TTC)' }),
    el('dl', { classe: 'doc-detail-prix' }, ...lignes.flatMap(([dt, dd]) => [el('dt', { texte: dt }), el('dd', { texte: dd })])));
}

// #############################################################################
// FACTURE
// #############################################################################
export async function ouvrirFacture(id) {
  preparer({ lien: 'finances/?vue=factures', texte: 'Factures et avoirs' });
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable('Facture introuvable.'); return; }
  const { data: d, error } = await supabase.rpc('admin_document_facture', { p_facture: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable('Facture introuvable.');
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  const f = d.facture;
  document.title = `Facture ${f.numero}, LOC RÉACTION`;
  $('titre-page').textContent = `Facture ${f.numero}`;

  // Au-dessus du document : avoirs et règlement (jamais imprimés)
  const credite = d.avoirs.reduce((n, a) => n + centimes(a.montant_ttc), 0) / 100;
  const infos = el('section', { classe: 'carte-admin non-imprimable', 'aria-label': 'Suivi de la facture' },
    el('p', {}, 'Règlement : ', d.paiement ? badgePaiement(d.paiement.statut) : 'aucun paiement (course gratuite)', ' ',
      d.paiement ? `${MODES_PAIEMENT[d.paiement.mode] || d.paiement.mode}${d.paiement.encaisse_le ? `, le ${dateCourte(d.paiement.encaisse_le)}` : ''}` : '',
      ' · ', el('a', { href: lienAdmin(`courses/?id=${d.course.id}`), texte: `course ${d.course.numero}` })),
    d.avoirs.length ? el('p', {}, `Corrigée par ${d.avoirs.length > 1 ? `${d.avoirs.length} avoirs` : 'un avoir'} (${euros(credite)} sur ${euros(f.montant_ttc)}) : `,
      ...d.avoirs.flatMap((a, i) => [i ? ', ' : '', el('a', { href: lienAdmin(`finances/?avoir=${a.id}`), texte: a.numero }), ` du ${dateCourte(a.date_emission)}`])) : null);

  $('contenu').replaceChildren(...[
    barreDocument(),
    avertissementMentions(manquants(d.societe || {}, d.compte_pro)),
    infos,
    documentFacture(d)
  ].filter(Boolean));
}

function documentFacture(d) {
  const f = d.facture;
  const c = d.course;
  const s = d.societe || {};
  const p = d.paiement;
  const prestation = c.statut === 'terminee' && f.nature === 'course' ? c.terminee_le : c.annulee_le || c.prise_en_charge_le;

  const entete = enteteDocument({
    societe: s, titre: 'Facture', sousTitre: `N° ${f.numero}`,
    dates: [['Date de la facture', dateCourte(f.date_emission)], ['Date de la prestation', dateCourte(prestation)], ['Course', c.numero]]
  });

  const lignes = el('table', { classe: 'doc-table doc-table-courte' },
    enteteTableau(['Désignation', 'Quantité', 'Prix unitaire HT', 'Montant HT'], [1, 2, 3]),
    el('tbody', {}, el('tr', {},
      designation(c, f.nature),
      el('td', { classe: 'droite', texte: '1' }),
      el('td', { classe: 'droite', texte: euros(f.montant_ht) }),
      el('td', { classe: 'droite', texte: euros(f.montant_ht) }))));

  const totaux = blocTotaux([
    ['Total HT', euros(f.montant_ht)],
    [`TVA ${nombre(f.taux_tva, 2)} % sur ${euros(f.montant_ht)}`, euros(f.montant_tva)],
    'trait',
    ['Total TTC', euros(f.montant_ttc), Number(f.pourboire) <= 0],
    Number(f.pourboire) > 0 ? ['Pourboire (hors TVA, reversé au chauffeur)', euros(f.pourboire)] : null,
    Number(f.pourboire) > 0 ? ['Total payé', euros(Number(f.montant_ttc) + Number(f.pourboire)), true] : null
  ]);

  // Règlement : mode, échéance d'un compte pro, ou facture acquittée
  const acquittee = p && ['encaisse', 'rembourse'].includes(p.statut);
  const reglement = [];
  if (!p) {
    reglement.push(el('p', { texte: 'Rien à régler.' }));
  } else if (p.mode === 'facture_mensuelle') {
    reglement.push(el('p', { texte: `Facture récapitulée sur le relevé mensuel ${avecDe(moisLisible(f.date_emission.slice(0, 7)))}${p.echeance ? `, à régler par virement au plus tard le ${dateCourte(p.echeance)}` : ''}.` }));
    if (!acquittee && s.iban) {
      reglement.push(el('p', { classe: 'doc-iban' }, el('strong', { texte: 'IBAN ' }), ibanLisible(s.iban), s.bic ? el('span', {}, el('strong', { texte: '  BIC ' }), s.bic) : null));
    }
  } else {
    reglement.push(el('p', { texte: `Mode de règlement : ${(MODES_PAIEMENT[p.mode] || p.mode).toLowerCase()}.` }));
  }
  if (acquittee && p.encaisse_le) reglement.push(el('p', { texte: `Facture acquittée le ${dateCourte(p.encaisse_le)}.` }));
  if (p && p.statut === 'annule') reglement.push(el('p', { texte: 'Somme annulée par avoir : rien à régler.' }));

  return el('article', { classe: 'doc', 'aria-label': `Facture ${f.numero}` },
    entete,
    destinataire(f, d.compte_pro),
    ...tableauDefilant(lignes),
    ...(() => {
      const detail = f.nature === 'course' ? detailPrix(c, f.montant_ttc) : null;
      return detail ? [el('div', { classe: 'doc-colonnes' }, detail, totaux)] : [totaux];
    })(),
    el('section', { classe: 'doc-bloc doc-reglement' }, el('h3', { texte: 'Règlement' }), ...reglement,
      acquittee ? el('span', { classe: 'doc-acquittee', texte: 'Acquittée' }) : null),
    el('section', { classe: 'doc-bloc' },
      el('p', { classe: 'doc-detail', texte: `Prestation de services : transport de personnes en véhicule de transport avec chauffeur (VTC). TVA au taux de ${nombre(f.taux_tva, 2)} %.` }),
      s.mentions_factures ? el('p', { classe: 'doc-mentions', texte: s.mentions_factures }) : null));
}

// #############################################################################
// AVOIR
// #############################################################################
export async function ouvrirAvoir(id) {
  preparer({ lien: 'finances/?vue=factures&type=avoirs', texte: 'Factures et avoirs' });
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable('Avoir introuvable.'); return; }
  const { data: d, error } = await supabase.rpc('admin_document_avoir', { p_avoir: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable('Avoir introuvable.');
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  const a = d.avoir;
  document.title = `Avoir ${a.numero}, LOC RÉACTION`;
  $('titre-page').textContent = `Avoir ${a.numero}`;
  const infos = el('section', { classe: 'carte-admin non-imprimable', 'aria-label': 'Suivi de l\'avoir' },
    el('p', {}, 'Corrige la facture ', el('a', { href: lienAdmin(`finances/?facture=${d.facture.id}`), texte: d.facture.numero }),
      ` (${euros(d.facture.montant_ttc)} TTC), créditée en tout de ${euros(d.credite_total)} · `,
      el('a', { href: lienAdmin(`courses/?id=${d.course.id}`), texte: `course ${d.course.numero}` })));
  $('contenu').replaceChildren(...[
    barreDocument(),
    avertissementMentions(manquants(d.societe || {}, d.compte_pro)),
    infos,
    documentAvoir(d)
  ].filter(Boolean));
}

function documentAvoir(d) {
  const a = d.avoir;
  const f = d.facture;
  const c = d.course;
  const s = d.societe || {};
  const total = centimes(a.montant_ttc) === centimes(f.montant_ttc);
  const objet = f.nature === 'course'
    ? `la course ${c.numero} du ${dateHeureComplete(c.prise_en_charge_le)}`
    : `les frais d'annulation de la course ${c.numero}`;
  const libelle = a.origine === 'remboursement'
    ? `Remboursement ${total ? 'total' : 'partiel'} de ${objet}`
    : `Annulation ${total ? 'de la somme due' : 'd\'une partie de la somme due'} pour ${objet}`;

  const entete = enteteDocument({
    societe: s, titre: 'Avoir', sousTitre: `N° ${a.numero}`,
    dates: [['Date de l\'avoir', dateCourte(a.date_emission)], ['Facture corrigée', f.numero], ['Facture du', dateCourte(f.date_emission)]]
  });

  const lignes = el('table', { classe: 'doc-table doc-table-courte' },
    enteteTableau(['Désignation', 'Montant HT'], [1]),
    el('tbody', {}, el('tr', {},
      el('td', {}, el('strong', { texte: libelle }),
        el('span', { classe: 'doc-detail', texte: `${c.depart_adresse} → ${c.arrivee_adresse}` }),
        el('span', { classe: 'doc-detail', texte: `Motif : ${a.motif}` })),
      el('td', { classe: 'droite', texte: euros(a.montant_ht) }))));

  const totaux = blocTotaux([
    ['Total HT de l\'avoir', euros(a.montant_ht)],
    [`TVA ${nombre(a.taux_tva, 2)} % sur ${euros(a.montant_ht)}`, euros(a.montant_tva)],
    'trait',
    ['Total TTC de l\'avoir', euros(a.montant_ttc), true]
  ]);

  const r = d.remboursement;
  const reglement = a.origine === 'remboursement' && r
    ? `Montant remboursé le ${dateCourte(r.cree_le)} ${r.mode === 'carte' ? 'sur la carte de paiement' : r.mode === 'virement' ? 'par virement' : 'en espèces'}.`
    : 'Montant déduit de la somme due : il n\'est pas à régler.';

  return el('article', { classe: 'doc', 'aria-label': `Avoir ${a.numero}` },
    entete,
    destinataire(a, d.compte_pro),
    el('p', { classe: 'doc-objet' }, el('strong', { texte: 'Objet : ' }),
      `avoir sur la facture ${f.numero} du ${dateCourte(f.date_emission)} (${euros(f.montant_ttc)} TTC), ${(ORIGINES_AVOIR[a.origine] || a.origine).toLowerCase()}.`),
    ...tableauDefilant(lignes),
    totaux,
    el('section', { classe: 'doc-bloc doc-reglement' }, el('h3', { texte: 'Règlement' }), el('p', { texte: reglement })),
    el('section', { classe: 'doc-bloc' },
      el('p', { classe: 'doc-detail', texte: `Avoir établi en correction de la facture ${f.numero}, dont il reprend le taux de TVA (${nombre(a.taux_tva, 2)} %). Prestation de services : transport de personnes en VTC.` }),
      s.mentions_factures ? el('p', { classe: 'doc-mentions', texte: s.mentions_factures }) : null));
}
