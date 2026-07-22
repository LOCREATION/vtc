// ============================================================
// LOC RÉACTION S.A.S — faq.js
// ============================================================
import { getCurrentUser, redirectToDashboard } from './shared/supabase.js'
import { initLangSwitcher, t } from './shared/i18n.js'
import { initHamburger } from './shared/nav.js'

initLangSwitcher('lang-select-desktop', 'faq', 0)
initLangSwitcher('lang-select-mobile', 'faq', 0)
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

window.toggleFaq = function(btn) {
  const item = btn.parentElement
  const wasOpen = item.classList.contains('open')
  document.querySelectorAll('.faq-item').forEach(el => el.classList.remove('open'))
  if (!wasOpen) item.classList.add('open')
}

