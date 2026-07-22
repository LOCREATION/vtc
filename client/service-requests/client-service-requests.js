// depth = 1 (client/service-requests.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()

const SERVICE_LABELS = { vtc: 'Transport VTC', location: 'Location Immobilière', btp: 'BTP & Construction', jardinage: 'Jardinage', amo: 'Assistance à Maîtrise d\'Ouvrage', autre: 'Autre' }
const STATUS_LABELS = { en_attente: ['En attente', 'badge-gray'], devis_envoye: ['Devis envoyé', 'badge-primary'], accepte: ['Accepté', 'badge-success'], en_cours: ['En cours', 'badge-gold'], termine: ['Terminé', 'badge-success'] }

async function init() {
  const user = await requireAuth(2, 'client')
  if (!user) return

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Client'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  const { data } = await supabase.from('service_requests').select('*').eq('client_id', user.id).order('created_at', { ascending: false })
  const requests = data || []

  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${requests.length}</div><div class="lbl">Demandes</div></div>`

  const tb = document.getElementById('sr-table'), em = document.getElementById('sr-empty')
  if (!requests.length) { tb.innerHTML = ''; em.style.display = 'block'; hideLoader(); return }
  em.style.display = 'none'

  tb.innerHTML = requests.map(r => {
    const [label, badgeClass] = STATUS_LABELS[r.statut] || ['—', 'badge-gray']
    return `<tr>
      <td>${formatDate(r.created_at)}</td>
      <td><span class="badge badge-primary">${SERVICE_LABELS[r.service_type] || r.service_type}</span></td>
      <td style="max-width:280px"><div style="font-size:.85rem">${r.description}</div></td>
      <td><span class="badge ${badgeClass}">${label}</span></td>
      <td style="font-weight:700">${r.devis_montant ? formatPrice(r.devis_montant) : '—'}</td>
    </tr>`
  }).join('')

  hideLoader()
}

init()
