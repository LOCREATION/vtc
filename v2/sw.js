// =============================================================================
// LOC RÉACTION S.A.S — Version 2
// Service hors connexion de l'application installable
// -----------------------------------------------------------------------------
// - Pages et fichiers du site : réseau d'abord (toujours la dernière version),
//   copie de secours si le téléphone est hors connexion.
// - Base de données, carte, adresses, bibliothèques externes : jamais mis en
//   cache ici (toujours à jour, et rien de personnel n'est conservé).
// Changer VERSION à chaque mise en ligne efface les anciennes copies.
// =============================================================================
const VERSION = 'loc-reaction-v2-2026-11-01-1';
const COQUILLE = [
  './',
  './connexion/',
  './commun/styles.css',
  './commun/img/logo.svg',
  './commun/polices/barlow-latin-400-normal.woff2',
  './commun/polices/barlow-latin-500-normal.woff2',
  './commun/polices/barlow-latin-600-normal.woff2',
  './commun/polices/barlow-semi-condensed-latin-500-normal.woff2',
  './commun/polices/barlow-semi-condensed-latin-600-normal.woff2',
  './commun/polices/barlow-semi-condensed-latin-700-normal.woff2'
];

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(COQUILLE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((cle) => cle !== VERSION).map((cle) => caches.delete(cle))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;
  const url = new URL(requete.url);
  // Uniquement les fichiers du site lui-même, en lecture
  if (requete.method !== 'GET' || url.origin !== self.location.origin) return;
  evenement.respondWith(
    fetch(requete)
      .then((reponse) => {
        if (reponse.ok) {
          const copie = reponse.clone();
          caches.open(VERSION).then((cache) => cache.put(requete, copie));
        }
        return reponse;
      })
      .catch(() => caches.match(requete, { ignoreSearch: requete.mode === 'navigate' }))
  );
});
