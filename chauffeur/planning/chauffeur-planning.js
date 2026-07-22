// depth = 1 (driver/schedule.html)
import { supabase, requireAuth, logout, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let currentUser = null

const DAYS = [
  { num: 1, label: 'Lundi' }, { num: 2, label: 'Mardi' }, { num: 3, label: 'Mercredi' },
  { num: 4, label: 'Jeudi' }, { num: 5, label: 'Vendredi' }, { num: 6, label: 'Samedi' }, { num: 0, label: 'Dimanche' }
]

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

  const { data: schedules } = await supabase.from('driver_schedules').select('*').eq('chauffeur_id', user.id)
  renderDays(schedules || [])
  hideLoader()
}

function renderDays(schedules) {
  const container = document.getElementById('schedule-days')
  container.innerHTML = DAYS.map(day => {
    const existing = schedules.find(s => s.jour_semaine === day.num)
    return `<div class="day-row">
      <label class="toggle-switch"><input type="checkbox" id="active-${day.num}" ${existing?.actif ? 'checked' : ''} onchange="toggleDay(${day.num})"><span class="toggle-slider"></span></label>
      <div class="day-label">${day.label}</div>
      <div class="day-times">
        <input type="time" id="debut-${day.num}" class="form-control" value="${existing?.heure_debut?.slice(0,5) || '08:00'}" ${!existing?.actif ? 'disabled' : ''}>
        <span style="color:var(--gray)">à</span>
        <input type="time" id="fin-${day.num}" class="form-control" value="${existing?.heure_fin?.slice(0,5) || '20:00'}" ${!existing?.actif ? 'disabled' : ''}>
      </div>
    </div>`
  }).join('')
}

window.toggleDay = function(dayNum) {
  const checked = document.getElementById(`active-${dayNum}`).checked
  document.getElementById(`debut-${dayNum}`).disabled = !checked
  document.getElementById(`fin-${dayNum}`).disabled = !checked
}

window.saveSchedule = async function() {
  const rows = DAYS.map(day => ({
    chauffeur_id: currentUser.id,
    jour_semaine: day.num,
    heure_debut: document.getElementById(`debut-${day.num}`).value,
    heure_fin: document.getElementById(`fin-${day.num}`).value,
    actif: document.getElementById(`active-${day.num}`).checked
  }))

  const { error } = await supabase.from('driver_schedules').upsert(rows, { onConflict: 'chauffeur_id,jour_semaine' })
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Planning enregistré !', 'success')
}

init()
