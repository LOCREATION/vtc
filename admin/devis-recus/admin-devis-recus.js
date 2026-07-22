// depth = 1 (admin/service-requests.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allRequests = []

const SERVICE_LABELS = { vtc: 'VTC', location: 'Location', btp: 'BTP', jardinage: 'Jardinage', amo: 'AMO', autre: 'Autre' }
const STATUS_COLORS = { en_attente: 'badge-gray', devis_envoye: 'badge-primary', accepte: 'badge-success', en_cours: 'badge-gold', termine: 'badge-success' }

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

  const { data } = await supabase.from('service_requests').select('*').order('created_at', { ascending: false })
  allRequests = data || []
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allRequests.length}</div><div class="lbl">Demandes</div></div>`
  renderTable(allRequests)
  hideLoader()
}

function renderTable(requests) {
  const tb = document.getElementById('sr-table'), em = document.getElementById('sr-empty')
  if (!requests.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  tb.innerHTML = requests.map(r => `<tr>
    <td>${formatDate(r.created_at)}</td>
    <td><div style="font-weight:600;font-size:.85rem">${r.nom || '—'}</div><div class="td-sub">${r.email || ''}</div></td>
    <td><span class="badge badge-primary">${SERVICE_LABELS[r.service_type] || r.service_type}</span></td>
    <td style="max-width:240px"><div style="font-size:.83rem">${r.description}</div></td>
    <td><span class="badge ${STATUS_COLORS[r.statut] || 'badge-gray'}">${r.statut}</span></td>
    <td style="font-weight:700">${r.devis_montant ? formatPrice(r.devis_montant) : '—'}</td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-outline-gray btn-sm" onclick="openTreat('${r.id}')" title="Traiter"><i class="fas fa-edit"></i></button>
      <button class="btn btn-danger btn-sm" onclick="deleteRequest('${r.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('')
}

window.setFilter = function(filter, el) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); el.classList.add('active')
  renderTable(filter === 'tous' ? allRequests : allRequests.filter(r => r.statut === filter))
}

window.openTreat = function(id) {
  const r = allRequests.find(x => x.id === id)
  if (!r) return
  document.getElementById('sr-id').value = r.id
  document.getElementById('sr-statut').value = r.statut
  document.getElementById('sr-montant').value = r.devis_montant || ''
  document.getElementById('sr-modal').classList.add('open')
}

window.saveSR = async function() {
  const id = document.getElementById('sr-id').value
  const statut = document.getElementById('sr-statut').value
  const devis_montant = document.getElementById('sr-montant').value ? parseFloat(document.getElementById('sr-montant').value) : null

  const { error } = await supabase.from('service_requests').update({ statut, devis_montant }).eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Demande mise à jour !', 'success')
  document.getElementById('sr-modal').classList.remove('open')

  const { data } = await supabase.from('service_requests').select('*').order('created_at', { ascending: false })
  allRequests = data || []
  renderTable(allRequests)
}

window.deleteRequest = async function(id) {
  if (!confirm('Supprimer définitivement cette demande de devis ?')) return
  const { error } = await supabase.from('service_requests').delete().eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Demande supprimée.', 'warning')
  const { data } = await supabase.from('service_requests').select('*').order('created_at', { ascending: false })
  allRequests = data || []
  renderTable(allRequests)
}

init()
