// depth = 1 (auth/reset-password.html)
import { supabase } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'reset-password', 2)
initLangSwitcher('lang-select-mobile', 'reset-password', 2)
initHamburger('hamburger-btn', 'mobile-menu')

// Le client Supabase détecte automatiquement le jeton de récupération présent
// dans l'URL (envoyé par email) et crée une session temporaire.
// On vérifie qu'une session existe réellement avant d'autoriser le changement.
async function checkRecoverySession() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    document.getElementById('reset-valid-block').style.display = 'none'
    document.getElementById('reset-invalid-block').style.display = 'block'
  }
}
checkRecoverySession()

window.togglePw = function(id, btn) {
  const input = document.getElementById(id)
  const icon = btn.querySelector('i')
  if (input.type === 'password') { input.type = 'text'; icon.className = 'fas fa-eye-slash' }
  else { input.type = 'password'; icon.className = 'fas fa-eye' }
}

window.doReset = async function() {
  const pw = document.getElementById('rp-password').value
  const pwConfirm = document.getElementById('rp-password-confirm').value
  const alertEl = document.getElementById('reset-alert')
  const btn = document.getElementById('reset-btn')
  alertEl.className = 'auth-alert'

  if (!pw || !pwConfirm) {
    alertEl.textContent = t('err_required')
    alertEl.classList.add('show-error')
    return
  }
  if (pw !== pwConfirm) {
    alertEl.textContent = t('err_mismatch')
    alertEl.classList.add('show-error')
    return
  }
  if (pw.length < 8) {
    alertEl.textContent = t('err_short')
    alertEl.classList.add('show-error')
    return
  }

  btn.disabled = true
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('submitting')}`

  const { error } = await supabase.auth.updateUser({ password: pw })

  if (error) {
    alertEl.textContent = error.message
    alertEl.classList.add('show-error')
    btn.disabled = false
    btn.innerHTML = `<i class="fas fa-check"></i> ${t('submit')}`
    return
  }

  alertEl.textContent = t('success')
  alertEl.classList.add('show-success')
  document.getElementById('reset-form').style.display = 'none'

  setTimeout(() => { window.location.href = '../login/login.html' }, 2200)
}
