// depth = 1 (auth/verify-email.html)
import { supabase } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'verify-email', 2)
initLangSwitcher('lang-select-mobile', 'verify-email', 2)
initHamburger('hamburger-btn', 'mobile-menu')

// L'email est transmis en paramètre d'URL depuis register.js après inscription
const params = new URLSearchParams(location.search)
const email = params.get('email') || ''
if (email) document.getElementById('verify-email-addr').textContent = email

window.resendEmail = async function() {
  const alertEl = document.getElementById('verify-alert')
  const btn = document.getElementById('resend-btn')
  alertEl.className = 'auth-alert'

  if (!email) {
    alertEl.textContent = t('resend_error')
    alertEl.classList.add('show-error')
    return
  }

  btn.disabled = true
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('resend_sending')}`

  const { error } = await supabase.auth.resend({ type: 'signup', email })

  btn.disabled = false
  btn.innerHTML = `<i class="fas fa-redo"></i> ${t('resend_btn')}`

  if (error) {
    alertEl.textContent = t('resend_error')
    alertEl.classList.add('show-error')
    return
  }

  alertEl.textContent = t('resend_success')
  alertEl.classList.add('show-success')
}
