// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — TVA et export pour l'expert-comptable
// -----------------------------------------------------------------------------
// 1. TVA d'une année, mois par mois, avec le total de chaque trimestre et de
//    l'année :
//      - chiffre d'affaires HT et TVA facturés (factures moins avoirs) ;
//      - sommes encaissées et TVA sur les encaissements (moins les
//        remboursements) : pour une prestation de services, la TVA est due à
//        l'encaissement, sauf option pour les débits ;
//      - pourboires, hors TVA.
// 2. Dossier pour l'expert-comptable : pour la période choisie, une archive
//    ZIP (registre des factures et avoirs, journal des encaissements,
//    remboursements, remises d'espèces, TVA par mois, sommes dues, relevés
//    des plateformes, LISEZ-MOI),
//    ou chaque fichier CSV séparément.
// Lectures : admin_tva, et les listes des autres onglets (exports.js).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import {
  boutonAction, exporterCsv, telechargerFichier, messageErreurAdmin, moisLisible, jourParis
} from '../commun/composants.js';
import { enteteTableau, tableauDefilant } from '../commun/documents.js';
import { champsPeriode, bornes, periodeValable, periodeLisible } from '../commun/periode.js';
import { ecrireAdresse, lireDate, chargerTout, nomFichier } from '../commun/listes.js';
import {
  COLONNES_REGISTRE, COLONNES_PAIEMENTS, COLONNES_REMBOURSEMENTS, COLONNES_REMISES, COLONNES_TVA,
  chronologique, tvaDesMois, moisEntiers, dossierComptable
} from './exports.js';

const $ = (id) => document.getElementById(id);
const etat = { annee: null, du: '', au: '' };

export function afficherTva({ parametres }) {
  const annee = parseInt(parametres.get('annee') || '', 10);
  etat.annee = annee >= 2020 && annee <= 2100 ? annee : Number(jourParis().slice(0, 4));
  const defaut = bornes('mois_precedent');
  etat.du = lireDate(parametres, 'du') || defaut.du;
  etat.au = lireDate(parametres, 'au') || defaut.au;
  if (!periodeValable(etat.du, etat.au)) Object.assign(etat, defaut);
  $('entete-actions').replaceChildren();

  const choixAnnee = el('select', { id: 'tva-annee', classe: 'saisie' });
  choixAnnee.addEventListener('change', () => { etat.annee = Number(choixAnnee.value); chargerTva(); });
  const formulaire = el('form', { classe: 'barre-outils' },
    ...champsPeriode({ prefixe: 'dossier', du: etat.du, au: etat.au, changer: ({ du, au }) => { etat.du = du; etat.au = au; majDossier(); } }));
  formulaire.addEventListener('submit', (e) => e.preventDefault());

  $('contenu').replaceChildren(
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-tva' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-tva', texte: 'TVA' }),
        el('div', { classe: 'champ champ-mois' }, el('label', { for: 'tva-annee', texte: 'Année' }), choixAnnee),
        boutonAction('Exporter (CSV)', exporterTva)),
      el('div', { classe: 'explication' },
        el('p', {}, el('strong', { texte: 'TVA sur encaissements' }), ' : celle des sommes encaissées dans le mois, moins celle des remboursements. '
          + 'Pour une prestation de services comme le transport, la TVA est due à l\'encaissement, sauf option pour les débits : '
          + 'c\'est elle qui se déclare d\'ordinaire. À confirmer avec votre expert-comptable.'),
        el('p', {}, el('strong', { texte: 'TVA facturée' }), ' : celle des factures émises dans le mois, moins celle des avoirs. Les pourboires sont hors TVA.')),
      el('div', { id: 'tableau-tva' }, el('p', { classe: 'chargement', texte: 'Chargement…' }))),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-dossier' },
      el('h2', { id: 'titre-dossier', texte: 'Dossier pour l\'expert-comptable' }),
      el('p', { classe: 'aide-module', texte: 'Choisissez la période (un mois, un trimestre, une année), puis téléchargez le dossier : une archive ZIP de fichiers CSV qui s\'ouvrent dans Excel, avec un fichier LISEZ-MOI qui les présente. Envoyez-la telle quelle.' }),
      formulaire,
      el('ol', { classe: 'contenu-dossier', id: 'contenu-dossier' }),
      el('div', { classe: 'boutons-export', id: 'boutons-dossier' })));
  chargerTva();
  majDossier();
}

// ---------------------------------------------------------------------------
// TVA de l'année
// ---------------------------------------------------------------------------
async function chargerTva() {
  ecrireAdresse('tva', { annee: etat.annee, du: etat.du, au: etat.au });
  const zone = $('tableau-tva');
  zone.classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_tva', { p_annee: etat.annee });
  zone.classList.remove('rechargement');
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  etat.tva = data;
  const choix = $('tva-annee');
  choix.replaceChildren(...data.annees.map((a) => el('option', { value: String(a), texte: String(a) })));
  choix.value = String(data.annee);

  const plusieursTaux = new Set([...data.mois].flatMap((m) => m.par_taux.map((t) => t.taux))).size > 1;
  const cellule = (valeur, cle = false) => el('td', { classe: `droite${cle ? ' colonne-cle' : ''}`, texte: euros(valeur) });
  const ligneTva = (l, libelle, classe = null) => el('tr', { classe },
    el('th', { scope: 'row', texte: libelle }),
    cellule(l.ca_ht), cellule(l.tva_facturee), cellule(l.encaisse.ttc), cellule(l.base_exigible), cellule(l.tva_exigible, true), cellule(l.pourboires));
  const corps = [];
  data.mois.forEach((m, i) => {
    const vide = !m.factures.nb && !m.avoirs.nb && !m.encaisse.nb && !m.rembourse.nb && !Number(m.pourboires);
    const libelle = moisLisible(m.periode);
    corps.push(ligneTva(m, libelle.charAt(0).toUpperCase() + libelle.slice(1), vide ? 'mois-vide' : null));
    if (i % 3 === 2) {
      const t = data.trimestres[(i + 1) / 3 - 1];
      corps.push(ligneTva(t, `${['1er', '2e', '3e', '4e'][(i + 1) / 3 - 1]} trimestre`, 'ligne-trimestre'));
    }
  });
  corps.push(ligneTva(data.total, `Année ${data.annee}`, 'ligne-annee'));
  const table = el('table', { classe: 'doc-table table-tva' },
    enteteTableau(['Période', 'CA HT facturé', 'TVA facturée', 'Encaissé TTC', 'Base HT encaissée', 'TVA sur encaissements', 'Pourboires'], [1, 2, 3, 4, 5, 6]),
    el('tbody', {}, ...corps));
  zone.replaceChildren(...tableauDefilant(table),
    ...(plusieursTaux ? [el('p', { classe: 'alerte', texte: 'Plusieurs taux de TVA sur l\'année : le détail par taux figure dans l\'export CSV.' })] : []));
}

function exporterTva() {
  if (!etat.tva) return;
  exporterCsv(`${nomFichier('tva', String(etat.tva.annee))}.csv`, COLONNES_TVA, [...etat.tva.mois, ...etat.tva.trimestres, etat.tva.total]);
}

// ---------------------------------------------------------------------------
// Dossier pour l'expert-comptable
// ---------------------------------------------------------------------------
function majDossier() {
  ecrireAdresse('tva', { annee: etat.annee, du: etat.du, au: etat.au });
  const mois = moisEntiers(etat.du, etat.au);
  $('contenu-dossier').replaceChildren(
    el('li', {}, 'Registre des factures et des avoirs', el('span', { classe: 'secondaire', texte: 'pièces émises sur la période, dans l\'ordre chronologique' })),
    el('li', {}, 'Journal des encaissements', el('span', { classe: 'secondaire', texte: 'paiements encaissés sur la période, avec leur mode' })),
    el('li', {}, 'Remboursements', el('span', { classe: 'secondaire', texte: 'avec leur mode et leur avoir' })),
    el('li', {}, 'Remises d\'espèces des chauffeurs', el('span', { classe: 'secondaire', texte: 'reçus du bureau, annulations comprises' })),
    el('li', {}, 'TVA par mois', el('span', { classe: 'secondaire', texte: mois.length
      ? `${mois.length > 1 ? `${mois.length} mois entiers` : 'le mois entier'} : ${mois.map((m) => moisLisible(m)).join(', ')}`
      : 'non jointe : la période ne contient aucun mois entier' })),
    el('li', {}, 'Sommes encore dues', el('span', { classe: 'secondaire', texte: 'à encaisser et impayés, le jour du téléchargement' })),
    el('li', {}, 'Relevés des plateformes', el('span', { classe: 'secondaire', texte: 'Bolt, Uber, Heetch : relevés qui se terminent dans la période' })),
    el('li', {}, 'LISEZ-MOI', el('span', { classe: 'secondaire', texte: 'présentation des fichiers et des totaux' })));
  const periode = periodeLisible(etat.du, etat.au);
  $('boutons-dossier').replaceChildren(
    boutonAction(`Télécharger le dossier (ZIP) · ${periode}`, telechargerDossier, 'bouton-principal'),
    boutonAction('Registre (CSV)', async () => exporterSepare('registre')),
    boutonAction('Encaissements (CSV)', async () => exporterSepare('encaissements')),
    boutonAction('Remboursements (CSV)', async () => exporterSepare('remboursements')),
    boutonAction('Remises (CSV)', async () => exporterSepare('remises')),
    ...(mois.length ? [boutonAction('TVA par mois (CSV)', async () => exporterSepare('tva'))] : []));
}

async function telechargerDossier() {
  try {
    const { zip, nom, fichiers } = await dossierComptable(etat.du, etat.au);
    telechargerFichier(zip, nom);
    afficherMessage(`Dossier téléchargé : ${fichiers} fichiers, ${periodeLisible(etat.du, etat.au)}.`, 'succes');
  } catch (erreur) {
    afficherMessage(messageErreurAdmin(erreur), 'erreur');
  }
}

async function exporterSepare(quoi) {
  const periode = { p_debut: etat.du, p_fin: etat.au };
  try {
    if (quoi === 'registre') {
      const d = await chargerTout('admin_lister_factures', { p_type: 'tout', ...periode });
      exporterCsv(`${nomFichier('registre-factures-avoirs', etat.du, etat.au)}.csv`, COLONNES_REGISTRE, chronologique(d.lignes));
    } else if (quoi === 'encaissements') {
      const d = await chargerTout('admin_lister_paiements', { p_vue: 'encaisses', ...periode });
      exporterCsv(`${nomFichier('journal-encaissements', etat.du, etat.au)}.csv`, COLONNES_PAIEMENTS, [...d.lignes].reverse());
    } else if (quoi === 'remboursements') {
      const d = await chargerTout('admin_lister_remboursements', periode);
      exporterCsv(`${nomFichier('remboursements', etat.du, etat.au)}.csv`, COLONNES_REMBOURSEMENTS, [...d.lignes].reverse());
    } else if (quoi === 'remises') {
      const { data, error } = await supabase.rpc('admin_lister_remises', periode);
      if (error) throw error;
      exporterCsv(`${nomFichier('remises-especes', etat.du, etat.au)}.csv`, COLONNES_REMISES, [...data.lignes].reverse());
    } else if (quoi === 'tva') {
      const lignes = await tvaDesMois(etat.du, etat.au);
      exporterCsv(`${nomFichier('tva-par-mois', etat.du, etat.au)}.csv`, COLONNES_TVA, lignes);
    }
  } catch (erreur) {
    afficherMessage(messageErreurAdmin(erreur), 'erreur');
  }
}

