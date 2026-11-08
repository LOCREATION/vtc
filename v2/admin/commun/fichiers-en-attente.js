// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : effacement des fichiers des lignes supprimées
// -----------------------------------------------------------------------------
// Supabase interdit d'effacer un fichier du stockage depuis la base (il
// resterait sur ses disques). La base met donc en file chaque fichier d'une
// ligne effacée (pièce de chauffeur, pièce jointe du support, feuille de
// route, bulletin ou contrat brouillon, relevé, photo) ; cette fonction, jouée
// par la session de l'administration (seule autorisée sur tous les dossiers) :
//   1. lit la file (admin_fichiers_a_effacer : fichiers encore présents et
//      cités par aucune ligne) ;
//   2. les efface par l'API de stockage, dossier par dossier ;
//   3. fait oublier à la file ce qui n'existe plus (admin_fichiers_effaces),
//      à chaque passage, même sans fichier à effacer : une ligne dont le
//      fichier n'a jamais été déposé (dépôt interrompu) ne reste pas en file.
// Appelée juste après chaque suppression, et à chaque ouverture de
// l'administration pour ce qui resterait (coupure réseau, onglet fermé).
// Sans bruit : un échec laisse la file intacte, reprise la fois suivante.
// =============================================================================
import { supabase } from '../../commun/supabase.js';

let enCours = null;               // un seul passage à la fois

export function effacerFichiersEnAttente() {
  if (!enCours) enCours = passer().finally(() => { enCours = null; });
  return enCours;
}

async function passer() {
  try {
    const { data, error } = await supabase.rpc('admin_fichiers_a_effacer');
    if (error || !Array.isArray(data)) return 0;
    const parDossier = new Map();
    for (const f of data) {
      if (!parDossier.has(f.dossier)) parDossier.set(f.dossier, []);
      parDossier.get(f.dossier).push(f.chemin);
    }
    for (const [dossier, chemins] of parDossier) {
      await supabase.storage.from(dossier).remove(chemins);
    }
    const { data: oublies } = await supabase.rpc('admin_fichiers_effaces');
    return Number(oublies) || 0;
  } catch (_) {
    return 0;                     // reprise à la prochaine ouverture
  }
}
