// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Application installable : enregistrement du service hors connexion
// -----------------------------------------------------------------------------
// Le service (sw.js) sert les pages du site depuis le réseau en priorité et ne
// garde une copie que pour pouvoir s'ouvrir sans réseau. Il ne touche jamais
// aux échanges avec la base de données.
// =============================================================================
import { RACINE } from './config.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${RACINE}sw.js`, { scope: RACINE }).catch(() => {
      // Sans service hors connexion, le site fonctionne normalement
    });
  });
}
