// depth = 1 (client/history.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allRides = []

async function init() {
  const user = await requireAuth(2, 'client')
  if (!user) return

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Client'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  const { data } = await supabase.from('rides').select('*').eq('client_id', user.id).order('created_at', { ascending: false })
  allRides = data || []
  renderStats()
  renderTable(allRides)
  hideLoader()
}

function renderStats() {
  const done = allRides.filter(r => r.statut === 'termine')
  const total = done.reduce((s, r) => s + (r.prix || 0), 0)
  const km = done.reduce((s, r) => s + (r.distance_km || 0), 0)
  const notes = allRides.filter(r => r.note_chauffeur).map(r => r.note_chauffeur)
  const avgNote = notes.length ? (notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : '—'

  document.getElementById('h-total').textContent = allRides.length
  document.getElementById('h-spent').textContent = formatPrice(total)
  document.getElementById('h-km').textContent = km.toFixed(1) + ' km'
  document.getElementById('h-rating').textContent = avgNote === '—' ? '—' : avgNote + ' ★'
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allRides.length}</div><div class="lbl">Courses</div></div><div class="sidebar-stat"><div class="val">${formatPrice(total)}</div><div class="lbl">Dépensé</div></div>`
}

function renderTable(rides) {
  const tb = document.getElementById('rides-table'), em = document.getElementById('rides-empty')
  if (!rides.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  const statusColors = { termine: 'badge-success', annule: 'badge-danger', en_attente: 'badge-gray', accepte: 'badge-primary', en_cours: 'badge-gold' }
  tb.innerHTML = rides.map(r => `<tr>
    <td>${formatDate(r.created_at)}</td>
    <td><div style="font-size:.85rem;font-weight:600">${r.depart}</div><div class="td-sub">→ ${r.arrivee}</div></td>
    <td>${r.distance_km ? r.distance_km + ' km' : '—'}</td>
    <td style="font-weight:700">${formatPrice(r.prix || 0)}</td>
    <td><span class="badge ${statusColors[r.statut] || 'badge-gray'}">${r.statut}</span></td>
    <td>${r.bon_commande_url ? `<a href="${r.bon_commande_url}" class="btn btn-outline-gray btn-sm" target="_blank"><i class="fas fa-file-pdf"></i></a>` : ''}</td>
  </tr>`).join('')
}

window.filterRides = function(filter, el) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
  el.classList.add('active')
  renderTable(filter === 'tous' ? allRides : allRides.filter(r => r.statut === filter))
}

init()
