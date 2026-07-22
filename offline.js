// Pas de sélecteur visible sur cette page — on charge simplement le français,
// la langue du navigateur sera respectée si on ajoute un sélecteur plus tard.
import { loadLang } from './shared/i18n.js'
const browserLang = (navigator.language || 'fr').slice(0,2).toLowerCase()
const supported = ['fr','en','es','pt','zh','ja']
loadLang(supported.includes(browserLang) ? browserLang : 'fr', 'offline', 0)
