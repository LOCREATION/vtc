// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Notifications de l'application (la cloche) : lecture, nombre de non lues,
// « lue », effacement, adresse du lien
// -----------------------------------------------------------------------------
// Les notifications sont écrites par la base : course attribuée, document
// validé, pourboire reçu, message reçu pendant une course (migration 22)…
// Chacun ne lit, ne marque « lue » et n'efface que les siennes (règle d'accès
// « notifications_les_miennes » de la base).
// Lien d'une notification : chemin du site (« /chauffeur/revenus/ »), rendu
// ici en adresse sous la racine de la v2 ; une adresse externe en https est
// acceptée (campagne de l'administration) ; tout autre lien est ignoré.
// Nombre de non lues : temps réel de Supabase, et relecture de secours toutes
// les 30 secondes (réseau mobile instable).
// =============================================================================
import { supabase } from './supabase.js';
import { RACINE } from './config.js';

const COLONNES = 'id, type, titre, message, lien, lu_le, cree_le';
export const MAXIMUM_NOTIFICATIONS = 100;
const RELECTURE_MS = 30000;

const maintenant = () => new Date().toISOString();

// Les plus récentes d'abord (100 au plus)
export async function lireNotifications(moi) {
  const { data, error } = await supabase.from('notifications').select(COLONNES)
    .eq('destinataire_id', moi).order('cree_le', { ascending: false }).limit(MAXIMUM_NOTIFICATIONS);
  if (error) throw error;
  return data || [];
}

export async function compterNonLues(moi) {
  const { data, error } = await supabase.from('notifications').select('id')
    .eq('destinataire_id', moi).is('lu_le', null).limit(MAXIMUM_NOTIFICATIONS);
  if (error) throw error;
  return (data || []).length;
}

export async function marquerLue(moi, id) {
  const { error } = await supabase.from('notifications').update({ lu_le: maintenant() })
    .eq('destinataire_id', moi).eq('id', id).is('lu_le', null);
  if (error) throw error;
}

export async function toutMarquerLu(moi) {
  const { error } = await supabase.from('notifications').update({ lu_le: maintenant() })
    .eq('destinataire_id', moi).is('lu_le', null);
  if (error) throw error;
}

// Les notifications déjà lues sont retirées ; les non lues restent
export async function effacerLues(moi) {
  const { error } = await supabase.from('notifications').delete()
    .eq('destinataire_id', moi).not('lu_le', 'is', null);
  if (error) throw error;
}

// Adresse à ouvrir pour le lien d'une notification (null : pas de lien)
export function adresseDuLien(lien) {
  if (typeof lien !== 'string') return null;
  const chemin = lien.trim();
  if (chemin.startsWith('/') && !chemin.startsWith('//')) return RACINE + chemin.slice(1);
  if (/^https:\/\//i.test(chemin)) return chemin;
  return null;
}

// Lien des notifications « Message de … » d'une conversation de course
// (fonction prive.notifier_message_course de la base)
export function lienConversation(role, courseId) {
  return role === 'chauffeur' ? `/chauffeur/course/?id=${courseId}` : `/client/course/?id=${courseId}`;
}

// La conversation est lue : sa notification « Message de … » l'est aussi
export async function marquerConversationLue(moi, role, courseId) {
  const { error } = await supabase.from('notifications').update({ lu_le: maintenant() })
    .eq('destinataire_id', moi).eq('lien', lienConversation(role, courseId))
    .like('titre', 'Message de %').is('lu_le', null);
  if (error) throw error;
}

// Nombre de non lues tenu à jour : rappel(n) à chaque changement.
// Renvoie { relire, arreter } (relire : après une action sur la liste).
export function surveillerNonLues(moi, rappel) {
  let dernier = null;
  async function relire() {
    try {
      const n = await compterNonLues(moi);
      if (n !== dernier) {
        dernier = n;
        rappel(n);
      }
    } catch {
      // Réseau coupé : la prochaine relecture rattrapera
    }
  }
  const canal = supabase.channel(`notifications-${moi}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `destinataire_id=eq.${moi}` }, () => relire())
    .subscribe();
  const minuteur = setInterval(relire, RELECTURE_MS);
  relire();
  return {
    relire,
    arreter() {
      clearInterval(minuteur);
      supabase.removeChannel(canal);
    }
  };
}
