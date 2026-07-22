// depth = 1 (admin/tariffs.html)
import { supabase, requireAuth, logout, formatPrice, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let allTariffs = []

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

  await loadTariffs()
  hideLoader()
}

async function loadTariffs() {
  const { data } = await supabase.from('tariffs').select('*').order('updated_at', { ascending: false })
  allTariffs = data || []
  renderTable()
}

function renderTable() {
  document.getElementById('tariffs-table').innerHTML = allTariffs.map(t => `<tr>
    <td style="font-weight:600">${t.zone}</td>
    <td>${formatPrice(t.prix_base)}</td>
    <td>${formatPrice(t.prix_km)}</td>
    <td>${formatPrice(t.prix_min)}</td>
    <td>×${t.surcharge_nuit}</td>
    <td>×${t.surcharge_pointe}</td>
    <td><span class="badge ${t.actif ? 'badge-success' : 'badge-gray'}">${t.actif ? 'Actif' : 'Inactif'}</span></td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-outline-gray btn-sm" onclick="editTariff('${t.id}')" title="Modifier"><i class="fas fa-edit"></i></button>
      <button class="btn btn-danger btn-sm" onclick="deleteTariff('${t.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('')
}

window.openAdd = function() {
  document.getElementById('tariff-modal-title').textContent = 'Nouvelle zone tarifaire'
  document.getElementById('t-id').value = ''
  document.getElementById('t-zone').value = ''
  document.getElementById('t-base').value = 3.50
  document.getElementById('t-km').value = 1.70
  document.getElementById('t-min').value = 0.45
  document.getElementById('t-nuit').value = 1.30
  document.getElementById('t-pointe').value = 1.50
  document.getElementById('t-actif').value = 'true'
  document.getElementById('tariff-modal').classList.add('open')
}

window.editTariff = function(id) {
  const t = allTariffs.find(x => x.id === id)
  if (!t) return
  document.getElementById('tariff-modal-title').textContent = 'Modifier la zone tarifaire'
  document.getElementById('t-id').value = t.id
  document.getElementById('t-zone').value = t.zone
  document.getElementById('t-base').value = t.prix_base
  document.getElementById('t-km').value = t.prix_km
  document.getElementById('t-min').value = t.prix_min
  document.getElementById('t-nuit').value = t.surcharge_nuit
  document.getElementById('t-pointe').value = t.surcharge_pointe
  document.getElementById('t-actif').value = String(t.actif)
  document.getElementById('tariff-modal').classList.add('open')
}

window.saveTariff = async function() {
  const id = document.getElementById('t-id').value
  const payload = {
    zone: document.getElementById('t-zone').value.trim(),
    prix_base: parseFloat(document.getElementById('t-base').value),
    prix_km: parseFloat(document.getElementById('t-km').value),
    prix_min: parseFloat(document.getElementById('t-min').value),
    surcharge_nuit: parseFloat(document.getElementById('t-nuit').value),
    surcharge_pointe: parseFloat(document.getElementById('t-pointe').value),
    actif: document.getElementById('t-actif').value === 'true',
    updated_at: new Date().toISOString()
  }

  if (!payload.zone) { showToast('Le nom de la zone est obligatoire.', 'warning'); return }

  const { error } = id ? await supabase.from('tariffs').update(payload).eq('id', id) : await supabase.from('tariffs').insert(payload)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }

  showToast('Tarif enregistré !', 'success')
  document.getElementById('tariff-modal').classList.remove('open')
  await loadTariffs()
}

window.deleteTariff = async function(id) {
  if (!confirm('Supprimer définitivement cette zone tarifaire ?')) return
  const { error } = await supabase.from('tariffs').delete().eq('id', id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }
  showToast('Zone tarifaire supprimée.', 'warning')
  await loadTariffs()
}

init()
