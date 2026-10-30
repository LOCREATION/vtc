// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Connexion à la base de données (client Supabase unique pour tout le site)
// -----------------------------------------------------------------------------
// - Version de la bibliothèque figée (2.117.3) : une mise à jour ne peut pas
//   changer le comportement du site sans qu'on l'ait décidé.
// - La session de connexion est gardée par la bibliothèque dans le navigateur
//   du téléphone ou de l'ordinateur : c'est ce qui évite de redemander un code
//   à chaque visite. Aucune autre donnée de l'application n'y est stockée :
//   tout le reste vient de la base, à jour.
// =============================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_CLE_PUBLIQUE } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_CLE_PUBLIQUE, {
  auth: {
    persistSession: true,       // rester connecté d'une visite à l'autre
    autoRefreshToken: true,     // renouveler la session avant qu'elle n'expire
    detectSessionInUrl: true    // accepter aussi le lien reçu par e-mail
  }
});

// Utilisateur connecté et son profil (rôle, prénom, langue…), ou null.
// Le profil est lu dans la table « profils » : la règle d'accès ne renvoie
// que la ligne de la personne connectée.
export async function profilConnecte() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from('profils')
    .select('id, role, statut, prenom, nom, email, telephone, langue, code_parrainage')
    .eq('id', session.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Traduit une erreur de la base en message lisible. Les fonctions serveur
// renvoient déjà des messages en français (« Ajoutez votre numéro… ») : on les
// affiche tels quels ; les erreurs techniques reçoivent un message générique.
export function messageErreur(erreur, langue = 'fr') {
  const brut = (erreur && (erreur.message || erreur.error_description || String(erreur))) || '';
  const technique = /permission denied|violates|duplicate key|JWT|fetch|network|Failed to fetch|row-level security/i.test(brut);
  if (brut && !technique) return brut;
  if (/Failed to fetch|network|fetch/i.test(brut)) {
    return langue === 'en'
      ? 'No connection. Check your network and try again.'
      : 'Pas de connexion. Vérifiez votre réseau et réessayez.';
  }
  return langue === 'en'
    ? 'Something went wrong. Please try again in a moment.'
    : 'L\'opération n\'a pas abouti. Réessayez dans un instant.';
}
