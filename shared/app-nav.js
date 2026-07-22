// ============================================================
// LOC RÉACTION S.A.S — shared/app-nav.js
// Menu hamburger pour les espaces connectés (client/chauffeur/admin)
// Distinct de nav.js (qui gère les pages publiques)
// ============================================================

export function initAppHamburger() {
  const toggle = document.getElementById('app-hamburger-btn')
  const sidebar = document.getElementById('sidebar')
  if (!toggle || !sidebar) return

  // Crée le fond assombri (backdrop) une seule fois
  let backdrop = document.querySelector('.sidebar-backdrop')
  if (!backdrop) {
    backdrop = document.createElement('div')
    backdrop.className = 'sidebar-backdrop'
    document.body.appendChild(backdrop)
  }

  function closeSidebar() {
    sidebar.classList.remove('open')
    toggle.classList.remove('active')
    backdrop.classList.remove('show')
    document.body.style.overflow = ''
  }

  function openSidebar() {
    sidebar.classList.add('open')
    toggle.classList.add('active')
    backdrop.classList.add('show')
    document.body.style.overflow = 'hidden'
  }

  toggle.addEventListener('click', () => {
    if (sidebar.classList.contains('open')) closeSidebar()
    else openSidebar()
  })

  backdrop.addEventListener('click', closeSidebar)

  // Ferme le tiroir après avoir cliqué un lien du menu (mobile)
  sidebar.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => { if (window.innerWidth <= 860) closeSidebar() })
  })

  window.addEventListener('resize', () => {
    if (window.innerWidth > 860) closeSidebar()
  })
}
