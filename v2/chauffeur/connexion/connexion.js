// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : connexion, et création du compte d'un nouveau chauffeur
// -----------------------------------------------------------------------------
// Parcours commun aux trois entrées : commun/connexion-code.js (code reçu par
// e-mail ; prénom, nom et téléphone à la première connexion).
// Une fois connecté : la page de l'espace chauffeur demandée (« suite »), ou
// l'accueil de l'espace chauffeur, qui s'ouvre selon le compte (service du
// chauffeur validé, candidature d'un nouveau chauffeur, dossier en cours…).
// =============================================================================
import { RACINE } from '../../commun/config.js';
import { imposerLangue } from '../../commun/i18n.js';
import { demarrerConnexion } from '../../commun/connexion-code.js';

imposerLangue('fr');                 // espace chauffeur en français

demarrerConnexion({
  espace: 'chauffeur',
  nomObligatoire: true,
  destination: (profil, suite) => (suite && suite.pathname.startsWith(`${RACINE}chauffeur/`) && !suite.pathname.startsWith(`${RACINE}chauffeur/connexion/`)
    ? suite.pathname + suite.search
    : `${RACINE}chauffeur/`)
});
