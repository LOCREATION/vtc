// LOC'RÉATION SAS — realtime.js
import { supabase } from './supabase.js'
export function listenDriverLocation(chauffeurId, callback) {
  return supabase.channel('gps-'+chauffeurId)
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'driver_locations',filter:`chauffeur_id=eq.${chauffeurId}`},p=>callback(p.new)).subscribe()
}
export function listenRideStatus(rideId, callback) {
  return supabase.channel('ride-'+rideId)
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'rides',filter:`id=eq.${rideId}`},p=>callback(p.new)).subscribe()
}
export async function sendInvitations(rideId) {
  const { data: drivers } = await supabase.from('driver_locations').select('chauffeur_id').eq('is_online',true).limit(5)
  if (!drivers?.length) return { sent: 0 }
  const { error } = await supabase.from('driver_invitations').insert(drivers.map(d=>({ride_id:rideId,chauffeur_id:d.chauffeur_id,statut:'pending'})))
  return { sent: drivers.length, error }
}
