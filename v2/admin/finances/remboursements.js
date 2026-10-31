// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — remboursements
// -----------------------------------------------------------------------------
// Tous les remboursements d'une période : montant, moyen (virement, carte,
// espèces), motif, paiement remboursé, course, client, avoir, auteur.
// Un remboursement se fait depuis le paiement : onglet Encaissements, liste
// « Encaissés », ou fiche de la course (bouton « Rembourser »). Celui d'une
// course ou de frais d'annulation crée l'avoir qui corrige la facture.
// Lecture : admin_lister_remboursements.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, pluriel, dateCourte, jourHeure, badge, boutonExporter, exporterCsv, messageErreurAdmin,
  MODES_PAIEMENT, NATURES_PAIEMENT, MODES_REMBOURSEMENT
} from '../commun/composants.js';
import { champsPeriode, bornes, periodeValable, periodeLisible, periodeCourte } from '../commun/periode.js';
import { ecrireAdresse, lireDate, lirePage, pagination, chargerTout, nomFichier } from '../commun/listes.js';
import { COLONNES_REMBOURSEMENTS } from './exports.js';

const $ = (id) => document.getElementById(id);
const PAR_PAGE = 50;
const filtres = { du: '', au: '', texte: '', page: 0 };

export function afficherRemboursements({ parametres }) {
  const mois = bornes('mois');
  filtres.du = lireDate(parametres, 'du') || mois.du;
  filtres.au = lireDate(parametres, 'au') || mois.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, mois);
  filtres.texte = (parametres.get('q') || '').slice(0, 100);
  filtres.page = lirePage(parametres);
  $('entete-actions').replaceChildren(boutonExporter(exporter));

  const texte = el('input', { id: 'remboursements-texte', classe: 'saisie', type: 'search', autocomplete: 'off',
    placeholder: 'Course, client, motif, avoir' });
  texte.value = filtres.texte;
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    ...champsPeriode({ prefixe: 'remboursements', du: filtres.du, au: filtres.au,
      changer: ({ du, au }) => { filtres.du = du; filtres.au = au; filtres.page = 0; charger(); } }),
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'remboursements-texte', texte: 'Rechercher' }), texte),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); filtres.page = 0; charger(); });

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-remboursements', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-remboursements' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-remboursements', texte: 'Remboursements' }),
        el('span', { classe: 'sous-titre', id: 'periode-remboursements' })),
      el('p', { classe: 'aide-module' }, 'Pour rembourser un client : onglet ',
        el('a', { href: lienAdmin('finances/?vue=encaisses'), texte: 'Encaissements, liste « Encaissés »' }),
        ', ou fiche de la course, bouton « Rembourser ». L\'avoir qui corrige la facture est créé en même temps.'),
      formulaire,
      el('div', { id: 'liste-remboursements' }, el('p', { classe: 'chargement', texte: 'Chargement…' })),
      el('div', { classe: 'pagination', id: 'pagination-remboursements' })));
  charger();
}

function parametres(limite, decalage) {
  return { p_debut: filtres.du, p_fin: filtres.au, p_texte: filtres.texte || null, p_limite: limite, p_decalage: decalage };
}

async function charger() {
  ecrireAdresse('remboursements', { du: filtres.du, au: filtres.au, q: filtres.texte, page: filtres.page });
  $('liste-remboursements').classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_remboursements', parametres(PAR_PAGE, filtres.page * PAR_PAGE));
  $('liste-remboursements').classList.remove('rechargement');
  if (error) { $('liste-remboursements').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  const t = data.totaux;
  const periode = periodeCourte(filtres.du, filtres.au);
  $('chiffres-remboursements').replaceChildren(
    tuile('Remboursé', euros(t.montant), `${pluriel(data.total, 'remboursement', 'remboursements')} · ${periode}`, Number(t.montant) > 0 ? 'or' : null),
    tuile('Par virement', euros(t.virement), 'depuis le compte bancaire'),
    tuile('Sur la carte', euros(t.carte), 'depuis le terminal de paiement'),
    tuile('En espèces', euros(t.especes), 'depuis la caisse du bureau'));
  $('periode-remboursements').textContent = `Période : ${periodeLisible(filtres.du, filtres.au)}`;
  $('liste-remboursements').replaceChildren(tableau({
    colonnes: [
      { titre: 'Date', valeur: (r) => el('span', {}, dateCourte(r.cree_le), el('span', { classe: 'secondaire', texte: r.cree_par_nom ? `par ${r.cree_par_nom}` : jourHeure(r.cree_le) })) },
      { titre: 'Course', valeur: (r) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${r.course_id}`), texte: r.course_numero }),
        el('span', { classe: 'secondaire', texte: `${NATURES_PAIEMENT[r.paiement_nature] || r.paiement_nature}, ${(MODES_PAIEMENT[r.paiement_mode] || r.paiement_mode).toLowerCase()} ${euros(r.paiement_montant)}` })) },
      { titre: 'Client', valeur: (r) => el('span', {}, el('a', { href: lienAdmin(`clients/?id=${r.client_id}`), texte: r.client_nom }),
        r.compte_pro ? el('span', { classe: 'secondaire', texte: r.compte_pro }) : null) },
      { titre: 'Remboursé', droite: true, valeur: (r) => el('span', {}, el('strong', { texte: euros(r.montant) }),
        el('span', { classe: 'secondaire', texte: (MODES_REMBOURSEMENT[r.mode] || r.mode).toLowerCase() })) },
      { titre: 'Motif', valeur: (r) => r.motif },
      { titre: 'Avoir', valeur: (r) => (r.avoir_id
        ? el('a', { href: lienAdmin(`finances/?avoir=${r.avoir_id}`), texte: r.avoir_numero })
        : badge('Pourboire : sans avoir', 'gris')) }
    ],
    lignes: data.lignes,
    vide: filtres.texte ? 'Aucun remboursement ne correspond à cette recherche.' : 'Aucun remboursement sur cette période.'
  }));
  pagination($('pagination-remboursements'), {
    total: data.total, page: filtres.page, parPage: PAR_PAGE, aller: (page) => { filtres.page = page; charger(); }
  });
}

async function exporter() {
  try {
    const data = await chargerTout('admin_lister_remboursements', parametres(0, 0));
    if (!data.lignes.length) { afficherMessage('Aucun remboursement à exporter sur cette période.'); return; }
    exporterCsv(`${nomFichier('remboursements', filtres.du, filtres.au)}.csv`, COLONNES_REMBOURSEMENTS, [...data.lignes].reverse());
  } catch (erreur) {
    afficherMessage(messageErreurAdmin(erreur), 'erreur');
  }
}
