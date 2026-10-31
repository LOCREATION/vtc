// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — encaissements
// -----------------------------------------------------------------------------
// En tête, quatre cases de chiffres (chacune mène à sa liste) :
//   à encaisser, impayés, encaissé sur la période, espèces chez les chauffeurs.
// Puis quatre listes de paiements :
//   - À encaisser : tout ce qui attend, les plus anciens d'abord ;
//   - Impayés : déclarés impayés, à relancer ;
//   - Encaissés : sur la période choisie (date d'encaissement) ;
//   - Annulés : sommes annulées (corrigées par un avoir).
// Sur chaque paiement, les actions du module commun : confirmer
// l'encaissement, déclarer impayé, annuler la somme, rembourser ; un
// paiement sur facture mensuelle mène au relevé de l'entreprise.
// Lectures : admin_finances_synthese, admin_lister_paiements.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, pluriel, dateCourte, jourHeure, depuis, badgePaiement, MODES_PAIEMENT, NATURES_PAIEMENT,
  telephoneLisible, exporterCsv, boutonExporter, messageErreurAdmin
} from '../commun/composants.js';
import { actionsPaiement } from '../commun/actions-paiement.js';
import { champsPeriode, bornes, periodeValable, periodeLisible, periodeCourte } from '../commun/periode.js';
import { ecrireAdresse, lireDate, lirePage, pagination, chargerTout, nomFichier } from '../commun/listes.js';
import { COLONNES_PAIEMENTS } from './exports.js';

const $ = (id) => document.getElementById(id);
export const LISTES = ['a_encaisser', 'impayes', 'encaisses', 'annules'];
const LIBELLES = { a_encaisser: 'À encaisser', impayes: 'Impayés', encaisses: 'Encaissés', annules: 'Annulés' };
const VIDES = {
  a_encaisser: 'Aucun paiement à encaisser : tout est réglé.',
  impayes: 'Aucun paiement impayé.',
  encaisses: 'Aucun paiement encaissé sur cette période.',
  annules: 'Aucune somme annulée.'
};
const PAR_PAGE = 50;
const MODES = [['', 'Tous'], ['especes', 'Espèces'], ['carte', 'Carte au terminal'], ['facture_mensuelle', 'Facture mensuelle'], ['solde', 'Solde']];
const NATURES = [['', 'Toutes'], ['course', 'Course'], ['pourboire', 'Pourboire'], ['frais_annulation', 'Frais d\'annulation']];
const filtres = { liste: 'a_encaisser', du: '', au: '', texte: '', mode: '', nature: '', page: 0 };

export function afficherEncaissements({ vue, parametres }) {
  filtres.liste = LISTES.includes(vue) ? vue : 'a_encaisser';
  const mois = bornes('mois');
  filtres.du = lireDate(parametres, 'du') || mois.du;
  filtres.au = lireDate(parametres, 'au') || mois.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, mois);
  filtres.texte = (parametres.get('q') || '').slice(0, 100);
  filtres.mode = MODES.some(([v]) => v === parametres.get('mode')) ? parametres.get('mode') : '';
  filtres.nature = NATURES.some(([v]) => v === parametres.get('nature')) ? parametres.get('nature') : '';
  filtres.page = lirePage(parametres);

  $('entete-actions').replaceChildren(boutonExporter(exporter));
  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-encaissements', 'aria-live': 'polite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-paiements' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-paiements', texte: 'Paiements' }),
        el('span', { classe: 'sous-titre', id: 'periode-paiements' })),
      el('div', { classe: 'sous-onglets', role: 'tablist', 'aria-label': 'Listes de paiements', id: 'listes-paiements' }),
      el('form', { classe: 'barre-outils', id: 'filtres-paiements', role: 'search' }),
      el('p', { classe: 'resume-liste', id: 'resume-paiements', 'aria-live': 'polite' }),
      el('div', { id: 'liste-paiements' }, el('p', { classe: 'chargement', texte: 'Chargement…' })),
      el('div', { classe: 'pagination', id: 'pagination-paiements' })));
  dessinerFiltres();
  charger();
}

// ---------------------------------------------------------------------------
// Filtres (la période ne concerne que la liste « Encaissés » et la case
// « Encaissé » ; les sommes dues s'affichent toujours toutes)
// ---------------------------------------------------------------------------
function dessinerFiltres() {
  const formulaire = $('filtres-paiements');
  const texte = el('input', { id: 'paiements-texte', classe: 'saisie', type: 'search', autocomplete: 'off',
    placeholder: 'Course, client, téléphone, chauffeur, facture' });
  texte.value = filtres.texte;
  const choix = (id, valeurs, actuel) => {
    const s = el('select', { id, classe: 'saisie' }, ...valeurs.map(([v, l]) => el('option', { value: v, texte: l })));
    s.value = actuel;
    return s;
  };
  const mode = choix('paiements-mode', MODES, filtres.mode);
  const nature = choix('paiements-nature', NATURES, filtres.nature);
  const effacer = el('button', { type: 'button', classe: 'bouton bouton-texte', texte: 'Effacer' });
  formulaire.replaceChildren(
    ...(filtres.liste === 'encaisses'
      ? champsPeriode({ prefixe: 'paiements', du: filtres.du, au: filtres.au, changer: ({ du, au }) => { filtres.du = du; filtres.au = au; filtres.page = 0; charger(); } })
      : []),
    el('div', { classe: 'champ' }, el('label', { for: 'paiements-mode', texte: 'Mode' }), mode),
    el('div', { classe: 'champ' }, el('label', { for: 'paiements-nature', texte: 'Nature' }), nature),
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'paiements-texte', texte: 'Rechercher' }), texte),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }),
    effacer);
  formulaire.onsubmit = (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); filtres.page = 0; charger(); };
  mode.addEventListener('change', () => { filtres.mode = mode.value; filtres.page = 0; charger(); });
  nature.addEventListener('change', () => { filtres.nature = nature.value; filtres.page = 0; charger(); });
  effacer.addEventListener('click', () => {
    Object.assign(filtres, { texte: '', mode: '', nature: '', page: 0 }, bornes('mois'));
    dessinerFiltres();
    charger();
  });
}

function parametresListe(limite, decalage) {
  return {
    p_vue: filtres.liste, p_debut: filtres.liste === 'encaisses' ? filtres.du : null, p_fin: filtres.liste === 'encaisses' ? filtres.au : null,
    p_texte: filtres.texte || null, p_mode: filtres.mode || null, p_nature: filtres.nature || null, p_limite: limite, p_decalage: decalage
  };
}

// ---------------------------------------------------------------------------
// Chargement : cases de chiffres et liste, en parallèle
// ---------------------------------------------------------------------------
async function charger() {
  ecrireAdresse(filtres.liste, {
    du: filtres.du, au: filtres.au, q: filtres.texte, mode: filtres.mode, nature: filtres.nature, page: filtres.page
  });
  $('liste-paiements').classList.add('rechargement');
  const [synthese, liste] = await Promise.all([
    supabase.rpc('admin_finances_synthese', { p_debut: filtres.du, p_fin: filtres.au }),
    supabase.rpc('admin_lister_paiements', parametresListe(PAR_PAGE, filtres.page * PAR_PAGE))
  ]);
  $('liste-paiements').classList.remove('rechargement');
  if (synthese.error || liste.error) {
    $('liste-paiements').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(synthese.error || liste.error) }));
    return;
  }
  dessinerChiffres(synthese.data);
  dessinerListes(synthese.data);
  dessinerListe(liste.data);
}

// Une case de chiffre qui mène à sa liste (ou à un autre onglet)
function caseLien(vue, contenu, actuelle) {
  const lien = el('a', { classe: 'chiffre-lien', href: `?vue=${vue}`, 'aria-current': actuelle ? 'true' : null }, contenu);
  if (LISTES.includes(vue)) {
    lien.addEventListener('click', (e) => { e.preventDefault(); changerListe(vue); });
  }
  return lien;
}

function dessinerChiffres(s) {
  const a = s.a_encaisser;
  const enc = s.encaisse;
  const parMode = [
    Number(enc.especes) > 0 ? `espèces ${euros(enc.especes)}` : null,
    Number(enc.carte) > 0 ? `carte ${euros(enc.carte)}` : null,
    Number(enc.facture_mensuelle) > 0 ? `virements ${euros(enc.facture_mensuelle)}` : null,
    Number(enc.solde) > 0 ? `solde ${euros(enc.solde)}` : null
  ].filter(Boolean).join(' · ');
  const esp = s.especes;
  $('chiffres-encaissements').replaceChildren(
    caseLien('a_encaisser', tuile('À encaisser', euros(a.sur_place),
      [a.nb_sur_place ? pluriel(a.nb_sur_place, 'paiement sur place', 'paiements sur place') : 'rien sur place',
        a.plus_24h ? `${a.plus_24h} depuis plus de 24 h` : null,
        Number(a.releves) > 0 ? `relevés des entreprises ${euros(a.releves)}` : null].filter(Boolean).join(' · '),
      a.plus_24h ? 'or' : null), filtres.liste === 'a_encaisser'),
    caseLien('impayes', tuile('Impayés', euros(s.impayes.total),
      s.impayes.nb ? `${pluriel(s.impayes.nb, 'paiement', 'paiements')} à relancer` : 'aucun', s.impayes.nb ? 'rouge' : null),
    filtres.liste === 'impayes'),
    caseLien('encaisses', tuile('Encaissé', euros(enc.total),
      [periodeCourte(filtres.du, filtres.au), parMode || 'rien encaissé'].join(' · ')), filtres.liste === 'encaisses'),
    caseLien('especes', tuile('Espèces chez les chauffeurs', euros(esp.a_remettre),
      Number(esp.a_remettre) > 0
        ? `${pluriel(esp.chauffeurs, 'chauffeur', 'chauffeurs')} · depuis le ${dateCourte(esp.depuis_le)}`
        : 'tout est remis au bureau', Number(esp.a_remettre) > 0 ? 'or' : null), false));
}

// Choix de la liste, avec le nombre de paiements de chacune
function dessinerListes(s) {
  const nombres = { a_encaisser: s.a_encaisser.nb, impayes: s.impayes.nb, encaisses: s.encaisse.nb, annules: null };
  $('listes-paiements').replaceChildren(...LISTES.map((code) => {
    const b = el('button', { type: 'button', classe: 'onglet', role: 'tab', 'aria-selected': String(code === filtres.liste) },
      LIBELLES[code], nombres[code] !== null ? el('span', { classe: 'compte', texte: String(nombres[code]) }) : null);
    b.addEventListener('click', () => changerListe(code));
    return b;
  }));
  $('periode-paiements').textContent = filtres.liste === 'encaisses'
    ? `Période : ${periodeLisible(filtres.du, filtres.au)}`
    : filtres.liste === 'a_encaisser' ? 'Toutes les sommes qui attendent, les plus anciennes d\'abord' : '';
}

function changerListe(code) {
  if (code === filtres.liste) return;
  filtres.liste = code;
  filtres.page = 0;
  dessinerFiltres();
  charger();
}

// ---------------------------------------------------------------------------
// Liste des paiements
// ---------------------------------------------------------------------------
function colonneEtat(p) {
  if (filtres.liste === 'encaisses') {
    return el('span', {}, `le ${jourHeure(p.encaisse_le)}`,
      el('span', { classe: 'secondaire', texte: [p.encaisse_par_nom ? `par ${p.encaisse_par_nom}` : null, p.reference_externe].filter(Boolean).join(' · ') }),
      p.statut === 'rembourse' ? el('span', { classe: 'secondaire' }, badgePaiement('rembourse')) : null);
  }
  if (filtres.liste === 'a_encaisser') {
    return el('span', {}, `depuis le ${dateCourte(p.cree_le)}`,
      el('span', { classe: 'secondaire', texte: p.mode === 'facture_mensuelle'
        ? `relevé, échéance le ${dateCourte(p.echeance)}` : depuis(p.cree_le) }));
  }
  return el('span', {}, badgePaiement(p.statut), p.motif ? el('span', { classe: 'secondaire', texte: p.motif }) : null);
}

const COLONNES = [
  { titre: 'Course', valeur: (p) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${p.course_id}`), texte: p.course_numero }),
    el('span', { classe: 'secondaire', texte: `${NATURES_PAIEMENT[p.nature] || p.nature} · ${jourHeure(p.prise_en_charge_le)}` })) },
  { titre: 'Client', valeur: (p) => el('span', {}, el('a', { href: lienAdmin(`clients/?id=${p.client_id}`), texte: p.client_nom }),
    el('span', { classe: 'secondaire', texte: p.compte_pro || telephoneLisible(p.client_telephone) || '' })) },
  { titre: 'Montant', droite: true, valeur: (p) => el('span', {}, euros(p.montant),
    Number(p.rembourse) > 0 ? el('span', { classe: 'secondaire', texte: `dont ${euros(p.rembourse)} remboursé` }) : null,
    Number(p.annule) > 0 ? el('span', { classe: 'secondaire', texte: p.statut === 'annule' ? `${euros(p.annule)} annulés` : `après ${euros(p.annule)} annulés` }) : null) },
  { titre: 'Mode', valeur: (p) => el('span', {}, MODES_PAIEMENT[p.mode] || p.mode,
    el('span', { classe: 'secondaire', texte: p.mode === 'especes' && p.encaisse_le
      ? (p.especes_chez ? `chez ${p.especes_chez}` : 'reçues au bureau')
      : p.chauffeur_nom ? `chauffeur ${p.chauffeur_nom}` : '' })) },
  { titre: 'Où en est-il', valeur: colonneEtat },
  { titre: '', valeur: (p) => { const a = actionsPaiement(p, charger); return a.length ? el('div', { classe: 'actions-ligne' }, ...a) : el('span'); } }
];

function dessinerListe(data) {
  const t = data.totaux;
  const parMode = data.par_mode.map((m) => `${(MODES_PAIEMENT[m.mode] || m.mode).toLowerCase()} ${euros(m.montant)}`).join(' · ');
  $('resume-paiements').replaceChildren(...(data.total
    ? [el('strong', { texte: `${pluriel(data.total, 'paiement', 'paiements')} · ${euros(t.montant)}` }),
      el('span', { texte: parMode }),
      Number(t.rembourse) > 0 ? el('span', { texte: `dont ${euros(t.rembourse)} remboursé` }) : null].filter(Boolean)
    : []));
  $('liste-paiements').replaceChildren(tableau({
    colonnes: COLONNES, lignes: data.lignes,
    vide: filtres.texte || filtres.mode || filtres.nature ? 'Aucun paiement ne correspond à ces critères.' : VIDES[filtres.liste]
  }));
  pagination($('pagination-paiements'), {
    total: data.total, page: filtres.page, parPage: PAR_PAGE, aller: (page) => { filtres.page = page; charger(); }
  });
}

// Export de la liste affichée (toutes les pages)
async function exporter() {
  try {
    const data = await chargerTout('admin_lister_paiements', parametresListe(0, 0));
    if (!data.lignes.length) { afficherMessage('Rien à exporter dans cette liste.'); return; }
    const lignes = filtres.liste === 'encaisses' ? [...data.lignes].reverse() : data.lignes;
    exporterCsv(`${nomFichier('paiements', LIBELLES[filtres.liste], filtres.liste === 'encaisses' ? filtres.du : null,
      filtres.liste === 'encaisses' ? filtres.au : null)}.csv`, COLONNES_PAIEMENTS, lignes);
  } catch (erreur) {
    afficherMessage(messageErreurAdmin(erreur), 'erreur');
  }
}
