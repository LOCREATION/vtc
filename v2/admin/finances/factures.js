// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : finances — factures et avoirs
// -----------------------------------------------------------------------------
// Registre de toutes les pièces émises sur une période (date d'émission) :
// factures (une par course terminée, une pour des frais d'annulation) et
// avoirs (remboursement, somme annulée), avec leur état de règlement.
// En tête : nombre et montants des factures et des avoirs, chiffre d'affaires
// HT et TVA nets, et le contrôle de la numérotation continue de chaque série
// (aucun numéro ne doit manquer). Chaque numéro ouvre la pièce imprimable.
// Lecture : admin_lister_factures.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, euros, nombre, afficherMessage } from '../../commun/outils.js';
import { lienAdmin } from '../commun/admin.js';
import {
  tableau, tuile, pluriel, dateCourte, jourHeure, badge, boutonExporter, exporterCsv, messageErreurAdmin,
  MODES_PAIEMENT, MODES_REMBOURSEMENT, ORIGINES_AVOIR
} from '../commun/composants.js';
import { champsPeriode, bornes, periodeValable, periodeLisible, periodeCourte } from '../commun/periode.js';
import { ecrireAdresse, lireDate, lirePage, pagination, chargerTout, nomFichier } from '../commun/listes.js';
import { COLONNES_REGISTRE, chronologique, etatFacture } from './exports.js';

const $ = (id) => document.getElementById(id);
const PAR_PAGE = 50;
const TYPES = [['tout', 'Factures et avoirs'], ['factures', 'Factures'], ['avoirs', 'Avoirs']];
const filtres = { du: '', au: '', type: 'tout', texte: '', page: 0 };

export function afficherFactures({ parametres }) {
  const mois = bornes('mois');
  filtres.du = lireDate(parametres, 'du') || mois.du;
  filtres.au = lireDate(parametres, 'au') || mois.au;
  if (!periodeValable(filtres.du, filtres.au)) Object.assign(filtres, mois);
  filtres.type = TYPES.some(([v]) => v === parametres.get('type')) ? parametres.get('type') : 'tout';
  filtres.texte = (parametres.get('q') || '').slice(0, 100);
  filtres.page = lirePage(parametres);
  $('entete-actions').replaceChildren(boutonExporter(exporter));

  const texte = el('input', { id: 'factures-texte', classe: 'saisie', type: 'search', autocomplete: 'off',
    placeholder: 'Numéro, client, entreprise, course' });
  texte.value = filtres.texte;
  const type = el('select', { id: 'factures-type', classe: 'saisie' }, ...TYPES.map(([v, l]) => el('option', { value: v, texte: l })));
  type.value = filtres.type;
  const formulaire = el('form', { classe: 'barre-outils', role: 'search' },
    ...champsPeriode({ prefixe: 'factures', du: filtres.du, au: filtres.au,
      changer: ({ du, au }) => { filtres.du = du; filtres.au = au; filtres.page = 0; charger(); } }),
    el('div', { classe: 'champ' }, el('label', { for: 'factures-type', texte: 'Pièces' }), type),
    el('div', { classe: 'champ champ-large' }, el('label', { for: 'factures-texte', texte: 'Rechercher' }), texte),
    el('button', { type: 'submit', classe: 'bouton bouton-principal', texte: 'Rechercher' }));
  formulaire.addEventListener('submit', (e) => { e.preventDefault(); filtres.texte = texte.value.trim(); filtres.page = 0; charger(); });
  type.addEventListener('change', () => { filtres.type = type.value; filtres.page = 0; charger(); });

  $('contenu').replaceChildren(
    el('div', { classe: 'chiffres-cles', id: 'chiffres-factures', 'aria-live': 'polite' }),
    el('div', { id: 'continuite' }),
    el('section', { classe: 'carte-admin', 'aria-labelledby': 'titre-registre' },
      el('div', { classe: 'carte-entete' }, el('h2', { id: 'titre-registre', texte: 'Registre' }),
        el('span', { classe: 'sous-titre', id: 'periode-registre' })),
      formulaire,
      el('p', { classe: 'resume-liste', id: 'resume-registre', 'aria-live': 'polite' }),
      el('div', { id: 'liste-registre' }, el('p', { classe: 'chargement', texte: 'Chargement…' })),
      el('div', { classe: 'pagination', id: 'pagination-registre' })));
  charger();
}

function parametres(limite, decalage) {
  return { p_type: filtres.type, p_debut: filtres.du, p_fin: filtres.au, p_texte: filtres.texte || null, p_limite: limite, p_decalage: decalage };
}

async function charger() {
  ecrireAdresse('factures', { du: filtres.du, au: filtres.au, type: filtres.type === 'tout' ? '' : filtres.type, q: filtres.texte, page: filtres.page });
  $('liste-registre').classList.add('rechargement');
  const { data, error } = await supabase.rpc('admin_lister_factures', parametres(PAR_PAGE, filtres.page * PAR_PAGE));
  $('liste-registre').classList.remove('rechargement');
  if (error) { $('liste-registre').replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  dessinerChiffres(data.totaux);
  dessinerContinuite(data.continuite);
  dessinerListe(data);
}

function dessinerChiffres(t) {
  const periode = periodeCourte(filtres.du, filtres.au);
  $('chiffres-factures').replaceChildren(
    tuile('Factures', euros(t.factures.ttc), `${pluriel(t.factures.nb, 'facture', 'factures')} TTC · ${periode}`),
    tuile('Avoirs', Number(t.avoirs.ttc) > 0 ? `− ${euros(t.avoirs.ttc)}` : euros(0),
      `${pluriel(t.avoirs.nb, 'avoir', 'avoirs')} TTC · ${periode}`, Number(t.avoirs.nb) ? 'or' : null),
    tuile('Chiffre d\'affaires HT', euros(t.net.ht), 'factures moins avoirs'),
    tuile('TVA facturée', euros(t.net.tva), `nette des avoirs · ${euros(t.net.ttc)} TTC`));
}

// Contrôle de la numérotation : une ligne par série et par année
function dessinerContinuite(series) {
  const zone = $('continuite');
  if (!series.length) { zone.replaceChildren(); return; }
  const anomalies = series.filter((s) => Number(s.nb_manquants) > 0);
  // Un numéro ne se coupe jamais en fin de ligne
  const numero = (s, n) => el('span', { classe: 'numero-piece', texte: `${s.prefixe}-${s.annee}-${String(n).padStart(6, '0')}` });
  const serie = (s) => `${s.serie === 'facture' ? 'Factures' : 'Avoirs'} ${s.annee} : `;
  zone.replaceChildren(el('section', { classe: 'continuite', dataset: { etat: anomalies.length ? 'anomalie' : 'ok' }, 'aria-label': 'Numérotation' },
    el('strong', { texte: anomalies.length ? 'Numérotation : numéros manquants' : 'Numérotation continue : aucun numéro manquant' }),
    ...series.map((s) => (Number(s.nb_manquants) > 0
      ? el('p', {}, serie(s), `${pluriel(s.nb_manquants, 'numéro manquant', 'numéros manquants')} (`,
        ...s.manquants.flatMap((n, i) => [i ? ', ' : '', numero(s, n)]),
        `${Number(s.nb_manquants) > s.manquants.length ? '…' : ''}). Signalez-le sans attendre.`)
      : el('p', {}, serie(s), numero(s, 1), ' à ', numero(s, s.dernier), `, ${pluriel(s.nombre, 'pièce', 'pièces')}.`)))));
}

// État d'une pièce : règlement pour une facture, origine pour un avoir
function etat(l) {
  if (l.type === 'avoir') {
    return el('span', {}, badge(ORIGINES_AVOIR[l.detail] || l.detail, 'gris'),
      el('span', { classe: 'secondaire', texte: l.remboursement
        ? `${(MODES_REMBOURSEMENT[l.remboursement.mode] || l.remboursement.mode).toLowerCase()} le ${dateCourte(l.remboursement.cree_le)}`
        : 'déduite de la somme due' }));
  }
  const p = l.paiement;
  const texte = etatFacture(l);
  const ton = /créditée/i.test(texte) ? 'gris' : !p ? 'gris' : { a_encaisser: 'or', encaisse: 'vert', echoue: 'rouge' }[p.statut] || 'gris';
  return el('span', {}, badge(texte, ton),
    p ? el('span', { classe: 'secondaire', texte: [MODES_PAIEMENT[p.mode] || p.mode, p.encaisse_le ? `le ${dateCourte(p.encaisse_le)}` : null].filter(Boolean).join(' ') }) : null);
}

const COLONNES = [
  { titre: 'Pièce', valeur: (l) => el('span', {},
    el('a', { href: lienAdmin(l.type === 'avoir' ? `finances/?avoir=${l.id}` : `finances/?facture=${l.id}`), texte: l.numero }),
    el('span', { classe: 'secondaire', texte: l.type === 'avoir' ? `Avoir sur ${l.facture_numero}`
      : l.detail === 'course' ? 'Facture de course' : 'Frais d\'annulation' })) },
  { titre: 'Date', valeur: (l) => dateCourte(l.date_emission) },
  { titre: 'Destinataire', valeur: (l) => el('span', {}, l.compte_pro_id
    ? el('a', { href: lienAdmin(`clients/?entreprise=${l.compte_pro_id}`), texte: l.destinataire_nom })
    : el('a', { href: lienAdmin(`clients/?id=${l.client_id}`), texte: l.destinataire_nom }),
  l.compte_pro_id ? el('span', { classe: 'secondaire', texte: `commandée par ${l.client_nom}` }) : null) },
  { titre: 'Course', valeur: (l) => el('span', {}, el('a', { href: lienAdmin(`courses/?id=${l.course_id}`), texte: l.course_numero }),
    el('span', { classe: 'secondaire', texte: jourHeure(l.prise_en_charge_le) })) },
  { titre: 'HT', droite: true, valeur: (l) => `${l.type === 'avoir' ? '− ' : ''}${euros(l.montant_ht)}` },
  { titre: 'TVA', droite: true, valeur: (l) => el('span', {}, `${l.type === 'avoir' ? '− ' : ''}${euros(l.montant_tva)}`,
    el('span', { classe: 'secondaire', texte: `${nombre(l.taux_tva, 2)} %` })) },
  { titre: 'TTC', droite: true, valeur: (l) => (l.type === 'avoir'
    ? el('strong', { classe: 'texte-rouge', texte: `− ${euros(l.montant_ttc)}` })
    : el('span', {}, el('strong', { texte: euros(l.montant_ttc) }),
      Number(l.credite) > 0 ? el('span', { classe: 'secondaire', texte: `${euros(l.credite)} crédités` }) : null)) },
  { titre: 'État', valeur: etat }
];

function dessinerListe(data) {
  $('periode-registre').textContent = `Émises ${periodeLisible(filtres.du, filtres.au)}`;
  $('resume-registre').replaceChildren(...(data.total ? [el('strong', { texte: pluriel(data.total, 'pièce', 'pièces') }),
    el('span', { texte: 'les plus récentes d\'abord ; le numéro ouvre la pièce imprimable' })] : []));
  $('liste-registre').replaceChildren(tableau({
    colonnes: COLONNES, lignes: data.lignes,
    vide: filtres.texte ? 'Aucune pièce ne correspond à cette recherche.' : 'Aucune facture ni aucun avoir émis sur cette période.',
    clicLigne: (l) => { location.href = lienAdmin(l.type === 'avoir' ? `finances/?avoir=${l.id}` : `finances/?facture=${l.id}`); },
    libelleLigne: (l) => `Ouvrir ${l.type === 'avoir' ? 'l\'avoir' : 'la facture'} ${l.numero}`
  }));
  pagination($('pagination-registre'), {
    total: data.total, page: filtres.page, parPage: PAR_PAGE, aller: (page) => { filtres.page = page; charger(); }
  });
}

// Registre de la période, dans l'ordre chronologique
async function exporter() {
  try {
    const data = await chargerTout('admin_lister_factures', parametres(0, 0));
    if (!data.lignes.length) { afficherMessage('Aucune pièce à exporter sur cette période.'); return; }
    exporterCsv(`${nomFichier('registre-factures-avoirs', filtres.du, filtres.au)}.csv`, COLONNES_REGISTRE, chronologique(data.lignes));
  } catch (erreur) {
    afficherMessage(messageErreurAdmin(erreur), 'erreur');
  }
}
