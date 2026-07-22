// ============================================================
// LOC RÉACTION S.A.S — shared/nav.js
// Menu hamburger partagé — réutilisé sur les pages publiques
// ============================================================

export function initHamburger(toggleId, menuId) {
  const toggle = document.getElementById(toggleId)
  const menu = document.getElementById(menuId)
  if (!toggle || !menu) return

  const backdrop = document.querySelector('.menu-backdrop')

  function closeMenu() {
    menu.classList.remove('open')
    toggle.classList.remove('active')
    toggle.setAttribute('aria-expanded', 'false')
    document.body.style.overflow = ''
  }

  toggle.addEventListener('click', () => {
    const isOpen = menu.classList.toggle('open')
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    toggle.classList.toggle('active', isOpen)
    document.body.style.overflow = isOpen ? 'hidden' : ''
  })

  // Ferme le menu si on clique sur le fond assombri
  if (backdrop) backdrop.addEventListener('click', closeMenu)

  // Ferme le menu si on clique sur un lien à l'intérieur
  menu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', closeMenu)
  })

  // Ferme le menu si la fenêtre est agrandie au-delà du breakpoint mobile
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900 && menu.classList.contains('open')) closeMenu()
  })
}
