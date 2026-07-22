// depth = 2 (admin/dashboard/admin-dash.html)
import { supabase, requireAuth, logout, formatPrice, formatDateTime, formatInitials, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()

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

  await loadKPIs()
  await renderChart()
  await loadPendingRides()
  await loadRecentMessages()
  hideLoader()
}

async function loadKPIs() {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01'
  const [{ data: rides }, { data: users }, { data: onlineDrivers }] = await Promise.all([
    supabase.from('rides').select('prix').eq('statut', 'termine').gte('created_at', monthStart),
    supabase.from('profiles').select('id').eq('actif', true),
    supabase.from('driver_locations').select('chauffeur_id').eq('is_online', true)
  ])

  const ca = (rides || []).reduce((s, r) => s + (r.prix || 0), 0)
  document.getElementById('k-ca').textContent = formatPrice(ca)
  document.getElementById('k-rides').textContent = (rides || []).length
  document.getElementById('k-users').textContent = (users || []).length
  document.getElementById('k-drivers-online').textContent = (onlineDrivers || []).length
}

async function renderChart() {
  const months = []
  for (let i = 5; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); months.push(d.toISOString().slice(0, 7)) }
  const labels = months.map(m => new Date(m + '-01').toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }))

  const caData = await Promise.all(months.map(async m => {
    const next = new Date(m + '-01'); next.setMonth(next.getMonth() + 1)
    const { data } = await supabase.from('rides').select('prix').eq('statut', 'termine').gte('created_at', m + '-01').lt('created_at', next.toISOString().slice(0, 10))
    return (data || []).reduce((s, r) => s + (r.prix || 0), 0)
  }))

  new Chart(document.getElementById('caChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'CA €', data: caData, backgroundColor: 'rgba(10,26,56,.85)', borderRadius: 8 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  })
}

async function loadPendingRides() {
  const { data } = await supabase.from('rides').select('*').eq('statut', 'en_attente').order('created_at', { ascending: false }).limit(5)
  const rides = data || []
  const container = document.getElementById('pending-rides'), empty = document.getElementById('pending-empty')
  if (!rides.length) { container.innerHTML = ''; empty.style.display = 'block'; return }
  empty.style.display = 'none'
  container.innerHTML = rides.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--gray-xlight);font-size:.85rem">
    <div>
      <div style="font-weight:600">${r.depart} → ${r.arrivee}</div>
      <div style="color:var(--gray);font-size:.78rem">${formatDateTime(r.created_at)} — ${formatPrice(r.prix)}</div>
    </div>
    <a href="../courses/admin-courses.html?ride=${r.id}" class="btn btn-primary btn-sm"><i class="fas fa-user-plus"></i> Assigner</a>
  </div>`).join('')
}

async function loadRecentMessages() {
  const { data } = await supabase.from('contact_messages').select('*').order('created_at', { ascending: false }).limit(5)
  const msgs = data || []
  const container = document.getElementById('recent-messages'), empty = document.getElementById('messages-empty')
  if (!msgs.length) { container.innerHTML = ''; empty.style.display = 'block'; return }
  empty.style.display = 'none'
  container.innerHTML = msgs.map(m => `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--gray-xlight);font-size:.85rem;gap:10px">
    <div style="flex:1;min-width:0">
      <div style="font-weight:600">${m.nom} ${!m.lu ? '<span class="badge badge-gold" style="margin-left:6px">Nouveau</span>' : ''}</div>
      <div style="color:var(--gray);font-size:.78rem">${m.sujet} — ${formatDateTime(m.created_at)}</div>
    </div>
    <button class="btn btn-outline-gray btn-sm" onclick="viewMessage('${m.id}')" title="Voir"><i class="fas fa-eye"></i></button>
  </div>`).join('')
}

window.viewMessage = async function(id) {
  const { data: m } = await supabase.from('contact_messages').select('*').eq('id', id).single()
  if (!m) return
  alert(`De : ${m.nom} (${m.email})\nTéléphone : ${m.telephone || '—'}\nSujet : ${m.sujet}\n\n${m.message}`)
  if (!m.lu) {
    await supabase.from('contact_messages').update({ lu: true }).eq('id', id)
    await loadRecentMessages()
  }
}

init()
