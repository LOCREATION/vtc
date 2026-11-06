// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : jours et périodes, à l'heure de Paris
// -----------------------------------------------------------------------------
// Un jour s'écrit « AAAA-MM-JJ » (comme dans la base). Les calculs se font sur
// des dates UTC fixées à midi : le passage à l'heure d'été ou d'hiver ne
// décale jamais un jour. Une semaine va du lundi au dimanche.
// Utilisé par les onglets Revenus et Courses, et par les documents (PDF).
// =============================================================================

// « fr-CA » écrit les dates dans l'ordre AAAA-MM-JJ
const FORMAT_JOUR = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

// Jour de Paris d'un instant (par défaut : maintenant)
export function jourParis(instant = new Date()) {
  return FORMAT_JOUR.format(new Date(instant));
}

function versDate(jour) {
  const [annee, mois, j] = jour.split('-').map(Number);
  return new Date(Date.UTC(annee, mois - 1, j, 12));
}

function versJour(date) {
  return date.toISOString().slice(0, 10);
}

export function ajouterJours(jour, n) {
  const d = versDate(jour);
  d.setUTCDate(d.getUTCDate() + n);
  return versJour(d);
}

// Premier jour du mois, décalé de n mois
export function ajouterMois(jour, n) {
  const d = versDate(jour);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return versJour(d);
}

// Bornes (comprises) de la période « jour », « semaine » ou « mois » qui
// contient le jour donné
export function bornesPeriode(type, jour) {
  if (type === 'jour') return { du: jour, au: jour };
  if (type === 'semaine') {
    const lundi = ajouterJours(jour, -((versDate(jour).getUTCDay() + 6) % 7));
    return { du: lundi, au: ajouterJours(lundi, 6) };
  }
  const premier = `${jour.slice(0, 7)}-01`;
  return { du: premier, au: ajouterJours(ajouterMois(premier, 1), -1) };
}

// Un jour de la période précédente (sens = -1) ou suivante (sens = +1)
export function deplacerPeriode(type, du, sens) {
  if (type === 'jour') return ajouterJours(du, sens);
  if (type === 'semaine') return ajouterJours(du, 7 * sens);
  return ajouterMois(du, sens);
}

// « 1er » pour le premier du mois, comme on l'écrit en français
function numeroDuJour(d) {
  return d.getUTCDate() === 1 ? '1er' : String(d.getUTCDate());
}

// « mardi 3 novembre 2026 » ; sans le jour de la semaine ou sans l'année
export function dateLongue(jour, { jourSemaine = true, annee = true } = {}) {
  const d = versDate(jour);
  return [jourSemaine ? JOURS[d.getUTCDay()] : null, numeroDuJour(d), MOIS[d.getUTCMonth()], annee ? d.getUTCFullYear() : null]
    .filter(Boolean).join(' ');
}

// « 03/11/2026 »
export function dateCourte(jour) {
  return `${jour.slice(8, 10)}/${jour.slice(5, 7)}/${jour.slice(0, 4)}`;
}

export function majuscule(texte) {
  return texte ? texte.charAt(0).toUpperCase() + texte.slice(1) : texte;
}

// Libellé d'une période : « Aujourd'hui », « Hier », « Mardi 3 novembre 2026 »,
// « Semaine du 2 au 8 novembre 2026 », « Novembre 2026 »
export function libellePeriode(type, du, au) {
  if (type === 'jour') {
    const aujourdhui = jourParis();
    if (du === aujourdhui) return 'Aujourd\'hui';
    if (du === ajouterJours(aujourdhui, -1)) return 'Hier';
    return majuscule(dateLongue(du));
  }
  if (type === 'semaine') {
    const debut = versDate(du);
    const debutTexte = du.slice(0, 7) === au.slice(0, 7)
      ? numeroDuJour(debut)
      : dateLongue(du, { jourSemaine: false, annee: du.slice(0, 4) !== au.slice(0, 4) });
    return `Semaine du ${debutTexte} au ${dateLongue(au, { jourSemaine: false })}`;
  }
  const d = versDate(du);
  return majuscule(`${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}`);
}

// La période dans une phrase : « aujourd'hui », « le mardi 3 novembre 2026 »,
// « la semaine du 2 au 8 novembre 2026 », « en novembre 2026 »
export function periodeDansPhrase(type, du, au) {
  const libelle = libellePeriode(type, du, au);
  if (type === 'jour') return ['Aujourd\'hui', 'Hier'].includes(libelle) ? libelle.toLowerCase() : `le ${dateLongue(du)}`;
  if (type === 'semaine') return `la s${libelle.slice(1)}`;
  return `en ${libelle.toLowerCase()}`;
}

// Durée lisible : « 45 min », « 2 h », « 2 h 05 »
export function dureeLisible(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const reste = total % 60;
  return reste ? `${Math.floor(total / 60)} h ${String(reste).padStart(2, '0')}` : `${Math.floor(total / 60)} h`;
}

// Heures décimales lisibles : 35 → « 35 h », 7.5 → « 7 h 30 »
export function heuresLisibles(heures) {
  return dureeLisible((Number(heures) || 0) * 60);
}
