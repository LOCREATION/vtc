// depth = 1 (client/receipts.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allRides = []
let currentClientName = ''

async function init() {
  const user = await requireAuth(2, 'client')
  if (!user) return
  currentClientName = user.prenom + ' ' + user.nom

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Client'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  const { data } = await supabase.from('rides').select('*').eq('client_id', user.id).eq('statut', 'termine').order('created_at', { ascending: false })
  allRides = data || []

  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allRides.length}</div><div class="lbl">Reçus</div></div>`

  const tb = document.getElementById('receipts-table'), em = document.getElementById('receipts-empty')
  if (!allRides.length) { tb.innerHTML = ''; em.style.display = 'block'; hideLoader(); return }
  em.style.display = 'none'

  tb.innerHTML = allRides.map(r => `<tr>
    <td>${formatDate(r.created_at)}</td>
    <td><div style="font-size:.85rem;font-weight:600">${r.depart}</div><div class="td-sub">→ ${r.arrivee}</div></td>
    <td style="font-weight:700">${formatPrice(r.prix || 0)}</td>
    <td><button class="btn btn-outline btn-sm" onclick="downloadReceipt('${r.id}')"><i class="fas fa-file-pdf"></i> PDF</button></td>
  </tr>`).join('')

  hideLoader()
}

window.downloadReceipt = function(rideId) {
  const ride = allRides.find(r => r.id === rideId)
  if (!ride) return

  const { jsPDF } = window.jspdf
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })

  doc.setFontSize(16); doc.setFont(undefined, 'bold')
  doc.text("LOC RÉACTION S.A.S", 105, 22, { align: 'center' })
  doc.setFontSize(9); doc.setFont(undefined, 'normal')
  doc.text('Île-de-France, 95270', 105, 28, { align: 'center' })
  doc.text('SIREN 100052570 — TVA FR49100052570', 105, 33, { align: 'center' })

  doc.setFontSize(13); doc.setFont(undefined, 'bold')
  doc.text('REÇU DE COURSE VTC', 105, 46, { align: 'center' })

  doc.setFontSize(10); doc.setFont(undefined, 'normal')
  doc.text(`Client : ${currentClientName}`, 20, 62)
  doc.text(`Date : ${formatDate(ride.created_at)}`, 20, 68)
  doc.text(`Départ : ${ride.depart}`, 20, 78)
  doc.text(`Arrivée : ${ride.arrivee}`, 20, 84)
  doc.text(`Distance : ${ride.distance_km || '—'} km`, 20, 94)
  doc.text(`Durée : ${ride.duree_min || '—'} min`, 20, 100)

  doc.setDrawColor(200)
  doc.line(20, 108, 190, 108)
  doc.setFontSize(12); doc.setFont(undefined, 'bold')
  doc.text('MONTANT PAYÉ', 20, 118)
  doc.text(formatPrice(ride.prix || 0), 188, 118, { align: 'right' })

  doc.setFontSize(8); doc.setTextColor(120)
  doc.text(`Reçu généré le ${formatDate(new Date())}`, 105, 280, { align: 'center' })

  doc.save(`recu_locreaction_${ride.id.slice(0, 8)}.pdf`)
}

init()
