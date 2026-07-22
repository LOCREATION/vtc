// depth = 1 (client/favorites.html)
import { supabase, requireAuth, logout, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
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

  await loadData()
  hideLoader()
}

async function loadData() {
  const [{ data: favs }, { data: drivers }, { data: locs }] = await Promise.all([
    supabase.from('favorite_drivers').select('driver_id').eq('client_id', currentUser.id),
    supabase.from('profiles').select('*').eq('role', 'chauffeur').eq('actif', true),
    supabase.from('driver_locations').select('chauffeur_id').eq('is_online', true)
  ])

  const favIds = (favs || []).map(f => f.driver_id)
  const onlineIds = (locs || []).map(l => l.chauffeur_id)
  const allDrivers = drivers || []

  document.getElementById('f-nb').textContent = favIds.length
  document.getElementById('f-online').textContent = onlineIds.length
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${favIds.length}</div><div class="lbl">Favoris</div></div>`

  const favDrivers = allDrivers.filter(d => favIds.includes(d.id))
  const favGrid = document.getElementById('favs-grid'), favEmpty = document.getElementById('favs-empty')
  if (!favDrivers.length) { favGrid.innerHTML = ''; favEmpty.style.display = 'block' }
  else { favEmpty.style.display = 'none'; favGrid.innerHTML = favDrivers.map(d => driverCard(d, true, onlineIds.includes(d.id))).join('') }

  const allGrid = document.getElementById('all-grid'), allEmpty = document.getElementById('all-empty')
  if (!allDrivers.length) { allGrid.innerHTML = ''; allEmpty.style.display = 'block' }
  else { allEmpty.style.display = 'none'; allGrid.innerHTML = allDrivers.map(d => driverCard(d, favIds.includes(d.id), onlineIds.includes(d.id))).join('') }
}

function driverCard(d, isFav, isOnline) {
  return `<div style="background:#fff;border:1.5px solid ${isFav ? 'var(--gold)' : 'var(--gray-light)'};border-radius:var(--radius-lg);padding:18px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div class="nav-avatar" style="width:50px;height:50px">${formatInitials(d.prenom, d.nom)}</div>
      <div>
        <div style="font-size:.95rem;font-weight:700">${d.prenom} ${d.nom}</div>
        <div style="display:flex;align-items:center;gap:6px;font-size:.75rem;margin-top:2px">
          <span class="status-dot ${isOnline ? 'status-online' : 'status-offline'}"></span>
          <span style="color:var(--gray)">${isOnline ? 'En ligne' : 'Hors ligne'}</span>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <a href="dashboard.html" class="btn btn-primary btn-sm" style="flex:1"><i class="fas fa-bolt"></i>Réserver</a>
      <button class="btn ${isFav ? 'btn-danger' : 'btn-outline'} btn-sm" onclick="toggleFav('${d.id}',${isFav})"><i class="fas fa-heart"></i></button>
    </div>
  </div>`
}

window.toggleFav = async function(driverId, isFav) {
  if (isFav) {
    await supabase.from('favorite_drivers').delete().eq('client_id', currentUser.id).eq('driver_id', driverId)
    showToast('Retiré des favoris.', 'warning')
  } else {
    await supabase.from('favorite_drivers').insert({ client_id: currentUser.id, driver_id: driverId })
    showToast('Ajouté aux favoris ❤️', 'success')
  }
  await loadData()
}

init()
