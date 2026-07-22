// ============================================================
// LOC RÉACTION S.A.S — /register.js
// depth = 1 (auth/register.html)
// ============================================================
import { supabase } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'register', 2)
initLangSwitcher('lang-select-mobile', 'register', 2)
initHamburger('hamburger-btn', 'mobile-menu')

let selectedRole = 'client'

const params = new URLSearchParams(location.search)
const urlRole = params.get('role')
if (urlRole && ['client', 'chauffeur'].includes(urlRole)) {
  selectedRole = urlRole
  document.querySelectorAll('.role-tab').forEach(el => el.classList.toggle('active', el.dataset.role === urlRole))
  document.getElementById('driver-fields').classList.toggle('show', urlRole === 'chauffeur')
}

window.selectRole = function(role, el) {
  selectedRole = role
  document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'))
  el.classList.add('active')
  document.getElementById('driver-fields').classList.toggle('show', role === 'chauffeur')
}

window.togglePw = function(id, btn) {
  const input = document.getElementById(id)
  const icon = btn.querySelector('i')
  if (input.type === 'password') { input.type = 'text'; icon.className = 'fas fa-eye-slash' }
  else { input.type = 'password'; icon.className = 'fas fa-eye' }
}

window.checkPwStrength = function(pw) {
  const bar = document.getElementById('pw-bar')
  let score = 0
  if (pw.length >= 8) score++
  if (/[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  const widths = ['10%', '35%', '65%', '85%', '100%']
  const colors = ['#C0392B', '#C0392B', '#C8A84B', '#1A6B3A', '#1A6B3A']
  bar.style.width = widths[score]
  bar.style.background = colors[score]
}

window.doRegister = async function() {
  const prenom = document.getElementById('r-prenom').value.trim()
  const nom = document.getElementById('r-nom').value.trim()
  const email = document.getElementById('r-email').value.trim()
  const password = document.getElementById('r-password').value
  const tel = document.getElementById('r-tel').value.trim()
  const ville = document.getElementById('r-ville').value.trim()
  const alertEl = document.getElementById('register-alert')
  const btn = document.getElementById('register-btn')
  alertEl.className = 'auth-alert'

  if (!prenom || !nom || !email || !password) {
    alertEl.textContent = t('err_required')
    alertEl.classList.add('show-error')
    return
  }
  if (password.length < 8) {
    alertEl.textContent = t('err_password_short')
    alertEl.classList.add('show-error')
    return
  }

  const metadata = { role: selectedRole, prenom, nom, tel, ville }

  if (selectedRole === 'chauffeur') {
    metadata.vehicule_marque = document.getElementById('r-marque').value.trim()
    metadata.vehicule_modele = document.getElementById('r-modele').value.trim()
    metadata.plaque = document.getElementById('r-plaque').value.trim()
    metadata.carte_vtc = document.getElementById('r-carte-vtc').value.trim()
  }

  btn.disabled = true
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('submitting')}`

  const { error } = await supabase.auth.signUp({
    email, password,
    options: { data: metadata }
  })

  btn.disabled = false
  btn.innerHTML = `<i class="fas fa-user-plus"></i> ${t('submit')}`

  if (error) {
    alertEl.textContent = error.message
    alertEl.classList.add('show-error')
    return
  }

  // Redirection réelle vers la page de vérification email (au lieu d'un simple message)
  window.location.href = `../verify-email/verify-email.html?email=${encodeURIComponent(email)}`
}
