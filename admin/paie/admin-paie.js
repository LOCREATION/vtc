// depth = 1 (admin/payroll.html)
import { supabase, requireAuth, logout, formatPrice, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let currentPayslipForPdf = null

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

  document.getElementById('payroll-month').value = new Date().toISOString().slice(0, 7)
  await loadPayslips()
  hideLoader()
}

async function loadPayslips() {
  const { data } = await supabase.from('payslips').select('*, employee:employee_id(prenom, nom, tel)').order('created_at', { ascending: false })
  const payslips = data || []
  const tb = document.getElementById('payslips-table'), em = document.getElementById('payslips-empty')
  if (!payslips.length) { tb.innerHTML = ''; em.style.display = 'block'; return }
  em.style.display = 'none'
  tb.innerHTML = payslips.map(p => `<tr>
    <td style="font-weight:600">${p.employee?.prenom || '—'} ${p.employee?.nom || ''}</td>
    <td>${p.mois ? new Date(p.mois).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : '—'}</td>
    <td><span class="badge ${p.type === 'vtc' ? 'badge-primary' : 'badge-gold'}">${p.type === 'vtc' ? 'VTC' : 'Gérance'}</span></td>
    <td>${formatPrice(p.salaire_brut)}</td><td style="font-weight:700;color:var(--green)">${formatPrice(p.salaire_net)}</td>
    <td style="color:var(--red)">${formatPrice(p.charges_patronales)}</td><td style="font-weight:700">${formatPrice(p.cout_employeur)}</td>
    <td><span class="badge ${p.paid_at ? 'badge-success' : 'badge-gray'}">${p.paid_at ? 'Payé' : 'En attente'}</span></td>
    <td style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="previewPayslip('${p.id}')"><i class="fas fa-eye"></i></button>${!p.paid_at ? `<button class="btn btn-success btn-sm" onclick="markPaid('${p.id}')"><i class="fas fa-check"></i></button>` : ''}</td>
  </tr>`).join('')
}

window.generatePayslips = async function() {
  const month = document.getElementById('payroll-month').value
  if (!month) { showToast('Sélectionnez un mois.', 'warning'); return }

  const btn = document.getElementById('btn-generate')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Génération…'

  const { data: employees } = await supabase.from('employees').select('*, profile:profile_id(prenom, nom, tel)').eq('actif', true)
  if (!employees?.length) { showToast('Aucun employé actif.', 'warning'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-calculator"></i>Générer'; return }

  const { data: existing } = await supabase.from('payslips').select('employee_id, type').eq('mois', month + '-01')
  const existingKeys = new Set((existing || []).map(p => p.employee_id + '_' + p.type))
  let created = 0

  for (const emp of employees) {
    if (emp.statut_vtc && !existingKeys.has(emp.profile_id + '_vtc')) {
      const net = emp.salaire_net_base, brut = +(net / 0.77).toFixed(2)
      const cotSal = +(brut - net).toFixed(2), chargesPat = +(net * 0.45).toFixed(2), coutTotal = +(net + chargesPat).toFixed(2)
      const { data: p } = await supabase.from('payslips').insert({ employee_id: emp.profile_id, mois: month + '-01', type: 'vtc', salaire_brut: brut, cotisations_salariales: cotSal, salaire_net: net, charges_patronales: chargesPat, cout_employeur: coutTotal }).select().single()
      if (p) { await supabase.from('accounting_entries').insert({ date: new Date().toISOString().slice(0, 10), type: 'salaire', categorie: 'Salaires VTC', montant: coutTotal, description: `Salaire VTC ${emp.profile?.prenom} ${emp.profile?.nom} — ${month}`, payslip_id: p.id }); created++ }
    }
    if (emp.statut_gerance && !existingKeys.has(emp.profile_id + '_gerance')) {
      const netG = 1500.00, brutG = +(netG / 0.77).toFixed(2)
      const cotSalG = +(brutG - netG).toFixed(2), chargesPatG = +(netG * 0.30).toFixed(2), coutTotalG = +(netG + chargesPatG).toFixed(2)
      const { data: pG } = await supabase.from('payslips').insert({ employee_id: emp.profile_id, mois: month + '-01', type: 'gerance', salaire_brut: brutG, cotisations_salariales: cotSalG, salaire_net: netG, charges_patronales: chargesPatG, cout_employeur: coutTotalG }).select().single()
      if (pG) { await supabase.from('accounting_entries').insert({ date: new Date().toISOString().slice(0, 10), type: 'salaire', categorie: 'Salaires Gérance', montant: coutTotalG, description: `Salaire Gérance ${emp.profile?.prenom} ${emp.profile?.nom} — ${month}`, payslip_id: pG.id }); created++ }
    }
  }

  btn.disabled = false; btn.innerHTML = '<i class="fas fa-calculator"></i>Générer'
  showToast(created === 0 ? 'Fiches déjà générées pour ce mois.' : `${created} fiche(s) générée(s) !`, created === 0 ? 'info' : 'success')
  await loadPayslips()
}

window.previewPayslip = async function(id) {
  const { data: p } = await supabase.from('payslips').select('*, employee:employee_id(prenom, nom, tel)').eq('id', id).single()
  if (!p) return
  currentPayslipForPdf = p
  const moisLabel = new Date(p.mois).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
  document.getElementById('payslip-preview').innerHTML = `
    <div style="font-size:.84rem;border:1px solid var(--gray-light);border-radius:var(--radius);padding:20px">
      <div style="text-align:center;padding-bottom:14px;border-bottom:2px solid var(--primary);margin-bottom:14px">
        <div style="font-size:1.1rem;font-weight:800;color:var(--primary)">LOC RÉACTION S.A.S</div>
        <div style="font-size:.75rem;color:var(--gray)">Île-de-France, 95270</div>
        <div style="font-weight:700;margin-top:8px">BULLETIN DE PAIE — ${moisLabel.toUpperCase()}</div>
        <div style="font-size:.8rem">Type : ${p.type === 'vtc' ? 'Chauffeur VTC' : 'Gérance'}</div>
      </div>
      <div style="margin-bottom:14px"><strong>Salarié :</strong> ${p.employee?.prenom || ''} ${p.employee?.nom || ''}<br><strong>Téléphone :</strong> ${p.employee?.tel || '—'}</div>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <tr style="background:var(--primary);color:#fff"><th style="padding:7px;text-align:left">Élément</th><th style="padding:7px;text-align:right">Montant</th></tr>
        <tr style="background:var(--gray-xlight)"><td style="padding:7px">Salaire brut</td><td style="padding:7px;text-align:right;font-weight:700">${formatPrice(p.salaire_brut)}</td></tr>
        <tr><td style="padding:7px">Cotisations salariales</td><td style="padding:7px;text-align:right;color:var(--red)">-${formatPrice(p.cotisations_salariales)}</td></tr>
        <tr style="background:var(--green-light)"><td style="padding:7px;font-weight:700">NET À PAYER</td><td style="padding:7px;text-align:right;font-weight:700;color:var(--green)">${formatPrice(p.salaire_net)}</td></tr>
        <tr style="background:var(--gray-xlight)"><td style="padding:7px">Charges patronales</td><td style="padding:7px;text-align:right;color:var(--red)">${formatPrice(p.charges_patronales)}</td></tr>
        <tr style="background:rgba(255,224,178,.4)"><td style="padding:7px;font-weight:700">COÛT TOTAL EMPLOYEUR</td><td style="padding:7px;text-align:right;font-weight:700">${formatPrice(p.cout_employeur)}</td></tr>
      </table>
    </div>`
  document.getElementById('payslip-modal').classList.add('open')
}

window.downloadPdf = async function() {
  if (!currentPayslipForPdf) return
  const p = currentPayslipForPdf
  const { jsPDF } = window.jspdf
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const moisLabel = new Date(p.mois).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

  doc.setFontSize(16); doc.setFont(undefined, 'bold'); doc.text("LOC RÉACTION S.A.S", 105, 20, { align: 'center' })
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.text('Île-de-France, 95270', 105, 26, { align: 'center' })
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.text(`BULLETIN DE PAIE — ${moisLabel.toUpperCase()}`, 105, 38, { align: 'center' })
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.text(`Type : ${p.type === 'vtc' ? 'Chauffeur VTC' : 'Gérance'}`, 105, 44, { align: 'center' })
  doc.text(`Salarié : ${p.employee?.prenom || ''} ${p.employee?.nom || ''}`, 20, 58)
  doc.text(`Téléphone : ${p.employee?.tel || '—'}`, 20, 64)

  let y = 78
  const rows = [['Salaire brut', formatPrice(p.salaire_brut)], ['Cotisations salariales', '-' + formatPrice(p.cotisations_salariales)], ['NET À PAYER', formatPrice(p.salaire_net)], ['Charges patronales', formatPrice(p.charges_patronales)], ['COÛT TOTAL EMPLOYEUR', formatPrice(p.cout_employeur)]]
  rows.forEach(([label, val], i) => {
    doc.setFont(undefined, (i === 2 || i === 4) ? 'bold' : 'normal')
    doc.text(label, 22, y); doc.text(val, 188, y, { align: 'right' }); doc.line(20, y + 2, 190, y + 2); y += 9
  })
  doc.setFontSize(8); doc.setTextColor(120); doc.text(`Document généré le ${new Date().toLocaleDateString('fr-FR')}`, 105, 280, { align: 'center' })

  const pdfBlob = doc.output('blob')
  const storagePath = `${p.employee_id}/${p.id}.pdf`
  const { error: uploadError } = await supabase.storage.from('payslips').upload(storagePath, pdfBlob, { contentType: 'application/pdf', upsert: true })
  if (!uploadError) await supabase.from('payslips').update({ pdf_url: storagePath }).eq('id', p.id)

  doc.save(`bulletin_${p.type}_${p.mois}.pdf`)
}

window.markPaid = async function(id) {
  await supabase.from('payslips').update({ paid_at: new Date().toISOString(), sent_at: new Date().toISOString() }).eq('id', id)
  showToast('Fiche marquée payée !', 'success')
  await loadPayslips()
}

init()
