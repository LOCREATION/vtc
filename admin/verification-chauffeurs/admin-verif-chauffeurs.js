// depth = 1 (admin/drivers-verification.html)
import { supabase, requireAuth, logout, formatDate, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allDrivers = []

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

  const { data } = await supabase.from('profiles').select('*').eq('role', 'chauffeur').order('created_at', { ascending: false })
  allDrivers = data || []
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allDrivers.length}</div><div class="lbl">Chauffeurs</div></div>`
  renderGrid(allDrivers)
  hideLoader()
}

function renderGrid(drivers) {
  const grid = document.getElementById('drivers-grid'), empty = document.getElementById('drivers-empty')
  if (!drivers.length) { grid.innerHTML = ''; empty.style.display = 'block'; return }
  empty.style.display = 'none'

  grid.innerHTML = drivers.map(d => `<div class="driver-verif-card ${d.documents_verifies ? 'verified' : ''}">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div class="nav-avatar" style="width:44px;height:44px">${formatInitials(d.prenom, d.nom)}</div>
      <div style="flex:1"><div style="font-weight:700;font-size:.9rem">${d.prenom} ${d.nom}</div><div style="font-size:.78rem;color:var(--gray)">${d.email || '—'}</div></div>
      <span class="badge ${d.documents_verifies ? 'badge-success' : 'badge-warning'}">${d.documents_verifies ? 'Vérifié' : 'En attente'}</span>
    </div>
    <div class="doc-row"><span>Véhicule</span><span style="font-weight:600">${[d.vehicule_marque, d.vehicule_modele].filter(Boolean).join(' ') || '—'}</span></div>
    <div class="doc-row"><span>Carte VTC n°${d.carte_vtc_numero || '—'}</span>${d.carte_vtc_url ? `<button class="btn btn-outline-gray btn-sm" onclick="viewDoc('${d.carte_vtc_url}')"><i class="fas fa-eye"></i></button>` : '<span style="color:var(--gray)">Non fourni</span>'}</div>
    <div class="doc-row"><span>Assurance ${d.assurance_expiration ? '(exp. ' + formatDate(d.assurance_expiration) + ')' : ''}</span>${d.assurance_url ? `<button class="btn btn-outline-gray btn-sm" onclick="viewDoc('${d.assurance_url}')"><i class="fas fa-eye"></i></button>` : '<span style="color:var(--gray)">Non fourni</span>'}</div>
    <div class="doc-row"><span>Carte grise</span>${d.carte_grise_url ? `<button class="btn btn-outline-gray btn-sm" onclick="viewDoc('${d.carte_grise_url}')"><i class="fas fa-eye"></i></button>` : '<span style="color:var(--gray)">Non fourni</span>'}</div>
    <button class="btn ${d.documents_verifies ? 'btn-outline-gray' : 'btn-success'} btn-sm btn-full" style="margin-top:12px" onclick="toggleVerified('${d.id}', ${d.documents_verifies})">
      <i class="fas ${d.documents_verifies ? 'fa-times' : 'fa-check'}"></i> ${d.documents_verifies ? 'Retirer la vérification' : 'Marquer comme vérifié'}
    </button>
  </div>`).join('')
}

window.setFilter = function(filter, el) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); el.classList.add('active')
  let filtered = allDrivers
  if (filter === 'attente') filtered = allDrivers.filter(d => !d.documents_verifies)
  if (filter === 'verifies') filtered = allDrivers.filter(d => d.documents_verifies)
  renderGrid(filtered)
}

window.viewDoc = async function(path) {
  const { data, error } = await supabase.storage.from('driver-documents').createSignedUrl(path, 300)
  if (error || !data) { showToast('Impossible d\'ouvrir le document.', 'error'); return }
  window.open(data.signedUrl, '_blank')
}

window.toggleVerified = async function(id, currentlyVerified) {
  const { error } = await supabase.from('profiles').update({ documents_verifies: !currentlyVerified }).eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast(currentlyVerified ? 'Vérification retirée.' : 'Chauffeur vérifié !', 'success')
  const d = allDrivers.find(x => x.id === id)
  if (d) d.documents_verifies = !currentlyVerified
  renderGrid(allDrivers)
}

init()
