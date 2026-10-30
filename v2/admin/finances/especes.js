// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — espèces des chauffeurs
// -----------------------------------------------------------------------------
// Les espèces reçues des clients restent chez le chauffeur jusqu'à ce qu'il
// les remette au bureau. Pour chaque chauffeur : ce qu'il a encaissé, ce qu'il
// a remis, ce qu'il détient encore et depuis quand, et ses paiements en
// espèces pas encore confirmés.
// Une remise s'enregistre une fois l'argent compté : reçu numéroté
// (RE-2026-000001), le chauffeur est prévenu. Une remise saisie par erreur
// s'annule avec un motif : elle reste visible, barrée.
// Les pourboires en espèces restent au chauffeur ; des espèces reçues
// directement au bureau ne sont pas comptées.
// Lectures : admin_especes_chauffeurs, admin_lister_remises.
// Actions : admin_enregistrer_remise, admin_annuler_remise.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, pluriel, dateCourte, jourHeure, depuis, badge, boutonAction, fenetreFormulaire, ouvrirFenetre,
  lienTelephone, exporterCsv, messageErreurAdmin, NATURES_PAIEMENT
} from '../commun/composants.js';
import { champsPeriode, bornes, periodeValable, periodeLisible } from './periode.js';
import { ecrireAdresse, lireDate, nomFichier } from './listes.js';
import { COLONNES_REMISES } from './exports.js';

const $ = (id) => document.getElementById(id);
const filtres = { du: '', au: '' };
const etat = { remises: null };

export function afficherEspeces({ parametres }) {
  const mois = bornes('mois');
  filtres.du = lireDate(parametres, 'du') || mois.du;
  filtres.au = lireDate(parametres, 'au') || mois.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, mois);
  $('entete-actions').replaceChildren();

  const formulaire = el('form', { classe: 'barre-outils', id: 'filtres-remises' },
    ...champsPeriode({ prefixe: 'remises', du: filtres.du, au: filtres.au,
      changer: ({ du, au }) => { filtres.du = du; filtres.au = au; chargerRemises(); } }));
  formulaire.addEventListener('submit', (e) => e.preventDefault());

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-especes', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-par-chauffeur' },
      el('h2', { id: 'titre-par-chauffeur', texte: 'Par chauffeur' }),
      el('p', { classe: 'aide-module', texte: 'Espèces reçues des clients (courses et frais d\'annulation) et pas encore remises au bureau. '
        + 'Les pourboires en espèces restent au chauffeur ; les espèces reçues directement au bureau ne sont pas comptées.' }),
      el('div', { id: 'liste-chauffeurs' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-remises' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-remises', texte: 'Remises au bureau' }),
        boutonAction('Exporter (CSV)', exporterRemises)),
      formulaire,
      el('p', { classe: 'resume-liste', id: 'resume-remises', 'aria-live': 'polite' }),
      el('div', { id: 'liste-remises' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))));
  chargerTout();
}

async function chargerTout() {
  await Promise.all([chargerChauffeurs(), chargerRemises()]);
}

// ---------------------------------------------------------------------------
// Par chauffeur
// ---------------------------------------------------------------------------
async function chargerChauffeurs() {
  const { data, error } = await supabase.rpc('admin_especes_chauffeurs');
  if (error) { $('liste-chauffeurs').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const avecEspeces = data.chauffeurs.filter((c) => Number(c.a_remettre) > 0);
  const plusAncien = avecEspeces.map((c) => c.depuis_le).filter(Boolean).sort()[0] || null;
  const nonConfirmes = data.chauffeurs.reduce((n, c) => n + Number(c.non_confirmes.nb), 0);
  const montantNonConfirmes = data.chauffeurs.reduce((n, c) => n + Number(c.non_confirmes.montant), 0);
  $('chiffres-especes').replaceChildren(
    tuile('À remettre au bureau', euros(data.total_a_remettre),
      avecEspeces.length ? pluriel(avecEspeces.length, 'chauffeur concerné', 'chauffeurs concernés') : 'tout est remis', avecEspeces.length ? 'or' : null),
    tuile('Plus ancienne espèce gardée', plusAncien ? dateCourte(plusAncien) : '—',
      plusAncien ? `il y a ${depuis(plusAncien)}` : 'aucune espèce en attente de remise',
      plusAncien && Date.now() - new Date(plusAncien).getTime() > 7 * 86400000 ? 'rouge' : null),
    tuile('Espèces pas encore confirmées', euros(montantNonConfirmes),
      nonConfirmes ? `${pluriel(nonConfirmes, 'paiement', 'paiements')} à confirmer (onglet Encaissements)` : 'toutes confirmées',
      nonConfirmes ? 'or' : null),
    tuile('Chauffeurs suivis', String(data.chauffeurs.length), 'validés, ou qui ont déjà eu des espèces'));

  $('liste-chauffeurs').replaceChildren(tableau({
    colonnes: [
      { titre: 'Chauffeur', valeur: (c) => el('span', {}, el('strong', { texte: c.nom }),
        el('span', { classe: 'secondaire' }, lienTelephone(c.telephone) || '', c.statut !== 'valide' ? ' · ' : '',
          c.statut !== 'valide' ? badge(c.statut === 'suspendu' ? 'Suspendu' : 'Plus actif', 'gris') : null)) },
      { titre: 'Encaissé', droite: true, valeur: (c) => euros(c.encaisse) },
      { titre: 'Remis', droite: true, valeur: (c) => el('span', {}, euros(c.remis),
        c.derniere_remise_le ? el('span', { classe: 'secondaire', texte: `dernière le ${dateCourte(c.derniere_remise_le)}` }) : null) },
      { titre: 'À remettre', droite: true, valeur: (c) => el('span', {},
        el('strong', { classe: Number(c.a_remettre) > 0 ? 'texte-or' : null, texte: euros(c.a_remettre) }),
        c.depuis_le ? el('span', { classe: 'secondaire', texte: `depuis le ${dateCourte(c.depuis_le)}` }) : null) },
      { titre: 'À confirmer', valeur: (c) => (Number(c.non_confirmes.nb)
        ? el('a', { href: lienAdmin(`finances/?vue=a_encaisser&mode=especes&q=${encodeURIComponent(c.nom)}`),
          texte: `${pluriel(c.non_confirmes.nb, 'paiement', 'paiements')}, ${euros(c.non_confirmes.montant)}` })
        : 'aucun') },
      { titre: '', valeur: (c) => el('div', { classe: 'actions-ligne' },
        Number(c.a_remettre) > 0 ? boutonAction('Enregistrer une remise', () => enregistrerRemise(c), 'bouton-principal') : null,
        c.non_remis.length ? boutonAction('Détail', async () => detail(c)) : null) }
    ],
    lignes: data.chauffeurs, vide: 'Aucun chauffeur validé pour le moment.'
  }));
}

// Encaissements pas encore remis d'un chauffeur (les plus anciens d'abord)
function detail(c) {
  ouvrirFenetre({
    titre: `Espèces gardées par ${c.nom}`,
    large: true,
    contenu: [
      el('p', { classe: 'sous-titre', texte: `${euros(c.a_remettre)} à remettre : encaissements pas encore couverts par ses remises, les plus anciens d'abord.` }),
      tableau({
        colonnes: [
          { titre: 'Course', valeur: (x) => el('a', { href: lienAdmin(`courses/?id=${x.course_id}`), texte: x.course_numero }) },
          { titre: 'Nature', valeur: (x) => NATURES_PAIEMENT[x.nature] || x.nature },
          { titre: 'Encaissé le', valeur: (x) => jourHeure(x.encaisse_le) },
          { titre: 'Montant', droite: true, valeur: (x) => el('span', {}, euros(x.montant),
            Number(x.reste) < Number(x.montant) ? el('span', { classe: 'secondaire reste-partiel', texte: `reste ${euros(x.reste)} (remis en partie)` }) : null) }
        ],
        lignes: c.non_remis
      }),
      el('div', { classe: 'fenetre-actions' },
        el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Fermer', onclick: (e) => e.target.closest('dialog').close() }))
    ]
  });
}

async function enregistrerRemise(c) {
  const avertissement = Number(c.non_confirmes.nb)
    ? el('p', { classe: 'alerte' }, `${pluriel(c.non_confirmes.nb, 'paiement', 'paiements')} en espèces de ses courses (${euros(c.non_confirmes.montant)}) `
      + 'ne sont pas encore confirmés. S\'il vous remet aussi cet argent, confirmez-les d\'abord dans l\'onglet Encaissements.')
    : null;
  let remise = null;
  const fait = await fenetreFormulaire({
    titre: `Remise d'espèces de ${c.nom}`,
    intro: `${c.nom} détient ${euros(c.a_remettre)} d'après ses encaissements${c.depuis_le ? ` (depuis le ${dateCourte(c.depuis_le)})` : ''}. `
      + 'Comptez l\'argent avant d\'enregistrer : un reçu numéroté est créé à votre nom et le chauffeur est prévenu.',
    avant: avertissement ? [avertissement] : [],
    champs: [
      { nom: 'montant', libelle: 'Montant remis (€)', type: 'nombre', requis: true, min: 0.01, max: Number(c.a_remettre), pas: '0.01' },
      { nom: 'note', libelle: 'Note', type: 'texte', longueur: 300, placeholder: 'Ex. enveloppe du soir' }
    ],
    valeurs: { montant: Number(c.a_remettre) },
    libelle: 'Enregistrer la remise',
    enregistrer: async (v) => {
      const { data, error } = await supabase.rpc('admin_enregistrer_remise', {
        p_chauffeur: c.chauffeur_id, p_montant: Math.round(v.montant * 100) / 100, p_note: v.note
      });
      if (error) throw error;
      remise = data;
    }
  });
  if (!fait) return;
  afficherMessage(`Remise enregistrée : reçu ${remise.numero}, ${euros(remise.montant)}. ${c.nom} est prévenu.`, 'succes');
  await chargerTout();
}

// ---------------------------------------------------------------------------
// Remises de la période
// ---------------------------------------------------------------------------
async function chargerRemises() {
  ecrireAdresse('especes', { du: filtres.du, au: filtres.au });
  $('liste-remises').classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_remises', { p_debut: filtres.du, p_fin: filtres.au });
  $('liste-remises').classList.remove('rechargement');
  if (error) { $('liste-remises').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.remises = data;
  $('resume-remises').replaceChildren(...[el('strong', { texte: `${pluriel(data.nb, 'remise', 'remises')} · ${euros(data.total)}` }),
    el('span', { texte: periodeLisible(filtres.du, filtres.au) }),
    data.lignes.length > data.nb ? el('span', { texte: `${pluriel(data.lignes.length - data.nb, 'remise annulée', 'remises annulées')}, non comptée${data.lignes.length - data.nb > 1 ? 's' : ''}` }) : null]
    .filter(Boolean));
  $('liste-remises').replaceChildren(tableau({
    colonnes: [
      { titre: 'Reçu', valeur: (r) => el('span', {}, el('strong', { classe: 'mono', texte: r.numero }),
        el('span', { classe: 'secondaire', texte: jourHeure(r.cree_le) })) },
      { titre: 'Chauffeur', valeur: (r) => r.chauffeur_nom },
      { titre: 'Montant', droite: true, valeur: (r) => (r.annulee_le ? el('del', { texte: euros(r.montant) }) : euros(r.montant)) },
      { titre: 'Reçue par', valeur: (r) => el('span', {}, r.recue_par_nom || '—', r.note ? el('span', { classe: 'secondaire', texte: r.note }) : null) },
      { titre: 'État', valeur: (r) => (r.annulee_le
        ? el('span', {}, badge('Annulée', 'gris'), el('span', { classe: 'secondaire', texte: `le ${dateCourte(r.annulee_le)}${r.annulee_par_nom ? ` par ${r.annulee_par_nom}` : ''} : ${r.motif_annulation}` }))
        : badge('Enregistrée', 'vert')) },
      { titre: '', valeur: (r) => (r.annulee_le ? el('span') : boutonAction('Annuler', () => annulerRemise(r), 'bouton-danger')) }
    ],
    lignes: data.lignes, vide: 'Aucune remise sur cette période.'
  }));
}

async function annulerRemise(r) {
  const fait = await fenetreFormulaire({
    titre: `Annuler la remise ${r.numero} ?`,
    intro: `${euros(r.montant)} remis par ${r.chauffeur_nom} le ${dateCourte(r.cree_le)}. La remise reste visible, annulée, et ces espèces redeviennent à remettre. Le chauffeur est prévenu.`,
    champs: [{ nom: 'motif', libelle: 'Motif (erreur de montant, de chauffeur…)', type: 'zone', requis: true, longueur: 300, plein: true,
      aide: 'Conservé dans le journal et transmis au chauffeur.' }],
    libelle: 'Annuler la remise',
    enregistrer: async (v) => {
      const { error } = await supabase.rpc('admin_annuler_remise', { p_remise: r.id, p_motif: v.motif });
      if (error) throw error;
    }
  });
  if (!fait) return;
  afficherMessage(`Remise ${r.numero} annulée.`, 'succes');
  await chargerTout();
}

function exporterRemises() {
  if (!etat.remises || !etat.remises.lignes.length) { afficherMessage('Aucune remise à exporter sur cette période.'); return; }
  exporterCsv(`${nomFichier('remises-especes', filtres.du, filtres.au)}.csv`, COLONNES_REMISES, [...etat.remises.lignes].reverse());
}
