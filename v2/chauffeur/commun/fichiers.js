// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : fichiers privés (documents, paie)
// -----------------------------------------------------------------------------
// Ouverture d'un fichier par un lien temporaire (10 minutes) : la fenêtre
// s'ouvre d'abord (sinon le téléphone la bloque), puis reçoit le lien.
// Les règles d'accès des dossiers ne laissent lire au chauffeur que ses
// propres pièces (documents/{son compte}/…, paie/{sa fiche salarié}/…).
// =============================================================================
import { supabase } from '../../commun/supabase.js';

export async function ouvrirFichier(dossier, chemin) {
  const fenetre = window.open('about:blank', '_blank');
  const { data, error } = await supabase.storage.from(dossier).createSignedUrl(chemin, 600);
  if (error || !data) {
    if (fenetre) fenetre.close();
    throw error || new Error('Fichier introuvable.');
  }
  if (fenetre) {
    fenetre.opener = null;
    fenetre.location.href = data.signedUrl;
  } else {
    location.href = data.signedUrl;
  }
}

// Extension d'un fichier choisi sur le téléphone, d'après son type
export function extension(fichier) {
  const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };
  if (types[fichier.type]) return types[fichier.type];
  const nom = String(fichier.name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return nom ? nom[1] : null;
}
