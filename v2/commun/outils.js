// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Petits outils communs : montants, distances, dates, messages, téléphone
// =============================================================================
import { langueActive } from './i18n.js';

// Montant en euros : « 30,40 € » en français, « €30.40 » en anglais
export function euros(montant) {
  const locale = langueActive() === 'en' ? 'en-GB' : 'fr-FR';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(Number(montant) || 0);
}

// Nombre décimal à la française (12,3) ou à l'anglaise (12.3)
export function nombre(valeur, decimales = 1) {
  const locale = langueActive() === 'en' ? 'en-GB' : 'fr-FR';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: decimales }).format(Number(valeur) || 0);
}

// Date et heure à l'heure de Paris, quel que soit le fuseau du téléphone
export function dateHeure(instant, options = { dateStyle: 'full', timeStyle: 'short' }) {
  const locale = langueActive() === 'en' ? 'en-GB' : 'fr-FR';
  return new Intl.DateTimeFormat(locale, { timeZone: 'Europe/Paris', ...options }).format(new Date(instant));
}

// Valeur pour un champ <input type="datetime-local"> (heure locale du téléphone)
export function valeurDateHeureLocale(date) {
  const decalage = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - decalage).toISOString().slice(0, 16);
}

// Exécute « fonction » seulement après « delai » ms sans nouvel appel
// (utile pendant la frappe : une seule recherche quand on s'arrête d'écrire)
export function apresPause(fonction, delai = 250) {
  let minuteur;
  return (...args) => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => fonction(...args), delai);
  };
}

// Crée un élément sans jamais interpréter de HTML (le texte reste du texte)
export function el(balise, attributs = {}, ...enfants) {
  const noeud = document.createElement(balise);
  for (const [cle, valeur] of Object.entries(attributs)) {
    if (valeur === null || valeur === undefined || valeur === false) continue;
    if (cle === 'classe') noeud.className = valeur;
    else if (cle === 'texte') noeud.textContent = valeur;
    else if (cle.startsWith('on') && typeof valeur === 'function') noeud.addEventListener(cle.slice(2), valeur);
    else if (cle === 'dataset') Object.assign(noeud.dataset, valeur);
    else noeud.setAttribute(cle, valeur === true ? '' : valeur);
  }
  for (const enfant of enfants.flat()) {
    if (enfant === null || enfant === undefined || enfant === false) continue;
    noeud.append(enfant instanceof Node ? enfant : document.createTextNode(String(enfant)));
  }
  return noeud;
}

// Message bref en bas de l'écran, annoncé aux lecteurs d'écran.
// type : « info », « succes » ou « erreur ».
export function afficherMessage(texte, type = 'info') {
  let zone = document.getElementById('zone-messages');
  if (!zone) {
    zone = el('div', { id: 'zone-messages', classe: 'zone-messages', 'aria-live': 'polite', role: 'status' });
    document.body.append(zone);
  }
  const message = el('p', { classe: `message message-${type}`, texte });
  zone.append(message);
  setTimeout(() => message.remove(), type === 'erreur' ? 7000 : 4000);
}

// Numéro de téléphone au format international (+33612345678), ou null.
// Accepte « 06 12 34 56 78 », « 0033 6… », « +33 6… », avec espaces ou points.
export function telephoneInternational(saisie) {
  let numero = String(saisie || '').replace(/[\s.\-()]/g, '');
  if (numero.startsWith('00')) numero = '+' + numero.slice(2);
  if (/^0[1-9][0-9]{8}$/.test(numero)) numero = '+33' + numero.slice(1);   // numéro français
  return /^\+[1-9][0-9]{6,14}$/.test(numero) ? numero : null;
}

// Adresse e-mail plausible (la vraie vérification est le code reçu)
export function emailValide(saisie) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(saisie || '').trim());
}

// Supprime les accents et la casse (recherche « orly » = « Orly »)
export function sansAccents(texte) {
  return String(texte || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Distance à vol d'oiseau entre deux points, en km (même formule que la base)
export function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (degres) => (degres * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Lieu desservi (aéroport, gare) qui contient ce point, le plus précis d'abord
export function zoneDuPoint(zones, lat, lng) {
  return zones
    .filter((z) => distanceKm(lat, lng, Number(z.latitude), Number(z.longitude)) <= Number(z.rayon_km))
    .sort((a, b) => Number(a.rayon_km) - Number(b.rayon_km))[0] || null;
}
