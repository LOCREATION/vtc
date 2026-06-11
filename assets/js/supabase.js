// assets/js/supabase.js
// LOC'RÉATION SAS - Version production complète

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = 'https://cgbafvewynahaiqpnejk.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNnYmFmdmV3eW5haGFpcXBuZWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NzIxMDcsImV4cCI6MjA5NjQ0ODEwN30.vfxwAU-JYfEpVPUTfe3HPMOTaKyM25rHXQH-JbV0ObY'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ---------- AUTH ----------
export async function getSession() {
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error) console.error('getSession error', error)
  return session
}

export async function getCurrentUser() {
  const session = await getSession()
  if (!session) return null
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single()
  if (error) {
    console.error('getCurrentUser profile error', error)
    return null
  }
  return { ...session.user, profile }
}

export async function requireAuth(role = null) {
  const user = await getCurrentUser()
  if (!user) {
    window.location.href = '/auth/login.html'
    return null
  }
  if (role && user.profile.role !== role && user.profile.role !== 'admin') {
    alert('Accès non autorisé. Vous n\'avez pas le rôle requis.')
    window.location.href = '/'
    return null
  }
  return user
}

export async function redirectToDashboard(role) {
  const map = {
    client: '/client/dashboard.html',
    chauffeur: '/driver/dashboard.html',
    admin: '/admin/dashboard.html'
  }
  const url = map[role] || '/index.html'
  window.location.href = url
}

export async function logout() {
  await supabase.auth.signOut()
  window.location.href = '/'
}

// ---------- TOAST ----------
let toastContainer = null

function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div')
    toastContainer.style.position = 'fixed'
    toastContainer.style.bottom = '20px'
    toastContainer.style.left = '50%'
    toastContainer.style.transform = 'translateX(-50%)'
    toastContainer.style.zIndex = '9999'
    toastContainer.style.display = 'flex'
    toastContainer.style.flexDirection = 'column'
    toastContainer.style.gap = '10px'
    document.body.appendChild(toastContainer)
  }
  return toastContainer
}

export function showToast(message, type = 'info') {
  const container = getToastContainer()
  const toast = document.createElement('div')
  toast.textContent = message
  toast.style.background = type === 'error' ? '#C0392B' : (type === 'success' ? '#27AE60' : '#0A1A38')
  toast.style.color = '#fff'
  toast.style.padding = '12px 24px'
  toast.style.borderRadius = '12px'
  toast.style.fontSize = '0.9rem'
  toast.style.fontWeight = '500'
  toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)'
  toast.style.maxWidth = '90vw'
  toast.style.textAlign = 'center'
  container.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

// ---------- PRICE CALCULATION (OSRM + tariffs) ----------
async function getCoordinates(address) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`)
  const data = await res.json()
  if (!data.length) throw new Error('Adresse introuvable')
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
}

async function getRoute(originLat, originLng, destLat, destLng) {
  const url = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=false`
  const res = await fetch(url)
  const data = await res.json()
  if (!data.routes.length) throw new Error('Itinéraire non trouvé')
  const route = data.routes[0]
  return { distanceKm: route.distance / 1000, durationMin: Math.round(route.duration / 60) }
}

export async function calculateRidePrice(departAddress, arriveeAddress) {
  const depart = await getCoordinates(departAddress)
  const arrivee = await getCoordinates(arriveeAddress)
  const { distanceKm, durationMin } = await getRoute(depart.lat, depart.lng, arrivee.lat, arrivee.lng)
  const { data: tariff, error } = await supabase
    .from('tariffs')
    .select('prix_km, prix_base, surcharge_nuit, surcharge_pointe')
    .eq('actif', true)
    .limit(1)
    .single()
  if (error) {
    console.error('Erreur chargement tarif', error)
    var prixKm = 1.70
    var prixBase = 3.50
    var surchargeNuit = 1.0
    var surchargePointe = 1.0
  } else {
    prixKm = tariff.prix_km
    prixBase = tariff.prix_base
    surchargeNuit = tariff.surcharge_nuit || 1.0
    surchargePointe = tariff.surcharge_pointe || 1.0
  }
  const now = new Date()
  const heures = now.getHours()
  let multiplier = 1.0
  if (heures >= 22 || heures < 6) multiplier = surchargeNuit
  else if ((heures >= 7 && heures < 9) || (heures >= 17 && heures < 19)) multiplier = surchargePointe
  let prix = (prixBase + distanceKm * prixKm) * multiplier
  const minCourse = 8.0
  if (prix < minCourse) prix = minCourse
  return {
    prix: Math.round(prix * 100) / 100,
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMin,
    depart,
    arrivee
  }
}

// ---------- HELPERS ----------
export function formatPrice(amount) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount)
}

export function formatDate(date) {
  return new Date(date).toLocaleDateString('fr-FR')
}

export function formatDateTime(date) {
  return new Date(date).toLocaleString('fr-FR')
}

export function hideLoader() {
  const loader = document.getElementById('global-loader')
  if (loader) loader.style.display = 'none'
}

export function formatInitials(prenom, nom) {
  return `${prenom.charAt(0)}${nom.charAt(0)}`.toUpperCase()
}