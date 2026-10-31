// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — bulletin de paie imprimable
// -----------------------------------------------------------------------------
// (?bulletin=…) Le bulletin tel que calculé et validé par la base, sur le
// modèle du bulletin clarifié (une page A4) :
//   - employeur (raison sociale, adresse du siège, SIRET, code APE, n° URSSAF,
//     convention collective) et salarié (matricule, n° de Sécurité sociale,
//     emploi, classification, statut, entrée) tels qu'au moment du calcul ;
//   - rémunération brute (base, taux exact, montant) ;
//   - cotisations par risque : santé, accidents du travail, retraite, famille,
//     assurance chômage, autres contributions de l'employeur, CSG et CRDS,
//     allègements ; totaux ;
//   - net à payer avant impôt, montant net social, prélèvement à la source
//     (base, taux personnalisé ou non, montant), éléments après le net, net à
//     payer au salarié ; coût total employeur et allègements ;
//   - cumuls de l'année, congés payés, mentions obligatoires ;
//   - au-dessus (jamais imprimé) : état, contrôles, actions (modifier ou
//     valider un brouillon, noter la remise, voir le PDF remis).
// Lecture : admin_document_bulletin.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { RACINE } from '../../commun/config.js';
import { lienAdmin } from '../commun/admin.js';
import { messageErreurAdmin, dateCourte, boutonAction, confirmer, ouvrirPiece, siretLisible } from '../commun/composants.js';
import { barreDocument, tableauDefilant, enteteTableau } from '../commun/documents.js';
import { STATUTS_BULLETIN, TYPES_CONTRAT, pastille, decimal, montant, heures, joursConges, moisEnLettres, deMois, nssLisible } from './commun-rh.js';
import { remettreBulletin } from './bulletins.js';

const $ = (id) => document.getElementById(id);
const SECTIONS = [
  { code: 'sante', titre: 'Santé' },
  { code: 'accidents_travail', titre: 'Accidents du travail - maladies professionnelles' },
  { code: 'retraite', titre: 'Retraite' },
  { code: 'famille', titre: 'Famille' },
  { code: 'chomage', titre: 'Assurance chômage' },
  { code: 'autres', titre: 'Autres contributions dues par l\'employeur', regroupee: true },
  { code: 'csg_crds', titre: 'CSG et CRDS', sansTitre: true }
];

const vide = (v) => v === null || v === undefined || v === '';
const taux = (v) => (vide(v) ? '' : decimal(v, 2, 6));
const somme = (lignes, cle) => Math.round(lignes.reduce((n, l) => n + Number(l[cle] || 0) * 100, 0)) / 100;

export async function ouvrirBulletin(id) {
  $('onglets').hidden = true;
  if (!/^[0-9a-f-]{36}$/i.test(id)) { introuvable(); return; }
  const { data: d, error } = await supabase.rpc('admin_document_bulletin', { p_bulletin: id });
  if (error) {
    if (/introuvable/i.test(error.message || '')) introuvable();
    else $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) }));
    return;
  }
  const c = d.calcul;
  const s = c.salarie;
  document.title = `Bulletin de paie ${deMois(d.periode)}, ${s.prenom} ${s.nom}, LOC RÉACTION`;
  $('titre-page').textContent = `Bulletin ${deMois(d.periode)} · ${s.prenom} ${s.nom}`;
  $('entete-actions').replaceChildren(
    el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?vue=bulletins&periode=${d.periode}`), texte: `Bulletins ${deMois(d.periode)}` }),
    el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?salarie=${d.salarie_id}`), texte: 'Dossier' }));
  $('contenu').replaceChildren(barreDocument(...actions(d)), suivi(d), documentBulletin(d));
}

function introuvable() {
  $('contenu').replaceChildren(el('section', { classe: 'carte-admin' },
    el('p', { texte: 'Bulletin introuvable.' }), el('a', { href: lienAdmin('rh/?vue=bulletins'), texte: 'Retour aux bulletins' })));
}

function actions(d) {
  const c = d.calcul;
  const bloquants = c.controles.filter((x) => x.niveau === 'bloquant').length;
  if (d.statut === 'brouillon') {
    return [
      el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?preparer=${d.salarie_id}&periode=${d.periode}`), texte: 'Modifier' }),
      bloquants ? null : boutonAction('Valider', async () => {
        const ok = await confirmer({ titre: 'Valider ce bulletin ?', texte: `Net à payer ${montant(c.net_a_payer)}. Il est recalculé avec les paramètres du moment, puis figé.`, libelle: 'Valider' });
        if (!ok) return;
        const { error } = await supabase.rpc('admin_valider_bulletin', { p_bulletin: d.id });
        if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
        afficherMessage('Bulletin validé.', 'succes');
        ouvrirBulletin(d.id);
      }, 'bouton-principal')
    ];
  }
  return [
    boutonAction(d.statut === 'valide' ? 'Remis au salarié' : 'Remplacer le PDF remis', async () => {
      const fait = await remettreBulletin({ id: d.id, salarieId: d.salarie_id, nom: `${c.salarie.prenom} ${c.salarie.nom}`, periode: d.periode });
      if (fait) { afficherMessage('Bulletin noté comme remis.', 'succes'); ouvrirBulletin(d.id); }
    }),
    d.pdf_chemin ? boutonAction('PDF remis', async () => {
      try { await ouvrirPiece('paie', d.pdf_chemin); } catch (erreur) { afficherMessage(messageErreurAdmin(erreur), 'erreur'); }
    }) : null
  ];
}

// Au-dessus du document (jamais imprimé) : état et contrôles
function suivi(d) {
  const c = d.calcul;
  const ordre = { bloquant: 0, attention: 1, info: 2 };
  const controles = [...c.controles].sort((a, b) => ordre[a.niveau] - ordre[b.niveau]);
  return el('section', { classe: 'carte-admin non-imprimable', 'aria-label': 'Suivi du bulletin' },
    el('p', {}, 'État : ', pastille(STATUTS_BULLETIN, d.statut),
      d.valide_le ? ` · validé le ${dateCourte(d.valide_le)}${d.valide_par_nom ? ` par ${d.valide_par_nom}` : ''}` : ' · brouillon : recalculé à chaque enregistrement'),
    controles.length ? el('ul', { classe: 'liste-controles' }, ...controles.map((x) => el('li', { dataset: { niveau: x.niveau } },
      el('span', { classe: 'controle-niveau', texte: { bloquant: 'Bloquant', attention: 'Attention', info: 'Info' }[x.niveau] }),
      el('span', { texte: x.message })))) : el('p', { classe: 'texte-vert', texte: 'Tous les montants ont été revérifiés : aucun point à signaler.' }));
}

function documentBulletin(d) {
  const c = d.calcul;
  const s = c.salarie;
  const so = c.societe;
  const brouillon = d.statut === 'brouillon';
  const classification = [s.qualification, s.niveau ? `niveau ${s.niveau}` : null, s.coefficient ? `coefficient ${s.coefficient}` : null].filter(Boolean).join(', ');

  return el('article', { classe: `doc bulletin${brouillon ? ' bulletin-brouillon' : ''}` },
    brouillon ? el('p', { classe: 'bulletin-filigrane', texte: 'Brouillon : non valable' }) : null,
    // En-tête : employeur, titre, période
    el('header', { classe: 'doc-entete' },
      el('div', { classe: 'doc-emetteur' },
        el('img', { src: `${RACINE}commun/img/logo.svg`, alt: '', width: '72', height: '36', classe: 'doc-logo' }),
        el('strong', { classe: 'doc-raison', texte: so.raison_sociale }),
        el('span', { texte: [so.adresse, [so.code_postal, so.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ') }),
        el('span', { texte: `SIRET ${siretLisible(so.siret)} · APE ${so.code_ape || ''}` }),
        el('span', { texte: `N° URSSAF ${so.numero_urssaf || ''}` }),
        el('span', { texte: `Convention collective : ${s.convention_collective || ''}` })),
      el('div', { classe: 'doc-titre' },
        el('h2', { texte: 'Bulletin de paie' }),
        el('p', { classe: 'doc-sous-titre', texte: moisEnLettres(d.periode) }),
        el('dl', {},
          el('dt', { texte: 'Période' }), el('dd', { texte: `du ${dateCourte(c.du)} au ${dateCourte(c.au)}` }),
          el('dt', { texte: 'Paiement' }), el('dd', { texte: `le ${dateCourte(c.date_paiement)}, par virement` })))),
    // Salarié
    el('section', { classe: 'doc-client bulletin-salarie', 'aria-label': 'Salarié' },
      el('span', { classe: 'doc-etiquette', texte: 'Salarié' }),
      el('strong', { texte: `${s.civilite ? `${s.civilite} ` : ''}${s.prenom} ${s.nom}` }),
      s.adresse ? el('span', { texte: `${s.adresse}, ${[s.code_postal, s.ville].filter(Boolean).join(' ')}` }) : null,
      el('span', { texte: `Matricule ${s.matricule}${s.numero_securite_sociale ? ` · Sécurité sociale ${nssLisible(s.numero_securite_sociale)}` : ''}` }),
      el('span', { texte: `${s.emploi}${classification ? `, ${classification}` : ''} · ${s.cadre ? 'cadre' : 'non cadre'}` }),
      el('span', { texte: `${TYPES_CONTRAT[s.type_contrat]}, ${s.temps === 'partiel' ? 'temps partiel' : 'temps plein'} · entrée le ${dateCourte(s.date_entree)}${s.date_sortie ? ` · sortie le ${dateCourte(s.date_sortie)}` : ''}` }),
      el('span', { texte: `Durée du travail : ${heures(c.heures.contrat)} par mois · taux horaire ${decimal(c.taux_horaire, 4, 6)} €` })),
    remuneration(c),
    cotisations(c),
    nets(c),
    piedEmployeur(c),
    el('div', { classe: 'doc-colonnes' }, cumuls(c), conges(c)),
    mentions());
}

function remuneration(c) {
  const corps = el('tbody', {}, ...c.remuneration.map((r) => el('tr', {},
    el('td', {}, r.libelle, r.detail ? el('span', { classe: 'doc-detail', texte: r.detail }) : null),
    el('td', { classe: 'droite', texte: vide(r.base) ? '' : decimal(r.base, 2, 2) }),
    el('td', { classe: 'droite', texte: vide(r.taux) ? '' : decimal(r.taux, 4, 6) }),
    el('td', { classe: 'droite', texte: montant(r.montant) }))));
  const table = el('table', { classe: 'doc-table doc-table-courte' },
    enteteTableau(['Rémunération', 'Base', 'Taux', 'Montant'], [1, 2, 3]), corps,
    el('tfoot', {}, el('tr', {}, el('td', { texte: 'Salaire brut' }), el('td', {}), el('td', {}), el('td', { classe: 'droite', texte: montant(c.brut) }))));
  return el('section', { classe: 'doc-bloc' }, ...tableauDefilant(table));
}

function cotisations(c) {
  const lignes = [];
  const ligneCotisation = (l, libelle = l.libelle, detail = l.detail) => el('tr', {},
    el('td', {}, libelle, detail ? el('span', { classe: 'doc-detail', texte: detail }) : null),
    el('td', { classe: 'droite', texte: vide(l.base) ? '' : decimal(l.base, 2, 2) }),
    el('td', { classe: 'droite', texte: l.unite === 'euro_heure' ? '' : taux(l.taux_salarial) }),
    el('td', { classe: 'droite', texte: Number(l.montant_salarial) ? montant(l.montant_salarial) : '' }),
    el('td', { classe: 'droite', texte: l.unite === 'euro_heure' ? `${decimal(l.taux_patronal, 2, 2)} €/h` : taux(l.taux_patronal) }),
    el('td', { classe: 'droite', texte: Number(l.montant_patronal) ? montant(l.montant_patronal) : '' }));
  for (const section of SECTIONS) {
    const lignesSection = c.cotisations.filter((l) => l.section === section.code);
    if (!lignesSection.length) continue;
    if (!section.sansTitre && !section.regroupee) lignes.push(el('tr', { classe: 'bulletin-section' }, el('td', { colspan: '6', texte: section.titre })));
    if (section.regroupee) {
      // Une seule ligne, comme sur le bulletin clarifié, avec le détail en dessous
      lignes.push(ligneCotisation({ base: null, taux_salarial: null, montant_salarial: somme(lignesSection, 'montant_salarial'),
        taux_patronal: null, montant_patronal: somme(lignesSection, 'montant_patronal') }, section.titre,
      lignesSection.map((l) => `${l.libelle} ${taux(l.taux_patronal)} %`).join(' · ')));
    } else {
      lignesSection.forEach((l) => lignes.push(ligneCotisation(l)));
    }
  }
  if (c.allegements.length) {
    lignes.push(el('tr', { classe: 'bulletin-section' }, el('td', { colspan: '6', texte: 'Exonérations, écrêtements et allègements de cotisations' })));
    c.allegements.forEach((l) => lignes.push(ligneCotisation(l)));
  }
  const table = el('table', { classe: 'doc-table' },
    enteteTableau(['Cotisations et contributions', 'Base', 'Taux salarial', 'Part salarié', 'Taux employeur', 'Part employeur'], [1, 2, 3, 4, 5]),
    el('tbody', {}, ...lignes),
    el('tfoot', {}, el('tr', {}, el('td', { texte: 'Total des cotisations et contributions' }), el('td', {}), el('td', {}),
      el('td', { classe: 'droite', texte: montant(c.totaux.cotisations_salariales) }), el('td', {}),
      el('td', { classe: 'droite', texte: montant(c.totaux.cotisations_patronales) }))));
  return el('section', { classe: 'doc-bloc' }, ...tableauDefilant(table));
}

function nets(c) {
  const pas = c.pas;
  return el('section', { classe: 'doc-bloc bulletin-nets' },
    el('dl', { classe: 'bulletin-ligne-forte' }, el('dt', { texte: 'Net à payer avant impôt sur le revenu' }), el('dd', { texte: montant(c.net_avant_impot) })),
    el('dl', { classe: 'bulletin-ligne' }, el('dt', { texte: 'Montant net social' }), el('dd', { texte: montant(c.net_social) })),
    el('div', { classe: 'bulletin-pas' },
      el('strong', { texte: 'Impôt sur le revenu prélevé à la source' }),
      el('dl', {},
        el('dt', { texte: 'Base (net imposable)' }), el('dd', { texte: montant(pas.base) }),
        el('dt', { texte: `Taux ${pas.type === 'personnalise' ? 'personnalisé' : 'non personnalisé'}` }), el('dd', { texte: `${decimal(pas.taux, 1, 2)} %` }),
        el('dt', { texte: 'Montant prélevé' }), el('dd', { texte: montant(pas.montant) }))),
    c.apres_net.length ? el('dl', { classe: 'bulletin-ligne bulletin-apres' },
      ...c.apres_net.flatMap((a) => [el('dt', { texte: a.libelle }), el('dd', { texte: montant(a.montant) })])) : null,
    el('dl', { classe: 'bulletin-net' }, el('dt', { texte: 'Net à payer au salarié' }), el('dd', { texte: montant(c.net_a_payer) })));
}

function piedEmployeur(c) {
  return el('section', { classe: 'bulletin-employeur', 'aria-label': 'Coût pour l\'employeur' },
    el('dl', {},
      el('dt', { texte: 'Total versé par l\'employeur' }), el('dd', { texte: montant(c.cout_employeur) }),
      el('dt', { texte: 'Allègement de cotisations employeur' }), el('dd', { texte: montant(c.totaux.allegements) })));
}

function cumuls(c) {
  const k = c.cumuls;
  const lignes = [
    ['Salaire brut', montant(k.brut)], ['Heures payées', heures(k.heures)], ['Net imposable', montant(k.net_imposable)],
    ['Montant net social', montant(k.net_social)], ['Cotisations salariales', montant(k.cotisations_salariales)],
    ['Cotisations patronales', montant(k.cotisations_patronales)], ['Impôt prélevé à la source', montant(k.pas)],
    ['Coût total employeur', montant(k.cout_employeur)]
  ];
  if (Number(k.hs_exonerees)) lignes.splice(2, 0, ['Heures supplémentaires exonérées', montant(k.hs_exonerees)]);
  return el('section', { classe: 'doc-bloc' },
    el('h3', { texte: `Cumuls ${c.constantes.annee}` }),
    el('dl', { classe: 'doc-detail-prix' }, ...lignes.flatMap(([dt, dd]) => [el('dt', { texte: dt }), el('dd', { texte: dd })])));
}

function conges(c) {
  const g = c.conges;
  return el('section', { classe: 'doc-bloc' },
    el('h3', { texte: 'Congés payés (jours ouvrables)' }),
    el('dl', { classe: 'doc-detail-prix' },
      el('dt', { texte: 'Acquis ce mois-ci' }), el('dd', { texte: joursConges(g.acquis_mois) }),
      el('dt', { texte: 'Pris ce mois-ci' }), el('dd', { texte: joursConges(g.pris_mois) }),
      el('dt', { texte: 'Période précédente (N-1) : reste à prendre' }), el('dd', { texte: joursConges(g.n1_solde) }),
      el('dt', { texte: `Période en cours (depuis le ${dateCourte(g.reference)}) : acquis` }), el('dd', { texte: joursConges(g.n_acquis) }),
      el('dt', { texte: 'Période en cours : pris' }), el('dd', { texte: joursConges(g.n_pris) }),
      el('dt', { texte: 'Période en cours : reste' }), el('dd', { texte: joursConges(g.n_solde) })));
}

function mentions() {
  return el('section', { classe: 'doc-mentions bulletin-mentions' },
    el('p', { texte: 'Dans votre intérêt et pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée.' }),
    el('p', { texte: 'Pour toute information complémentaire, consultez la rubrique dédiée au bulletin de paie sur le portail www.service-public.fr.' }),
    el('p', { texte: 'Le montant net social est égal au salaire brut, diminué des cotisations et contributions sociales obligatoires à la charge du salarié et augmenté de la part patronale de la prévoyance complémentaire. C\'est le montant à déclarer pour la prime d\'activité ou le RSA : www.mesdroitssociaux.gouv.fr.' }));
}
