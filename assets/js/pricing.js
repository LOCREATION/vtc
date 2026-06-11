// LOC'RÉATION SAS — pricing.js
import { supabase } from './supabase.js'
export const TARIF_KM=1.70, PRIX_BASE=3.50, PRIX_MIN=0.45, MIN_COURSE=8.00
export function isTarifNuit(){const h=new Date().getHours();return h<6||h>=22}
export function isTarifPointe(){const h=new Date().getHours();return (h>=7&&h<=9)||(h>=17&&h<=19)}
export async function estimatePriceFromKm(distanceKm,dureeMin){
  const {data:t}=await supabase.from('tariffs').select('*').eq('actif',true).limit(1).single()
  let prix=(t?.prix_base||PRIX_BASE)+(distanceKm*(t?.prix_km||TARIF_KM))+(dureeMin*(t?.prix_min||PRIX_MIN))
  if(isTarifNuit()) prix*=(t?.surcharge_nuit||1.30)
  if(isTarifPointe()) prix*=(t?.surcharge_pointe||1.50)
  return Math.max(MIN_COURSE,+prix.toFixed(2))
}
