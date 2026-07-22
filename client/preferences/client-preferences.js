// depth = 1 (client/preferences.html) — 100% Supabase, zéro localStorage
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

  await loadPrefs()
  hideLoader()
}

window.loadPrefs = async function() {
  const { data, error } = await supabase.from('client_preferences').select('*').eq('client_id', currentUser.id).maybeSingle()
  if (error) { showToast('Erreur de chargement.', 'error'); return }

  document.getElementById('pref-temp').value = data?.temperature ?? 22
  document.getElementById('temp-val').textContent = (data?.temperature ?? 22) + '°C'
  document.getElementById('pref-vol').value = data?.volume ?? 30
  document.getElementById('vol-val').textContent = (data?.volume ?? 30) + '%'
  document.getElementById('pref-music').value = data?.music_genre || 'silence'
  document.getElementById('pref-pets').checked = !!data?.pets_allowed
  document.getElementById('pref-baby').checked = !!data?.baby_seat
  document.getElementById('pref-note').value = data?.note_chauffeur || ''
}

window.savePrefs = async function() {
  const payload = {
    client_id: currentUser.id,
    temperature: parseInt(document.getElementById('pref-temp').value),
    volume: parseInt(document.getElementById('pref-vol').value),
    music_genre: document.getElementById('pref-music').value,
    pets_allowed: document.getElementById('pref-pets').checked,
    baby_seat: document.getElementById('pref-baby').checked,
    note_chauffeur: document.getElementById('pref-note').value,
    updated_at: new Date().toISOString()
  }
  const { error } = await supabase.from('client_preferences').upsert(payload, { onConflict: 'client_id' })
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Préférences enregistrées !', 'success')
}

init()
