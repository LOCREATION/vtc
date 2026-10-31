// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — congés et absences
// -----------------------------------------------------------------------------
//   - demandes des salariés (depuis l'application) : accepter, ou refuser
//     avec un motif transmis au salarié ;
//   - soldes de congés payés au dernier bulletin validé (N-1 et N), et les
//     congés acceptés depuis, à décompter sur les prochains bulletins ;
//   - absences d'une période : saisie (validée d'office), correction,
//     suppression ; une absence d'un mois dont le bulletin est validé est
//     figée (elle se régularise sur le bulletin suivant).
// Les congés payés se décomptent en jours ouvrables (lundi au samedi, jours
// fériés exclus) : une semaine complète de congés va du lundi au samedi.
// Lectures et actions : admin_lister_absences, admin_enregistrer_absence,
// admin_decider_absence ; suppression directe (administration).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import {
  tableau, tuile, boutonAction, boutonExporter, exporterCsv, fenetreFormulaire, confirmer, messageErreurAdmin, dateCourte, jourParis
} from '../commun/composants.js';
import { champsPeriode, periodeValable, periodeLisible } from '../commun/periode.js';
import { ecrireAdresse, lireDate, nomFichier } from '../commun/listes.js';
import { TYPES_ABSENCE, STATUTS_ABSENCE, pastille, decimal, joursConges, moisEnLettres } from './commun-rh.js';

const $ = (id) => document.getElementById(id);
const filtres = { du: '', au: '', salarie: '' };
const etat = { donnees: null };

export function afficherAbsences({ parametres }) {
  // Par défaut : l'année entière (les congés à venir comptent aussi)
  const annee = jourParis().slice(0, 4);
  const defaut = { du: `${annee}-01-01`, au: `${annee}-12-31` };
  filtres.du = lireDate(parametres, 'du') || defaut.du;
  filtres.au = lireDate(parametres, 'au') || defaut.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, defaut);
  filtres.salarie = parametres.get('salarie') || '';

  const ajouter = el('button', { type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Ajouter une absence' });
  ajouter.addEventListener('click', () => formulaireAbsence(null));
  $('entete-actions').replaceChildren(ajouter, boutonExporter(exporter));

  const choixSalarie = el('select', { id: 'absences-salarie', classe: 'saisie' }, el('option', { value: '', texte: 'Tous' }));
  choixSalarie.addEventListener('change', () => { filtres.salarie = choixSalarie.value; charger(); });
  const formulaire = el('form', { classe: 'barre-outils' },
    ...champsPeriode({ prefixe: 'absences', du: filtres.du, au: filtres.au, changer: ({ du, au }) => { filtres.du = du; filtres.au = au; charger(); } }),
    el('div', { classe: 'champ' }, el('label', { for: 'absences-salarie', texte: 'Salarié' }), choixSalarie));
  formulaire.addEventListener('submit', (e) => e.preventDefault());

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-absences', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', id: 'carte-demandes', 'aria-labelledby': 'titre-demandes', hidden: true },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-demandes', texte: 'Demandes à traiter' })),
      el('div', { id: 'liste-demandes' })),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-soldes' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-soldes', texte: 'Soldes de congés payés' })),
      el('p', { classe: 'aide-module', texte: 'Soldes au dernier bulletin validé : 2,5 jours ouvrables acquis par mois (période du 1er juin au 31 mai), les congés pris se décomptant d\'abord de la période précédente (N-1). Les congés acceptés depuis se décompteront sur les prochains bulletins.' }),
      el('div', { id: 'liste-soldes' })),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-absences' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-absences', texte: 'Absences' }), el('span', { classe: 'sous-titre', id: 'periode-absences' })),
      formulaire,
      el('div', { id: 'liste-absences' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  charger();
}

async function charger() {
  ecrireAdresse('absences', { du: filtres.du, au: filtres.au, salarie: filtres.salarie });
  const zone = $('liste-absences');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_absences', { p_debut: filtres.du, p_fin: filtres.au, p_salarie: filtres.salarie || null });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;
  const choix = $('absences-salarie');
  choix.replaceChildren(el('option', { value: '', texte: 'Tous' }), ...data.salaries.map((s) => el('option', { value: s.id, texte: s.nom })));
  choix.value = data.salaries.some((s) => s.id === filtres.salarie) ? filtres.salarie : '';
  $('periode-absences').textContent = periodeLisible(filtres.du, filtres.au);

  const validees = data.lignes.filter((a) => a.statut === 'validee');
  const jours = (type) => validees.filter((a) => a.type === type).reduce((n, a) => n + Number(a.jours), 0);
  $('chiffres-absences').replaceChildren(
    tuile('Demandes en attente', String(data.demandes.length), data.demandes.length ? 'à accepter ou refuser' : 'aucune', data.demandes.length ? 'or' : null),
    tuile('Congés payés', `${decimal(jours('conges_payes'), 0, 1)} j`, 'jours ouvrables acceptés sur la période'),
    tuile('Maladie et accidents', `${decimal(jours('maladie') + jours('accident_travail'), 0, 1)} j`, 'jours calendaires'),
    tuile('Autres absences', `${decimal(jours('sans_solde') + jours('autre'), 0, 1)} j`, 'sans solde et autres'));

  // Demandes
  $('carte-demandes').hidden = !data.demandes.length;
  $('liste-demandes').replaceChildren(tableau({
    colonnes: [
      { titre: 'Salarié', valeur: (a) => el('strong', { texte: a.nom }) },
      { titre: 'Demande', valeur: (a) => el('span', {}, pastille(TYPES_ABSENCE, a.type),
        el('span', { classe: 'secondaire', texte: `du ${dateCourte(a.debut)} au ${dateCourte(a.fin)} · ${decimal(a.jours, 0, 1)} j` })) },
      { titre: 'Commentaire', valeur: (a) => a.commentaire || '' },
      { titre: '', valeur: (a) => el('span', { classe: 'actions-ligne' },
        boutonAction('Accepter', () => decider(a, 'validee'), 'bouton-principal'),
        boutonAction('Refuser', () => decider(a, 'refusee'), 'bouton-danger')) }
    ],
    lignes: data.demandes
  }));

  // Soldes
  $('liste-soldes').replaceChildren(tableau({
    colonnes: [
      { titre: 'Salarié', valeur: (s) => el('strong', { texte: s.nom }) },
      { titre: 'N-1 à prendre', droite: true, valeur: (s) => soldeTexte(s, 'n1_solde') },
      { titre: 'N acquis', droite: true, valeur: (s) => soldeTexte(s, 'n_solde') },
      { titre: 'Au', valeur: (s) => (s.au ? `fin ${moisEnLettres(s.au)}` : s.reprise ? `fin ${moisEnLettres(s.reprise.mois)} (reprise)` : el('span', { classe: 'texte-gris', texte: 'aucun bulletin validé' })) },
      { titre: 'Acceptés depuis', droite: true, valeur: (s) => (Number(s.pris_ensuite) ? `${decimal(s.pris_ensuite, 0, 1)} j` : '') }
    ],
    lignes: data.soldes,
    vide: 'Aucun salarié.'
  }));

  // Absences
  zone.replaceChildren(tableau({
    colonnes: [
      { titre: 'Salarié', valeur: (a) => el('strong', { texte: a.nom }) },
      { titre: 'Absence', valeur: (a) => el('span', {}, pastille(TYPES_ABSENCE, a.type), a.commentaire ? el('span', { classe: 'secondaire', texte: a.commentaire }) : null) },
      { titre: 'Dates', valeur: (a) => `du ${dateCourte(a.debut)} au ${dateCourte(a.fin)}` },
      { titre: 'Jours', droite: true, valeur: (a) => decimal(a.jours, 0, 1) },
      { titre: 'État', valeur: (a) => el('span', {}, pastille(STATUTS_ABSENCE, a.statut),
        a.decision_note ? el('span', { classe: 'secondaire', texte: a.decision_note }) : null,
        a.verrouille ? el('span', { classe: 'secondaire', texte: 'bulletin validé : figée' }) : null) },
      { titre: '', valeur: (a) => (a.verrouille ? null : el('span', { classe: 'actions-ligne' },
        a.statut !== 'demandee' ? boutonAction('Corriger', () => formulaireAbsence(a)) : null,
        boutonAction('Supprimer', () => supprimer(a), 'bouton-danger'))) }
    ],
    lignes: data.lignes,
    vide: 'Aucune absence sur cette période.'
  }));
}

function soldeTexte(s, cle) {
  const valeur = s.au ? s[cle] : s.reprise ? s.reprise[cle] : null;
  if (valeur === null || valeur === undefined) return '';
  return el('span', { classe: Number(valeur) < 0 ? 'texte-rouge' : null, texte: joursConges(valeur) });
}

async function formulaireAbsence(a) {
  const salaries = (etat.donnees && etat.donnees.salaries) || [];
  if (!salaries.length) { afficherMessage('Aucun salarié : créez d\'abord sa fiche (onglet « Salariés »).', 'erreur'); return; }
  const fait = await fenetreFormulaire({
    titre: a ? `Absence de ${a.nom}` : 'Ajouter une absence',
    intro: 'Congés payés : jours ouvrables, du lundi au samedi (une semaine complète va du lundi au samedi, le samedi compte même s\'il n\'est pas travaillé). Autres absences : jours calendaires. Laissez « Jours décomptés » vide pour le calcul automatique.',
    champs: [
      { nom: 'salarie', libelle: 'Salarié', type: 'choix', requis: true, vide: 'Choisir…', options: salaries.map((s) => ({ valeur: s.id, libelle: s.nom })) },
      { nom: 'type', libelle: 'Type', type: 'choix', requis: true, options: Object.entries(TYPES_ABSENCE).map(([valeur, t]) => ({ valeur, libelle: t.libelle })) },
      { nom: 'debut', libelle: 'Premier jour d\'absence', type: 'date', requis: true },
      { nom: 'fin', libelle: 'Dernier jour d\'absence', type: 'date', requis: true },
      { nom: 'jours', libelle: 'Jours décomptés', type: 'nombre', min: 0.5, aide: 'Seulement pour une demi-journée ou un décompte particulier.' },
      { nom: 'commentaire', libelle: 'Commentaire', type: 'texte', longueur: 500, plein: true, aide: 'Ex. « arrêt de travail reçu le 15/09 ». Jamais le motif d\'une grève.' }
    ],
    valeurs: a ? { salarie: a.salarie_id, type: a.type, debut: a.debut, fin: a.fin, jours: null, commentaire: a.commentaire }
      : { salarie: filtres.salarie || (salaries.length === 1 ? salaries[0].id : ''), type: 'conges_payes' },
    libelle: a ? 'Enregistrer' : 'Ajouter',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_enregistrer_absence', {
        p_absence: a ? a.id : null, p_salarie: v.salarie, p_type: v.type, p_debut: v.debut, p_fin: v.fin, p_jours: v.jours, p_commentaire: v.commentaire
      });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage(a ? 'Absence corrigée.' : 'Absence ajoutée.', 'succes'); charger(); }
}

async function decider(a, decision) {
  const ok = await confirmer({
    titre: decision === 'validee' ? `Accepter la demande de ${a.nom} ?` : `Refuser la demande de ${a.nom} ?`,
    texte: `${TYPES_ABSENCE[a.type].libelle} du ${dateCourte(a.debut)} au ${dateCourte(a.fin)} (${decimal(a.jours, 0, 1)} j). Le salarié est prévenu dans l'application.`,
    libelle: decision === 'validee' ? 'Accepter' : 'Refuser', danger: decision === 'refusee',
    motif: decision === 'refusee' ? { libelle: 'Motif du refus', obligatoire: true, aide: 'Transmis au salarié.' } : null
  });
  if (!ok) return;
  const { error } = await supabase.rpc('admin_decider_absence', { p_absence: a.id, p_decision: decision, p_note: ok.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(decision === 'validee' ? 'Demande acceptée.' : 'Demande refusée.', 'succes');
  charger();
}

async function supprimer(a) {
  const ok = await confirmer({ titre: 'Supprimer cette absence ?', texte: `${a.nom} : ${TYPES_ABSENCE[a.type].libelle.toLowerCase()} du ${dateCourte(a.debut)} au ${dateCourte(a.fin)}. Elle reste lisible dans le journal des modifications.`, libelle: 'Supprimer', danger: true });
  if (!ok) return;
  const { error } = await supabase.from('absences').delete().eq('id', a.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Absence supprimée.', 'succes');
  charger();
}

function exporter() {
  if (!etat.donnees || !etat.donnees.lignes.length) { afficherMessage('Aucune absence à exporter sur cette période.'); return; }
  exporterCsv(`${nomFichier('absences', filtres.du, filtres.au)}.csv`, [
    { titre: 'Salarié', csv: (a) => a.nom }, { titre: 'Type', csv: (a) => TYPES_ABSENCE[a.type].libelle },
    { titre: 'Du', csv: (a) => dateCourte(a.debut) }, { titre: 'Au', csv: (a) => dateCourte(a.fin) },
    { titre: 'Jours', csv: (a) => String(a.jours).replace('.', ',') }, { titre: 'État', csv: (a) => STATUTS_ABSENCE[a.statut].libelle },
    { titre: 'Commentaire', csv: (a) => a.commentaire || '' }, { titre: 'Décision', csv: (a) => a.decision_note || '' }
  ], absencesChronologiques());
}

// Absences dans l'ordre des dates (puis des noms), pour l'export
function absencesChronologiques() {
  return [...etat.donnees.lignes].sort((x, y) => (x.debut < y.debut ? -1 : x.debut > y.debut ? 1 : x.nom.localeCompare(y.nom)));
}

