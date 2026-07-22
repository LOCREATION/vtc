// ============================================================
// LOC RÉACTION S.A.S — cgu.js
// ============================================================
import { getCurrentUser, redirectToDashboard } from './shared/supabase.js'
import { initLangSwitcher, t } from './shared/i18n.js'
import { initHamburger } from './shared/nav.js'

initLangSwitcher('lang-select-desktop', 'cgu', 0)
initLangSwitcher('lang-select-mobile', 'cgu', 0)
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

