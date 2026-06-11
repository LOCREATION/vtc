// LOC'RÉATION SAS — bon-commande.js
import { supabase, formatPrice } from './supabase.js'
export async function generateBonCommande(rideId) {
  const { data: ride } = await supabase.from('rides').select('*,client:client_id(*),chauffeur:chauffeur_id(*)').eq('id',rideId).single()
  if (!ride) return
  const { data: emp } = await supabase.from('employees').select('*').eq('profile_id',ride.chauffeur_id).single()
  const { data: tariff } = await supabase.from('tariffs').select('*').eq('actif',true).limit(1).single()
  const bonNum = `BON-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${rideId.slice(-4).toUpperCase()}`
  let bonDiv = document.getElementById('bon-commande')
  if (!bonDiv) { bonDiv = document.createElement('div'); bonDiv.id='bon-commande'; document.body.appendChild(bonDiv) }
  bonDiv.innerHTML = getBonTemplate(ride,emp,tariff,bonNum)
  bonDiv.style.display = 'block'
  await supabase.from('rides').update({bon_commande_url:`bon-${bonNum}`}).eq('id',rideId)
  window.print()
  return bonNum
}
function getBonTemplate(ride,emp,tariff,bonNum){
  const now=new Date(),prise=ride.created_at?new Date(ride.created_at):now
  return `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:30px;border:2px solid #0A1A38;border-radius:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:14px;border-bottom:3px solid #C8A84B">
      <div><div style="font-size:1.3rem;font-weight:900;color:#0A1A38">⚡ LOC'RÉATION SAS</div><div style="font-size:.78rem;color:#7C7C9E">5 Allée de la Prairie — 77127 Lieusaint (77) | SIREN : 123 456 789</div></div>
      <div style="text-align:right"><div style="font-size:.75rem;color:#7C7C9E">N° de bon</div><div style="font-size:1rem;font-weight:800;color:#C8A84B">${bonNum}</div><div style="font-size:.72rem;color:#7C7C9E">Émis le ${now.toLocaleDateString('fr-FR')} à ${now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</div></div>
    </div>
    <div style="text-align:center;margin-bottom:16px"><div style="font-size:1.1rem;font-weight:800;color:#0A1A38;letter-spacing:2px">BON DE COMMANDE VTC</div><div style="font-size:.75rem;color:#7C7C9E;font-style:italic">Justificatif de mission VTC — Article L.3121-1 Code des transports</div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
      <div style="background:#EEF2FA;border-radius:10px;padding:14px"><div style="font-size:.68rem;font-weight:700;color:#0A1A38;text-transform:uppercase;margin-bottom:7px">CHAUFFEUR</div>
        <div style="font-weight:700">${ride.chauffeur?.prenom||'—'} ${ride.chauffeur?.nom||''}</div>
        <div style="font-size:.8rem;color:#7C7C9E">Carte pro VTC : ${emp?.matricule||'À renseigner'}</div>
        <div style="font-size:.8rem;color:#7C7C9E">Tél : ${ride.chauffeur?.tel||'—'}</div>
      </div>
      <div style="background:#F9F7FD;border-radius:10px;padding:14px"><div style="font-size:.68rem;font-weight:700;color:#0A1A38;text-transform:uppercase;margin-bottom:7px">CLIENT</div>
        <div style="font-weight:700">${ride.client?.prenom||'—'} ${ride.client?.nom||''}</div>
        <div style="font-size:.8rem;color:#7C7C9E">Tél : ${ride.client?.tel||'—'}</div>
      </div>
    </div>
    <div style="background:#0A1A38;border-radius:10px;padding:14px;margin-bottom:14px;color:#fff">
      <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;margin-bottom:10px;color:#C8A84B">TRAJET</div>
      <div style="margin-bottom:8px"><span style="background:#27AE60;width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px"></span><strong>Départ :</strong> ${ride.depart||'—'}</div>
      <div><span style="background:#C0392B;width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px"></span><strong>Destination :</strong> ${ride.arrivee||'—'}</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,.15)">
        <div style="text-align:center"><div style="font-size:1rem;font-weight:800;color:#C8A84B">${ride.distance_km||'—'} km</div><div style="font-size:.68rem;opacity:.7">Distance</div></div>
        <div style="text-align:center"><div style="font-size:1rem;font-weight:800;color:#C8A84B">${ride.duree_min||'—'} min</div><div style="font-size:.68rem;opacity:.7">Durée</div></div>
        <div style="text-align:center"><div style="font-size:1rem;font-weight:800;color:#C8A84B">${tariff?.prix_km||1.70} €/km</div><div style="font-size:.68rem;opacity:.7">Tarif</div></div>
        <div style="text-align:center"><div style="font-size:1.2rem;font-weight:900;color:#C8A84B">${formatPrice(ride.prix||0)}</div><div style="font-size:.68rem;opacity:.7">TOTAL TTC</div></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;font-size:.8rem">
      <div><span style="color:#7C7C9E">Prise en charge : </span><strong>${prise.toLocaleString('fr-FR')}</strong></div>
      <div><span style="color:#7C7C9E">Paiement : </span><strong>${ride.paiement==='wallet'?'Portefeuille électronique':'Carte bancaire'}</strong></div>
    </div>
    <div style="border-top:2px solid #C8A84B;padding-top:14px;display:flex;justify-content:space-between;align-items:flex-end">
      <div style="font-size:.72rem;color:#7C7C9E;max-width:360px"><strong style="color:#0A1A38">⚠ DOCUMENT OFFICIEL</strong><br>Ce bon certifie que le transport est effectué dans le cadre d'une activité VTC légalement déclarée — LOC'RÉATION SAS.</div>
      <div style="text-align:center"><div style="font-size:.68rem;color:#7C7C9E;margin-bottom:4px">Cachet</div><div style="width:110px;height:55px;border:1px dashed #7C7C9E;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:.68rem;color:#7C7C9E">LOC'RÉATION SAS</div></div>
    </div>
  </div>`
}
window.generateBonCommande = generateBonCommande
