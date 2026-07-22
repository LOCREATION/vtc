// depth = 1 (admin/users.html)
import { supabase, requireAuth, logout, formatDate, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allUsers = []
let currentRoleFilter = 'tous'

async function init() {
  const user = await requireAuth(2, 'admin')
  if (!user) return

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Administrateur'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
  allUsers = data || []
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allUsers.length}</div><div class="lbl">Utilisateurs</div></div>`
  renderTable(allUsers)
  hideLoader()
}

function renderTable(users) {
  const tb = document.getElementById('users-table'), em = document.getElementById('users-empty')
  if (!users.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  const roleColors = { client: 'badge-primary', chauffeur: 'badge-gold', admin: 'badge-danger' }
  tb.innerHTML = users.map(u => `<tr>
    <td style="font-weight:600">${u.prenom} ${u.nom}</td>
    <td style="font-size:.82rem">${u.email || '—'}</td>
    <td><span class="badge ${roleColors[u.role] || 'badge-gray'}">${u.role}</span></td>
    <td>${u.ville || '—'}</td>
    <td>${formatDate(u.created_at)}</td>
    <td><span class="badge ${u.actif ? 'badge-success' : 'badge-danger'}">${u.actif ? 'Actif' : 'Désactivé'}</span></td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-outline btn-sm" onclick="openEditUser('${u.id}')" title="Modifier"><i class="fas fa-edit"></i></button>
      <button class="btn btn-outline-gray btn-sm" onclick="toggleActive('${u.id}', ${u.actif})" title="${u.actif ? 'Désactiver' : 'Réactiver'}"><i class="fas fa-power-off"></i></button>
    </td>
  </tr>`).join('')
}

function applyFilters() {
  const search = document.getElementById('search-input').value.toLowerCase()
  let filtered = currentRoleFilter === 'tous' ? allUsers : allUsers.filter(u => u.role === currentRoleFilter)
  if (search) filtered = filtered.filter(u => `${u.prenom} ${u.nom}`.toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search))
  renderTable(filtered)
}

window.filterUsers = applyFilters
window.setRoleFilter = function(role, el) {
  currentRoleFilter = role
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
  el.classList.add('active')
  applyFilters()
}

window.toggleActive = async function(id, currentlyActive) {
  const label = currentlyActive ? 'désactiver' : 'réactiver'
  if (!confirm(`Voulez-vous ${label} ce compte ?`)) return
  const { error } = await supabase.from('profiles').update({ actif: !currentlyActive }).eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast(`Compte ${currentlyActive ? 'désactivé' : 'réactivé'}.`, 'success')
  const u = allUsers.find(x => x.id === id)
  if (u) u.actif = !currentlyActive
  applyFilters()
}

window.openEditUser = function(id) {
  const u = allUsers.find(x => x.id === id)
  if (!u) return
  document.getElementById('u-id').value = u.id
  document.getElementById('u-prenom').value = u.prenom || ''
  document.getElementById('u-nom').value = u.nom || ''
  document.getElementById('u-tel').value = u.tel || ''
  document.getElementById('u-ville').value = u.ville || ''
  document.getElementById('u-role').value = u.role
  document.getElementById('user-modal').classList.add('open')
}

window.saveUser = async function() {
  const id = document.getElementById('u-id').value
  const prenom = document.getElementById('u-prenom').value.trim()
  const nom = document.getElementById('u-nom').value.trim()
  if (!prenom || !nom) { showToast('Prénom et nom sont obligatoires.', 'warning'); return }

  const payload = {
    prenom, nom,
    tel: document.getElementById('u-tel').value.trim(),
    ville: document.getElementById('u-ville').value.trim(),
    role: document.getElementById('u-role').value
  }

  const { error } = await supabase.from('profiles').update(payload).eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }

  showToast('Utilisateur mis à jour !', 'success')
  document.getElementById('user-modal').classList.remove('open')

  const u2 = allUsers.find(x => x.id === id)
  if (u2) Object.assign(u2, payload)
  applyFilters()
}

init()
