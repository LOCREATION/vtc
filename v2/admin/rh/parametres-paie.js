// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — paramètres de paie
// -----------------------------------------------------------------------------
// Une année de paie :
//   - validation par l'expert-comptable (qui, quand) : sans elle, aucun
//     bulletin ne se valide ; une année validée ne se modifie plus sans
//     retirer d'abord la validation (motif conservé au journal) ;
//   - constantes : plafond de la Sécurité sociale, SMIC, réduction générale
//     dégressive unique, heures supplémentaires, abattement de CSG ;
//   - lignes de cotisation : taux salariaux et patronaux, forfaits
//     (complémentaire santé), plafonds, conditions, imputation de la
//     réduction générale ;
//   - SMIC et ses revalorisations, grille du taux neutre du prélèvement à la
//     source ;
//   - création de l'année suivante à partir de l'année choisie.
// Lectures et actions : admin_parametres_paie, admin_valider_parametres_paie,
// admin_retirer_validation_paie, admin_copier_parametres_paie ; écritures
// directes (constantes, lignes, SMIC, grille) protégées par la base.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, afficherMessage } from '../../commun/outils.js';
import {
  tableau, badge, boutonAction, fenetreFormulaire, confirmer, messageErreurAdmin, dateCourte, ligne, jourParis
} from '../commun/composants.js';
import { decimal, montant, pourcent } from './commun-rh.js';

const $ = (id) => document.getElementById(id);
const SECTIONS = { sante: 'Santé', accidents_travail: 'Accidents du travail', retraite: 'Retraite', famille: 'Famille',
  chomage: 'Assurance chômage', autres: 'Autres contributions', csg_crds: 'CSG et CRDS' };
const ASSIETTES = { brut: 'Salaire brut', tranche_1: 'Tranche 1 (jusqu\'au plafond)', tranche_2: 'Tranche 2 (de 1 à 8 plafonds)',
  csg_crds: 'Assiette CSG-CRDS (98,25 % du brut)', forfait: 'Forfait mensuel' };
const CONDITIONS = { toujours: 'Tous les salariés', cadre: 'Cadres', non_cadre: 'Non-cadres', au_dela_plafond: 'Salaire au-dessus du plafond' };
const PROTECTIONS = { sante: 'Complémentaire santé', prevoyance: 'Prévoyance' };
const etat = { annee: Number(jourParis().slice(0, 4)), donnees: null };

export function afficherParametresPaie({ parametres }) {
  const demande = Number(parametres.get('annee'));
  if (demande >= 2020 && demande <= 2100) etat.annee = demande;
  charger();
}

async function charger() {
  history.replaceState(null, '', `${location.pathname}?vue=parametres&annee=${etat.annee}`);
  const { data, error } = await supabase.rpc('admin_parametres_paie', { p_annee: etat.annee });
  if (error) { $('contenu').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.donnees = data;
  const annees = data.annees.length ? data.annees : [etat.annee];
  const choix = el('select', { id: 'paie-annee', classe: 'saisie' },
    ...[...new Set([...annees, etat.annee])].sort((a, b) => b - a).map((a) => el('option', { value: String(a), texte: String(a) })));
  choix.value = String(etat.annee);
  choix.addEventListener('change', () => { etat.annee = Number(choix.value); charger(); });
  const derniere = Math.max(...annees);
  const creer = boutonAction(`Créer ${derniere + 1} à partir de ${derniere}`, () => copier(derniere, derniere + 1));
  $('entete-actions').replaceChildren(creer);

  if (!data.constantes) {
    $('contenu').replaceChildren(el('form', { classe: 'barre-outils' }, el('div', { classe: 'champ' }, el('label', { for: 'paie-annee', texte: 'Année' }), choix)),
      el('section', { classe: 'carte-admin' }, el('p', { texte: `Aucun paramètre de paie pour ${etat.annee}. Créez l'année à partir de la précédente (bouton en haut), puis mettez à jour les valeurs qui changent au 1er janvier.` })));
    return;
  }
  const valide = data.constantes.valide_par_comptable;
  $('contenu').replaceChildren(
    el('form', { classe: 'barre-outils' }, el('div', { classe: 'champ' }, el('label', { for: 'paie-annee', texte: 'Année' }), choix)),
    blocValidation(data),
    blocConstantes(data, valide),
    blocLignes(data, valide),
    el('div', { classe: 'grille-2' }, blocSmic(data), blocGrille(data)));
}

// ---------------------------------------------------------------------------
// Validation par l'expert-comptable
// ---------------------------------------------------------------------------
function blocValidation(d) {
  const c = d.constantes;
  const points = d.points || [];
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-validation' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-validation', texte: `Paramètres de paie ${d.annee}` }),
      c.valide_par_comptable ? badge('Validés par l\'expert-comptable', 'vert') : badge('À faire valider', 'or')),
    c.valide_par_comptable
      ? el('p', {}, `Validés le ${dateCourte(c.valide_le)}${c.valide_par_nom ? ` (saisi par ${c.valide_par_nom})` : ''} : ${c.validation_note}. `,
        `${d.bulletins_valides} bulletin${d.bulletins_valides > 1 ? 's' : ''} validé${d.bulletins_valides > 1 ? 's' : ''} sur ${d.annee}.`)
      : el('p', { classe: 'aide-module', texte: `Faites vérifier ces valeurs par l'expert-comptable, puis validez-les : sans validation, les bulletins se préparent mais ne se valident pas.${c.validation_note ? ` Dernière note : ${c.validation_note}.` : ''}` }),
    points.length ? el('ul', { classe: 'liste-controles' }, ...points.map((x) => el('li', { dataset: { niveau: x.niveau } },
      el('span', { classe: 'controle-niveau', texte: x.niveau === 'bloquant' ? 'Bloquant' : 'Attention' }), el('span', { texte: x.message })))) : null,
    el('div', { classe: 'actions-ligne' }, c.valide_par_comptable
      ? boutonAction('Retirer la validation', retirerValidation, 'bouton-danger')
      : boutonAction('Valider les paramètres', validerParametres, 'bouton-principal')));
}

async function validerParametres() {
  const fait = await fenetreFormulaire({
    titre: `Valider les paramètres de paie ${etat.annee}`,
    intro: 'Seulement après la vérification de l\'expert-comptable. Le nom du cabinet et la date sont inscrits avec la validation.',
    champs: [{ nom: 'note', libelle: 'Validé par (cabinet, expert-comptable) et quand', type: 'texte', requis: true, longueur: 300, plein: true,
      placeholder: 'Ex. Cabinet Durand Expertise, le 30/10/2026' }],
    libelle: 'Valider',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_valider_parametres_paie', { p_annee: etat.annee, p_note: v.note });
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Paramètres validés.', 'succes'); charger(); }
}

async function retirerValidation() {
  const ok = await confirmer({
    titre: 'Retirer la validation ?',
    texte: 'Les bulletins déjà validés restent tels quels. Les suivants ne se valideront qu\'après une nouvelle validation.',
    libelle: 'Retirer', danger: true, motif: { libelle: 'Motif', obligatoire: true, aide: 'Conservé dans le journal (ex. « nouveau taux AT notifié »).' }
  });
  if (!ok) return;
  const { error } = await supabase.rpc('admin_retirer_validation_paie', { p_annee: etat.annee, p_motif: ok.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Validation retirée : les paramètres peuvent être corrigés.', 'succes');
  charger();
}

async function copier(source, cible) {
  const ok = await confirmer({
    titre: `Créer les paramètres ${cible} ?`,
    texte: `Toutes les valeurs de ${source} sont recopiées, non validées : mettez à jour celles qui changent au 1er janvier (plafond, SMIC, taux), puis faites-les valider.`,
    libelle: 'Créer'
  });
  if (!ok) return;
  const { error } = await supabase.rpc('admin_copier_parametres_paie', { p_source: source, p_cible: cible });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  etat.annee = cible;
  afficherMessage(`Paramètres ${cible} créés.`, 'succes');
  charger();
}

// ---------------------------------------------------------------------------
// Constantes de l'année
// ---------------------------------------------------------------------------
const CHAMPS_CONSTANTES = [
  { nom: 'plafond_mensuel_ss', libelle: 'Plafond mensuel de la Sécurité sociale (€)', type: 'nombre', requis: true, min: 1, format: montant },
  { nom: 'smic_horaire', libelle: 'SMIC horaire au 1er janvier (€)', type: 'nombre', requis: true, min: 1, format: (v) => `${decimal(v, 2, 4)} €` },
  { nom: 'smic_horaire_rgdu', libelle: 'SMIC horaire de la réduction générale (€)', type: 'nombre', min: 1, format: (v) => `${decimal(v, 2, 4)} €` },
  { nom: 'rgdu_tmin', libelle: 'Réduction générale : Tmin', type: 'nombre', min: 0, max: 1, format: (v) => decimal(v, 4, 4) },
  { nom: 'rgdu_tdelta', libelle: 'Réduction générale : Tdelta', type: 'nombre', min: 0, max: 1, format: (v) => decimal(v, 4, 4) },
  { nom: 'rgdu_p', libelle: 'Réduction générale : exposant P', type: 'nombre', min: 0.001, format: (v) => decimal(v, 2, 3) },
  { nom: 'rgdu_taux_at', libelle: 'Réduction générale : part de la cotisation AT (%)', type: 'nombre', min: 0, max: 10, format: pourcent },
  { nom: 'abattement_csg', libelle: 'Abattement d\'assiette de la CSG (%)', type: 'nombre', requis: true, min: 0, max: 10, format: pourcent },
  { nom: 'reduction_salariale_hs', libelle: 'Réduction salariale sur heures supplémentaires (%)', type: 'nombre', requis: true, min: 0, max: 20, format: pourcent },
  { nom: 'deduction_patronale_hs', libelle: 'Déduction patronale par heure supplémentaire (€)', type: 'nombre', requis: true, min: 0, format: (v) => `${decimal(v, 2, 2)} €` },
  { nom: 'plafond_exoneration_hs', libelle: 'Plafond annuel d\'exonération d\'impôt des heures supplémentaires (€)', type: 'nombre', requis: true, min: 0, format: montant }
];

function blocConstantes(d, valide) {
  const c = d.constantes;
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-constantes' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-constantes', texte: 'Constantes de l\'année' }),
      valide ? null : boutonAction('Modifier', modifierConstantes)),
    el('dl', { classe: 'fiche-donnees' }, ...CHAMPS_CONSTANTES.flatMap((ch) => ligne(ch.libelle,
      c[ch.nom] === null || c[ch.nom] === undefined ? el('span', { classe: 'texte-or', texte: 'Non renseigné' }) : ch.format(c[ch.nom])))),
    el('p', { classe: 'aide-module', texte: 'Les revalorisations du SMIC en cours d\'année se saisissent dans la liste des SMIC (plus bas) : le bulletin retient celle en vigueur à la fin du mois.' }));
}

async function modifierConstantes() {
  const c = etat.donnees.constantes;
  const fait = await fenetreFormulaire({
    titre: `Constantes ${etat.annee}`, large: true,
    intro: 'Sources : Urssaf (plafond, SMIC, réduction générale), Bulletin officiel de la Sécurité sociale. Les quatre valeurs de la réduction générale se renseignent ensemble.',
    champs: CHAMPS_CONSTANTES.map(({ format, ...ch }) => ch), valeurs: c,
    enregistrer: async (v) => {
      const rgdu = ['smic_horaire_rgdu', 'rgdu_tmin', 'rgdu_tdelta', 'rgdu_p', 'rgdu_taux_at'];
      const remplis = rgdu.filter((k) => v[k] !== null).length;
      if (remplis && remplis !== rgdu.length) throw new Error('Réduction générale : renseignez les cinq valeurs (SMIC, Tmin, Tdelta, P, part AT), ou aucune.');
      const { error } = await supabase.from('constantes_paie').update(v).eq('annee', etat.annee);
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Constantes enregistrées.', 'succes'); charger(); }
}

// ---------------------------------------------------------------------------
// Lignes de cotisation
// ---------------------------------------------------------------------------
function blocLignes(d, valide) {
  const ajouter = valide ? null : boutonAction('Ajouter une ligne', () => formulaireLigne(null));
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-lignes' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-lignes', texte: 'Cotisations et contributions' }), ajouter),
    el('p', { classe: 'aide-module', texte: 'Taux appliqués ligne par ligne (base × taux, arrondi au centime). « RG » : la réduction générale s\'impute sur la part patronale de la ligne. Le taux accidents du travail est celui notifié à l\'entreprise (compte AT/MP sur net-entreprises.fr).' }),
    tableau({
      colonnes: [
        { titre: 'Cotisation', valeur: (l) => el('span', { classe: l.actif ? null : 'texte-gris' }, el('strong', { texte: l.libelle }),
          el('span', { classe: 'secondaire', texte: `${SECTIONS[l.section]} · ${CONDITIONS[l.condition]}${l.protection ? ` · ${PROTECTIONS[l.protection]}` : ''}` })) },
        { titre: 'Assiette', valeur: (l) => el('span', {}, ASSIETTES[l.assiette],
          l.plafond_pmss ? el('span', { classe: 'secondaire', texte: `limitée à ${decimal(l.plafond_pmss, 0, 1)} plafonds` }) : null) },
        { titre: 'Salarié', droite: true, valeur: (l) => (l.assiette === 'forfait' ? montant(l.montant_salarial) : Number(l.taux_salarial) ? pourcent(l.taux_salarial) : '') },
        { titre: 'Employeur', droite: true, valeur: (l) => el('span', { classe: l.section === 'accidents_travail' && Number(l.taux_patronal) === 0 ? 'texte-rouge' : null },
          l.assiette === 'forfait' ? montant(l.montant_patronal) : Number(l.taux_patronal) ? pourcent(l.taux_patronal) : (l.section === 'accidents_travail' ? 'à saisir' : '')) },
        { titre: '', valeur: (l) => el('span', { classe: 'actions-ligne' },
          l.rgdu ? badge('RG', 'bleu') : null, l.actif ? null : badge('Inactive', 'gris'),
          valide ? null : boutonAction('Modifier', () => formulaireLigne(l)),
          valide ? null : boutonAction('Supprimer', () => supprimerLigne(l), 'bouton-danger')) }
      ],
      lignes: d.lignes
    }));
}

async function formulaireLigne(l) {
  const fait = await fenetreFormulaire({
    titre: l ? l.libelle : 'Nouvelle ligne de cotisation', large: true,
    intro: 'Taux en pourcentage de l\'assiette. Un forfait (complémentaire santé) se saisit en euros par mois.',
    champs: [
      { nom: 'libelle', libelle: 'Libellé sur le bulletin', type: 'texte', requis: true, longueur: 120, plein: true },
      { nom: 'code', libelle: 'Code (lettres minuscules, chiffres, « _ »)', type: 'texte', requis: true, longueur: 40, motif: /^[a-z0-9_]+$/,
        messageMotif: 'Lettres minuscules, chiffres et « _ » seulement.' },
      { nom: 'section', libelle: 'Rubrique du bulletin', type: 'choix', requis: true, options: Object.entries(SECTIONS).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'assiette', libelle: 'Assiette', type: 'choix', requis: true, options: Object.entries(ASSIETTES).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'taux_salarial', libelle: 'Taux salarial (%)', type: 'nombre', min: 0, max: 100 },
      { nom: 'taux_patronal', libelle: 'Taux patronal (%)', type: 'nombre', min: 0, max: 100 },
      { nom: 'montant_salarial', libelle: 'Forfait salarial (€ par mois)', type: 'nombre', min: 0 },
      { nom: 'montant_patronal', libelle: 'Forfait patronal (€ par mois)', type: 'nombre', min: 0 },
      { nom: 'plafond_pmss', libelle: 'Assiette limitée à … plafonds', type: 'nombre', min: 0.1, aide: '4 pour le chômage et l\'AGS, 8 pour la CET ; vide sinon.' },
      { nom: 'condition', libelle: 'Salariés concernés', type: 'choix', requis: true, options: Object.entries(CONDITIONS).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'protection', libelle: 'Protection complémentaire', type: 'choix', vide: 'Non', options: Object.entries(PROTECTIONS).map(([valeur, libelle]) => ({ valeur, libelle })) },
      { nom: 'ordre', libelle: 'Ordre sur le bulletin', type: 'nombre', pas: '1', min: 0 },
      { nom: 'deductible', libelle: 'Déductible du revenu imposable (part salariale)', type: 'case' },
      { nom: 'rgdu', libelle: 'La réduction générale s\'impute sur cette ligne', type: 'case' },
      { nom: 'actif', libelle: 'Ligne active', type: 'case' }
    ],
    valeurs: l || { section: 'autres', assiette: 'brut', condition: 'toujours', deductible: true, actif: true, ordre: 500 },
    preparer: (elements) => {
      const bloc = (nom) => elements[nom].saisie.closest('.champ');
      const basculer = () => {
        const forfait = elements.assiette.saisie.value === 'forfait';
        ['taux_salarial', 'taux_patronal'].forEach((n) => { bloc(n).hidden = forfait; });
        ['montant_salarial', 'montant_patronal'].forEach((n) => { bloc(n).hidden = !forfait; });
      };
      elements.assiette.saisie.addEventListener('change', basculer);
      basculer();
      if (l) elements.code.saisie.readOnly = true;
    },
    enregistrer: async (v) => {
      const forfait = v.assiette === 'forfait';
      const ligneSql = {
        ...v, annee: etat.annee, taux_salarial: forfait ? 0 : v.taux_salarial ?? 0, taux_patronal: forfait ? 0 : v.taux_patronal ?? 0,
        montant_salarial: forfait ? v.montant_salarial ?? 0 : null, montant_patronal: forfait ? v.montant_patronal ?? 0 : null,
        ordre: v.ordre ?? 0
      };
      const requete = l ? supabase.from('parametres_paie').update(ligneSql).eq('id', l.id) : supabase.from('parametres_paie').insert(ligneSql);
      const { error } = await requete;
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Ligne enregistrée.', 'succes'); charger(); }
}

async function supprimerLigne(l) {
  const ok = await confirmer({ titre: `Supprimer « ${l.libelle} » ?`, texte: 'Pour une cotisation qui ne s\'applique plus, vous pouvez aussi la rendre inactive. La suppression reste lisible dans le journal.', libelle: 'Supprimer', danger: true });
  if (!ok) return;
  const { error } = await supabase.from('parametres_paie').delete().eq('id', l.id);
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage('Ligne supprimée.', 'succes');
  charger();
}

// ---------------------------------------------------------------------------
// SMIC et ses revalorisations
// ---------------------------------------------------------------------------
function blocSmic(d) {
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-smic' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-smic', texte: 'SMIC horaire' }), boutonAction('Ajouter', () => formulaireSmic(null))),
    tableau({
      colonnes: [
        { titre: 'Depuis le', valeur: (m) => el('strong', { texte: dateCourte(m.valable_du) }) },
        { titre: 'Horaire', droite: true, valeur: (m) => `${decimal(m.horaire, 2, 4)} €` },
        { titre: 'Mensuel (151,67 h)', droite: true, valeur: (m) => montant(Math.round(Number(m.horaire) * 1820 / 12 * 100) / 100) },
        { titre: '', valeur: (m) => el('span', { classe: 'actions-ligne' }, boutonAction('Modifier', () => formulaireSmic(m))) }
      ],
      lignes: d.smic,
      vide: 'Aucun SMIC enregistré.'
    }));
}

async function formulaireSmic(m) {
  const fait = await fenetreFormulaire({
    titre: m ? `SMIC du ${dateCourte(m.valable_du)}` : 'Revalorisation du SMIC',
    champs: [
      { nom: 'valable_du', libelle: 'En vigueur depuis le', type: 'date', requis: true },
      { nom: 'horaire', libelle: 'SMIC horaire brut (€)', type: 'nombre', requis: true, min: 1 },
      { nom: 'source', libelle: 'Source', type: 'texte', longueur: 200, plein: true, aide: 'Ex. « Décret n° … du … ».' }
    ],
    valeurs: m || {},
    enregistrer: async (v) => {
      const requete = m ? supabase.from('smic').update(v).eq('valable_du', m.valable_du) : supabase.from('smic').insert(v);
      const { error } = await requete;
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('SMIC enregistré.', 'succes'); charger(); }
}

// ---------------------------------------------------------------------------
// Grille du taux neutre du prélèvement à la source
// ---------------------------------------------------------------------------
function blocGrille(d) {
  const g = d.grille;
  const tranches = g.tranches || [];
  return el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-grille' },
    el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-grille', texte: 'Taux neutre du prélèvement à la source' }),
      boutonAction('Nouvelle grille', formulaireGrille)),
    el('p', { classe: 'aide-module', texte: g.valable_du ? `Grille en vigueur depuis le ${dateCourte(g.valable_du)} (métropole), appliquée quand le salarié n'a pas de taux personnalisé.` : 'Aucune grille enregistrée.' }),
    tableau({
      colonnes: [
        { titre: 'Net imposable mensuel', valeur: (t, i = tranches.indexOf(t)) => (i < tranches.length - 1
          ? `de ${montant(t.de)} à moins de ${montant(tranches[i + 1].de)}` : `${montant(t.de)} et plus`) },
        { titre: 'Taux', droite: true, valeur: (t) => `${decimal(t.taux, 1, 2)} %` }
      ],
      lignes: tranches
    }));
}

async function formulaireGrille() {
  const fait = await fenetreFormulaire({
    titre: 'Nouvelle grille du taux neutre',
    intro: 'Une ligne par tranche : le montant à partir duquel le taux s\'applique, puis le taux, séparés par « ; » (ex. « 1635 ; 0,5 »). La première tranche part de 0.',
    champs: [
      { nom: 'valable_du', libelle: 'En vigueur à partir du', type: 'date', requis: true },
      { nom: 'tranches', libelle: 'Tranches', type: 'zone', requis: true, longueur: 4000, plein: true, placeholder: '0 ; 0\n1635 ; 0,5\n1698 ; 1,3' }
    ],
    enregistrer: async (v) => {
      const lignes = v.tranches.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((x, i) => {
        const morceaux = x.split(';').map((m) => m.trim().replace(/[\s  ]/g, '').replace(',', '.'));
        if (morceaux.length !== 2 || !/^\d+(\.\d+)?$/.test(morceaux[0]) || !/^\d+(\.\d+)?$/.test(morceaux[1])) {
          throw new Error(`Ligne ${i + 1} : « montant ; taux » attendu (ex. 1635 ; 0,5).`);
        }
        return { valable_du: v.valable_du, de: Number(morceaux[0]), taux: Number(morceaux[1]) };
      });
      if (!lignes.length || lignes[0].de !== 0) throw new Error('La première tranche part de 0.');
      for (let i = 1; i < lignes.length; i += 1) {
        if (lignes[i].de <= lignes[i - 1].de) throw new Error(`Ligne ${i + 1} : les montants doivent être croissants.`);
      }
      const { error } = await supabase.from('grille_taux_neutre').insert(lignes);
      if (error) throw error;
    }
  });
  if (fait) { afficherMessage('Grille enregistrée.', 'succes'); charger(); }
}
