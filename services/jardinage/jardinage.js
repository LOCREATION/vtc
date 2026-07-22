// ============================================================
// LOC RÉACTION S.A.S — /jardinage.js
// depth = 1 (services/jardinage.html)
// ============================================================
import { getCurrentUser, redirectToDashboard } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'jardinage', 2)
initLangSwitcher('lang-select-mobile', 'jardinage', 2)
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

