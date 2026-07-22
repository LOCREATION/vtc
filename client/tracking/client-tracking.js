// ============================================================
// LOC RÉACTION S.A.S — (chemin mis à jour)
// depth = 1 (client/tracking.html)
// ============================================================
import { supabase, requireAuth, logout, formatPrice, formatInitials, showToast, hideLoader, debitWallet, getRouteDuration } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'
import { getOrCreateRideConversation, loadMessages, sendTextMessage, sendImageMessage, getImageUrl, markConversationRead, subscribeToConversation, unsubscribe, formatMessageTime } from '../../shared/messaging.js'

initAppHamburger()

let currentUser = null
let currentRide = null
let map = null
let driverMarker = null
let gpsChannel = null
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

  await loadActiveRide()
  hideLoader()
}

async function loadActiveRide() {
  const params = new URLSearchParams(location.search)
  const rideIdFromUrl = params.get('ride')

  let query = supabase.from('rides').select('*, chauffeur:chauffeur_id(prenom, nom, tel)').eq('client_id', currentUser.id)
  query = rideIdFromUrl ? query.eq('id', rideIdFromUrl) : query.in('statut', ['accepte', 'en_cours'])

  const { data: rides } = await query.order('created_at', { ascending: false }).limit(1)
  const ride = rides?.[0]

  if (!ride || ['termine', 'annule'].includes(ride.statut)) {
    document.getElementById('no-ride-card').style.display = 'block'
    return
  }

  currentRide = ride
  document.getElementById('ride-active-content').style.display = 'block'
  renderRideDetails()
  initMap()
  subscribeToUpdates()

  if (ride.chauffeur_id) {
    await loadDriverInfo()
    // Récupère la position actuelle immédiatement, sans attendre la prochaine mise à jour live
    const { data: loc } = await supabase.from('driver_locations').select('latitude, longitude').eq('chauffeur_id', ride.chauffeur_id).maybeSingle()
    if (loc?.latitude && loc?.longitude) {
      driverMarker = L.marker([loc.latitude, loc.longitude], {
        icon: L.divIcon({ html: '<div style="width:34px;height:34px;background:#0A1A38;border:3px solid #C8A84B;border-radius:50%;display:flex;align-items:center;justify-content:center"><i class="fas fa-car" style="color:#C8A84B;font-size:.8rem"></i></div>', className: '' })
      }).addTo(map)
      updateETA(loc.latitude, loc.longitude)
    }
  }
}

function renderRideDetails() {
  const labels = { accepte: 'Chauffeur en route', en_cours: 'Course en cours' }
  document.getElementById('ride-status-label').textContent = labels[currentRide.statut] || currentRide.statut
  document.getElementById('ride-status-badge').textContent = currentRide.statut
  document.getElementById('d-depart').textContent = currentRide.depart
  document.getElementById('d-arrivee').textContent = currentRide.arrivee
  document.getElementById('d-distance').textContent = (currentRide.distance_km || 0) + ' km'
  document.getElementById('d-prix').textContent = formatPrice(currentRide.prix)
  document.getElementById('cancel-ride-btn').style.display = currentRide.statut === 'accepte' ? 'block' : 'none'
}

async function loadDriverInfo() {
  const { data: driver } = await supabase.from('profiles').select('prenom, nom, tel').eq('id', currentRide.chauffeur_id).single()
  if (!driver) return
  document.getElementById('driver-info-card').style.display = 'block'
  document.getElementById('driver-av').textContent = formatInitials(driver.prenom, driver.nom)
  document.getElementById('driver-name').textContent = driver.prenom + ' ' + driver.nom
  document.getElementById('driver-phone').textContent = driver.tel || 'Non renseigné'
  document.getElementById('driver-call-btn').href = driver.tel ? `tel:${driver.tel}` : '#'
  document.getElementById('chat-driver-av').textContent = formatInitials(driver.prenom, driver.nom)
  document.getElementById('chat-driver-name').textContent = driver.prenom + ' ' + driver.nom
}

// ─── Messagerie temps réel avec le chauffeur ───
let chatConversation = null
let chatChannel = null

window.openChat = async function() {
  document.getElementById('chat-card').style.display = 'block'
  document.getElementById('chat-card').scrollIntoView({ behavior: 'smooth' })

  if (!chatConversation) {
    chatConversation = await getOrCreateRideConversation(currentRide.id, currentUser.id, currentRide.chauffeur_id)
    chatChannel = subscribeToConversation(chatConversation.id, (msg) => {
      appendMessage(msg)
      if (msg.sender_id !== currentUser.id) markConversationRead(chatConversation.id, currentUser.id)
    })
  }

  const messages = await loadMessages(chatConversation.id)
  const box = document.getElementById('chat-messages')
  box.innerHTML = ''
  if (!messages.length) {
    box.innerHTML = `<div class="chat-empty"><i class="fas fa-comment-dots"></i><div>Aucun message — dites bonjour à votre chauffeur !</div></div>`
  } else {
    for (const m of messages) await appendMessage(m, false)
  }
  box.scrollTop = box.scrollHeight
  await markConversationRead(chatConversation.id, currentUser.id)
  document.getElementById('chat-unread').style.display = 'none'
}

async function appendMessage(msg, scroll = true) {
  const box = document.getElementById('chat-messages')
  if (box.querySelector('.chat-empty')) box.innerHTML = ''

  const mine = msg.sender_id === currentUser.id
  const bubble = document.createElement('div')
  bubble.className = `chat-bubble ${mine ? 'mine' : 'theirs'}`

  let inner = ''
  if (msg.contenu) inner += `<div>${msg.contenu.replace(/</g, '&lt;')}</div>`
  if (msg.image_url) {
    const url = await getImageUrl(msg.image_url)
    if (url) inner += `<img src="${url}" alt="photo" onclick="window.open('${url}','_blank')">`
  }
  inner += `<span class="chat-bubble-time">${formatMessageTime(msg.created_at)}</span>`
  bubble.innerHTML = inner

  box.appendChild(bubble)
  if (scroll) box.scrollTop = box.scrollHeight
}

window.sendChatText = async function() {
  const input = document.getElementById('chat-input')
  const text = input.value.trim()
  if (!text || !chatConversation) return
  input.value = ''
  await sendTextMessage(chatConversation.id, currentUser.id, text)
}

window.sendChatImage = async function(file) {
  if (!file || !chatConversation) return
  showToast('Envoi de la photo…', 'info')
  await sendImageMessage(chatConversation.id, currentUser.id, file)
}

function initMap() {
  map = L.map('map').setView([currentRide.depart_lat || 49.1667, currentRide.depart_lng || 2.3667], 12)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map)

  L.marker([currentRide.depart_lat, currentRide.depart_lng], {
    icon: L.divIcon({ html: '<div style="width:16px;height:16px;background:#27AE60;border:3px solid #fff;border-radius:50%"></div>', className: '' })
  }).addTo(map)
  L.marker([currentRide.arrivee_lat, currentRide.arrivee_lng], {
    icon: L.divIcon({ html: '<div style="width:16px;height:16px;background:#C0392B;border:3px solid #fff;border-radius:50%"></div>', className: '' })
  }).addTo(map)
}

function subscribeToUpdates() {
  // Position GPS du chauffeur en temps réel
  gpsChannel = supabase.channel(`gps-${currentRide.chauffeur_id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_locations', filter: `chauffeur_id=eq.${currentRide.chauffeur_id}` }, (payload) => {
      const { latitude, longitude } = payload.new
      if (!driverMarker) {
        driverMarker = L.marker([latitude, longitude], {
          icon: L.divIcon({ html: '<div style="width:34px;height:34px;background:#0A1A38;border:3px solid #C8A84B;border-radius:50%;display:flex;align-items:center;justify-content:center"><i class="fas fa-car" style="color:#C8A84B;font-size:.8rem"></i></div>', className: '' })
        }).addTo(map)
      } else {
        driverMarker.setLatLng([latitude, longitude])
      }
      updateETA(latitude, longitude)
    })
    .subscribe()

  // Statut de la course (acceptée → en cours → terminée)
  rideChannel = supabase.channel(`ride-status-${currentRide.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${currentRide.id}` }, (payload) => {
      currentRide = { ...currentRide, ...payload.new }
      renderRideDetails()
      if (payload.new.statut === 'termine') {
        document.getElementById('eta-card').style.display = 'none'
        showToast('Course terminée !', 'success')
        document.getElementById('rating-modal').classList.add('open')
      }
    })
    .subscribe()
}

// ─── ETA en direct : recalcule la durée réelle (OSRM) vers le point pertinent,
// limité à un appel toutes les 25s pour ne pas saturer le service de routage ───
let lastEtaCalc = 0
async function updateETA(driverLat, driverLng) {
  if (!['accepte', 'en_cours'].includes(currentRide.statut)) {
    document.getElementById('eta-card').style.display = 'none'
    return
  }

  const now = Date.now()
  if (now - lastEtaCalc < 25000) return
  lastEtaCalc = now

  const target = currentRide.statut === 'accepte'
    ? { lat: currentRide.depart_lat, lng: currentRide.depart_lng, label: 'Votre chauffeur arrive dans' }
    : { lat: currentRide.arrivee_lat, lng: currentRide.arrivee_lng, label: 'Arrivée à destination dans' }

  if (!target.lat || !target.lng) return

  const { dureeMin } = await getRouteDuration(driverLat, driverLng, target.lat, target.lng)

  document.getElementById('eta-card').style.display = 'block'
  document.getElementById('eta-label').textContent = target.label
  document.getElementById('eta-value').textContent = dureeMin <= 1 ? "moins d'1 min" : `${dureeMin} min`
  document.getElementById('eta-updated').textContent = 'Mis à jour à ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

window.cancelActiveRide = async function() {
  if (!currentRide || !confirm('Annuler cette course ?')) return
  await supabase.from('rides').update({ statut: 'annule' }).eq('id', currentRide.id)
  showToast('Course annulée.', 'warning')
  setTimeout(() => window.location.reload(), 1000)
}

// ─── Notation en fin de course ───
let selectedRating = 0
document.addEventListener('click', (e) => {
  const star = e.target.closest('#rating-stars i')
  if (!star) return
  selectedRating = parseInt(star.dataset.val)
  document.querySelectorAll('#rating-stars i').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.val) <= selectedRating)
  })
})

window.submitRating = async function() {
  if (!selectedRating) { showToast('Sélectionnez une note.', 'warning'); return }
  const comment = document.getElementById('rating-comment').value.trim()

  await supabase.from('ratings').insert({
    ride_id: currentRide.id, from_user_id: currentUser.id, to_user_id: currentRide.chauffeur_id,
    note: selectedRating, commentaire: comment || null
  })
  await supabase.from('rides').update({ note_client: selectedRating }).eq('id', currentRide.id)

  document.getElementById('rating-modal').classList.remove('open')
  showToast('Merci pour votre avis !', 'success')
  setTimeout(() => window.location.href = '../history/client-history.html', 1200)
}

window.skipRating = function() {
  document.getElementById('rating-modal').classList.remove('open')
  window.location.href = '../history/client-history.html'
}

init()
