// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : choix d'une période (commun aux modules)
// -----------------------------------------------------------------------------
// Raccourcis (aujourd'hui, ce mois-ci, mois dernier, ce trimestre, trimestre
// dernier, cette année, année dernière) ou dates libres, toujours en jours de
// Paris (« AAAA-MM-JJ »), bornes comprises. Un raccourci remplit les dates ;
// des dates saisies à la main affichent le raccourci qui leur correspond,
// sinon « Dates choisies ».
// =============================================================================
import { el, afficherMessage } from '../../commun/outils.js';
import { jourParis, ajouterJours, dateCourte } from './composants.js';

export const PERIODES = [
  { code: 'jour', libelle: 'Aujourd\'hui' },
  { code: 'mois', libelle: 'Ce mois-ci' },
  { code: 'mois_precedent', libelle: 'Mois dernier' },
  { code: 'trimestre', libelle: 'Ce trimestre' },
  { code: 'trimestre_precedent', libelle: 'Trimestre dernier' },
  { code: 'annee', libelle: 'Cette année' },
  { code: 'annee_precedente', libelle: 'Année dernière' },
  { code: 'libre', libelle: 'Dates choisies' }
];

const deux = (n) => String(n).padStart(2, '0');
// Dernier jour d'un mois (1 à 12)
const finMois = (annee, mois) => ajouterJours(`${mois === 12 ? annee + 1 : annee}-${deux(mois === 12 ? 1 : mois + 1)}-01`, -1);

// Bornes d'un raccourci, ou null pour « Dates choisies »
export function bornes(code, aujourdhui = jourParis()) {
  const [a, m] = aujourdhui.split('-').map(Number);
  const debutTrimestre = Math.floor((m - 1) / 3) * 3 + 1;
  switch (code) {
    case 'jour': return { du: aujourdhui, au: aujourdhui };
    case 'mois': return { du: `${a}-${deux(m)}-01`, au: aujourdhui };
    case 'mois_precedent': {
      const pa = m === 1 ? a - 1 : a;
      const pm = m === 1 ? 12 : m - 1;
      return { du: `${pa}-${deux(pm)}-01`, au: finMois(pa, pm) };
    }
    case 'trimestre': return { du: `${a}-${deux(debutTrimestre)}-01`, au: aujourdhui };
    case 'trimestre_precedent': {
      const pa = debutTrimestre === 1 ? a - 1 : a;
      const pm = debutTrimestre === 1 ? 10 : debutTrimestre - 3;
      return { du: `${pa}-${deux(pm)}-01`, au: finMois(pa, pm + 2) };
    }
    case 'annee': return { du: `${a}-01-01`, au: aujourdhui };
    case 'annee_precedente': return { du: `${a - 1}-01-01`, au: `${a - 1}-12-31` };
    default: return null;
  }
}

// Raccourci correspondant à des dates (« libre » sinon)
export function codePeriode(du, au) {
  const trouve = PERIODES.find((p) => { const b = bornes(p.code); return b && b.du === du && b.au === au; });
  return trouve ? trouve.code : 'libre';
}

// « octobre 2026 », « du 01/10/2026 au 30/10/2026 », « le 30/10/2026 »
export function periodeLisible(du, au) {
  if (du === au) return `le ${dateCourte(du)}`;
  const [a, m, j] = du.split('-').map(Number);
  if (j === 1 && au === finMois(a, m)) {
    return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${du}T12:00:00Z`));
  }
  if (du === `${a}-01-01` && au === `${a}-12-31`) return `l'année ${a}`;
  return `du ${dateCourte(du)} au ${dateCourte(au)}`;
}

// « ce mois-ci », « mois dernier », « aujourd'hui »… ou les dates
export function periodeCourte(du, au) {
  const code = codePeriode(du, au);
  if (code !== 'libre') return PERIODES.find((p) => p.code === code).libelle.toLowerCase();
  return periodeLisible(du, au);
}

// Période valable : deux dates, dans l'ordre
export function periodeValable(du, au) {
  return /^\d{4}-\d{2}-\d{2}$/.test(du || '') && /^\d{4}-\d{2}-\d{2}$/.test(au || '') && du <= au;
}

// Champs d'une barre de filtres : raccourci, puis « Du » et « Au ».
// changer({ du, au }) est appelé à chaque période valable choisie.
export function champsPeriode({ prefixe, du, au, changer }) {
  const choix = el('select', { id: `${prefixe}-periode`, classe: 'saisie' },
    ...PERIODES.map((p) => el('option', { value: p.code, texte: p.libelle })));
  const saisieDu = el('input', { id: `${prefixe}-du`, classe: 'saisie', type: 'date', value: du });
  const saisieAu = el('input', { id: `${prefixe}-au`, classe: 'saisie', type: 'date', value: au });
  choix.value = codePeriode(du, au);

  choix.addEventListener('change', () => {
    const b = bornes(choix.value);
    if (!b) { saisieDu.focus(); return; }               // « Dates choisies » : à saisir
    saisieDu.value = b.du;
    saisieAu.value = b.au;
    changer(b);
  });
  const datesSaisies = () => {
    if (!saisieDu.value || !saisieAu.value) return;
    if (saisieAu.value < saisieDu.value) { afficherMessage('La date de fin est avant la date de début.', 'erreur'); return; }
    choix.value = codePeriode(saisieDu.value, saisieAu.value);
    changer({ du: saisieDu.value, au: saisieAu.value });
  };
  saisieDu.addEventListener('change', datesSaisies);
  saisieAu.addEventListener('change', datesSaisies);

  return [
    el('div', { classe: 'champ champ-periode' }, el('label', { for: `${prefixe}-periode`, texte: 'Période' }), choix),
    el('div', { classe: 'champ' }, el('label', { for: `${prefixe}-du`, texte: 'Du' }), saisieDu),
    el('div', { classe: 'champ' }, el('label', { for: `${prefixe}-au`, texte: 'Au' }), saisieAu)
  ];
}
