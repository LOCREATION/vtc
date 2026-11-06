// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Administration : connexion par code reçu par e-mail
// -----------------------------------------------------------------------------
// Parcours commun aux trois entrées : commun/connexion-code.js. Une fois
// connecté, retour à l'administration (page demandée, ou l'accueil de
// l'administration) : la porte (commun/admin.js) vérifie que le compte est
// administrateur, fait choisir le mot de passe la première fois, puis demande
// la double authentification.
// =============================================================================
import { RACINE } from '../../commun/config.js';
import { imposerLangue } from '../../commun/i18n.js';
import { demarrerConnexion } from '../../commun/connexion-code.js';

imposerLangue('fr');                 // administration en français

demarrerConnexion({
  espace: 'admin',
  nomObligatoire: true,
  destination: (profil, suite) => (suite && suite.pathname.startsWith(`${RACINE}admin/`) && !suite.pathname.startsWith(`${RACINE}admin/connexion/`)
    ? suite.pathname + suite.search
    : `${RACINE}admin/`)
});
