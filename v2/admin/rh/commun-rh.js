// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : RH et paie — éléments communs aux onglets
// -----------------------------------------------------------------------------
// Libellés (contrats, absences, statuts), pastilles, nombres à la française
// avec le bon nombre de décimales (taux horaire exact, jamais arrondi au
// centime), mois de paie, n° de Sécurité sociale lisible et sa clé.
// =============================================================================
import { el } from '../../commun/outils.js';
import { badge, jourParis } from '../commun/composants.js';

export const TYPES_CONTRAT = { CDI: 'CDI', CDD: 'CDD', apprentissage: 'Apprentissage', avenant: 'Avenant' };
export const TEMPS = { plein: 'Temps plein', partiel: 'Temps partiel' };
export const STATUTS_SALARIE = {
  en_poste: { libelle: 'En poste', ton: 'vert' }, a_venir: { libelle: 'Entrée à venir', ton: 'bleu' }, sorti: { libelle: 'Sorti', ton: 'gris' }
};
export const STATUTS_CONTRAT = {
  brouillon: { libelle: 'À imprimer', ton: 'or' }, envoye: { libelle: 'Remis pour signature', ton: 'bleu' },
  signe: { libelle: 'Signé, classé', ton: 'vert' }, termine: { libelle: 'Terminé', ton: 'gris' }
};
export const STATUTS_BULLETIN = {
  brouillon: { libelle: 'Brouillon', ton: 'or' }, valide: { libelle: 'Validé', ton: 'vert' }, envoye: { libelle: 'Remis', ton: 'vert' }
};
export const TYPES_ABSENCE = {
  conges_payes: { libelle: 'Congés payés', ton: 'bleu' }, maladie: { libelle: 'Maladie', ton: 'or' },
  accident_travail: { libelle: 'Accident du travail', ton: 'rouge' }, sans_solde: { libelle: 'Sans solde', ton: 'gris' },
  autre: { libelle: 'Autre absence', ton: 'gris' }
};
export const STATUTS_ABSENCE = {
  demandee: { libelle: 'Demandée', ton: 'or' }, validee: { libelle: 'Acceptée', ton: 'vert' }, refusee: { libelle: 'Refusée', ton: 'rouge' }
};
export const MOTIFS_CDD = {
  accroissement: 'Accroissement temporaire d\'activité', remplacement: 'Remplacement d\'un salarié absent', saisonnier: 'Emploi saisonnier'
};

export function pastille(table, code) {
  const s = table[code] || { libelle: code, ton: 'gris' };
  return badge(s.libelle, s.ton);
}

// « 12,5272 » : au moins « min » décimales, au plus « max » (taux exact)
export function decimal(valeur, min = 2, max = 6) {
  if (valeur === null || valeur === undefined || valeur === '') return '';
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: min, maximumFractionDigits: max }).format(Number(valeur));
}

// Heures : « 151,67 h »
export function heures(valeur) {
  return `${decimal(valeur, 0, 2)} h`;
}

// Taux en pourcentage : « 6,90 % », « 0,016 % »
export function pourcent(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return `${decimal(valeur, 2, 4)} %`;
}

// Jours de congés : « 2,5 j », « −1,4 j »
export function joursConges(valeur) {
  const n = Number(valeur || 0);
  return `${n < 0 ? '−' : ''}${decimal(Math.abs(n), 0, 2)} j`;
}

// « 2026-10-01 » du mois d'un jour
export function debutMois(jour = jourParis()) {
  return `${jour.slice(0, 7)}-01`;
}

// Mois voisin (« 2026-10-01 », -1 → « 2026-09-01 »)
export function moisVoisin(mois, decalage) {
  const [a, m] = mois.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + decalage, 1));
  return d.toISOString().slice(0, 10);
}

// Dernier jour d'un mois « 2026-10-01 » → « 2026-10-31 »
export function finMois(mois) {
  const d = new Date(`${moisVoisin(mois, 1)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// « octobre 2026 »
export function moisEnLettres(mois) {
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${mois.slice(0, 7)}-15T12:00:00Z`));
}

// « d'octobre 2026 », « de novembre 2026 » (élision devant une voyelle)
export function deMois(mois) {
  const t = moisEnLettres(mois);
  return /^[aeiouyàâéèêîôû]/i.test(t) ? `d'${t}` : `de ${t}`;
}

// Taux horaire exact, comme la base : 4 décimales, ou 5 ou 6 s'il le faut
// pour que heures × taux redonne le salaire de base au centime près
export function tauxExact(base, heures) {
  const b = Number(base);
  const h = Number(heures);
  for (const n of [4, 5, 6]) {
    const t = Math.round((b / h) * 10 ** n) / 10 ** n;
    if (Math.round(h * t * 100) === Math.round(b * 100)) return t;
  }
  return Math.round((b / h) * 1e6) / 1e6;
}

// Liste déroulante des mois : de « avant » mois en arrière à « apres » mois en avant
export function choixMois({ id, valeur, avant = 18, apres = 2, changer }) {
  const courant = debutMois();
  const options = [];
  for (let i = apres; i >= -avant; i -= 1) {
    const m = moisVoisin(courant, i);
    options.push(el('option', { value: m, texte: moisEnLettres(m) }));
  }
  const choix = el('select', { id, classe: 'saisie' }, ...options);
  if (valeur && !options.some((o) => o.value === valeur)) choix.prepend(el('option', { value: valeur, texte: moisEnLettres(valeur) }));
  choix.value = valeur || courant;
  choix.addEventListener('change', () => changer(choix.value));
  return choix;
}

// N° de Sécurité sociale : « 2 85 07 75 123 456 55 »
export function nssLisible(nss) {
  const n = String(nss || '');
  if (!/^\d{13}(\d{2})?$/.test(n)) return n;
  return `${n[0]} ${n.slice(1, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7, 10)} ${n.slice(10, 13)}${n.length === 15 ? ` ${n.slice(13)}` : ''}`;
}

// Contrôle du n° de Sécurité sociale saisi (clé = 97 − reste de la division des
// 13 premiers chiffres par 97) ; renvoie un message ou null
export function erreurNss(valeur) {
  const n = String(valeur || '').replace(/[\s.\-]/g, '');
  if (!/^[12]\d{12}(\d{2})?$/.test(n)) return 'N° de Sécurité sociale : 13 chiffres (commençant par 1 ou 2) et la clé à 2 chiffres.';
  if (n.length === 15) {
    const cle = 97 - Number(BigInt(n.slice(0, 13)) % 97n);
    if (cle !== Number(n.slice(13))) return 'La clé ne correspond pas aux 13 premiers chiffres : vérifiez la saisie.';
  }
  return null;
}

// Date « AAAA-MM-JJ » + n mois − 1 jour (fin d'une période d'essai de n
// mois), comme la base : un 31 janvier + 1 mois donne le 28 février, puis
// la veille
export function finApresMois(jour, mois) {
  const [a, m, j] = jour.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + mois, j));
  if (d.getUTCDate() !== j) d.setUTCDate(0);          // mois plus court : son dernier jour
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Montants : « 1 900,00 € » (négatifs avec le signe moins typographique)
export function montant(valeur) {
  const n = Number(valeur || 0);
  const texte = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Math.abs(n));
  return n < 0 ? `−${texte}` : texte;
}
