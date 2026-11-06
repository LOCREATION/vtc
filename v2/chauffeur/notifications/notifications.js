// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Espace chauffeur : la cloche et le panneau des notifications
// -----------------------------------------------------------------------------
// Le panneau est commun aux espaces (commun/panneau-notifications.js) ; ici,
// ce qu'ouvre une notification dans l'espace chauffeur, sans quitter la page
// quand c'est possible (le service continue : position, demandes) :
//   /chauffeur/            → onglet Accueil
//   /chauffeur/revenus/    → onglet Revenus
//   /chauffeur/documents/  → onglet Compte, « Mes documents »
//   /chauffeur/demandes/   → « Mes demandes au support » (la demande)
// Les autres liens (une course…) ouvrent leur page. Une demande de course
// qui arrive ferme le panneau (chauffeur.js).
// =============================================================================
import { installerPanneauNotifications } from '../../commun/panneau-notifications.js';
import { adresseDuLien } from '../../commun/notifications.js';

// cloche : bouton de la barre du haut ; pastille : son nombre de non lues ;
// moi : identifiant du chauffeur ; contexte : ouvrirOnglet, ouvrirSupport (chauffeur.js)
export function installerNotifications({ cloche, pastille, moi, contexte }) {
  return installerPanneauNotifications({ cloche, pastille, moi, suivreLien: (lien) => suivreLien(lien, contexte) });
}

async function suivreLien(lien, contexte) {
  const chemin = lien.split(/[?#]/)[0];
  if (chemin === '/chauffeur/' || chemin === '/chauffeur') {
    await contexte.ouvrirOnglet('accueil');
    return;
  }
  if (chemin === '/chauffeur/revenus/') {
    await contexte.ouvrirOnglet('revenus');
    return;
  }
  if (chemin === '/chauffeur/documents/') {
    await contexte.ouvrirOnglet('compte');
    const section = document.getElementById('compte-documents');
    if (section) section.scrollIntoView({ block: 'start' });
    return;
  }
  if (chemin === '/chauffeur/demandes/') {
    const demande = new URLSearchParams(lien.split('?')[1] || '').get('id');
    await contexte.ouvrirSupport(demande ? { demande } : {});
    return;
  }
  const adresse = adresseDuLien(lien);
  if (adresse) location.href = adresse;
}
