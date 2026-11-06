// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Page publique « Devenir chauffeur »
// -----------------------------------------------------------------------------
// - Visiteur : « Déposer ma candidature » mène à l'entrée de l'espace
//   chauffeur (chauffeur/connexion/), qui envoie le code par e-mail puis
//   ouvre la candidature.
// - Personne déjà connectée : le bouton mène directement à son espace
//   chauffeur ; un chauffeur en service y retrouve son accueil (« Ouvrir mon
//   espace chauffeur »), un autre compte y trouve sa candidature.
// - Pied de page : identité légale lue dans la base (commun/pied.js).
// Page en français seulement, comme l'espace chauffeur.
// =============================================================================
import { supabase, profilConnecte } from '../commun/supabase.js';
import { imposerLangue } from '../commun/i18n.js';
import { remplirPiedDePage } from '../commun/pied.js';
import '../commun/pwa.js';

imposerLangue('fr');

const $ = (id) => document.getElementById(id);

demarrer();

async function demarrer() {
  // Le pied de page ne dépend pas de la connexion
  remplirPiedDePage().catch(() => {});
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const profil = await profilConnecte();
    if (!profil) return;
    const chauffeur = profil.role === 'chauffeur';
    for (const id of ['candidater', 'candidater-bas']) {
      $(id).href = '../chauffeur/';
      if (chauffeur) $(id).textContent = 'Ouvrir mon espace chauffeur';
    }
    $('lien-espace-chauffeur').href = '../chauffeur/';
    $('pied-chauffeur').href = '../chauffeur/';
    $('candidater-note').textContent = chauffeur
      ? 'Vous êtes connecté avec votre compte chauffeur.'
      : 'Vous êtes connecté : votre candidature se remplit dans votre espace chauffeur.';
  } catch {
    // Réseau coupé : les liens restent ceux de l'entrée de l'espace chauffeur
  }
}
