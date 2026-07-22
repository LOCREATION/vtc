// ============================================================
// LOC RÉACTION S.A.S — /btp.js
// depth = 1 (services/btp.html)
// ============================================================
import { getCurrentUser, redirectToDashboard } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'btp', 2)
initLangSwitcher('lang-select-mobile', 'btp', 2)
initHamburger('hamburger-btn', 'mobile-menu')

async function checkAuth() {
  const user = await getCurrentUser()
  if (!user) return
  document.querySelectorAll('.nav-cta-login').forEach(el => {
    el.textContent = t('nav_my_space')
    el.onclick = (e) => { e.preventDefault(); redirectToDashboard(user.role, 2) }
  })
}
checkAuth()

