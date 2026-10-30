// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : actions sur une course, communes au dispatch et à la fiche
// -----------------------------------------------------------------------------
// Attribuer à la main, relancer la recherche, retirer le chauffeur, annuler.
// Chaque action appelle une fonction serveur (contrôles, notifications et
// journal côté base), puis « apres() » pour recharger l'affichage.
// La course passée en paramètre suit la forme : { id, numero, statut, type,
// prise_en_charge_le, cree_le, depart_adresse, arrivee_adresse,
// chauffeur_id, chauffeur_nom }.
// =============================================================================
import { supabase } from '../../commun/supabase.js';
import { el, nombre, afficherMessage } from '../../commun/outils.js';
import { badge, heure, libelleJour, depuis, confirmer, ouvrirFenetre, messageErreurAdmin, lienTelephone } from './composants.js';

// « Immédiate · commandée il y a 3 min » ou « Prise en charge : demain à 14:30 »
export function quandCourse(c) {
  if (c.type === 'immediate') return `Immédiate · commandée il y a ${depuis(c.cree_le)}`;
  const moment = `${libelleJour(c.prise_en_charge_le)} à ${heure(c.prise_en_charge_le)}`;
  return c.type === 'mise_a_disposition' ? `Mise à disposition · ${moment}` : `Prise en charge : ${moment}`;
}

function telephone(numero) {
  return lienTelephone(numero);
}

// ---------------------------------------------------------------------------
// Attribution à la main
// ---------------------------------------------------------------------------
// Liste des chauffeurs validés : attribuables d'abord, en ligne, du plus
// proche au plus loin ; motif affiché quand l'attribution est impossible,
// avertissements (documents, conflit d'horaire) quand elle reste possible.
export async function fenetreAttribution(c, apres) {
  const zone = el('div', { classe: 'choix-chauffeurs' }, el('p', { classe: 'chargement', texte: 'Recherche des chauffeurs…' }));
  const fenetre = ouvrirFenetre({
    titre: `Attribuer ${c.numero}`, large: true,
    contenu: [
      el('p', { classe: 'sous-titre', texte: `${quandCourse(c)} · ${c.depart_adresse} → ${c.arrivee_adresse}` }),
      zone,
      el('div', { classe: 'fenetre-actions' },
        el('button', { type: 'button', classe: 'bouton bouton-secondaire', texte: 'Fermer', onclick: () => fenetre.fermer() }))
    ]
  });
  const { data, error } = await supabase.rpc('admin_chauffeurs_pour_course', { p_course: c.id });
  if (error) { zone.replaceChildren(el('p', { classe: 'alerte', texte: messageErreurAdmin(error) })); return; }
  if (!data.length) {
    zone.replaceChildren(el('p', { classe: 'vide-admin', texte: 'Aucun chauffeur validé. Validez d\'abord une candidature dans le module Chauffeurs.' }));
    return;
  }
  zone.replaceChildren(el('ul', { classe: 'liste-choix' }, ...data.map((ch) => ligneChoix(ch, c, fenetre, apres))));
}

function ligneChoix(ch, c, fenetre, apres) {
  const etats = [ch.en_ligne ? badge('En ligne', 'vert') : badge('Hors ligne', 'gris')];
  if (ch.occupe) etats.push(badge('En course', 'bleu'));
  if (ch.chauffeuse) etats.push(badge('Chauffeuse', 'bleu'));
  const actuel = c.chauffeur_id === ch.chauffeur_id;
  if (actuel) etats.push(badge('Chauffeur actuel', 'or'));
  const details = [
    ch.vehicule || 'Aucun véhicule',
    ch.distance_km !== null ? `à ${nombre(ch.distance_km, 1)} km du départ` : 'position inconnue',
    ch.note_moyenne ? `note ${nombre(ch.note_moyenne, 2)} / 5` : null
  ].filter(Boolean).join(' · ');
  const choisir = el('button', {
    type: 'button', classe: 'bouton bouton-principal bouton-petit', texte: 'Attribuer',
    disabled: !ch.attribuable || actuel, 'aria-label': `Attribuer ${c.numero} à ${ch.nom}`
  });
  choisir.addEventListener('click', async () => {
    choisir.disabled = true;
    const { error } = await supabase.rpc('attribuer_course', { p_course: c.id, p_chauffeur: ch.chauffeur_id });
    if (error) { choisir.disabled = false; afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
    fenetre.fermer();
    afficherMessage(`${c.numero} attribuée à ${ch.nom}. Le chauffeur et le client sont prévenus.`, 'succes');
    await apres();
  });
  return el('li', { classe: `choix${ch.attribuable ? '' : ' choix-impossible'}` },
    el('div', { classe: 'choix-identite' }, el('strong', { texte: ch.nom || 'Sans nom' }), ...etats),
    el('p', { classe: 'choix-details', texte: details }),
    ch.telephone ? el('p', {}, telephone(ch.telephone)) : null,
    ch.conflit ? el('p', { classe: 'texte-or', texte: `Déjà une course à moins d'1 h 30 : ${ch.conflit}` }) : null,
    ...(ch.avertissements || []).map((a) => el('p', { classe: 'texte-or', texte: a })),
    ch.motif ? el('p', { classe: 'texte-rouge', texte: ch.motif }) : null,
    el('div', { classe: 'choix-action' }, choisir));
}

// ---------------------------------------------------------------------------
// Relancer, retirer, annuler
// ---------------------------------------------------------------------------
export async function relancerRecherche(c, apres) {
  const { error } = await supabase.rpc('admin_lancer_recherche', { p_course: c.id });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(`${c.numero} : demande envoyée au chauffeur en ligne le plus proche.`, 'succes');
  await apres();
}

// « procheMs » : la course part-elle avant le début de la recherche automatique ?
export async function retirerChauffeur(c, apres, rechercheAvantMin) {
  const loin = new Date(c.prise_en_charge_le).getTime() - Date.now() > rechercheAvantMin * 60000;
  const reponse = await confirmer({
    titre: `Retirer la course ${c.numero} à ${c.chauffeur_nom || 'ce chauffeur'} ?`,
    texte: loin
      ? 'La réservation redevient sans chauffeur : attribuez-la ensuite à quelqu\'un d\'autre. Le chauffeur et le client sont prévenus.'
      : 'L\'heure est proche : la course repart aussitôt en recherche automatique. Le chauffeur et le client sont prévenus.',
    libelle: 'Retirer le chauffeur', danger: true,
    motif: { libelle: 'Motif, transmis au chauffeur', obligatoire: false }
  });
  if (!reponse) return;
  const { error } = await supabase.rpc('admin_retirer_chauffeur', { p_course: c.id, p_motif: reponse.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(`${c.numero} retirée au chauffeur.`, 'succes');
  await apres();
}

export async function annulerCourse(c, apres) {
  const reponse = await confirmer({
    titre: `Annuler la course ${c.numero} ?`,
    texte: 'Le client et le chauffeur éventuel sont prévenus. Aucuns frais ne sont facturés au client ; un code promo utilisé lui est rendu.',
    libelle: 'Annuler la course', danger: true,
    motif: { libelle: 'Motif, transmis au client', obligatoire: true }
  });
  if (!reponse) return;
  const { error } = await supabase.rpc('annuler_course', { p_course: c.id, p_motif: reponse.motif });
  if (error) { afficherMessage(messageErreurAdmin(error), 'erreur'); return; }
  afficherMessage(`${c.numero} annulée.`, 'succes');
  await apres();
}
