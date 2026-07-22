// depth = 2 (admin/messagerie/admin-messagerie.html)
import { supabase, requireAuth, logout, formatInitials, showToast, hideLoader } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'
import { loadMessages, sendTextMessage, sendImageMessage, getImageUrl, markConversationRead, subscribeToConversation, formatMessageTime } from '../../shared/messaging.js'

initAppHamburger()

let currentUser = null
let allConversations = []
let currentFilter = 'support'
let activeConversation = null
let activeChannel = null

async function init() {
  const user = await requireAuth(2, 'admin')
  if (!user) return
  currentUser = user

  document.getElementById('nav-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('nav-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('nav-rl').textContent = 'Administrateur'
  document.getElementById('sb-av').textContent = formatInitials(user.prenom, user.nom)
  document.getElementById('sb-nm').textContent = user.prenom + ' ' + user.nom
  document.getElementById('logout-btn').onclick = () => logout(2)
  document.getElementById('logout-link').onclick = (e) => { e.preventDefault(); logout(2) }

  await loadConversations()

  // Écoute en direct les nouvelles conversations de support
  supabase.channel('admin-conv-watch')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, () => loadConversations())
    .subscribe()

  hideLoader()
}

async function loadConversations() {
  const { data } = await supabase
    .from('conversations')
    .select('*, client:client_id(prenom, nom), chauffeur:chauffeur_id(prenom, nom)')
    .order('last_message_at', { ascending: false })

  allConversations = data || []
  document.getElementById('sb-st').innerHTML = `<div class="sidebar-stat"><div class="val">${allConversations.length}</div><div class="lbl">Conversations</div></div>`
  renderConvList()
}

function renderConvList() {
  const filtered = allConversations.filter(c => c.type === currentFilter)
  const list = document.getElementById('conv-list'), empty = document.getElementById('conv-empty')

  if (!filtered.length) { list.innerHTML = ''; empty.style.display = 'block'; return }
  empty.style.display = 'none'

  list.innerHTML = filtered.map(c => {
    const name = currentFilter === 'support'
      ? `${c.client?.prenom || '—'} ${c.client?.nom || ''}`
      : `${c.client?.prenom || '—'} ↔ ${c.chauffeur?.prenom || 'en attente'}`
    const active = activeConversation?.id === c.id ? 'active' : ''
    return `<div class="chat-conv-item ${active}" data-id="${c.id}" onclick="openConversation('${c.id}')">
      <div class="nav-avatar">${(c.client?.prenom || '?')[0]}</div>
      <div style="flex:1;overflow:hidden">
        <div class="chat-conv-name">${name}</div>
        <div class="chat-conv-preview">${c.statut === 'ouverte' ? 'Conversation active' : 'Fermée'}</div>
      </div>
    </div>`
  }).join('')
}

window.setFilter = function(filter, el) {
  currentFilter = filter
  document.querySelectorAll('.tabs .tab-btn').forEach(b => b.classList.remove('active'))
  el.classList.add('active')
  renderConvList()
}

window.openConversation = async function(id) {
  activeConversation = allConversations.find(c => c.id === id)
  if (!activeConversation) return

  document.querySelectorAll('.chat-conv-item').forEach(el => el.classList.toggle('active', el.dataset.id === id))
  document.getElementById('no-conv-selected').style.display = 'none'
  document.getElementById('chat-panel').style.display = 'flex'

  const name = activeConversation.type === 'support'
    ? `${activeConversation.client?.prenom || ''} ${activeConversation.client?.nom || ''}`
    : `${activeConversation.client?.prenom || ''} ↔ ${activeConversation.chauffeur?.prenom || 'en attente'}`
  document.getElementById('chat-other-name').textContent = name
  document.getElementById('chat-other-av').textContent = (activeConversation.client?.prenom || '?')[0]
  document.getElementById('chat-other-status').textContent = activeConversation.type === 'support' ? 'Conversation support' : 'Conversation liée à une course'

  const messages = await loadMessages(id)
  const box = document.getElementById('chat-messages')
  box.innerHTML = ''
  if (!messages.length) {
    box.innerHTML = `<div class="chat-empty"><i class="fas fa-comment-dots"></i><div>Aucun message pour l'instant</div></div>`
  } else {
    for (const m of messages) await appendMessage(m, false)
    box.scrollTop = box.scrollHeight
  }
  await markConversationRead(id, currentUser.id)

  if (activeChannel) supabase.removeChannel(activeChannel)
  activeChannel = subscribeToConversation(id, (msg) => {
    appendMessage(msg)
    if (msg.sender_id !== currentUser.id) markConversationRead(id, currentUser.id)
  })
}

async function appendMessage(msg, scroll = true) {
  const box = document.getElementById('chat-messages')
  if (box.querySelector('.chat-empty')) box.innerHTML = ''

  const mine = msg.sender_id === currentUser.id
  const bubble = document.createElement('div')
  bubble.className = `chat-bubble ${mine ? 'mine' : 'theirs'}`

  let inner = ''
  if (msg.contenu) inner += `<div>${msg.contenu.replace(/</g, '&lt;')}</div>`
  if (msg.image_url) {
    const url = await getImageUrl(msg.image_url)
    if (url) inner += `<img src="${url}" alt="photo" onclick="window.open('${url}','_blank')">`
  }
  inner += `<span class="chat-bubble-time">${formatMessageTime(msg.created_at)}</span>`
  bubble.innerHTML = inner

  box.appendChild(bubble)
  if (scroll) box.scrollTop = box.scrollHeight
}

window.sendChatText = async function() {
  const input = document.getElementById('chat-input')
  const text = input.value.trim()
  if (!text || !activeConversation) return
  input.value = ''
  await sendTextMessage(activeConversation.id, currentUser.id, text)
}

window.sendChatImage = async function(file) {
  if (!file || !activeConversation) return
  showToast('Envoi de la photo…', 'info')
  await sendImageMessage(activeConversation.id, currentUser.id, file)
}

init()
