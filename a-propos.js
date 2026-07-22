// ============================================================
// LOC RÉACTION S.A.S — a-propos.js
// Logique propre à la page À propos
// ============================================================
import { getCurrentUser, redirectToDashboard } from './shared/supabase.js'
import { initLangSwitcher, t } from './shared/i18n.js'
import { initHamburger } from './shared/nav.js'

// depth = 0 : a-propos.html est à la racine
initLangSwitcher('lang-select-desktop', 'a-propos', 0)
initLangSwitcher('lang-select-mobile', 'a-propos', 0)
initHamburger('hamburger-btn', 'mobile-menu')

async function checkAuth() {
  const user = await getCurrentUser()
  if (!user) return
  document.querySelectorAll('.nav-cta-login').forEach(el => {
    el.textContent = t('nav_my_space')
    el.onclick = (e) => { e.preventDefault(); redirectToDashboard(user.role, 0) }
  })
}
checkAuth()
