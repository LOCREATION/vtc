// depth = 1 (driver/support.html)
import { supabase, requireAuth, logout, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
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

  hideLoader()
}

window.sendSupport = async function() {
  const sujet = document.getElementById('s-sujet').value
  const message = document.getElementById('s-message').value.trim()
  const alertEl = document.getElementById('support-alert')
  alertEl.style.display = 'none'
  if (!message) { showToast('Merci de décrire votre problème.', 'warning'); return }

  const { error } = await supabase.from('contact_messages').insert({
    nom: currentUser.prenom + ' ' + currentUser.nom, email: currentUser.email,
    telephone: currentUser.tel || null, sujet: `[Support Chauffeur] ${sujet}`, message, user_id: currentUser.id
  })

  if (error) {
    alertEl.style.display = 'block'; alertEl.style.background = 'rgba(192,57,43,.08)'; alertEl.style.color = 'var(--red)'
    alertEl.textContent = 'Erreur : ' + error.message
    return
  }
  alertEl.style.display = 'block'; alertEl.style.background = 'rgba(26,107,58,.08)'; alertEl.style.color = 'var(--green)'
  alertEl.textContent = 'Message envoyé ! Notre équipe vous répondra rapidement.'
  document.getElementById('s-message').value = ''
}

init()
