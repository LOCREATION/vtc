// ============================================================
// LOC RÉACTION S.A.S — /location-immobiliere.js
// depth = 1 (services/location-immobiliere.html)
// ============================================================
import { getCurrentUser, redirectToDashboard } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'location-immobiliere', 2)
initLangSwitcher('lang-select-mobile', 'location-immobiliere', 2)
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

