// depth = 1 (client/profile.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let currentUser = null

async function init() {
  const user = await requireAuth(2, 'client')
  if (!user) return
  currentUser = user

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Client'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  document.getElementById('p-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('p-name').textContent = user.prenom + ' ' + user.nom
  document.getElementById('v-fullname').textContent = user.prenom + ' ' + user.nom
  document.getElementById('v-email').textContent = user.email || '—'
  document.getElementById('v-tel').textContent = user.tel || '—'
  document.getElementById('v-ville').textContent = user.ville || '—'
  document.getElementById('e-prenom').value = user.prenom || ''
  document.getElementById('e-nom').value = user.nom || ''
  document.getElementById('e-tel').value = user.tel || ''
  document.getElementById('e-ville').value = user.ville || ''
  document.getElementById('p-since').textContent = user.created_at ? formatDate(user.created_at) : '—'

  const { data: rides } = await supabase.from('rides').select('prix').eq('client_id', user.id).eq('statut', 'termine')
  const total = (rides || []).reduce((s, r) => s + (r.prix || 0), 0)
  document.getElementById('p-courses').textContent = (rides || []).length
  document.getElementById('p-spent').textContent = formatPrice(total)

  hideLoader()
}

let editing = false
window.toggleEdit = function() {
  editing = !editing
  document.getElementById('view-mode').style.display = editing ? 'none' : 'block'
  document.getElementById('edit-mode').style.display = editing ? 'block' : 'none'
}

window.saveProfile = async function() {
  const prenom = document.getElementById('e-prenom').value.trim()
  const nom = document.getElementById('e-nom').value.trim()
  if (!prenom || !nom) { showToast('Prénom et nom sont obligatoires.', 'warning'); return }

  const { error } = await supabase.from('profiles').update({
    prenom, nom, tel: document.getElementById('e-tel').value, ville: document.getElementById('e-ville').value
  }).eq('id', currentUser.id)

  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Profil mis à jour !', 'success')
  document.getElementById('p-name').textContent = prenom + ' ' + nom
  document.getElementById('v-fullname').textContent = prenom + ' ' + nom
  toggleEdit()
}

init()
