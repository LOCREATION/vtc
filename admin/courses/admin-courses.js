// depth = 1 (admin/rides.html)
import { supabase, requireAuth, logout, formatPrice, formatDateTime, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'
import { generateBonCommande, getBonCommandeSignedUrl } from '../../shared/bon-commande.js'

initAppHamburger()
let allRides = []
let currentFilter = 'tous'
let adminId = null
let currentBonPath = null
let currentBonBlob = null

async function init() {
  const user = await requireAuth(2, 'admin')
  if (!user) return
  adminId = user.id

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Administrateur'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  const { data } = await supabase.from('rides').select('*, client:client_id(prenom,nom), chauffeur:chauffeur_id(prenom,nom,tel,email)').order('created_at', { ascending: false }).limit(300)
  allRides = data || []
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allRides.length}</div><div class="lbl">Courses</div></div>`
  renderTable(allRides)

  // Ouvre directement la fiche d'une course si on arrive via un lien "?ride=<id>"
  const params = new URLSearchParams(location.search)
  const rideParam = params.get('ride')
  if (rideParam && allRides.some(r => r.id === rideParam)) openDetail(rideParam)
  hideLoader()
}

const STATUS_COLORS = { en_attente: 'badge-gray', accepte: 'badge-primary', en_cours: 'badge-gold', termine: 'badge-success', annule: 'badge-danger' }

function renderTable(rides) {
  const tb = document.getElementById('rides-table'), em = document.getElementById('rides-empty')
  if (!rides.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  tb.innerHTML = rides.map(r => `<tr>
    <td>${formatDateTime(r.created_at)}</td>
    <td>${r.client ? r.client.prenom + ' ' + r.client.nom : '—'}</td>
    <td>${r.chauffeur ? r.chauffeur.prenom + ' ' + r.chauffeur.nom : '—'}</td>
    <td><div style="font-size:.85rem">${r.depart}</div><div class="td-sub">→ ${r.arrivee}</div></td>
    <td style="font-weight:700">${formatPrice(r.prix || 0)}</td>
    <td><span class="badge ${STATUS_COLORS[r.statut] || 'badge-gray'}">${r.statut}</span></td>
    <td><button class="btn btn-outline-gray btn-sm" onclick="openDetail('${r.id}')" title="Voir / Modifier"><i class="fas fa-eye"></i></button></td>
  </tr>`).join('')
}

window.setFilter = function(filter, el) {
  currentFilter = filter
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
  el.classList.add('active')
  renderTable(filter === 'tous' ? allRides : allRides.filter(r => r.statut === filter))
}

window.exportCSV = function() {
  const rows = [['Date', 'Client', 'Chauffeur', 'Départ', 'Arrivée', 'Prix', 'Statut']]
  allRides.forEach(r => rows.push([formatDateTime(r.created_at), r.client ? `${r.client.prenom} ${r.client.nom}` : '', r.chauffeur ? `${r.chauffeur.prenom} ${r.chauffeur.nom}` : '', r.depart, r.arrivee, r.prix || '', r.statut]))
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'courses_locreaction.csv'; link.click()
}

window.openDetail = function(id) {
  const r = allRides.find(x => x.id === id)
  if (!r) return
  document.getElementById('rd-id').value = r.id
  document.getElementById('rd-client').textContent = r.client ? `${r.client.prenom} ${r.client.nom}` : '—'
  document.getElementById('rd-chauffeur').textContent = r.chauffeur ? `${r.chauffeur.prenom} ${r.chauffeur.nom}` : 'Non assigné'
  document.getElementById('rd-depart').textContent = r.depart
  document.getElementById('rd-arrivee').textContent = r.arrivee
  document.getElementById('rd-distance').textContent = r.distance_km ? r.distance_km + ' km' : '—'
  document.getElementById('rd-prix').textContent = formatPrice(r.prix || 0)
  document.getElementById('rd-date').textContent = formatDateTime(r.created_at)
  document.getElementById('rd-statut').value = r.statut
  document.getElementById('detail-modal').classList.add('open')

  // La réassignation n'a de sens que si on a des coordonnées de départ valides
  document.getElementById('rd-assign-section').style.display = (r.depart_lat && r.depart_lng) ? 'block' : 'none'
  loadNearbyDrivers(r)

  // Bon de commande — n'a de sens que si un chauffeur est assigné
  const bonSection = document.getElementById('rd-bon-section')
  const genBtn = document.getElementById('rd-bon-generate-btn')
  const shareDiv = document.getElementById('rd-bon-share')
  currentBonPath = null
  currentBonBlob = null

  if (!r.chauffeur_id) {
    bonSection.style.display = 'none'
  } else {
    bonSection.style.display = 'block'
    if (r.bon_commande_url) {
      document.getElementById('rd-bon-status').textContent = `Bon déjà généré le ${formatDateTime(r.bon_commande_genere_at)}${r.bon_commande_envoye_via ? ' — envoyé via ' + r.bon_commande_envoye_via : ''}.`
      currentBonPath = r.bon_commande_url
      genBtn.innerHTML = '<i class="fas fa-sync"></i> Régénérer le bon'
      shareDiv.style.display = 'flex'
    } else {
      document.getElementById('rd-bon-status').textContent = 'Aucun bon généré pour cette course.'
      genBtn.innerHTML = '<i class="fas fa-file-pdf"></i> Générer le bon de commande'
      shareDiv.style.display = 'none'
    }
  }
}

window.refreshNearbyDrivers = function() {
  const id = document.getElementById('rd-id').value
  const r = allRides.find(x => x.id === id)
  if (r) loadNearbyDrivers(r)
}

async function loadNearbyDrivers(ride) {
  const list = document.getElementById('rd-nearby-list')
  if (!ride.depart_lat || !ride.depart_lng) return
  list.innerHTML = `<div style="text-align:center;padding:10px;color:var(--gray);font-size:.8rem"><i class="fas fa-spinner fa-spin"></i> Recherche…</div>`

  const { data, error } = await supabase.rpc('nearby_online_drivers', {
    p_lat: ride.depart_lat, p_lng: ride.depart_lng, p_radius_km: 50
  })

  if (error) { list.innerHTML = `<div style="font-size:.78rem;color:var(--red)">Erreur : ${error.message}</div>`; return }
  if (!data || !data.length) { list.innerHTML = `<div style="font-size:.8rem;color:var(--gray);padding:8px 0">Aucun chauffeur en ligne dans un rayon de 50 km.</div>`; return }

  list.innerHTML = data.map(d => `<div class="rd-driver-row">
    <div class="nav-avatar">${(d.prenom || '?')[0]}${(d.nom || '?')[0]}</div>
    <div class="rd-driver-info">
      <div class="rd-driver-name">${d.prenom} ${d.nom}</div>
      <div class="rd-driver-meta">${[d.vehicule_marque, d.vehicule_modele].filter(Boolean).join(' ') || 'Véhicule non renseigné'}</div>
    </div>
    <div class="rd-driver-dist">${d.distance_km} km</div>
    <button class="btn btn-primary btn-sm" onclick="assignDriver('${d.chauffeur_id}', '${(d.prenom + ' ' + d.nom).replace(/'/g, "\\'")}')"><i class="fas fa-check"></i></button>
  </div>`).join('')
}

window.assignDriver = async function(chauffeurId, driverName) {
  const rideId = document.getElementById('rd-id').value
  if (!confirm(`Assigner cette course à ${driverName} ?`)) return

  const { error } = await supabase.from('rides').update({
    chauffeur_id: chauffeurId, statut: 'accepte', assigne_manuellement_par: adminId
  }).eq('id', rideId)

  if (error) { showToast('Erreur : ' + error.message, 'error'); return }

  // Nettoie les invitations automatiques devenues obsolètes pour cette course
  await supabase.from('driver_invitations').update({ statut: 'expired' }).eq('ride_id', rideId).eq('statut', 'pending')

  // Notifie le chauffeur assigné
  const { error: notifError } = await supabase.from('notifications').insert({
    user_id: chauffeurId, titre: 'Course assignée par l\'administration',
    message: 'Une course vous a été attribuée directement. Consultez votre tableau de bord.', type: 'success'
  })
  if (notifError) console.error('Échec notification chauffeur :', notifError)

  showToast(`Course assignée à ${driverName} !`, 'success')
  document.getElementById('detail-modal').classList.remove('open')

  const r = allRides.find(x => x.id === rideId)
  if (r) { r.chauffeur_id = chauffeurId; r.statut = 'accepte' }
  renderTable(currentFilter === 'tous' ? allRides : allRides.filter(x => x.statut === currentFilter))
}

window.saveRideStatus = async function() {
  const id = document.getElementById('rd-id').value
  const statut = document.getElementById('rd-statut').value
  const { error } = await supabase.from('rides').update({ statut }).eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Statut mis à jour !', 'success')
  document.getElementById('detail-modal').classList.remove('open')
  const r = allRides.find(x => x.id === id)
  if (r) r.statut = statut
  renderTable(currentFilter === 'tous' ? allRides : allRides.filter(x => x.statut === currentFilter))
}

window.deleteRide = async function() {
  const id = document.getElementById('rd-id').value
  if (!confirm('Supprimer définitivement cette course ? Cette action est irréversible.')) return
  const { error } = await supabase.from('rides').delete().eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Course supprimée.', 'warning')
  document.getElementById('detail-modal').classList.remove('open')
  allRides = allRides.filter(x => x.id !== id)
  renderTable(currentFilter === 'tous' ? allRides : allRides.filter(x => x.statut === currentFilter))
}

window.generateBon = async function() {
  const rideId = document.getElementById('rd-id').value
  const btn = document.getElementById('rd-bon-generate-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Génération…'

  const result = await generateBonCommande(rideId)

  btn.disabled = false
  if (!result) {
    showToast('Erreur lors de la génération du bon.', 'error')
    btn.innerHTML = '<i class="fas fa-file-pdf"></i> Générer le bon de commande'
    return
  }

  currentBonPath = result.path
  currentBonBlob = result.blob
  document.getElementById('rd-bon-status').textContent = `Bon généré à l'instant (${result.bonNum}).`
  btn.innerHTML = '<i class="fas fa-sync"></i> Régénérer le bon'
  document.getElementById('rd-bon-share').style.display = 'flex'
  showToast('Bon de commande généré !', 'success')

  const r = allRides.find(x => x.id === rideId)
  if (r) { r.bon_commande_url = result.path; r.bon_commande_genere_at = new Date().toISOString() }
}

async function markBonSent(via) {
  const rideId = document.getElementById('rd-id').value
  await supabase.from('rides').update({ bon_commande_envoye_via: via, bon_commande_envoye_at: new Date().toISOString() }).eq('id', rideId)
  const r = allRides.find(x => x.id === rideId)
  if (r) { r.bon_commande_envoye_via = via; r.bon_commande_envoye_at = new Date().toISOString() }
}

window.shareBonWhatsApp = async function() {
  if (!currentBonPath) return
  const rideId = document.getElementById('rd-id').value
  const ride = allRides.find(x => x.id === rideId)
  const tel = ride?.chauffeur?.tel
  if (!tel) { showToast('Aucun numéro de téléphone renseigné pour ce chauffeur.', 'warning'); return }

  const url = await getBonCommandeSignedUrl(currentBonPath, 86400)
  if (!url) { showToast('Erreur lors de la génération du lien.', 'error'); return }

  const telClean = tel.replace(/[^0-9+]/g, '')
  const message = encodeURIComponent(`Bonjour, voici votre bon de commande LOC RÉACTION S.A.S pour la course en cours. Valable 24h : ${url}`)
  window.open(`https://wa.me/${telClean}?text=${message}`, '_blank')
  await markBonSent('WhatsApp')
  showToast('Lien WhatsApp ouvert.', 'success')
}

window.shareBonEmail = async function() {
  if (!currentBonPath) return
  const rideId = document.getElementById('rd-id').value
  const ride = allRides.find(x => x.id === rideId)
  const email = ride?.chauffeur?.email
  if (!email) { showToast('Aucun email renseigné pour ce chauffeur.', 'warning'); return }

  const url = await getBonCommandeSignedUrl(currentBonPath, 86400)
  if (!url) { showToast('Erreur lors de la génération du lien.', 'error'); return }

  const subject = encodeURIComponent('Votre bon de commande LOC RÉACTION S.A.S')
  const body = encodeURIComponent(`Bonjour,\n\nVoici le lien de téléchargement de votre bon de commande pour la course en cours (valable 24h) :\n${url}\n\nCordialement,\nLOC RÉACTION S.A.S`)
  window.location.href = `mailto:${email}?subject=${subject}&body=${body}`
  await markBonSent('Email')
  showToast('Client email ouvert.', 'success')
}

window.downloadBonAdmin = async function() {
  if (currentBonBlob) {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(currentBonBlob)
    link.download = 'bon_commande.pdf'
    link.click()
    return
  }
  // Bon généré lors d'une session précédente : pas de blob en mémoire, on passe par l'URL signée
  if (!currentBonPath) { showToast('Générez d\'abord le bon.', 'warning'); return }
  const url = await getBonCommandeSignedUrl(currentBonPath, 300)
  if (!url) { showToast('Erreur lors de la récupération du fichier.', 'error'); return }
  window.open(url, '_blank')
}

init()
