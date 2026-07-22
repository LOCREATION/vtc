// ============================================================
// LOC RÉACTION S.A.S — index.js
// Logique propre à la page d'accueil
// ============================================================
import { getCurrentUser, redirectToDashboard } from './shared/supabase.js'
import { initLangSwitcher, t } from './shared/i18n.js'
import { initHamburger } from './shared/nav.js'

// depth = 0 : index.html est à la racine
initLangSwitcher('lang-select-desktop', 'index', 0)
initLangSwitcher('lang-select-mobile', 'index', 0)
initHamburger('hamburger-btn', 'mobile-menu')

// Adapter le bouton "Connexion" si une session Supabase réelle existe déjà
async function checkAuth() {
  const user = await getCurrentUser()
  if (!user) return
  const ctas = document.querySelectorAll('.nav-cta-login')
  ctas.forEach(el => {
    el.textContent = t('nav_my_space')
    el.onclick = (e) => { e.preventDefault(); redirectToDashboard(user.role, 0) }
  })
}
checkAuth()

// Widget de réservation en page d'accueil → redirige vers la connexion
// avec les champs pré-remplis, comme le reste du site le fait déjà
window.goBook = function() {
  const d = document.getElementById('bw-depart').value.trim()
  const a = document.getElementById('bw-arrivee').value.trim()
  const params = new URLSearchParams()
  if (d) params.set('depart', d)
  if (a) params.set('arrivee', a)
  window.location.href = `auth/login/login.html?role=client&redirect=booking&${params.toString()}`
}
