// ============================================================
// LOC RÉACTION S.A.S — shared/i18n.js
// Moteur de traduction partagé — réutilisé sur les 50 pages
// Choix assumé : PAS de localStorage. La langue est détectée
// depuis le navigateur (navigator.language) à chaque chargement,
// puis modifiable pour la session en cours via le sélecteur.
//
// ARCHITECTURE (v2) : chaque page a SON PROPRE dossier de
// traductions : shared/i18n/<page>/<lang>.json
// → une page livrée ne fait plus jamais référence à un fichier
//   partagé qu'une autre page pourrait modifier plus tard.
// ============================================================

export const SUPPORTED_LANGS = ['fr', 'en', 'es', 'pt', 'zh', 'ja']
export const LANG_LABELS = { fr: 'Français', en: 'English', es: 'Español', pt: 'Português', zh: '中文', ja: '日本語' }

let currentDict = {}
let currentLang = 'fr'

function detectBrowserLang() {
  const nav = (navigator.language || 'fr').slice(0, 2).toLowerCase()
  return SUPPORTED_LANGS.includes(nav) ? nav : 'fr'
}

// page = nom du dossier de traduction propre à la page (ex: 'index', 'contact', 'faq')
// depth = nombre de niveaux de dossiers depuis la racine (0 pour les pages racine, 1 pour auth/login.html, etc.)
export async function loadLang(lang, page, depth = 0) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = 'fr'
  const prefix = '../'.repeat(depth)
  const res = await fetch(`${prefix}shared/i18n/${page}/${lang}.json`)
  currentDict = await res.json()
  currentLang = lang
  applyTranslations()
  document.documentElement.setAttribute('lang', lang)
  document.documentElement.setAttribute('dir', 'ltr')
  return currentDict
}

export function t(key) {
  return currentDict[key] || key
}

export function getCurrentLang() {
  return currentLang
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')
    if (currentDict[key]) el.textContent = currentDict[key]
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder')
    if (currentDict[key]) el.setAttribute('placeholder', currentDict[key])
  })
  const titleKey = document.querySelector('[data-i18n-title]')
  if (titleKey && currentDict[titleKey.getAttribute('data-i18n-title')]) {
    document.title = currentDict[titleKey.getAttribute('data-i18n-title')]
  }
}

// Initialise le sélecteur de langue (liste déroulante) et branche le changement
export function initLangSwitcher(selectId, page, depth = 0) {
  const sel = document.getElementById(selectId)
  if (!sel) return
  sel.innerHTML = SUPPORTED_LANGS.map(l => `<option value="${l}">${LANG_LABELS[l]}</option>`).join('')
  sel.value = detectBrowserLang()
  loadLang(sel.value, page, depth)
  sel.addEventListener('change', () => loadLang(sel.value, page, depth))
}
