// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace client : connexion et création de compte par code reçu par e-mail
// -----------------------------------------------------------------------------
// Le parcours (e-mail, code, profil) est commun aux trois entrées du site :
// commun/connexion-code.js. Ici, l'entrée du client : une fois connecté, on
// revient à la page demandée (« suite ») ou à l'accueil, où l'on commande.
// Un chauffeur ou un administrateur qui passe par ici arrive aussi côté
// client ; son espace a sa propre entrée (liens en bas de la page).
// =============================================================================
import { RACINE } from '../commun/config.js';
import { appliquerTraductions } from '../commun/i18n.js';
import { demarrerConnexion } from '../commun/connexion-code.js';
import '../commun/pwa.js';

appliquerTraductions();
demarrerConnexion({
  espace: 'client',
  destination: (profil, suite) => (suite ? suite.pathname + suite.search : RACINE)
});
