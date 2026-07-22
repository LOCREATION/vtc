// ============================================================
// LOC RÉACTION S.A.S — contact.js
// ============================================================
import { getCurrentUser, redirectToDashboard } from './shared/supabase.js'
import { initLangSwitcher, t } from './shared/i18n.js'
import { initHamburger } from './shared/nav.js'

initLangSwitcher('lang-select-desktop', 'contact', 0)
initLangSwitcher('lang-select-mobile', 'contact', 0)
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

import { supabase } from './shared/supabase.js'
window.sendContact = async function() {
  const nom = document.getElementById('c-nom').value.trim()
  const email = document.getElementById('c-email').value.trim()
  const telephone = document.getElementById('c-tel').value.trim()
  const sujet = document.getElementById('c-sujet').value.trim()
  const message = document.getElementById('c-message').value.trim()
  const alertEl = document.getElementById('contact-alert')
  alertEl.className = 'form-alert'
  if (!nom || !email || !sujet || !message) {
    alertEl.textContent = t('error_required')
    alertEl.classList.add('show-error')
    return
  }
  const { error } = await supabase.from('contact_messages').insert({ nom, email, telephone: telephone || null, sujet, message })
  if (error) {
    alertEl.textContent = 'Erreur : ' + error.message
    alertEl.classList.add('show-error')
    return
  }
  alertEl.textContent = t('success')
  alertEl.classList.add('show-success')
  document.getElementById('c-nom').value = ''
  document.getElementById('c-email').value = ''
  document.getElementById('c-tel').value = ''
  document.getElementById('c-sujet').value = ''
  document.getElementById('c-message').value = ''
}

