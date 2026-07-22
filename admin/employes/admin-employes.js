// depth = 1 (admin/employees.html)
import { supabase, requireAuth, logout, formatPrice, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let searchTimeout = null
let allEmployees = []

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

  await loadEmployees()
  hideLoader()
}

async function loadEmployees() {
  const { data } = await supabase.from('employees').select('*, profile:profile_id(prenom, nom)').order('date_embauche', { ascending: true })
  const employees = data || []
  allEmployees = employees
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${employees.length}</div><div class="lbl">Employés</div></div>`

  const tb = document.getElementById('employees-table'), em = document.getElementById('emp-empty')
  if (!employees.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  tb.innerHTML = employees.map(e => `<tr>
    <td style="font-family:monospace;font-size:.82rem">${e.matricule}</td>
    <td style="font-weight:600">${e.profile?.prenom || '—'} ${e.profile?.nom || ''}</td>
    <td>${e.poste}</td><td style="font-weight:700">${formatPrice(e.salaire_net_base)}</td>
    <td>${e.statut_vtc ? '<span class="badge badge-primary">Oui</span>' : '<span class="badge badge-gray">Non</span>'}</td>
    <td>${e.statut_gerance ? '<span class="badge badge-gold">Oui</span>' : '<span class="badge badge-gray">Non</span>'}</td>
    <td>${e.actif ? '<span class="badge badge-success">Actif</span>' : '<span class="badge badge-danger">Inactif</span>'}</td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-outline btn-sm" onclick="openEditEmployee('${e.id}')" title="Modifier"><i class="fas fa-edit"></i></button>
      <button class="btn btn-outline-gray btn-sm" onclick="toggleActive('${e.id}', ${e.actif})" title="${e.actif ? 'Désactiver' : 'Réactiver'}"><i class="fas fa-power-off"></i></button>
      <button class="btn btn-danger btn-sm" onclick="deleteEmployee('${e.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('')
}

window.openAdd = function() {
  document.getElementById('emp-modal-title').textContent = 'Nouvel employé'
  document.getElementById('emp-search-wrap').style.display = 'block'
  document.getElementById('emp-search-email').value = ''
  document.getElementById('emp-search-result').innerHTML = ''
  document.getElementById('emp-id').value = ''
  document.getElementById('emp-profile-id').value = ''
  document.getElementById('emp-matricule').value = ''
  document.getElementById('emp-poste').value = ''
  document.getElementById('emp-salaire').value = ''
  document.getElementById('emp-date').value = new Date().toISOString().slice(0, 10)
  document.getElementById('emp-vtc').checked = false
  document.getElementById('emp-gerance').checked = false
  document.getElementById('emp-modal').classList.add('open')
}

window.openEditEmployee = function(id) {
  const e = allEmployees.find(x => x.id === id)
  if (!e) return
  document.getElementById('emp-modal-title').textContent = 'Modifier l\'employé'
  document.getElementById('emp-search-wrap').style.display = 'none'
  document.getElementById('emp-id').value = e.id
  document.getElementById('emp-profile-id').value = e.profile_id
  document.getElementById('emp-matricule').value = e.matricule || ''
  document.getElementById('emp-poste').value = e.poste || ''
  document.getElementById('emp-contrat').value = e.type_contrat || 'CDI'
  document.getElementById('emp-date').value = e.date_embauche || ''
  document.getElementById('emp-salaire').value = e.salaire_net_base || ''
  document.getElementById('emp-vtc').checked = !!e.statut_vtc
  document.getElementById('emp-gerance').checked = !!e.statut_gerance
  document.getElementById('emp-modal').classList.add('open')
}

window.searchProfile = function() {
  clearTimeout(searchTimeout)
  const email = document.getElementById('emp-search-email').value.trim()
  if (email.length < 3) return
  searchTimeout = setTimeout(async () => {
    const { data } = await supabase.from('profiles').select('id, prenom, nom, email, role').ilike('email', `%${email}%`).limit(5)
    const resultDiv = document.getElementById('emp-search-result')
    if (!data?.length) { resultDiv.innerHTML = '<span style="color:var(--gray)">Aucun utilisateur trouvé</span>'; return }
    resultDiv.innerHTML = data.map(p => `<div style="padding:8px;border:1px solid var(--gray-light);border-radius:var(--radius-sm);margin-bottom:4px;cursor:pointer" onclick="selectProfile('${p.id}','${p.prenom} ${p.nom}')">
      <strong>${p.prenom} ${p.nom}</strong> — ${p.email} <span class="badge badge-gray">${p.role}</span>
    </div>`).join('')
  }, 400)
}

window.selectProfile = function(id, name) {
  document.getElementById('emp-profile-id').value = id
  document.getElementById('emp-search-result').innerHTML = `<span style="color:var(--green)"><i class="fas fa-check-circle"></i> ${name} sélectionné</span>`
}

window.saveEmployee = async function() {
  const id = document.getElementById('emp-id').value
  const profileId = document.getElementById('emp-profile-id').value
  const matricule = document.getElementById('emp-matricule').value.trim()
  const poste = document.getElementById('emp-poste').value.trim()
  const salaire = parseFloat(document.getElementById('emp-salaire').value)

  if (!profileId) { showToast('Sélectionnez un utilisateur via la recherche email.', 'warning'); return }
  if (!matricule || !poste || isNaN(salaire)) { showToast('Remplissez tous les champs obligatoires.', 'warning'); return }

  const payload = {
    profile_id: profileId, matricule, poste,
    type_contrat: document.getElementById('emp-contrat').value,
    date_embauche: document.getElementById('emp-date').value,
    salaire_net_base: salaire,
    statut_vtc: document.getElementById('emp-vtc').checked,
    statut_gerance: document.getElementById('emp-gerance').checked
  }

  const { error } = id
    ? await supabase.from('employees').update(payload).eq('id', id)
    : await supabase.from('employees').insert({ ...payload, actif: true })

  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast(id ? 'Employé mis à jour !' : 'Employé ajouté !', 'success')
  document.getElementById('emp-modal').classList.remove('open')
  await loadEmployees()
}

window.deleteEmployee = async function(id) {
  if (!confirm('Supprimer définitivement cet employé ? Ses fiches de paie déjà générées seront conservées.')) return
  const { error } = await supabase.from('employees').delete().eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Employé supprimé.', 'warning')
  await loadEmployees()
}

window.toggleActive = async function(id, currentlyActive) {
  if (!confirm(`Voulez-vous ${currentlyActive ? 'désactiver' : 'réactiver'} cet employé ?`)) return
  await supabase.from('employees').update({ actif: !currentlyActive }).eq('id', id)
  showToast('Statut mis à jour.', 'success')
  await loadEmployees()
}

init()
