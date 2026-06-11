// ============================================================
// LOC'RÉATION SAS — assets/js/supabase.js
// Client Supabase + Auth + Helpers — v1.0
// Supabase: https://cgbafvewynahaiqpnejk.supabase.co
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = 'https://cgbafvewynahaiqpnejk.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNnYmFmdmV3eW5haGFpcXBuZWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NzIxMDcsImV4cCI6MjA5NjQ0ODEwN30.vfxwAU-JYfEpVPUTfe3HPMOTaKyM25rHXQH-Jb0VObY'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── AUTH HELPERS ────────────────────────────────────────────
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
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
  if (error) return null
  return { ...profile, email: session.user.email }
}

export async function requireAuth(requiredRole = null) {
  const user = await getCurrentUser()
  if (!user) {
    const depth = window.location.pathname.split('/').length - 2
    const prefix = depth > 1 ? '../'.repeat(depth - 1) : ''
    window.location.href = prefix + 'auth/login.html'
    return null
  }
  if (requiredRole && user.role !== requiredRole && user.role !== 'admin') {
    redirectToDashboard(user.role)
    return null
  }
  return user
}

export async function logout() {
  await supabase.auth.signOut()
  window.location.href = '/auth/login.html'
}

export function redirectToDashboard(role) {
  const base = 'https://locreation.github.io/vtc'
  const map = {
    client:   '/client/dashboard.html',
    chauffeur:'/driver/dashboard.html',
    admin:    '/admin/dashboard.html',
  }
  window.location.href = (map[role] || '/index.html')
}

// ─── PRIX VTC ────────────────────────────────────────────────
export async function calculateRidePrice(dLat, dLng, aLat, aLng) {
  try {
    // Distance via OSRM (gratuit, OpenStreetMap)
    const url = `https://router.project-osrm.org/route/v1/driving/${dLng},${dLat};${aLng},${aLat}?overview=false`
    const res  = await fetch(url)
    const data = await res.json()
    const distanceKm = +(data.routes[0].distance / 1000).toFixed(1)
    const dureeMin   = Math.round(data.routes[0].duration / 60)

    // Tarif depuis Supabase
    const { data: tariff } = await supabase
      .from('tariffs')
      .select('*')
      .eq('actif', true)
      .limit(1)
      .single()

    const prixKm  = tariff?.prix_km  || 1.70
    const prixBase = tariff?.prix_base || 3.50
    const prixMin  = tariff?.prix_min  || 0.45

    const h = new Date().getHours()
    const isNuit   = h < 6 || h >= 22
    const isPointe = (h >= 7 && h <= 9) || (h >= 17 && h <= 19)

    let prix = prixBase + (distanceKm * prixKm) + (dureeMin * prixMin)
    if (isNuit)   prix *= (tariff?.surcharge_nuit   || 1.30)
    if (isPointe) prix *= (tariff?.surcharge_pointe || 1.50)
    prix = Math.max(8, prix)

    return { prix: +prix.toFixed(2), distanceKm, dureeMin }
  } catch (e) {
    // Estimation simple si OSRM indisponible
    const d = Math.sqrt(Math.pow(dLat-aLat,2)+Math.pow(dLng-aLng,2)) * 111
    const dist = +(d || 10).toFixed(1)
    return { prix: +(3.50 + dist * 1.70).toFixed(2), distanceKm: dist, dureeMin: Math.round(dist * 3) }
  }
}

// ─── WALLET HELPERS ──────────────────────────────────────────
export async function getWallet(userId) {
  const { data } = await supabase
    .from('wallets').select('*').eq('user_id', userId).single()
  return data
}

export async function debitWallet(userId, amount, description, rideId = null) {
  const wallet = await getWallet(userId)
  if (!wallet || wallet.balance < amount) return { ok: false, error: 'Solde insuffisant' }
  const newBalance = +(wallet.balance - amount).toFixed(2)
  await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', userId)
  await supabase.from('transactions').insert({ wallet_id: wallet.id, type: 'debit', amount, description, ride_id: rideId })
  return { ok: true, newBalance }
}

export async function creditWallet(userId, amount, description, rideId = null) {
  const wallet = await getWallet(userId)
  if (!wallet) return { ok: false }
  const newBalance = +(wallet.balance + amount).toFixed(2)
  await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', userId)
  await supabase.from('transactions').insert({ wallet_id: wallet.id, type: 'credit', amount, description, ride_id: rideId })
  return { ok: true, newBalance }
}

// ─── ADRESSES NOMINATIM (OpenStreetMap) ──────────────────────
export async function searchAddress(query) {
  if (!query || query.length < 3) return []
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=fr&limit=5&addressdetails=1`,
      { headers: { 'Accept-Language': 'fr' } }
    )
    const data = await res.json()
    return data.map(d => ({
      label: d.display_name,
      lat: +d.lat,
      lng: +d.lon,
    }))
  } catch { return [] }
}

// ─── FORMAT HELPERS ──────────────────────────────────────────
export function formatPrice(n) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n || 0)
}
export function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}
export function formatDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
export function formatInitials(prenom = '', nom = '') {
  return ((prenom[0] || '') + (nom[0] || '')).toUpperCase()
}

// ─── UI HELPERS ──────────────────────────────────────────────
export function showToast(msg, type = 'info', duration = 3500) {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:10px;'
    document.body.appendChild(container)
  }
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' }
  const colors = { success: '#27ae60', error: '#c0392b', warning: '#f39c12', info: '#1B3A6B' }
  const toast = document.createElement('div')
  toast.style.cssText = `display:flex;align-items:center;gap:12px;padding:14px 20px;border-radius:12px;background:${colors[type]||colors.info};color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.2);min-width:280px;font-family:Poppins,sans-serif;font-size:.87rem;font-weight:500;animation:toastIn .4s ease;`
  toast.innerHTML = `<i class="fas ${icons[type]||icons.info}"></i><span style="flex:1">${msg}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,.8);cursor:pointer;font-size:1rem;">✕</button>`
  if (!document.getElementById('toast-css')) {
    const s = document.createElement('style')
    s.id = 'toast-css'
    s.textContent = '@keyframes toastIn{from{opacity:0;transform:translateX(60px)}to{opacity:1;transform:translateX(0)}}'
    document.head.appendChild(s)
  }
  container.appendChild(toast)
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; setTimeout(() => toast.remove(), 300) }, duration)
}

export function hideLoader() {
  const l = document.getElementById('global-loader')
  if (l) { l.style.opacity = '0'; l.style.transition = 'opacity .4s'; setTimeout(() => l.remove(), 400) }
}
