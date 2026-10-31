// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — bulletins d'un mois
// -----------------------------------------------------------------------------
// Chaque salarié sous contrat dans le mois, et l'état de son bulletin :
//   - à établir (bouton « Préparer ») ; brouillon (points bloquants
//     signalés) ; validé ; remis au salarié ;
//   - chiffres du mois : brut, net à payer, prélèvement à la source, coût
//     total employeur ;
//   - validation directe d'un brouillon sans point bloquant, suppression
//     d'un brouillon, remise (avec le PDF imprimé, facultatif) ;
//   - export pour l'expert-comptable (un bulletin par ligne).
// Lectures et actions : admin_lister_bulletins, admin_valider_bulletin,
// admin_remettre_bulletin ; suppression directe d'un brouillon.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, badge, boutonAction, boutonExporter, exporterCsv, confirmer, fenetreFormulaire, messageErreurAdmin, dateCourte, pluriel
} from '../commun/composants.js';
import { nomFichier } from '../commun/listes.js';
import { STATUTS_BULLETIN, pastille, montant, debutMois, moisEnLettres, choixMois, decimal } from './commun-rh.js';

const $ = (id) => document.getElementById(id);
const etat = { mois: debutMois(), donnees: null };

export function afficherBulletins({ parametres }) {
  const demande = parametres.get('periode');
  if (demande && /^\d{4}-\d{2}-01$/.test(demande)) etat.mois = demande;
  $('entete-actions').replaceChildren(boutonExporter(exporter));
  const formulaire = el('form', { classe: 'barre-outils' },
    el('div', { classe: 'champ' }, el('label', { for: 'bulletins-mois', texte: 'Mois' }),
      choixMois({ id: 'bulletins-mois', valeur: etat.mois, changer: (m) => { etat.mois = m; charger(); } })));
  formulaire.addEventListener('submit', (e) => e.preventDefault());
  $('contenu').replaceChildren(
    el('div', { id: 'alerte-parametres' }),
    el('div', { classe: 'chiffres-cles', id: 'chiffres-bulletins', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-bulletins' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-bulletins', texte: 'Bulletins de paie' }),
        el('span', { classe: 'sous-titre', id: 'mois-bulletins' })),
      el('p', { classe: 'aide-module', texte: 'Chaque bulletin est calculé par la base à partir de la fiche du salarié, des paramètres de paie de l\'année et des variables du mois (heures, absences, primes). Chaque ligne et chaque total sont revérifiés au centime. Validez les mois dans l\'ordre : les cumuls, la réduction générale et les congés en dépendent.' }),
      formulaire,
      el('div', { id: 'liste-bulletins' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  charger();
}

async function charger() {
  history.replaceState(null, '', `${location.pathname}?vue=bulletins&periode=${etat.mois}`);
  const zone = $('liste-bulletins');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_bulletins', { p_periode: etat.mois });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;
  const t = data.totaux;
  const p = data.parametres;
  $('mois-bulletins').textContent = moisEnLettres(etat.mois);
  $('alerte-parametres').replaceChildren(!p.existent || !p.valides ? el('p', { classe: 'alerte' },
    p.existent ? `Paramètres de paie ${p.annee} pas encore validés par l'expert-comptable : les bulletins se préparent, ils ne se valident pas. `
      : `Paramètres de paie ${p.annee} absents : créez-les à partir de l'année précédente. `,
    el('a', { href: lienAdmin('rh/?vue=parametres'), texte: 'Ouvrir les paramètres de paie' })) : '');
  $('chiffres-bulletins').replaceChildren(
    tuile('Salaires bruts', montant(t.brut), `${pluriel(t.valides, 'bulletin validé', 'bulletins validés')} · ${pluriel(t.brouillons, 'brouillon', 'brouillons')}`),
    tuile('Nets à payer', montant(t.net_a_payer), 'à virer aux salariés'),
    tuile('Prélèvement à la source', montant(t.pas), 'à reverser par la déclaration sociale'),
    tuile('Coût total employeur', montant(t.cout_employeur), data.manquants ? `${pluriel(data.manquants, 'bulletin', 'bulletins')} encore à établir` : 'tous les bulletins sont établis',
      data.manquants ? 'or' : null));

  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Salarié', valeur: (l) => el('span', {}, el('strong', { texte: l.nom }),
        el('span', { classe: 'secondaire', texte: `${l.matricule} · ${l.emploi}` })) },
      { titre: 'Bulletin', valeur: (l) => etatBulletin(l) },
      { titre: 'Brut', droite: true, valeur: (l) => (l.bulletin ? montant(l.bulletin.brut) : '') },
      { titre: 'Net à payer', droite: true, valeur: (l) => (l.bulletin ? el('strong', { texte: montant(l.bulletin.net_a_payer) }) : '') },
      { titre: 'Coût employeur', droite: true, valeur: (l) => (l.bulletin ? montant(l.bulletin.cout_employeur) : '') },
      { titre: '', valeur: (l) => actions(l) }
    ],
    lignes: data.lignes,
    vide: `Aucun salarié sous contrat en ${moisEnLettres(etat.mois)}.`
  }));
}

function etatBulletin(l) {
  const b = l.bulletin;
  if (!b) {
    return l.present ? badge('À établir', 'rouge') : el('span', { classe: 'texte-gris', texte: 'hors contrat ce mois-ci' });
  }
  return el('span', {}, pastille(STATUTS_BULLETIN, b.statut),
    b.statut === 'brouillon' && b.bloquants ? el('span', { classe: 'secondaire texte-rouge', texte: pluriel(b.bloquants, 'point bloquant', 'points bloquants') }) : null,
    b.valide_le ? el('span', { classe: 'secondaire', texte: `validé le ${dateCourte(b.valide_le)}` }) : null);
}

function actions(l) {
  const b = l.bulletin;
  const preparer = lienAdmin(`rh/?preparer=${l.salarie_id}&periode=${etat.mois}`);
  if (!b) {
    return l.present ? el('a', { classe: 'bouton bouton-principal bouton-petit', href: preparer, texte: 'Préparer' }) : null;
  }
  const boutons = [];
  if (b.statut === 'brouillon') {
    boutons.push(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: preparer, texte: 'Modifier' }));
    if (!b.bloquants) boutons.push(boutonAction('Valider', () => valider(l), 'bouton-principal'));
    boutons.push(boutonAction('Supprimer', () => supprimer(l), 'bouton-danger'));
  } else {
    boutons.push(el('a', { classe: 'bouton bouton-secondaire bouton-petit', href: lienAdmin(`rh/?bulletin=${b.id}`), texte: 'Voir, imprimer' }));
    if (b.statut === 'valide') boutons.push(boutonAction('Remis au salarié', () => remettre(l)));
  }
  return el('span', { classe: 'actions-ligne' }, ...boutons);
}

async function valider(l) {
  const ok = await confirmer({
    titre: `Valider le bulletin de ${l.nom} ?`,
    texte: `${moisEnLettres(etat.mois)} : net à payer ${montant(l.bulletin.net_a_payer)}. Le bulletin est recalculé avec les paramètres du moment, puis figé : une erreur se corrigera sur le bulletin du mois suivant.${l.compte ? ' Le salarié est prévenu dans l\'application.' : ''}`,
    libelle: 'Valider'
  });
  if (!ok) return;
  const { error } = await supabase.rpc('admin_valider_bulletin', { p_bulletin: l.bulletin.id });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Bulletin validé.', 'succes');
  charger();
}

async function supprimer(l) {
  const ok = await confirmer({ titre: 'Supprimer ce brouillon ?', texte: `Bulletin de ${l.nom}, ${moisEnLettres(etat.mois)}. Il reste lisible dans le journal des modifications.`, libelle: 'Supprimer', danger: true });
  if (!ok) return;
  const { error } = await supabase.from('bulletins').delete().eq('id', l.bulletin.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Brouillon supprimé.', 'succes');
  charger();
}

// Remis au salarié, avec le PDF imprimé (« Enregistrer en PDF ») facultatif
export async function remettreBulletin({ id, salarieId, nom, periode }) {
  const fichier = el('input', { id: 'bulletin-pdf', classe: 'saisie', type: 'file', accept: '.pdf,application/pdf' });
  return fenetreFormulaire({
    titre: `Bulletin de ${nom} remis`,
    intro: `${moisEnLettres(periode)}. Joignez si vous le souhaitez le PDF du bulletin (bouton « Imprimer ou enregistrer en PDF » du bulletin) : il est rangé dans le dossier privé de la paie.`,
    champs: [],
    avant: [el('div', { classe: 'champ' }, el('label', { for: 'bulletin-pdf', texte: 'PDF du bulletin (facultatif, 10 Mo au plus)' }), fichier)],
    libelle: 'Noter comme remis',
    enregistrer: async () => {
      const choisi = fichier.files[0] || null;
      let chemin = null;
      if (choisi) {
        if (choisi.size > 10 * 1024 * 1024) throw new Error('Fichier trop lourd : 10 Mo au plus.');
        if (choisi.type && choisi.type !== 'application/pdf') throw new Error('Format refusé : PDF seulement.');
        chemin = `${salarieId}/bulletins/${periode.slice(0, 7)}-${Date.now()}.pdf`;
        const envoi = await supabase.storage.from('paie').upload(chemin, choisi, { contentType: 'application/pdf', upsert: false });
        if (envoi.error) throw envoi.error;
      }
      const { data, error } = await supabase.rpc('admin_remettre_bulletin', { p_bulletin: id, p_chemin: chemin });
      if (error) { if (chemin) await supabase.storage.from('paie').remove([chemin]); throw error; }
      if (data) await supabase.storage.from('paie').remove([data]);
    }
  });
}

async function remettre(l) {
  const fait = await remettreBulletin({ id: l.bulletin.id, salarieId: l.salarie_id, nom: l.nom, periode: etat.mois });
  if (fait) { afficherMessage('Bulletin noté comme remis.', 'succes'); charger(); }
}

// ---------------------------------------------------------------------------
// Export pour l'expert-comptable : les bulletins du mois, un par ligne
// ---------------------------------------------------------------------------
async function exporter() {
  const lignes = (etat.donnees ? etat.donnees.lignes : []).filter((l) => l.bulletin);
  if (!lignes.length) { afficherMessage('Aucun bulletin ce mois-ci.'); return; }
  const documents = await Promise.all(lignes.map((l) => supabase.rpc('admin_document_bulletin', { p_bulletin: l.bulletin.id })));
  const probleme = documents.find((d) => d.error);
  if (probleme) { afficherMessage(messageErreurAdmin(probleme.error), 'erreur'); return; }
  const n = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
  exporterCsv(`${nomFichier('bulletins', etat.mois.slice(0, 7))}.csv`, [
    { titre: 'Matricule', csv: (d) => d.calcul.salarie.matricule },
    { titre: 'Salarié', csv: (d) => `${d.calcul.salarie.nom} ${d.calcul.salarie.prenom}` },
    { titre: 'État', csv: (d) => STATUTS_BULLETIN[d.statut].libelle },
    { titre: 'Heures payées', csv: (d) => n(d.calcul.heures.payees) },
    { titre: 'Heures supplémentaires ou complémentaires', csv: (d) => n(Number(d.calcul.heures.sup_25) + Number(d.calcul.heures.sup_50)
      + Number(d.calcul.heures.comp_10) + Number(d.calcul.heures.comp_25)) },
    { titre: 'Taux horaire', csv: (d) => decimal(d.calcul.taux_horaire, 4, 6) },
    { titre: 'Brut', csv: (d) => n(d.calcul.brut) },
    { titre: 'Cotisations salariales', csv: (d) => n(d.calcul.totaux.cotisations_salariales) },
    { titre: 'Cotisations patronales', csv: (d) => n(d.calcul.totaux.cotisations_patronales) },
    { titre: 'Allègements', csv: (d) => n(d.calcul.totaux.allegements) },
    { titre: 'Réduction générale', csv: (d) => n(d.calcul.rgdu.reduction_mois) },
    { titre: 'Net avant impôt', csv: (d) => n(d.calcul.net_avant_impot) },
    { titre: 'Net social', csv: (d) => n(d.calcul.net_social) },
    { titre: 'Net imposable', csv: (d) => n(d.calcul.net_imposable) },
    { titre: 'Taux PAS', csv: (d) => n(d.calcul.pas.taux) },
    { titre: 'Type de taux', csv: (d) => (d.calcul.pas.type === 'personnalise' ? 'personnalisé' : 'neutre') },
    { titre: 'Prélèvement à la source', csv: (d) => n(d.calcul.pas.montant) },
    { titre: 'Net à payer', csv: (d) => n(d.calcul.net_a_payer) },
    { titre: 'Coût total employeur', csv: (d) => n(d.calcul.cout_employeur) },
    { titre: 'Date de paiement', csv: (d) => dateCourte(d.calcul.date_paiement) }
  ], documents.map((d) => d.data));
}
