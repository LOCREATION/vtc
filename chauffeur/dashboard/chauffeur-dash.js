// ============================================================
// LOC RÉACTION S.A.S — chauffeur-dash.js
// depth = 2 (chauffeur/dashboard/chauffeur-dash.html)
// ============================================================
import { supabase, requireAuth, logout, formatPrice, formatInitials, showToast, hideLoader, creditWallet } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'
import { downloadBonCommande } from '../../shared/bon-commande.js'
import { getOrCreateRideConversation, loadMessages, sendTextMessage, sendImageMessage, getImageUrl, markConversationRead, subscribeToConversation, formatMessageTime } from '../../shared/messaging.js'

initAppHamburger()

let currentUser = null
let isOnline = false
let watchId = null
let activeInvitation = null
let invitationTimer = null
let activeRide = null
let map = null, driverMarker = null
let invitationChannel = null, rideChannel = null

async function init() {
  const user = await requireAuth(2, 'chauffeur')
  if (!user) return
  currentUser = user

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Chauffeur'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  await checkExistingOnlineStatus()
  await checkActiveRide()
  await loadTodayStats()
  listenForInvitations()

  hideLoader()
}

async function checkExistingOnlineStatus() {
  const { data } = await supabase.from('driver_locations').select('is_online').eq('chauffeur_id', currentUser.id).maybeSingle()
  isOnline = data?.is_online || false
  document.getElementById('online-toggle').checked = isOnline
  updateOnlineUI()
  if (isOnline) startWatchingPosition()
}

function updateOnlineUI() {
  document.getElementById('online-dot').className = 'status-dot ' + (isOnline ? 'status-online' : 'status-offline')
  document.getElementById('online-label').textContent = isOnline ? 'En ligne — visible des clients' : 'Hors ligne'
}

// ─── Disponibilité + GPS réel ───
window.toggleOnline = async function(checked) {
  isOnline = checked
  updateOnlineUI()

  if (isOnline) {
    // Marqué en ligne immédiatement — ne dépend plus d'un premier succès GPS.
    // Un client peut donc envoyer une invitation dès l'activation, même avant
    // que la première position ne soit reçue.
    const { data: existing } = await supabase.from('driver_locations').select('chauffeur_id').eq('chauffeur_id', currentUser.id).maybeSingle()
    if (existing) {
      await supabase.from('driver_locations').update({ is_online: true, updated_at: new Date().toISOString() }).eq('chauffeur_id', currentUser.id)
    } else {
      await supabase.from('driver_locations').insert({ chauffeur_id: currentUser.id, is_online: true, latitude: 49.1667, longitude: 2.3667, updated_at: new Date().toISOString() })
    }
    showToast('Vous êtes en ligne.', 'success')
    startWatchingPosition()
  } else {
    if (watchId) navigator.geolocation.clearWatch(watchId)
    await supabase.from('driver_locations').update({ is_online: false, updated_at: new Date().toISOString() }).eq('chauffeur_id', currentUser.id)
    showToast('Vous êtes hors ligne.', 'info')
  }
}

function startWatchingPosition() {
  if (!navigator.geolocation) {
    showToast('Géolocalisation non disponible sur cet appareil — vous restez en ligne, mais votre position ne sera pas partagée.', 'warning')
    return
  }

  watchId = navigator.geolocation.watchPosition(
    async (position) => {
      const { latitude, longitude } = position.coords
      await supabase.from('driver_locations').update({
        latitude, longitude, is_online: true, updated_at: new Date().toISOString()
      }).eq('chauffeur_id', currentUser.id)
      document.getElementById('gps-status-note')?.remove()
    },
    (err) => {
      // Une erreur GPS ne remet plus le chauffeur hors ligne — il reste visible
      // des clients, on l'informe juste que sa position n'est pas partagée.
      let msg = 'Position indisponible pour le moment — vous restez en ligne.'
      if (err.code === err.PERMISSION_DENIED) msg = 'Localisation refusée par le navigateur. Autorisez-la dans les réglages du site pour partager votre position (vous restez en ligne sans elle).'
      showToast(msg, 'warning')
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  )
}

// ─── Écoute des invitations en temps réel ───
function listenForInvitations() {
  invitationChannel = supabase.channel(`driver-invites-${currentUser.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'driver_invitations', filter: `chauffeur_id=eq.${currentUser.id}` }, (payload) => {
      if (!activeRide) showInvitation(payload.new)
    })
    .subscribe()
}

async function showInvitation(invitation) {
  const { data: ride } = await supabase.from('rides').select('*').eq('id', invitation.ride_id).single()
  if (!ride || ride.statut !== 'en_attente') return

  activeInvitation = { invitation, ride }
  document.getElementById('inv-depart').textContent = ride.depart
  document.getElementById('inv-arrivee').textContent = ride.arrivee
  document.getElementById('inv-distance').textContent = (ride.distance_km || 0) + ' km'
  document.getElementById('inv-prix').textContent = formatPrice(ride.prix)
  document.getElementById('invitation-card').style.display = 'block'

  let timeLeft = 30
  const timerBar = document.getElementById('inv-timer')
  timerBar.style.width = '100%'
  invitationTimer = setInterval(() => {
    timeLeft--
    timerBar.style.width = (timeLeft / 30 * 100) + '%'
    if (timeLeft <= 0) { clearInterval(invitationTimer); declineInvitation() }
  }, 1000)
}

window.acceptInvitation = async function() {
  if (!activeInvitation) return
  clearInterval(invitationTimer)
  const { ride, invitation } = activeInvitation

  // Garde contre la concurrence : n'accepte que si personne d'autre n'a déjà pris la course
  const { data: updated, error } = await supabase.from('rides')
    .update({ chauffeur_id: currentUser.id, statut: 'accepte' })
    .eq('id', ride.id).eq('statut', 'en_attente')
    .select().maybeSingle()

  document.getElementById('invitation-card').style.display = 'none'

  if (!updated) {
    showToast('Cette course a déjà été prise par un autre chauffeur.', 'warning')
    activeInvitation = null
    return
  }

  await supabase.from('driver_invitations').update({ statut: 'accepted', responded_at: new Date().toISOString() }).eq('id', invitation.id)
  showToast('Course acceptée !', 'success')
  activeRide = updated
  activeInvitation = null
  renderActiveRide()
  subscribeRideUpdates()
}

window.declineInvitation = async function() {
  clearInterval(invitationTimer)
  if (activeInvitation) {
    await supabase.from('driver_invitations').update({ statut: 'declined', responded_at: new Date().toISOString() }).eq('id', activeInvitation.invitation.id)
  }
  document.getElementById('invitation-card').style.display = 'none'
  activeInvitation = null
}

// ─── Course active ───
async function checkActiveRide() {
  const { data } = await supabase.from('rides').select('*').eq('chauffeur_id', currentUser.id).in('statut', ['accepte', 'en_cours']).order('created_at', { ascending: false }).limit(1)
  if (data && data.length) {
    activeRide = data[0]
    renderActiveRide()
    subscribeRideUpdates()
  }
}

async function renderActiveRide() {
  document.getElementById('active-ride-card').style.display = 'block'
  document.getElementById('ar-statut').textContent = activeRide.statut
  document.getElementById('ar-depart').textContent = activeRide.depart
  document.getElementById('ar-arrivee').textContent = activeRide.arrivee

  const { data: client } = await supabase.from('profiles').select('prenom, nom').eq('id', activeRide.client_id).single()
  document.getElementById('ar-client').textContent = client ? `${client.prenom} ${client.nom}` : '—'
  if (client) {
    document.getElementById('chat-client-av').textContent = formatInitials(client.prenom, client.nom)
    document.getElementById('chat-client-name').textContent = client.prenom + ' ' + client.nom
  }

  const btn = document.getElementById('ar-action-btn')
  if (activeRide.statut === 'accepte') {
    btn.innerHTML = '<i class="fas fa-play"></i> Démarrer la course'
  } else {
    btn.innerHTML = '<i class="fas fa-flag-checkered"></i> Terminer la course'
  }

  if (!map) {
    map = L.map('map').setView([activeRide.depart_lat, activeRide.depart_lng], 13)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map)
    L.marker([activeRide.depart_lat, activeRide.depart_lng]).addTo(map)
    L.marker([activeRide.arrivee_lat, activeRide.arrivee_lng]).addTo(map)
  }
}

window.advanceRide = async function() {
  if (!activeRide) return

  if (activeRide.statut === 'accepte') {
    await supabase.from('rides').update({ statut: 'en_cours' }).eq('id', activeRide.id)
    activeRide.statut = 'en_cours'
    renderActiveRide()
    showToast('Course démarrée !', 'success')
  } else {
    await supabase.from('rides').update({ statut: 'termine' }).eq('id', activeRide.id)
    await creditWallet(currentUser.id, activeRide.prix, `Course terminée — ${activeRide.depart} → ${activeRide.arrivee}`, activeRide.id)
    showToast(`Course terminée ! +${formatPrice(activeRide.prix)}`, 'success')
    activeRide = null
    document.getElementById('active-ride-card').style.display = 'none'
    await loadTodayStats()
  }
}

function subscribeRideUpdates() {
  if (rideChannel) supabase.removeChannel(rideChannel)
  rideChannel = supabase.channel(`ride-driver-${activeRide.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${activeRide.id}` }, (payload) => {
      if (payload.new.statut === 'annule') {
        showToast('Le client a annulé la course.', 'warning')
        activeRide = null
        document.getElementById('active-ride-card').style.display = 'none'
      }
    })
    .subscribe()
}

window.printBonCommande = async function() {
  if (!activeRide) return
  showToast('Génération du bon de commande…', 'info')
  const result = await downloadBonCommande(activeRide.id)
  if (!result) showToast('Erreur lors de la génération.', 'error')
}

async function loadTodayStats() {
  const today = new Date().toISOString().slice(0, 10)
  const { data: rides } = await supabase.from('rides').select('prix, note_client').eq('chauffeur_id', currentUser.id).eq('statut', 'termine').gte('created_at', today)
  const todayRides = rides || []
  const total = todayRides.reduce((s, r) => s + (r.prix || 0), 0)

  const { data: allRated } = await supabase.from('rides').select('note_client').eq('chauffeur_id', currentUser.id).not('note_client', 'is', null)
  const notes = (allRated || []).map(r => r.note_client)
  const avg = notes.length ? (notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : '—'

  document.getElementById('stat-today').textContent = formatPrice(total)
  document.getElementById('stat-rides').textContent = todayRides.length
  document.getElementById('stat-rating').textContent = avg === '—' ? '—' : avg + ' ★'
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${formatPrice(total)}</div><div class="lbl">Aujourd'hui</div></div>`
}

// ─── Messagerie temps réel avec le client ───
let chatConversation = null

window.openChat = async function() {
  if (!activeRide) return
  document.getElementById('chat-card').style.display = 'block'
  document.getElementById('chat-card').scrollIntoView({ behavior: 'smooth' })

  if (!chatConversation) {
    chatConversation = await getOrCreateRideConversation(activeRide.id, activeRide.client_id, currentUser.id)
    subscribeToConversation(chatConversation.id, (msg) => {
      appendMessage(msg)
      if (msg.sender_id !== currentUser.id) markConversationRead(chatConversation.id, currentUser.id)
    })
  }

  const messages = await loadMessages(chatConversation.id)
  const box = document.getElementById('chat-messages')
  box.innerHTML = ''
  if (!messages.length) {
    box.innerHTML = `<div class="chat-empty"><i class="fas fa-comment-dots"></i><div>Aucun message pour l'instant</div></div>`
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

init()
