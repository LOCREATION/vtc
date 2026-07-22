// depth = 1 (admin/accounting.html)
import { supabase, requireAuth, logout, formatPrice, formatDate, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allEntries = []

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

  await loadAll()
  hideLoader()
}

async function loadAll() {
  const month = new Date().toISOString().slice(0, 7)
  const [ridesRes, payslipsRes, entriesRes, allRidesRes] = await Promise.all([
    supabase.from('rides').select('prix').eq('statut', 'termine').gte('created_at', month + '-01'),
    supabase.from('payslips').select('cout_employeur, mois').gte('mois', month + '-01').lte('mois', month + '-31'),
    supabase.from('accounting_entries').select('*').order('date', { ascending: false }),
    supabase.from('rides').select('prix').eq('statut', 'termine')
  ])

  allEntries = entriesRes.data || []
  const ca = (ridesRes.data || []).reduce((s, r) => s + (r.prix || 0), 0)
  const sal = (payslipsRes.data || []).reduce((s, p) => s + (p.cout_employeur || 0), 0)
  const chg = allEntries.filter(e => e.type === 'depense' && e.date?.startsWith(month)).reduce((s, e) => s + (e.montant || 0), 0)

  document.getElementById('acc-ca').textContent = formatPrice(ca)
  document.getElementById('acc-chg').textContent = formatPrice(chg)
  document.getElementById('acc-sal').textContent = formatPrice(sal)
  document.getElementById('acc-ben').textContent = formatPrice(ca - chg - sal)

  const caTotal = (allRidesRes.data || []).reduce((s, r) => s + (r.prix || 0), 0)
  const chgTotal = allEntries.filter(e => e.type === 'depense').reduce((s, e) => s + (e.montant || 0), 0)
  const { data: allPayslips } = await supabase.from('payslips').select('cout_employeur')
  const salTotal = (allPayslips || []).reduce((s, p) => s + (p.cout_employeur || 0), 0)
  document.getElementById('acc-treso').textContent = formatPrice(caTotal - chgTotal - salTotal)

  await renderChart()
  renderEntries(allEntries)
}

async function renderChart() {
  const months = []
  for (let i = 5; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); months.push(d.toISOString().slice(0, 7)) }
  const labels = months.map(m => new Date(m + '-01').toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }))
  const caData = await Promise.all(months.map(async m => {
    const next = new Date(m + '-01'); next.setMonth(next.getMonth() + 1)
    const { data } = await supabase.from('rides').select('prix').eq('statut', 'termine').gte('created_at', m + '-01').lt('created_at', next.toISOString().slice(0, 10))
    return (data || []).reduce((s, r) => s + (r.prix || 0), 0)
  }))
  const chgData = months.map(m => allEntries.filter(e => e.type === 'depense' && e.date?.startsWith(m)).reduce((s, e) => s + (e.montant || 0), 0))
  const benData = caData.map((c, i) => c - chgData[i])

  new Chart(document.getElementById('accChart'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'CA', data: caData, backgroundColor: 'rgba(10,26,56,.85)', borderRadius: 6 },
      { label: 'Charges', data: chgData, backgroundColor: 'rgba(192,57,43,.75)', borderRadius: 6 },
      { label: 'Bénéfice', data: benData, backgroundColor: 'rgba(39,174,96,.75)', borderRadius: 6 }
    ]},
    options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
  })
}

function renderEntries(entries) {
  const tb = document.getElementById('entries-table'), em = document.getElementById('e-empty')
  if (!entries.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  const typeColors = { recette: 'badge-success', depense: 'badge-danger', investissement: 'badge-warning', salaire: 'badge-primary' }
  tb.innerHTML = entries.map(e => `<tr>
    <td>${formatDate(e.date)}</td><td><span class="badge ${typeColors[e.type] || 'badge-gray'}">${e.type}</span></td>
    <td>${e.categorie}</td><td>${e.description || '—'}</td>
    <td style="font-weight:700;color:${e.type === 'recette' ? 'var(--green)' : 'var(--red)'}">${e.type === 'recette' ? '+' : '-'}${formatPrice(e.montant || 0)}</td>
    <td><button class="btn btn-outline-gray btn-sm" onclick="deleteEntry('${e.id}')"><i class="fas fa-trash"></i></button></td>
  </tr>`).join('')
}

window.filterEntries = function(f, el) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); el.classList.add('active')
  renderEntries(f === 'tous' ? allEntries : allEntries.filter(e => e.type === f))
}

window.openAdd = function() { document.getElementById('e-date').value = new Date().toISOString().slice(0, 10); document.getElementById('entry-modal').classList.add('open') }

window.saveEntry = async function() {
  const date = document.getElementById('e-date').value, type = document.getElementById('e-type').value
  const categorie = document.getElementById('e-cat').value.trim(), montant = parseFloat(document.getElementById('e-montant').value)
  const description = document.getElementById('e-desc').value.trim()
  if (!date || !categorie || isNaN(montant) || montant <= 0) { showToast('Champs invalides.', 'warning'); return }

  const { error } = await supabase.from('accounting_entries').insert({ date, type, categorie, montant, description })
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Écriture ajoutée !', 'success')
  document.getElementById('entry-modal').classList.remove('open')
  document.getElementById('e-cat').value = ''; document.getElementById('e-montant').value = ''; document.getElementById('e-desc').value = ''
  await loadAll()
}

window.deleteEntry = async function(id) {
  if (!confirm('Supprimer cette écriture ?')) return
  await supabase.from('accounting_entries').delete().eq('id', id)
  showToast('Écriture supprimée.', 'warning')
  await loadAll()
}

window.exportEntries = function() {
  const rows = [['Date', 'Type', 'Catégorie', 'Description', 'Montant']]
  allEntries.forEach(e => rows.push([e.date, e.type, e.categorie, e.description || '', e.montant]))
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'comptabilite_locreaction.csv'; link.click()
}

init()
