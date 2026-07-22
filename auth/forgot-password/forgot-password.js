// depth = 1 (auth/forgot-password.html)
import { supabase } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'forgot-password', 2)
initLangSwitcher('lang-select-mobile', 'forgot-password', 2)
initHamburger('hamburger-btn', 'mobile-menu')

window.doForgot = async function() {
  const email = document.getElementById('f-email').value.trim()
  const alertEl = document.getElementById('forgot-alert')
  const btn = document.getElementById('forgot-btn')
  alertEl.className = 'auth-alert'

  if (!email) {
    alertEl.textContent = t('err_required')
    alertEl.classList.add('show-error')
    return
  }

  btn.disabled = true
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('submitting')}`

  // redirectTo pointe vers reset-password.html à la racine du site (depth=1 -> "../")
  const redirectTo = window.location.origin + window.location.pathname.replace('/auth/forgot-password/forgot-password.html', '/auth/reset-password/reset-password.html')
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })

  btn.disabled = false
  btn.innerHTML = `<i class="fas fa-paper-plane"></i> ${t('submit')}`

  if (error) {
    alertEl.textContent = t('err_generic')
    alertEl.classList.add('show-error')
    return
  }

  alertEl.textContent = t('success')
  alertEl.classList.add('show-success')
  document.getElementById('forgot-form').style.display = 'none'
}
