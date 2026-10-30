// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Réglages communs à toutes les pages
// -----------------------------------------------------------------------------
// L'adresse du projet et la clé « publishable » sont publiques par nature :
// elles identifient le projet Supabase, et ce sont les règles d'accès de la
// base (une par table) qui décident de ce que chacun peut lire ou écrire.
// Aucune clé secrète ne doit jamais apparaître dans le site.
// =============================================================================

// Projet Supabase « Version 2.0 » (région Paris)
export const SUPABASE_URL = 'https://rolfbdmrhwslwxluhfwr.supabase.co';
export const SUPABASE_CLE_PUBLIQUE = 'sb_publishable_XEKN4wssRDMJ5dtin19-9Q_VRhkLE1B';

// Racine du site v2 (dossier /v2/ pendant la construction, puis la racine
// du site au basculement : seule cette ligne changera)
export const RACINE = '/v2/';

// Service d'adresses de l'État (Géoplateforme de l'IGN, ex-API Adresse) :
// ouvert, sans clé, 50 requêtes par seconde au plus depuis une même adresse.
export const GEOCODAGE_URL = 'https://data.geopf.fr/geocodage';

// Centre par défaut des recherches d'adresses : Paris
export const CENTRE_PAR_DEFAUT = { lat: 48.8566, lng: 2.3522 };

// Catégorie proposée sur la page d'accueil (la seule pour l'instant)
export const CATEGORIE_PAR_DEFAUT = 'berline_hybride';
