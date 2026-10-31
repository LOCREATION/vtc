// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : outils des listes (communs aux modules)
// -----------------------------------------------------------------------------
//   - filtres gardés dans l'adresse de la page (retour arrière et
//     rechargement les conservent) ;
//   - pagination « Précédent / Suivant » ;
//   - lecture de toutes les pages d'une liste (exports CSV et dossier ZIP).
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el } from '../../commun/outils.js';

// Écrit la vue et les filtres dans l'adresse (valeurs vides omises)
export function ecrireAdresse(vue, valeurs = {}) {
  const p = new URLSearchParams({ vue });
  for (const [cle, valeur] of Object.entries(valeurs)) {
    if (valeur !== null && valeur !== undefined && valeur !== '' && valeur !== 0) p.set(cle, String(valeur));
  }
  history.replaceState(null, '', `${location.pathname}?${p}`);
}

// Date « AAAA-MM-JJ » lue dans l'adresse, ou ''
export function lireDate(parametres, cle) {
  const v = parametres.get(cle) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

// Numéro de page lu dans l'adresse (0 = première)
export function lirePage(parametres) {
  return Math.max(0, parseInt(parametres.get('page') || '0', 10) || 0);
}

// Boutons de pagination dans « zone » ; aller(page) recharge la liste
export function pagination(zone, { total, page, parPage, aller }) {
  const pages = Math.max(1, Math.ceil(total / parPage));
  if (total <= parPage) { zone.replaceChildren(); return; }
  const precedent = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Précédent', disabled: page === 0 });
  const suivant = el('button', { type: 'button', classe: 'bouton bouton-secondaire bouton-petit', texte: 'Suivant', disabled: page >= pages - 1 });
  precedent.addEventListener('click', () => { aller(page - 1); window.scrollTo(0, 0); });
  suivant.addEventListener('click', () => { aller(page + 1); window.scrollTo(0, 0); });
  zone.replaceChildren(precedent, el('span', { texte: `Page ${page + 1} sur ${pages}` }), suivant);
}

// Toutes les lignes d'une liste paginée par la base (2 000 par demande)
export async function chargerTout(fonction, parametres, parDemande = 2000) {
  let resultat = null;
  let lignes = [];
  for (let decalage = 0; ; decalage += parDemande) {
    const { data, error } = await supabase.rpc(fonction, { ...parametres, p_limite: parDemande, p_decalage: decalage });
    if (error) throw error;
    resultat = data;
    lignes = lignes.concat(data.lignes);
    if (!data.lignes.length || lignes.length >= data.total) break;
  }
  return { ...resultat, lignes };
}

// Nom de fichier sans espaces ni accents gênants : « encaissements-2026-10-01-2026-10-31.csv »
export function nomFichier(...parties) {
  return parties.filter(Boolean).join('-').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase();
}
