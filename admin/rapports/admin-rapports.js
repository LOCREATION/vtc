// depth = 1 (admin/reports.html)
import { supabase, requireAuth, logout, formatPrice, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()

async function init() {
  const user = await requireAuth(2, 'admin')
  if (!user) return

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Administrateur'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  await loadSynthese()
  hideLoader()
}

async function loadSynthese() {
  // Vue déjà créée dans 00_hardening_complet.sql
  const { data, error } = await supabase.from('v_synthese_mensuelle').select('*').limit(12)
  const tb = document.getElementById('synthese-table')

  if (error || !data?.length) {
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--gray);padding:24px">Aucune donnée disponible pour l'instant.</td></tr>`
    return
  }

  tb.innerHTML = data.map(row => `<tr>
    <td style="font-weight:600">${new Date(row.mois).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</td>
    <td>${row.courses_terminees}</td>
    <td style="font-weight:700;color:var(--green)">${formatPrice(row.ca_mensuel)}</td>
    <td>${(row.km_parcourus || 0).toFixed(1)} km</td>
  </tr>`).join('')
}

window.exportTable = async function(tableName, columns) {
  const { data, error } = await supabase.from(tableName).select(columns.join(',')).order('created_at', { ascending: false }).limit(1000)
  if (error) { showToast('Erreur lors de l\'export : ' + error.message, 'error'); return }
  if (!data?.length) { showToast('Aucune donnée à exporter.', 'warning'); return }

  const rows = [columns]
  data.forEach(row => rows.push(columns.map(c => row[c] ?? '')))
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${tableName}_locreaction_${new Date().toISOString().slice(0,10)}.csv`
  link.click()
  showToast('Export téléchargé !', 'success')
}

init()
