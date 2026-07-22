// ============================================================
// LOC RÉACTION S.A.S — /login.js
// depth = 1 (auth/login.html)
// ============================================================
import { supabase } from '../../shared/supabase.js'
import { initLangSwitcher, t } from '../../shared/i18n.js'
import { initHamburger } from '../../shared/nav.js'

initLangSwitcher('lang-select-desktop', 'login', 2)
initLangSwitcher('lang-select-mobile', 'login', 2)
initHamburger('hamburger-btn', 'mobile-menu')

let selectedRole = 'client'

// Préselection du rôle depuis l'URL (?role=chauffeur, etc.)
const params = new URLSearchParams(location.search)
const urlRole = params.get('role')
if (urlRole && ['client', 'chauffeur', 'admin'].includes(urlRole)) {
  selectedRole = urlRole
  document.querySelectorAll('.role-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.role === urlRole)
  })
}

window.selectRole = function(role, el) {
  selectedRole = role
  document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'))
  el.classList.add('active')
}

window.togglePw = function(id, btn) {
  const input = document.getElementById(id)
  const icon = btn.querySelector('i')
  if (input.type === 'password') { input.type = 'text'; icon.className = 'fas fa-eye-slash' }
  else { input.type = 'password'; icon.className = 'fas fa-eye' }
}

window.doLogin = async function() {
  const email = document.getElementById('l-email').value.trim()
  const password = document.getElementById('l-password').value
  const alertEl = document.getElementById('login-alert')
  const btn = document.getElementById('login-btn')
  alertEl.className = 'auth-alert'

  if (!email || !password) {
    alertEl.textContent = t('err_required')
    alertEl.classList.add('show-error')
    return
  }

  btn.disabled = true
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('submitting')}`

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password })

  if (authError) {
    alertEl.textContent = t('err_credentials')
    alertEl.classList.add('show-error')
    btn.disabled = false
    btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> ${t('submit')}`
    return
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, prenom, nom, actif')
    .eq('id', authData.user.id)
    .maybeSingle()

  if (profileError || !profile) {
    alertEl.textContent = t('err_profile')
    alertEl.classList.add('show-error')
    await supabase.auth.signOut()
    btn.disabled = false
    btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> ${t('submit')}`
    return
  }

  if (!profile.actif) {
    alertEl.textContent = t('err_inactive')
    alertEl.classList.add('show-error')
    await supabase.auth.signOut()
    btn.disabled = false
    btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> ${t('submit')}`
    return
  }

  if (profile.role !== selectedRole) {
    alertEl.textContent = t('err_role')
    alertEl.classList.add('show-error')
    await supabase.auth.signOut()
    btn.disabled = false
    btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> ${t('submit')}`
    return
  }

  // Redirection vers le bon tableau de bord (depth=1 -> "../" prefix)
  const dashboards = { client: '../../client/dashboard/client-dash.html', chauffeur: '../../chauffeur/dashboard/chauffeur-dash.html', admin: '../../admin/dashboard/admin-dash.html' }
  window.location.href = dashboards[profile.role]
}
