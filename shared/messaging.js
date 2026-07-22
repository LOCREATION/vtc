// ============================================================
// LOC RÉACTION S.A.S — shared/messaging.js
// Module de messagerie temps réel réutilisable : client ↔ chauffeur
// (liée à une course) et client ↔ admin (support, négociation)
// ============================================================
import { supabase } from './supabase.js'

// Récupère la conversation liée à une course, ou la crée si elle n'existe pas encore
export async function getOrCreateRideConversation(rideId, clientId, chauffeurId) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('ride_id', rideId)
    .eq('type', 'ride')
    .maybeSingle()

  if (existing) return existing

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({ type: 'ride', ride_id: rideId, client_id: clientId, chauffeur_id: chauffeurId })
    .select()
    .single()

  if (error) throw error
  return created
}

// Récupère (ou crée) la conversation de support d'un client avec l'administration
export async function getOrCreateSupportConversation(clientId) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('client_id', clientId)
    .eq('type', 'support')
    .eq('statut', 'ouverte')
    .maybeSingle()

  if (existing) return existing

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({ type: 'support', client_id: clientId })
    .select()
    .single()

  if (error) throw error
  return created
}

// Charge l'historique des messages d'une conversation
export async function loadMessages(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*, sender:sender_id(prenom, nom, role)')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) throw error
  return data || []
}

// Envoie un message texte
export async function sendTextMessage(conversationId, senderId, contenu) {
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, contenu })
  if (error) throw error
}

// Envoie une photo : upload réel vers Supabase Storage, puis enregistre le message
export async function sendImageMessage(conversationId, senderId, file) {
  const ext = file.name.split('.').pop()
  const path = `${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const { error: uploadError } = await supabase.storage.from('chat-images').upload(path, file)
  if (uploadError) throw uploadError

  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, image_url: path })
  if (error) throw error
}

// Récupère une URL signée temporaire pour afficher une photo (bucket privé)
export async function getImageUrl(path) {
  const { data, error } = await supabase.storage.from('chat-images').createSignedUrl(path, 3600)
  if (error) return null
  return data.signedUrl
}

// Marque tous les messages d'une conversation comme lus (sauf les siens)
export async function markConversationRead(conversationId, myUserId) {
  await supabase
    .from('messages')
    .update({ lu: true })
    .eq('conversation_id', conversationId)
    .neq('sender_id', myUserId)
    .eq('lu', false)
}

// S'abonne en temps réel aux nouveaux messages d'une conversation
export function subscribeToConversation(conversationId, onNewMessage) {
  const channel = supabase
    .channel(`conv-${conversationId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, (payload) => {
      onNewMessage(payload.new)
    })
    .subscribe()
  return channel
}

export function unsubscribe(channel) {
  if (channel) supabase.removeChannel(channel)
}

// Compte les messages non lus d'un utilisateur, toutes conversations confondues
export async function countUnreadMessages(userId) {
  const { data: convs } = await supabase
    .from('conversations')
    .select('id')
    .or(`client_id.eq.${userId},chauffeur_id.eq.${userId}`)

  if (!convs || !convs.length) return 0

  const ids = convs.map(c => c.id)
  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)
    .neq('sender_id', userId)
    .eq('lu', false)

  return count || 0
}

// Formate l'heure d'un message (HH:MM)
export function formatMessageTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}
