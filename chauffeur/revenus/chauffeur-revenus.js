// depth = 1 (driver/earnings.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allRides = []

async function init() {
  const user = await requireAuth(2, 'chauffeur')
  if (!user) return

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Chauffeur'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  const { data, error } = await supabase.from('rides').select('*').eq('chauffeur_id', user.id).eq('statut', 'termine').order('created_at', { ascending: false })
  if (error) { showToast('Erreur : ' + error.message, 'error'); hideLoader(); return }

  allRides = data || []
  renderStats(); renderChart(); renderTable()
  hideLoader()
}

function renderStats() {
  const total = allRides.reduce((s, r) => s + (r.prix || 0), 0)
  const km = allRides.reduce((s, r) => s + (r.distance_km || 0), 0)
  document.getElementById('e-total').textContent = total.toFixed(2).replace('.', ',')
  document.getElementById('e-subtitle').textContent = allRides.length + ' courses réalisées'
  document.getElementById('e-km').textContent = km.toFixed(1) + ' km'
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allRides.length}</div><div class="lbl">Courses</div></div><div class="sidebar-stat"><div class="val">${formatPrice(total)}</div><div class="lbl">Total</div></div>`

  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const monthStart = new Date().toISOString().slice(0, 7)
  document.getElementById('e-jour').textContent = formatPrice(allRides.filter(r => r.created_at?.startsWith(today)).reduce((s, r) => s + (r.prix || 0), 0))
  document.getElementById('e-semaine').textContent = formatPrice(allRides.filter(r => r.created_at >= weekAgo).reduce((s, r) => s + (r.prix || 0), 0))
  document.getElementById('e-mois').textContent = formatPrice(allRides.filter(r => r.created_at?.startsWith(monthStart)).reduce((s, r) => s + (r.prix || 0), 0))
}

function renderChart() {
  const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
  const now = new Date()
  const weekData = [], labels = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    labels.push(days[(d.getDay() + 6) % 7])
    weekData.push(allRides.filter(r => r.created_at?.startsWith(dateStr)).reduce((s, r) => s + (r.prix || 0), 0))
  }
  new Chart(document.getElementById('weekChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Revenus €', data: weekData, backgroundColor: 'rgba(10,26,56,.85)', borderRadius: 8 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { callback: v => v + ' €' } } } }
  })
}

function renderTable() {
  const tb = document.getElementById('earnings-table'), em = document.getElementById('e-empty')
  if (!allRides.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  tb.innerHTML = allRides.map(r => `<tr>
    <td>${formatDate(r.created_at)}</td>
    <td><div style="font-size:.85rem;font-weight:600">${r.depart}</div><div class="td-sub">→ ${r.arrivee}</div></td>
    <td>${r.distance_km ? r.distance_km + ' km' : '—'}</td>
    <td>${r.note_client ? '★'.repeat(r.note_client) : '—'}</td>
    <td style="font-weight:700;color:var(--green)">+${formatPrice(r.prix || 0)}</td>
  </tr>`).join('')
}

window.exportCSV = function() {
  const rows = [['Date', 'Départ', 'Arrivée', 'Distance', 'Note', 'Revenu']]
  allRides.forEach(r => rows.push([formatDate(r.created_at), r.depart, r.arrivee, r.distance_km || '', r.note_client || '', r.prix || '']))
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob); link.download = 'mes_revenus_locreaction.csv'; link.click()
}

init()
