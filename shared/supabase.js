// ============================================================
// LOC RÉACTION S.A.S — shared/supabase.js
// Client Supabase RÉEL + Auth + Helpers — Production v1.0
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

export const supabase = createClient(
  'https://cgbafvewynahaiqpnejk.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNnYmFmdmV3eW5haGFpcXBuZWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NzIxMDcsImV4cCI6MjA5NjQ0ODEwN30.vfxwAU-JYfEpVPUTfe3HPMOTaKyM25rHXQH-Jb0VObY'
)

// ─── AUTH ────────────────────────────────────────────────────
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function getCurrentUser() {
  const session = await getSession()
  if (!session) return null
  const { data: profile, error } = await supabase
    .from('profiles').select('*').eq('id', session.user.id).single()
  if (error || !profile) return null
  return { ...profile, email: session.user.email }
}

// depth = nombre de dossiers depuis la racine (ex: 'client/dashboard/client-dash.html' -> depth=2)
export async function requireAuth(depth = 1, requiredRole = null) {
  const user = await getCurrentUser()
  const prefix = '../'.repeat(depth)
  if (!user) { window.location.href = prefix + 'auth/login/login.html'; return null }
  if (user.actif === false) { await logout(depth); return null }
  if (requiredRole && user.role !== requiredRole && user.role !== 'admin') {
    redirectToDashboard(user.role, depth); return null
  }
  return user
}

export async function logout(depth = 1) {
  await supabase.auth.signOut()
  window.location.href = '../'.repeat(depth) + 'auth/login/login.html'
}

export function redirectToDashboard(role, depth = 1) {
  const prefix = '../'.repeat(depth)
  const map = { client: prefix+'client/dashboard/client-dash.html', chauffeur: prefix+'chauffeur/dashboard/chauffeur-dash.html', admin: prefix+'admin/dashboard/admin-dash.html' }
  window.location.href = map[role] || prefix + 'index.html'
}

// ─── PRIX VTC (tarif réel depuis Supabase) ─────────────────
export async function calculateRidePrice(dLat, dLng, aLat, aLng) {
  let distanceKm, dureeMin
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${dLng},${dLat};${aLng},${aLat}?overview=false`
    const res = await fetch(url)
    const data = await res.json()
    distanceKm = +(data.routes[0].distance / 1000).toFixed(1)
    dureeMin = Math.round(data.routes[0].duration / 60)
  } catch (e) {
    const R = 6371
    const dLatR = (aLat-dLat) * Math.PI/180, dLngR = (aLng-dLng) * Math.PI/180
    const a = Math.sin(dLatR/2)**2 + Math.cos(dLat*Math.PI/180)*Math.cos(aLat*Math.PI/180)*Math.sin(dLngR/2)**2
    distanceKm = +(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.3).toFixed(1)
    dureeMin = Math.round(distanceKm * 2.2)
  }

  const { data: tariff } = await supabase.from('tariffs').select('*').eq('actif', true).limit(1).single()
  const prixKm = tariff?.prix_km || 1.70
  const prixBase = tariff?.prix_base || 3.50
  const prixMin = tariff?.prix_min || 0.45

  const h = new Date().getHours()
  const isNuit = h < 6 || h >= 22
  const isPointe = (h >= 7 && h <= 9) || (h >= 17 && h <= 19)

  let prix = prixBase + (distanceKm * prixKm) + (dureeMin * prixMin)
  if (isNuit) prix *= (tariff?.surcharge_nuit || 1.30)
  if (isPointe) prix *= (tariff?.surcharge_pointe || 1.50)
  prix = Math.max(8, prix)

  return { prix: +prix.toFixed(2), distanceKm, dureeMin }
}

// Durée/distance réelles entre deux points (utilisé pour l'ETA en direct côté client)
export async function getRouteDuration(fromLat, fromLng, toLat, toLng) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`
    const res = await fetch(url)
    const data = await res.json()
    return {
      distanceKm: +(data.routes[0].distance / 1000).toFixed(1),
      dureeMin: Math.max(1, Math.round(data.routes[0].duration / 60))
    }
  } catch (e) {
    const R = 6371
    const dLatR = (toLat-fromLat) * Math.PI/180, dLngR = (toLng-fromLng) * Math.PI/180
    const a = Math.sin(dLatR/2)**2 + Math.cos(fromLat*Math.PI/180)*Math.cos(toLat*Math.PI/180)*Math.sin(dLngR/2)**2
    const distanceKm = +(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.3).toFixed(1)
    return { distanceKm, dureeMin: Math.max(1, Math.round(distanceKm * 2.2)) }
  }
}

// ─── WALLET ──────────────────────────────────────────────────
export async function getWallet(userId) {
  const { data } = await supabase.from('wallets').select('*').eq('user_id', userId).single()
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

// ─── ADRESSES (Nominatim OpenStreetMap) ─────────────────────
export async function searchAddress(query) {
  if (!query || query.length < 3) return []
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=fr&limit=5&addressdetails=1`,
      { headers: { 'Accept-Language': 'fr' } }
    )
    const data = await res.json()
    return data.map(d => ({ label: d.display_name, lat: +d.lat, lng: +d.lon }))
  } catch { return [] }
}

// ─── FORMATTERS ──────────────────────────────────────────────
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

// ─── UI ──────────────────────────────────────────────────────
export function showToast(msg, type = 'info', duration = 3500) {
  let c = document.getElementById('toast-container')
  if (!c) { c = document.createElement('div'); c.id = 'toast-container'; c.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:10px;'; document.body.appendChild(c) }
  const icons = { success:'fa-check-circle', error:'fa-times-circle', warning:'fa-exclamation-triangle', info:'fa-info-circle' }
  const colors = { success:'#27ae60', error:'#c0392b', warning:'#f39c12', info:'#1B3A6B' }
  const t = document.createElement('div')
  t.style.cssText = `display:flex;align-items:center;gap:12px;padding:14px 20px;border-radius:12px;background:${colors[type]||colors.info};color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.2);min-width:280px;font-family:Poppins,sans-serif;font-size:.87rem;font-weight:500;`
  t.innerHTML = `<i class="fas ${icons[type]||icons.info}"></i><span style="flex:1">${msg}</span><span onclick="this.parentElement.remove()" style="cursor:pointer;opacity:.7">✕</span>`
  c.appendChild(t)
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300) }, duration)
}

export function hideLoader() {
  const l = document.getElementById('global-loader')
  if (l) { l.style.opacity = '0'; l.style.transition = 'opacity .3s'; setTimeout(() => l.remove(), 300) }
}
