// ============================================================
// LOC RÉACTION S.A.S — shared/bon-commande.js
// Génération réelle du bon de commande VTC en PDF (jsPDF),
// stocké dans Supabase Storage pour partage (WhatsApp/email/site).
// Nécessite que la page appelante charge le script jsPDF CDN.
// ============================================================
import { supabase, formatPrice } from './supabase.js'

// Génère le PDF, l'enregistre dans le stockage, met à jour la course.
// Retourne { bonNum, path, blob } ou null en cas d'erreur.
export async function generateBonCommande(rideId) {
  if (!window.jspdf) {
    console.error('jsPDF non chargé sur cette page.')
    return null
  }

  const { data: ride, error } = await supabase
    .from('rides')
    .select('*, client:client_id(*), chauffeur:chauffeur_id(*)')
    .eq('id', rideId)
    .single()

  if (error || !ride) { console.error('Bon de commande : course introuvable', error); return null }

  const { data: emp } = await supabase.from('employees').select('*').eq('profile_id', ride.chauffeur_id).maybeSingle()
  const { data: tariff } = await supabase.from('tariffs').select('*').eq('actif', true).limit(1).maybeSingle()

  const bonNum = `BON-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${rideId.slice(-4).toUpperCase()}`
  const chauffeurNom = ride.chauffeur ? `${ride.chauffeur.prenom||''} ${ride.chauffeur.nom||''}`.trim() : 'Non assigné'
  const clientNom = ride.client ? `${ride.client.prenom||''} ${ride.client.nom||''}`.trim() : '—'
  const now = new Date()
  const prise = ride.created_at ? new Date(ride.created_at) : now

  const { jsPDF } = window.jspdf
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })

  // En-tête
  doc.setFontSize(15); doc.setFont(undefined, 'bold'); doc.setTextColor(10, 26, 56)
  doc.text('LOC RÉACTION S.A.S', 20, 20)
  doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(120)
  doc.text('Île-de-France, 95270 — SIREN 100052570 — Transport VTC Professionnel', 20, 26)

  doc.setFontSize(9); doc.setTextColor(200, 168, 75); doc.setFont(undefined, 'bold')
  doc.text(`N° ${bonNum}`, 190, 20, { align: 'right' })
  doc.setFontSize(7.5); doc.setTextColor(120); doc.setFont(undefined, 'normal')
  doc.text(`Émis le ${now.toLocaleDateString('fr-FR')} à ${now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}`, 190, 25, { align: 'right' })

  doc.setDrawColor(200, 168, 75); doc.setLineWidth(0.6); doc.line(20, 30, 190, 30)

  doc.setFontSize(13); doc.setTextColor(10, 26, 56); doc.setFont(undefined, 'bold')
  doc.text('BON DE COMMANDE VTC', 105, 40, { align: 'center' })
  doc.setFontSize(7.5); doc.setTextColor(120); doc.setFont(undefined, 'italic')
  doc.text('Justificatif de mission VTC professionnelle — Article L.3121-1 Code des transports', 105, 45, { align: 'center' })

  // Chauffeur / Client
  doc.setFont(undefined, 'normal'); doc.setFontSize(8); doc.setTextColor(10,26,56); doc.setFont(undefined,'bold')
  doc.text('CHAUFFEUR', 22, 56)
  doc.text('CLIENT', 112, 56)
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(30)
  doc.text(chauffeurNom, 22, 62)
  doc.text(clientNom, 112, 62)
  doc.setFontSize(8); doc.setTextColor(120)
  doc.text(`Carte pro VTC : ${emp?.matricule || 'à renseigner'}`, 22, 67)
  doc.text(`Tél : ${ride.chauffeur?.tel || '—'}`, 22, 72)
  doc.text(`Tél : ${ride.client?.tel || '—'}`, 112, 67)

  // Trajet
  doc.setFillColor(10, 26, 56); doc.roundedRect(20, 80, 170, 42, 3, 3, 'F')
  doc.setFontSize(8); doc.setTextColor(200,168,75); doc.setFont(undefined,'bold')
  doc.text('TRAJET', 25, 88)
  doc.setFontSize(9); doc.setTextColor(255); doc.setFont(undefined,'normal')
  doc.text(`Départ : ${ride.depart || '—'}`, 25, 96)
  doc.text(`Arrivée : ${ride.arrivee || '—'}`, 25, 103)

  doc.setFontSize(8)
  doc.text(`${ride.distance_km || '—'} km`, 45, 116, { align: 'center' })
  doc.text(`${ride.duree_min || '—'} min`, 85, 116, { align: 'center' })
  doc.text(`${tariff?.prix_km || 1.70} €/km`, 125, 116, { align: 'center' })
  doc.setFont(undefined,'bold'); doc.setTextColor(200,168,75); doc.setFontSize(11)
  doc.text(formatPrice(ride.prix || 0), 165, 116, { align: 'center' })

  // Détails complémentaires
  doc.setFontSize(8.5); doc.setTextColor(80); doc.setFont(undefined, 'normal')
  doc.text(`Prise en charge : ${prise.toLocaleString('fr-FR')}`, 22, 132)
  doc.text(`Paiement : ${ride.paiement === 'wallet' ? 'Portefeuille électronique' : 'Carte bancaire'}`, 22, 138)

  // Pied — mention officielle
  doc.setDrawColor(200,168,75); doc.line(20, 146, 190, 146)
  doc.setFontSize(7.5); doc.setTextColor(120); doc.setFont(undefined, 'bold')
  doc.text('DOCUMENT OFFICIEL', 22, 153)
  doc.setFont(undefined, 'normal')
  doc.text("Ce bon certifie que le transport est effectué dans le cadre d'une activité VTC légalement", 22, 158)
  doc.text('déclarée — LOC RÉACTION S.A.S. À présenter en cas de contrôle routier.', 22, 162)

  doc.setDrawColor(180); doc.setLineDashPattern([1, 1], 0)
  doc.rect(150, 150, 35, 16)
  doc.setFontSize(6.5); doc.text('Cachet LOC RÉACTION', 167.5, 159, { align: 'center' })

  // Upload réel dans Supabase Storage
  const blob = doc.output('blob')
  const path = `${rideId}/${bonNum}.pdf`
  const { error: uploadError } = await supabase.storage.from('bons-commande').upload(path, blob, { contentType: 'application/pdf', upsert: true })

  if (uploadError) { console.error('Erreur upload bon de commande :', uploadError); return null }

  await supabase.from('rides').update({
    bon_commande_url: path,
    bon_commande_genere_at: new Date().toISOString()
  }).eq('id', rideId)

  return { bonNum, path, blob, ride }
}

// Télécharge le PDF localement (utilisé par le bouton "Imprimer" du chauffeur)
export async function downloadBonCommande(rideId) {
  const result = await generateBonCommande(rideId)
  if (!result) return null
  const link = document.createElement('a')
  link.href = URL.createObjectURL(result.blob)
  link.download = `${result.bonNum}.pdf`
  link.click()
  return result
}

// Récupère une URL signée temporaire pour partager un bon déjà généré
export async function getBonCommandeSignedUrl(path, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from('bons-commande').createSignedUrl(path, expiresIn)
  if (error) return null
  return data.signedUrl
}

window.generateBonCommande = generateBonCommande
window.downloadBonCommande = downloadBonCommande
