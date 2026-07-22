// ============================================================
// LOC RÉACTION S.A.S — devis.js
// ============================================================
import { getCurrentUser, redirectToDashboard, supabase } from './shared/supabase.js'
import { initLangSwitcher, t } from './shared/i18n.js'
import { initHamburger } from './shared/nav.js'

initLangSwitcher('lang-select-desktop', 'devis', 0)
initLangSwitcher('lang-select-mobile', 'devis', 0)
initHamburger('hamburger-btn', 'mobile-menu')

async function checkAuth() {
  const user = await getCurrentUser()
  if (!user) return
  document.querySelectorAll('.nav-cta-login').forEach(el => {
    el.textContent = t('nav_my_space')
    el.onclick = (e) => { e.preventDefault(); redirectToDashboard(user.role, 0) }
  })
}
checkAuth()

// Pré-sélection du service depuis l'URL (?type=vtc, ?type=btp, etc.)
const params = new URLSearchParams(location.search)
if (params.get('type')) {
  const sel = document.getElementById('d-service')
  if (sel) sel.value = params.get('type')
}

window.sendDevis = async function() {
  const service_type = document.getElementById('d-service').value
  const nom = document.getElementById('d-nom').value.trim()
  const email = document.getElementById('d-email').value.trim()
  const telephone = document.getElementById('d-tel').value.trim()
  const date_souhaitee = document.getElementById('d-date').value || null
  const adresse = document.getElementById('d-adresse').value.trim()
  const description = document.getElementById('d-description').value.trim()
  const alertEl = document.getElementById('devis-alert')
  alertEl.className = 'form-alert'

  if (!nom || !email || !description) {
    alertEl.textContent = t('error_required')
    alertEl.classList.add('show-error')
    return
  }

  const user = await getCurrentUser()

  const { error } = await supabase.from('service_requests').insert({
    client_id: user ? user.id : null,
    service_type, nom, email, telephone: telephone || null,
    adresse: adresse || null, date_souhaitee, description, statut: 'en_attente'
  })

  if (error) {
    alertEl.textContent = 'Erreur : ' + error.message
    alertEl.classList.add('show-error')
    return
  }

  alertEl.textContent = t('success')
  alertEl.classList.add('show-success')
  document.getElementById('d-nom').value = ''
  document.getElementById('d-email').value = ''
  document.getElementById('d-tel').value = ''
  document.getElementById('d-adresse').value = ''
  document.getElementById('d-description').value = ''
}

