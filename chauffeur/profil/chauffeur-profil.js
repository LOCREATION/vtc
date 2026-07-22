// depth = 1 (driver/profile.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let currentUser = null

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

  document.getElementById('dp-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('dp-name').textContent = user.prenom + ' ' + user.nom
  document.getElementById('v-fullname').textContent = user.prenom + ' ' + user.nom
  document.getElementById('v-tel').textContent = user.tel || '—'
  document.getElementById('v-vehicule').textContent = [user.vehicule_marque, user.vehicule_modele].filter(Boolean).join(' ') || '—'
  document.getElementById('v-plaque').textContent = user.plaque || '—'
  document.getElementById('e-prenom').value = user.prenom || ''
  document.getElementById('e-nom').value = user.nom || ''
  document.getElementById('e-tel').value = user.tel || ''
  document.getElementById('e-marque').value = user.vehicule_marque || ''
  document.getElementById('e-modele').value = user.vehicule_modele || ''
  document.getElementById('e-plaque').value = user.plaque || ''

  const { data: rides } = await supabase.from('rides').select('prix, note_client').eq('chauffeur_id', user.id).eq('statut', 'termine')
  const allRides = rides || []
  const notes = allRides.filter(r => r.note_client).map(r => r.note_client)
  const avg = notes.length ? +(notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : null
  const rev = allRides.reduce((s, r) => s + (r.prix || 0), 0)

  document.getElementById('dp-badge').textContent = allRides.length + ' courses'
  document.getElementById('dp-note').textContent = avg ? avg + ' ★' : '—'
  document.getElementById('dp-avg').textContent = avg || '—'
  document.getElementById('dp-stars').textContent = avg ? '★'.repeat(Math.round(avg)) + '☆'.repeat(5 - Math.round(avg)) : '—'
  document.getElementById('dp-nb-avis').textContent = notes.length ? 'sur ' + notes.length + ' avis' : 'Aucun avis'
  document.getElementById('dp-courses').textContent = allRides.length
  document.getElementById('dp-rev').textContent = formatPrice(rev)
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allRides.length}</div><div class="lbl">Courses</div></div>`

  const { data: reviews } = await supabase.from('ratings').select('note, commentaire, created_at').eq('to_user_id', user.id).order('created_at', { ascending: false }).limit(5)
  if (reviews?.length) {
    document.getElementById('dp-reviews').innerHTML = reviews.map(r => `<div style="padding:12px 0;border-bottom:1px solid var(--gray-xlight)">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--gold)">${'★'.repeat(r.note)}${'☆'.repeat(5 - r.note)}</span><span style="font-size:.72rem;color:var(--gray)">${formatDate(r.created_at)}</span></div>
      ${r.commentaire ? `<div style="font-size:.83rem;color:var(--gray-dark);font-style:italic">"${r.commentaire}"</div>` : ''}
    </div>`).join('')
  } else {
    document.getElementById('dp-reviews').innerHTML = `<p style="font-size:.82rem;color:var(--gray);text-align:center;padding:12px 0">Vos avis apparaîtront ici après vos premières courses notées.</p>`
  }

  hideLoader()
}

let editing = false
window.toggleEdit = function() {
  editing = !editing
  document.getElementById('view-mode').style.display = editing ? 'none' : 'block'
  document.getElementById('edit-mode').style.display = editing ? 'block' : 'none'
}

window.saveProfile = async function() {
  const prenom = document.getElementById('e-prenom').value.trim()
  const nom = document.getElementById('e-nom').value.trim()
  if (!prenom || !nom) { showToast('Prénom et nom obligatoires.', 'warning'); return }

  const { error } = await supabase.from('profiles').update({
    prenom, nom, tel: document.getElementById('e-tel').value,
    vehicule_marque: document.getElementById('e-marque').value,
    vehicule_modele: document.getElementById('e-modele').value,
    plaque: document.getElementById('e-plaque').value
  }).eq('id', currentUser.id)

  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Profil mis à jour !', 'success')
  document.getElementById('dp-name').textContent = prenom + ' ' + nom
  document.getElementById('v-fullname').textContent = prenom + ' ' + nom
  document.getElementById('v-vehicule').textContent = [document.getElementById('e-marque').value, document.getElementById('e-modele').value].filter(Boolean).join(' ') || '—'
  document.getElementById('v-plaque').textContent = document.getElementById('e-plaque').value || '—'
  toggleEdit()
}

init()
