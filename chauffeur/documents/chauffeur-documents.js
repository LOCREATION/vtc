// depth = 1 (driver/documents.html)
import { supabase, requireAuth, logout, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let currentUser = null

const DOC_FIELDS = {
  carte: { urlCol: 'carte_vtc_url', expCol: 'carte_vtc_expiration' },
  assurance: { urlCol: 'assurance_url', expCol: 'assurance_expiration' },
  grise: { urlCol: 'carte_grise_url', expCol: null }
}

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

  renderStatus(user)
  document.getElementById('carte-numero').value = user.carte_vtc_numero || ''
  document.getElementById('carte-expiration').value = user.carte_vtc_expiration || ''
  document.getElementById('assurance-expiration').value = user.assurance_expiration || ''

  if (user.carte_vtc_url) document.getElementById('carte-current').textContent = '✓ Document déjà envoyé'
  if (user.assurance_url) document.getElementById('assurance-current').textContent = '✓ Document déjà envoyé'
  if (user.carte_grise_url) document.getElementById('grise-current').textContent = '✓ Document déjà envoyé'

  hideLoader()
}

function renderStatus(user) {
  const icon = document.getElementById('verif-icon')
  const title = document.getElementById('verif-title')
  const text = document.getElementById('verif-text')
  if (user.documents_verifies) {
    icon.style.color = 'var(--success)'
    icon.innerHTML = '<i class="fas fa-check-circle"></i>'
    title.textContent = 'Documents vérifiés'
    text.textContent = 'Votre dossier est complet et validé par l\'administration.'
  } else {
    icon.style.color = 'var(--warning)'
    icon.innerHTML = '<i class="fas fa-clock"></i>'
    title.textContent = 'Documents en attente de vérification'
    text.textContent = 'L\'administration vérifie vos documents avant activation complète.'
  }
}

window.uploadDoc = async function(type) {
  const fileInput = document.getElementById(`${type}-file`)
  const file = fileInput.files[0]
  if (!file) { showToast('Sélectionnez un fichier.', 'warning'); return }

  const { urlCol, expCol } = DOC_FIELDS[type]
  const path = `${currentUser.id}/${type}-${Date.now()}.${file.name.split('.').pop()}`

  const { error: uploadError } = await supabase.storage.from('driver-documents').upload(path, file)
  if (uploadError) { showToast('Erreur d\'envoi : ' + uploadError.message, 'error'); return }

  const updatePayload = { [urlCol]: path }
  if (type === 'carte') updatePayload.carte_vtc_numero = document.getElementById('carte-numero').value
  if (expCol) {
    const expInput = document.getElementById(`${type}-expiration`)
    if (expInput?.value) updatePayload[expCol] = expInput.value
  }
  // Nouvel envoi remet le statut en attente de vérification
  updatePayload.documents_verifies = false

  const { error } = await supabase.from('profiles').update(updatePayload).eq('id', currentUser.id)
  if (error) { showToast('Erreur : ' + error.message, 'error'); return }

  document.getElementById(`${type}-current`).textContent = '✓ Document envoyé — en attente de vérification'
  showToast('Document envoyé avec succès !', 'success')
  renderStatus({ documents_verifies: false })
}

init()
