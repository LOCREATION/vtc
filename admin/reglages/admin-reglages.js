// depth = 1 (admin/settings.html)
import { supabase, requireAuth, logout, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let currentUser = null

async function init() {
  const user = await requireAuth(2, 'admin')
  if (!user) return
  currentUser = user

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Administrateur'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  document.getElementById('s-prenom').value = user.prenom || ''
  document.getElementById('s-nom').value = user.nom || ''
  document.getElementById('s-tel').value = user.tel || ''

  const { data: settings } = await supabase.from('platform_settings').select('*')
  const settingsMap = Object.fromEntries((settings || []).map(s => [s.cle, s.valeur]))
  document.getElementById('set-email').value = settingsMap.email_contact || ''
  document.getElementById('set-rayon').value = settingsMap.rayon_villes_km || '300'

  hideLoader()
}

window.saveAccount = async function() {
  const prenom = document.getElementById('s-prenom').value.trim()
  const nom = document.getElementById('s-nom').value.trim()
  if (!prenom || !nom) { showToast('Prénom et nom obligatoires.', 'warning'); return }

  const { error } = await supabase.from('profiles').update({ prenom, nom, tel: document.getElementById('s-tel').value }).eq('id', currentUser.id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Compte mis à jour !', 'success')
}

window.changePassword = async function() {
  const newPass = document.getElementById('s-newpass').value
  if (!newPass) { showToast('Saisissez un nouveau mot de passe.', 'warning'); return }
  if (newPass.length < 8) { showToast('Le mot de passe doit contenir au moins 8 caractères.', 'warning'); return }

  const { error } = await supabase.auth.updateUser({ password: newPass })
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Mot de passe mis à jour !', 'success')
  document.getElementById('s-newpass').value = ''
}

window.saveSettings = async function() {
  const email = document.getElementById('set-email').value.trim()
  const rayon = document.getElementById('set-rayon').value

  const { error } = await supabase.from('platform_settings').upsert([
    { cle: 'email_contact', valeur: email, updated_at: new Date().toISOString() },
    { cle: 'rayon_villes_km', valeur: rayon, updated_at: new Date().toISOString() }
  ], { onConflict: 'cle' })

  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Réglages enregistrés !', 'success')
}

init()
