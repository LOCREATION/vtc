// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : connexion et création de compte par code reçu par e-mail
// -----------------------------------------------------------------------------
// Le parcours (e-mail, code, profil) est commun aux trois entrées du site :
// commun/connexion-code.js. Ici, l'entrée du client : une fois connecté, on
// revient à la page demandée (« suite ») ou à l'accueil, où l'on commande.
// Un chauffeur ou un administrateur qui passe par ici arrive aussi côté
// client ; son espace a sa propre entrée (liens en bas de la page).
// Lien d'invitation (?parrain=CODE) : le code part avec la demande de code de
// connexion et la base l'enregistre à la création du compte.
// =============================================================================
import { RACINE } from '../commun/config.js';
import { supabase } from '../commun/supabase.js';
import { t, appliquerTraductions } from '../commun/i18n.js';
import { euros } from '../commun/outils.js';
import { demarrerConnexion } from '../commun/connexion-code.js';
import '../commun/pwa.js';

// Code de parrainage du lien d'invitation (lettres et chiffres seulement)
const brut = (new URLSearchParams(location.search).get('parrain') || '').replace(/\s/g, '').toUpperCase();
const codeParrain = /^[A-Z0-9]{4,20}$/.test(brut) ? brut : null;

appliquerTraductions();
demarrerConnexion({
  espace: 'client',
  destination: (profil, suite) => (suite ? suite.pathname + suite.search : RACINE),
  codeParrain
});
if (codeParrain) afficherInvitation();

// Bandeau : le code et l'offre de bienvenue (montant réglé par LOC RÉACTION)
async function afficherInvitation() {
  const bandeau = document.getElementById('invitation-parrainage');
  let montant = 0;
  try {
    const { data } = await supabase.from('parametres').select('recompense_filleul').maybeSingle();
    montant = Number(data && data.recompense_filleul) || 0;
  } catch {
    // Réseau coupé : le bandeau s'affiche sans le montant
  }
  bandeau.textContent = montant > 0
    ? t('connexion.invitation', { code: codeParrain, montant: euros(montant) })
    : t('connexion.invitation_sans', { code: codeParrain });
  bandeau.hidden = false;
}
