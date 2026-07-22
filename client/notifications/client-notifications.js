// depth = 1 (client/notifications.html)
import { supabase, requireAuth, logout, formatDateTime, formatInitials, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'

initAppHamburger()
let currentUser = null

async function init() {
  const user = await requireAuth(2, 'client')
  if (!user) return
  currentUser = user

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Client'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  await loadNotifications()

  // Temps réel : nouvelle notification pendant que la page est ouverte
  supabase.channel(`notif-${user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, () => loadNotifications())
    .subscribe()

  hideLoader()
}

const ICONS = { success: ['fa-check-circle', 'var(--green)', 'var(--green-light)'], warning: ['fa-exclamation-triangle', 'var(--warning)', 'rgba(243,156,18,.12)'], error: ['fa-times-circle', 'var(--red)', 'var(--red-light)'], info: ['fa-info-circle', 'var(--primary)', 'var(--primary-xlight)'] }

async function loadNotifications() {
  const { data } = await supabase.from('notifications').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(50)
  const list = document.getElementById('notif-list'), empty = document.getElementById('notif-empty')
  const notifs = data || []

  const unreadCount = notifs.filter(n => !n.lu).length
  document.getElementById('sb-st').innerHTML = unreadCount ? `<div class="sidebar-stat"><div class="val">${unreadCount}</div><div class="lbl">Non lues</div></div>` : ''

  if (!notifs.length) { list.innerHTML = ''; empty.style.display = 'block'; return }
  empty.style.display = 'none'

  list.innerHTML = notifs.map(n => {
    const [icon, color, bg] = ICONS[n.type] || ICONS.info
    return `<div class="notif-item ${!n.lu ? 'unread' : ''}" onclick="openNotif('${n.id}', ${n.lien ? `'${n.lien}'` : 'null'})">
      <div class="notif-icon" style="background:${bg};color:${color}"><i class="fas ${icon}"></i></div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:.88rem">${n.titre}</div>
        <div style="font-size:.82rem;color:var(--gray);margin-top:2px">${n.message}</div>
        <div style="font-size:.72rem;color:var(--gray);margin-top:4px">${formatDateTime(n.created_at)}</div>
      </div>
      ${!n.lu ? '<div style="width:8px;height:8px;border-radius:50%;background:var(--primary);flex-shrink:0;margin-top:6px"></div>' : ''}
    </div>`
  }).join('')
}

window.openNotif = async function(id, lien) {
  await supabase.from('notifications').update({ lu: true }).eq('id', id)
  if (lien) window.location.href = lien
  else loadNotifications()
}

window.markAllRead = async function() {
  await supabase.from('notifications').update({ lu: true }).eq('user_id', currentUser.id).eq('lu', false)
  await loadNotifications()
}

init()
