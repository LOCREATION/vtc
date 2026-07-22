// depth = 2 (client/support/client-support.html)
import { requireAuth, logout, formatInitials, hideLoader, showToast } from '../../shared/supabase.js'
import { initAppHamburger } from '../../shared/app-nav.js'
import { getOrCreateSupportConversation, loadMessages, sendTextMessage, sendImageMessage, getImageUrl, markConversationRead, subscribeToConversation, formatMessageTime } from '../../shared/messaging.js'

initAppHamburger()
let currentUser = null
let conversation = null

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

  conversation = await getOrCreateSupportConversation(currentUser.id)

  const messages = await loadMessages(conversation.id)
  const box = document.getElementById('chat-messages')
  if (!messages.length) {
    box.innerHTML = `<div class="chat-empty"><i class="fas fa-headset"></i><div>Posez votre question à l'équipe LOC RÉACTION — disponibilité, tarif, réclamation…</div></div>`
  } else {
    for (const m of messages) await appendMessage(m, false)
    box.scrollTop = box.scrollHeight
  }
  await markConversationRead(conversation.id, currentUser.id)

  subscribeToConversation(conversation.id, (msg) => {
    appendMessage(msg)
    if (msg.sender_id !== currentUser.id) markConversationRead(conversation.id, currentUser.id)
  })

  hideLoader()
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
  if (!text || !conversation) return
  input.value = ''
  await sendTextMessage(conversation.id, currentUser.id, text)
}

window.sendChatImage = async function(file) {
  if (!file || !conversation) return
  showToast('Envoi de la photo…', 'info')
  await sendImageMessage(conversation.id, currentUser.id, file)
}

init()
