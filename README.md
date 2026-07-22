# LOC RÉACTION S.A.S — Plateforme VTC & Multi-Services

Site web complet : transport VTC, location immobilière, BTP, jardinage, assistance à maîtrise d'ouvrage (AMO).

## Structure du dépôt

Chaque page possède son propre dossier contenant ses 3 fichiers (`.html`, `.css`, `.js`) côte à côte — aucun dossier `assets` centralisé.

```
locreaction/
├── index.html / index.css / index.js          (12 pages publiques à la racine)
├── services/<page>/<page>.html/.css/.js         (5 pages)
├── auth/<page>/<page>.html/.css/.js             (5 pages)
├── client/<page>/client-<page>.html/.css/.js    (11 pages)
├── chauffeur/<page>/chauffeur-<page>.html/.css/.js (6 pages)
├── admin/<page>/admin-<page>.html/.css/.js      (11 pages)
├── shared/                                       (fichiers communs à toutes les pages)
│   ├── supabase.js, i18n.js, nav.js, app-nav.js, cities-data.js, bon-commande.js
│   ├── main.css, site-shared.css, print.css, service-shared.css, auth-shared.css, legal.css, system.css
│   ├── img/logo-icon.svg
│   └── i18n/<page>/{fr,en,es,pt,zh,ja}.json     (22 dossiers de traduction — pages publiques uniquement)
└── sql/                                          (10 scripts, à exécuter dans l'ordre 00 → 09)
```

**Total : 50 pages, 150 fichiers HTML/CSS/JS, 13 fichiers partagés, 22 dossiers de traduction.**

## Déploiement

1. **Base de données** — dans Supabase Dashboard → SQL Editor, exécutez les 10 scripts du dossier `sql/` dans l'ordre numérique (00 à 09). Chacun est idempotent (ré-exécutable sans risque).
2. **Site** — poussez l'intégralité de ce dépôt sur GitHub, activez GitHub Pages sur la branche principale. Aucune étape de build n'est nécessaire (HTML/CSS/JS natifs).

## Stack technique

- Frontend : HTML5 / CSS3 / JavaScript ES6+ (aucun framework, aucune dépendance de build)
- Backend : Supabase (PostgreSQL, Auth, Realtime, Storage)
- Cartographie : Leaflet.js + OpenStreetMap
- Graphiques : Chart.js
- PDF : jsPDF (fiches de paie, reçus, bon de commande)
- Hébergement : GitHub Pages

## Notes importantes

- **Aucun `localStorage`** n'est utilisé nulle part dans le projet — toutes les données persistantes vivent dans Supabase.
- Les pages publiques (racine + `services/` + `auth/`) sont disponibles en **6 langues** (FR/EN/ES/PT/ZH/JA) avec menu hamburger mobile et responsive fluide.
- Les espaces connectés (`client/`, `chauffeur/`, `admin/`) sont en français, avec menu hamburger mobile, mais sans sélecteur de langue à ce stade.
- Identité légale : **LOC RÉACTION S.A.S**, Île-de-France, 95270 — SIREN 100052570.
