// ============================================================
// LOC RÉACTION S.A.S — (chemin mis à jour)
// depth = 2 (client/dashboard/client-dash.html)
// ============================================================
import { supabase, requireAuth, logout, formatPrice, formatInitials, showToast, hideLoader, calculateRidePrice, searchAddress } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'
import { getNearestCities } from '../../shared/cities-data.js'

initAppHamburger()

let currentUser = null
let departCoords = null
let arriveeCoords = null
let currentEstimate = null
let map = null
let departMarker = null, arriveeMarker = null
let searchTimeout = null
let activeRideId = null
let rideChannel = null

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

  initMap()
  setupAutocomplete('depart-input', 'depart-list', (result) => {
    departCoords = { lat: result.lat, lng: result.lng, label: result.label }
    document.getElementById('depart-input').value = result.label
    updateMapMarker('depart', departCoords)
    tryEstimate()
  })
  setupAutocomplete('arrivee-input', 'arrivee-list', (result) => {
    arriveeCoords = { lat: result.lat, lng: result.lng, label: result.label }
    document.getElementById('arrivee-input').value = result.label
    updateMapMarker('arrivee', arriveeCoords)
    tryEstimate()
  })

  // Pré-remplissage depuis l'URL si redirigé depuis le widget d'accueil
  const params = new URLSearchParams(location.search)
  if (params.get('depart')) document.getElementById('depart-input').value = params.get('depart')
  if (params.get('arrivee')) document.getElementById('arrivee-input').value = params.get('arrivee')

  hideLoader()
}

function initMap() {
  map = L.map('map').setView([49.1667, 2.3667], 10) // Chaumontel
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map)
}

function updateMapMarker(type, coords) {
  const icon = type === 'depart'
    ? L.divIcon({ html: '<div style="width:16px;height:16px;background:#27AE60;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>', className: '' })
    : L.divIcon({ html: '<div style="width:16px;height:16px;background:#C0392B;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>', className: '' })

  if (type === 'depart') {
    if (departMarker) map.removeLayer(departMarker)
    departMarker = L.marker([coords.lat, coords.lng], { icon }).addTo(map)
  } else {
    if (arriveeMarker) map.removeLayer(arriveeMarker)
    arriveeMarker = L.marker([coords.lat, coords.lng], { icon }).addTo(map)
  }

  const bounds = []
  if (departMarker) bounds.push(departMarker.getLatLng())
  if (arriveeMarker) bounds.push(arriveeMarker.getLatLng())
  if (bounds.length) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 })
}

function setupAutocomplete(inputId, listId, onSelect) {
  const input = document.getElementById(inputId)
  const list = document.getElementById(listId)

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout)
    const query = input.value.trim()
    if (query.length < 3) { list.classList.remove('open'); return }
    searchTimeout = setTimeout(async () => {
      const results = await searchAddress(query)
      if (!results || !results.length) { list.classList.remove('open'); return }
      list.innerHTML = results.map((r, i) => `<li data-idx="${i}"><i class="fas fa-map-marker-alt" style="color:var(--gray)"></i> ${r.label}</li>`).join('')
      list.classList.add('open')
      list.querySelectorAll('li').forEach((li, i) => {
        li.onclick = () => { onSelect(results[i]); list.classList.remove('open') }
      })
    }, 400)
  })

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) list.classList.remove('open')
  })
}

// ─── NOUVELLE FONCTIONNALITÉ : villes proches par géolocalisation (rayon 300km) ───
window.findNearbyCities = function() {
  const btn = document.getElementById('geoloc-btn')
  if (!navigator.geolocation) {
    showToast('La géolocalisation n\'est pas disponible sur cet appareil.', 'error')
    return
  }
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Localisation en cours…'

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords
      const nearest = getNearestCities(latitude, longitude, 300, 10)

      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-location-arrow"></i> Utiliser ma position pour voir les villes proches'

      if (!nearest.length) {
        showToast('Aucune ville trouvée dans un rayon de 300 km autour de vous.', 'warning')
        return
      }

      const wrap = document.getElementById('nearby-cities-wrap')
      const chips = document.getElementById('nearby-cities-chips')
      chips.innerHTML = nearest.map(city => `
        <button class="badge badge-primary" style="cursor:pointer;font-size:.8rem;padding:8px 14px;border:1.5px solid var(--primary-xlight)" onclick="selectNearbyCity('${city.name.replace(/'/g, "\\\'")}', ${city.lat}, ${city.lng})">
          <i class="fas fa-map-marker-alt"></i> ${city.name} <span style="opacity:.65">· ${city.distance.toFixed(0)} km</span>
        </button>
      `).join('')
      wrap.style.display = 'block'
    },
    (err) => {
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-location-arrow"></i> Utiliser ma position pour voir les villes proches'
      showToast('Localisation refusée ou indisponible. Autorisez l\'accès à votre position.', 'error')
    }
  )
}

window.selectNearbyCity = function(name, lat, lng) {
  arriveeCoords = { lat, lng, label: name }
  document.getElementById('arrivee-input').value = name
  updateMapMarker('arrivee', arriveeCoords)
  tryEstimate()
}

// ─── Estimation de prix en temps réel (dès que départ + arrivée sont connus) ───
async function tryEstimate() {
  if (!departCoords || !arriveeCoords) return
  const estimateBox = document.getElementById('price-estimate')
  document.getElementById('price-value').innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:1.2rem"></i>'
  estimateBox.style.display = 'block'

  const result = await calculateRidePrice(departCoords.lat, departCoords.lng, arriveeCoords.lat, arriveeCoords.lng)
  if (!result) {
    showToast('Impossible de calculer l\'itinéraire. Vérifiez les adresses.', 'error')
    estimateBox.style.display = 'none'
    return
  }

  currentEstimate = result
  document.getElementById('price-value').textContent = formatPrice(result.prix)
  document.getElementById('price-distance').textContent = result.distanceKm.toFixed(1) + ' km'
  document.getElementById('price-duration').textContent = result.dureeMin + ' min'
  document.getElementById('book-btn').disabled = false
}

// ─── Réservation réelle ───
window.bookRide = async function() {
  if (!departCoords || !arriveeCoords || !currentEstimate) return
  const alertEl = document.getElementById('booking-alert')
  const btn = document.getElementById('book-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Création de la course…'

  const { data: ride, error } = await supabase.from('rides').insert({
    client_id: currentUser.id,
    depart: departCoords.label, arrivee: arriveeCoords.label,
    depart_lat: departCoords.lat, depart_lng: departCoords.lng,
    arrivee_lat: arriveeCoords.lat, arrivee_lng: arriveeCoords.lng,
    statut: 'en_attente', prix: currentEstimate.prix,
    distance_km: currentEstimate.distanceKm, duree_min: currentEstimate.dureeMin,
    paiement: 'wallet'
  }).select().single()

  if (error) {
    alertEl.style.display = 'block'
    alertEl.style.background = 'rgba(192,57,43,.08)'
    alertEl.style.color = 'var(--red)'
    alertEl.textContent = 'Erreur lors de la réservation : ' + error.message
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-car"></i> Réserver maintenant'
    return
  }

  activeRideId = ride.id

  // Invite tous les chauffeurs actuellement en ligne
  const { data: onlineDrivers } = await supabase.from('driver_locations').select('chauffeur_id').eq('is_online', true)

  let invitedCount = 0
  if (onlineDrivers && onlineDrivers.length) {
    const invitations = onlineDrivers.map(d => ({ ride_id: ride.id, chauffeur_id: d.chauffeur_id, statut: 'pending' }))
    const { error: inviteError } = await supabase.from('driver_invitations').insert(invitations)
    if (inviteError) {
      showToast('Erreur lors de l\'envoi aux chauffeurs : ' + inviteError.message, 'error')
      console.error('Échec insertion driver_invitations :', inviteError)
    } else {
      invitedCount = onlineDrivers.length
    }
  }

  document.querySelector('.card').style.display = 'none'
  document.getElementById('searching-card').style.display = 'block'
  document.getElementById('searching-count').textContent = `${invitedCount} chauffeur(s) contacté(s)`

  // Écoute en temps réel : dès qu'un chauffeur accepte, on redirige vers le suivi
  rideChannel = supabase.channel(`ride-${ride.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${ride.id}` }, (payload) => {
      if (payload.new.statut === 'accepte') {
        window.location.href = `tracking.html?ride=${ride.id}`
      }
    })
    .subscribe()
}

window.cancelSearch = async function() {
  if (!activeRideId) return
  await supabase.from('rides').update({ statut: 'annule' }).eq('id', activeRideId)
  if (rideChannel) supabase.removeChannel(rideChannel)
  showToast('Demande annulée.', 'warning')
  window.location.reload()
}

init()
