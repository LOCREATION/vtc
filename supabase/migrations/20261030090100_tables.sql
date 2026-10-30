-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 2/8 : TABLES DES 8 MODULES
-- -----------------------------------------------------------------------------
-- Comptes · Offre · Flotte · Courses · Paiements · RH et paie · Support · Administration
-- Les droits et les règles d'accès ligne par ligne sont posés à la migration 4 :
-- ici, uniquement la structure, les contrôles de cohérence et les index.
-- Les montants sont en euros TTC, arrondis au centime (numeric 2 décimales).
-- =============================================================================


-- #############################################################################
-- MODULE COMPTES : profils, proches, lieux, appareils, notifications, comptes pro
-- #############################################################################

-- Un profil par compte de connexion. Le rôle n'est JAMAIS pris dans le
-- formulaire d'inscription : il vaut « client » et seul un administrateur le
-- change, par une fonction serveur journalisée.
create table public.profils (
  id               uuid primary key references auth.users (id) on delete cascade,
  role             text not null default 'client' check (role in ('client', 'chauffeur', 'admin')),
  statut           text not null default 'actif'  check (statut in ('actif', 'bloque')),
  prenom           text not null default '' check (char_length(prenom) <= 80),
  nom              text not null default '' check (char_length(nom) <= 80),
  email            text,
  telephone        text check (telephone is null or telephone ~ '^\+[1-9][0-9]{6,14}$'),  -- format international (+33…)
  langue           text not null default 'fr' check (langue in ('fr', 'en')),
  photo_chemin     text,                                   -- chemin dans le dossier « photos »
  code_parrainage  text not null unique default prive.nouveau_code_parrainage(),
  notif_email      boolean not null default true,
  notif_whatsapp   boolean not null default true,
  notif_push       boolean not null default true,
  cree_le          timestamptz not null default now(),
  maj_le           timestamptz not null default now()
);
create index profils_role_idx on public.profils (role);
comment on table public.profils is 'Profil de chaque compte : rôle et statut modifiables uniquement par l''administration.';

-- Proches pour qui le client peut commander une course.
create table public.proches (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.profils (id) on delete cascade,
  nom        text not null check (char_length(nom) between 1 and 120),
  telephone  text not null check (telephone ~ '^\+[1-9][0-9]{6,14}$'),
  relation   text check (char_length(relation) <= 40),
  cree_le    timestamptz not null default now()
);
create index proches_client_idx on public.proches (client_id);

-- Lieux enregistrés : domicile, travail (un seul de chaque), favoris.
create table public.lieux (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.profils (id) on delete cascade,
  type        text not null check (type in ('domicile', 'travail', 'favori')),
  libelle     text check (char_length(libelle) <= 60),
  adresse     text not null check (char_length(adresse) <= 300),
  latitude    numeric(9,6) not null check (latitude between -90 and 90),
  longitude   numeric(9,6) not null check (longitude between -180 and 180),
  precision   text check (char_length(precision) <= 200),        -- bâtiment, code, étage…
  cree_le     timestamptz not null default now()
);
create index lieux_client_idx on public.lieux (client_id);
create unique index lieux_un_domicile_un_travail on public.lieux (client_id, type) where type in ('domicile', 'travail');

-- Téléphones et navigateurs abonnés aux notifications de l'application.
create table public.appareils (
  id          uuid primary key default gen_random_uuid(),
  profil_id   uuid not null references public.profils (id) on delete cascade,
  endpoint    text not null unique,
  cle_p256dh  text not null,
  cle_auth    text not null,
  agent       text,
  cree_le     timestamptz not null default now(),
  vu_le       timestamptz not null default now()
);
create index appareils_profil_idx on public.appareils (profil_id);

-- Notifications affichées dans l'application (cloche).
create table public.notifications (
  id               uuid primary key default gen_random_uuid(),
  destinataire_id  uuid not null references public.profils (id) on delete cascade,
  type             text not null default 'info' check (type in ('info', 'course', 'paiement', 'alerte', 'document')),
  titre            text not null check (char_length(titre) <= 120),
  message          text not null check (char_length(message) <= 1000),
  lien             text,
  lu_le            timestamptz,
  cree_le          timestamptz not null default now()
);
create index notifications_destinataire_idx on public.notifications (destinataire_id, cree_le desc);

-- Comptes professionnels (entreprises clientes, facture mensuelle avec TVA).
create table public.comptes_pro (
  id                       uuid primary key default gen_random_uuid(),
  raison_sociale           text not null check (char_length(raison_sociale) <= 200),
  siret                    text check (siret ~ '^[0-9]{14}$'),
  tva_intracommunautaire   text,
  adresse                  text,
  code_postal              text,
  ville                    text,
  email_facturation        text not null,
  telephone                text,
  contact_nom              text,
  plafond_mensuel          numeric(10,2) check (plafond_mensuel >= 0),
  statut                   text not null default 'actif' check (statut in ('actif', 'suspendu')),
  cree_le                  timestamptz not null default now(),
  maj_le                   timestamptz not null default now()
);

create table public.comptes_pro_membres (
  compte_pro_id  uuid not null references public.comptes_pro (id) on delete cascade,
  profil_id      uuid not null references public.profils (id) on delete cascade,
  role           text not null default 'membre' check (role in ('gestionnaire', 'membre')),
  cree_le        timestamptz not null default now(),
  primary key (compte_pro_id, profil_id)
);
create index comptes_pro_membres_profil_idx on public.comptes_pro_membres (profil_id);


-- #############################################################################
-- MODULE OFFRE : catégories, tarifs datés, majorations, fériés, zones, forfaits,
--                codes promo, parrainage
-- #############################################################################

create table public.categories (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique check (code ~ '^[a-z0-9_]{2,40}$'),
  nom_fr          text not null,
  nom_en          text not null,
  description_fr  text,
  description_en  text,
  places          integer not null default 4 check (places between 1 and 8),
  bagages         integer not null default 3 check (bagages between 0 and 10),
  ordre           integer not null default 0,
  active          boolean not null default true,
  cree_le         timestamptz not null default now(),
  maj_le          timestamptz not null default now()
);

-- Tarifs datés : un nouveau tarif ne réécrit pas l'ancien, il prend le relais
-- à sa date. Les courses gardent la référence du tarif qui a servi au calcul.
create table public.tarifs (
  id                      uuid primary key default gen_random_uuid(),
  categorie_id            uuid not null references public.categories (id),
  valide_du               date not null,
  valide_au               date,                                    -- null = toujours en vigueur
  prise_en_charge         numeric(8,2) not null check (prise_en_charge >= 0),
  prix_km                 numeric(8,2) not null check (prix_km >= 0),
  prix_minute             numeric(8,2) not null check (prix_minute >= 0),
  minimum                 numeric(8,2) not null default 0 check (minimum >= 0),
  prix_attente_minute     numeric(8,2) not null default 0 check (prix_attente_minute >= 0),
  prix_heure_mad          numeric(8,2) check (prix_heure_mad > 0),  -- mise à disposition ; null = non proposée
  frais_annulation        numeric(8,2) not null default 0 check (frais_annulation >= 0),
  supplement_chauffeuse   numeric(8,2) not null default 0 check (supplement_chauffeuse >= 0),
  cree_le                 timestamptz not null default now(),
  maj_le                  timestamptz not null default now(),
  constraint tarifs_periode check (valide_au is null or valide_au >= valide_du),
  unique (categorie_id, valide_du)
);
create index tarifs_categorie_idx on public.tarifs (categorie_id, valide_du desc);

-- Une ligne par type de majoration ; non cumulables : la plus forte s'applique.
create table public.majorations (
  type          text primary key check (type in ('nuit', 'dimanche', 'ferie')),
  pourcentage   numeric(5,2) not null default 0 check (pourcentage between 0 and 200),
  heure_debut   time,      -- nuit uniquement (ex. 22:00)
  heure_fin     time,      -- nuit uniquement (ex. 06:00, le lendemain)
  active        boolean not null default false,
  maj_le        timestamptz not null default now(),
  constraint majorations_nuit check (type <> 'nuit' or (heure_debut is not null and heure_fin is not null))
);

create table public.jours_feries (
  jour     date primary key,
  libelle  text not null
);

-- Zones : aéroports, gares, villes. Un point appartient à une zone s'il est à
-- moins de « rayon_km » de son centre. Servent aux forfaits et à la prise en
-- charge précise (terminal, sortie).
create table public.zones (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[a-z0-9_]{2,40}$'),
  nom        text not null,
  type       text not null check (type in ('aeroport', 'gare', 'ville', 'autre')),
  latitude   numeric(9,6) not null check (latitude between -90 and 90),
  longitude  numeric(9,6) not null check (longitude between -180 and 180),
  rayon_km   numeric(6,2) not null default 2 check (rayon_km > 0 and rayon_km <= 50),
  active     boolean not null default true,
  cree_le    timestamptz not null default now(),
  maj_le     timestamptz not null default now()
);

-- Forfaits entre deux zones, dans les deux sens (Paris ↔ CDG = CDG ↔ Paris).
create table public.forfaits (
  id            uuid primary key default gen_random_uuid(),
  categorie_id  uuid not null references public.categories (id),
  zone_a_id     uuid not null references public.zones (id),
  zone_b_id     uuid not null references public.zones (id),
  prix          numeric(8,2) not null check (prix > 0),
  active        boolean not null default true,
  cree_le       timestamptz not null default now(),
  maj_le        timestamptz not null default now(),
  constraint forfaits_deux_zones check (zone_a_id <> zone_b_id)
);
create unique index forfaits_paire_unique
  on public.forfaits (categorie_id, least(zone_a_id, zone_b_id), greatest(zone_a_id, zone_b_id));

create table public.codes_promo (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null unique check (code ~ '^[A-Z0-9_-]{3,20}$'),
  libelle                   text,
  type                      text not null check (type in ('pourcentage', 'montant')),
  valeur                    numeric(8,2) not null check (valeur > 0),
  debut                     timestamptz,
  fin                       timestamptz,
  utilisations_max          integer check (utilisations_max > 0),
  utilisations_par_client   integer not null default 1 check (utilisations_par_client > 0),
  minimum_course            numeric(8,2) not null default 0 check (minimum_course >= 0),
  actif                     boolean not null default true,
  cree_le                   timestamptz not null default now(),
  maj_le                    timestamptz not null default now(),
  constraint codes_promo_pourcentage check (type <> 'pourcentage' or valeur <= 100),
  constraint codes_promo_periode check (fin is null or debut is null or fin > debut)
);

create table public.parrainages (
  id                   uuid primary key default gen_random_uuid(),
  parrain_id           uuid not null references public.profils (id) on delete cascade,
  filleul_id           uuid not null unique references public.profils (id) on delete cascade,
  statut               text not null default 'en_attente' check (statut in ('en_attente', 'valide', 'annule')),
  recompense_parrain   numeric(8,2) not null default 0,
  recompense_filleul   numeric(8,2) not null default 0,
  valide_le            timestamptz,
  cree_le              timestamptz not null default now(),
  constraint parrainages_pas_soi_meme check (parrain_id <> filleul_id)
);
create index parrainages_parrain_idx on public.parrainages (parrain_id);


-- #############################################################################
-- MODULE FLOTTE : véhicules, entretiens, chauffeurs, documents, candidatures
-- #############################################################################

create table public.vehicules (
  id                             uuid primary key default gen_random_uuid(),
  categorie_id                   uuid not null references public.categories (id),
  immatriculation                text not null unique check (immatriculation ~ '^[A-Z0-9-]{4,12}$'),
  marque                         text not null,
  modele                         text not null,
  couleur                        text,
  energie                        text not null default 'hybride' check (energie in ('hybride', 'electrique', 'essence', 'diesel', 'autre')),
  places                         integer not null default 4 check (places between 1 and 8),
  annee                          integer check (annee between 1990 and 2100),
  mise_en_circulation            date,
  kilometrage                    integer not null default 0 check (kilometrage >= 0),
  vignette_vtc_numero            text,
  vignette_vtc_expiration        date,
  controle_technique_expiration  date,
  assurance_expiration           date,
  actif                          boolean not null default true,
  notes                          text,
  cree_le                        timestamptz not null default now(),
  maj_le                         timestamptz not null default now()
);

create table public.entretiens (
  id           uuid primary key default gen_random_uuid(),
  vehicule_id  uuid not null references public.vehicules (id) on delete cascade,
  jour         date not null,
  type         text not null check (type in ('vidange', 'pneus', 'revision', 'freins', 'reparation', 'controle_technique', 'autre')),
  kilometrage  integer check (kilometrage >= 0),
  montant      numeric(10,2) check (montant >= 0),
  description  text,
  cree_le      timestamptz not null default now()
);
create index entretiens_vehicule_idx on public.entretiens (vehicule_id, jour desc);

-- Un chauffeur est d'abord « candidat » ; l'administration le valide après
-- vérification des documents, ce qui lui donne le rôle « chauffeur ».
create table public.chauffeurs (
  id                       uuid primary key references public.profils (id) on delete cascade,
  statut                   text not null default 'candidat' check (statut in ('candidat', 'valide', 'suspendu', 'refuse')),
  salarie                  boolean not null default true,     -- salarié de LOC RÉACTION (indépendants plus tard)
  chauffeuse               boolean not null default false,    -- peut assurer l'option « chauffeuse pour clientes »
  vehicule_id              uuid references public.vehicules (id),
  carte_vtc_numero         text,
  carte_vtc_expiration     date,
  permis_numero            text,
  permis_expiration        date,
  note_moyenne             numeric(3,2) check (note_moyenne between 1 and 5),
  nb_notes                 integer not null default 0 check (nb_notes >= 0),
  courses_proposees        integer not null default 0 check (courses_proposees >= 0),
  courses_acceptees        integer not null default 0 check (courses_acceptees >= 0),
  filtre_destination_actif boolean not null default false,
  filtre_destination_lat   numeric(9,6),
  filtre_destination_lng   numeric(9,6),
  valide_le                timestamptz,
  valide_par               uuid references public.profils (id),
  cree_le                  timestamptz not null default now(),
  maj_le                   timestamptz not null default now()
);
create index chauffeurs_vehicule_idx on public.chauffeurs (vehicule_id);

create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  chauffeur_id    uuid references public.chauffeurs (id) on delete cascade,
  vehicule_id     uuid references public.vehicules (id) on delete cascade,
  type            text not null check (type in (
                    'permis', 'carte_vtc', 'registre_vtc', 'piece_identite', 'justificatif_domicile',
                    'assurance', 'carte_grise', 'controle_technique', 'vignette_vtc', 'autre')),
  fichier_chemin  text not null,                     -- chemin dans le dossier « documents »
  numero          text,
  expire_le       date,
  statut          text not null default 'en_attente' check (statut in ('en_attente', 'valide', 'refuse')),
  commentaire     text,
  verifie_par     uuid references public.profils (id),
  verifie_le      timestamptz,
  cree_le         timestamptz not null default now(),
  constraint documents_un_proprietaire check ((chauffeur_id is null) <> (vehicule_id is null))
);
create index documents_chauffeur_idx on public.documents (chauffeur_id);
create index documents_vehicule_idx on public.documents (vehicule_id);
create index documents_expiration_idx on public.documents (expire_le) where statut = 'valide';

create table public.candidatures (
  id            uuid primary key default gen_random_uuid(),
  profil_id     uuid not null unique references public.profils (id) on delete cascade,
  ville         text,
  experience    text check (char_length(experience) <= 2000),
  a_carte_vtc   boolean not null default false,
  message       text check (char_length(message) <= 2000),
  statut        text not null default 'nouvelle' check (statut in ('nouvelle', 'en_cours', 'acceptee', 'refusee')),
  motif_refus   text,
  traitee_par   uuid references public.profils (id),
  traitee_le    timestamptz,
  cree_le       timestamptz not null default now(),
  maj_le        timestamptz not null default now()
);


-- #############################################################################
-- MODULE COURSES : courses, arrêts, propositions, positions, événements, notes
-- #############################################################################

-- Statuts d'une course :
--   planifiee   réservation à venir (chauffeur attribué ou non)
--   recherche   recherche d'un chauffeur en cours (propositions envoyées une à une)
--   a_attribuer personne n'a accepté : l'administration attribue à la main
--   acceptee    chauffeur en route vers le point de prise en charge
--   arrivee     chauffeur arrivé, il attend le client
--   en_cours    client à bord
--   terminee / annulee
create table public.courses (
  id                         uuid primary key default gen_random_uuid(),
  numero                     text not null unique,                              -- C-2026-000001
  client_id                  uuid not null references public.profils (id),
  compte_pro_id              uuid references public.comptes_pro (id),
  pour_proche                boolean not null default false,
  beneficiaire_nom           text check (char_length(beneficiaire_nom) <= 120),
  beneficiaire_telephone     text check (beneficiaire_telephone is null or beneficiaire_telephone ~ '^\+[1-9][0-9]{6,14}$'),
  categorie_id               uuid not null references public.categories (id),
  option_chauffeuse          boolean not null default false,
  type                       text not null check (type in ('immediate', 'planifiee', 'mise_a_disposition')),
  statut                     text not null check (statut in (
                               'planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours', 'terminee', 'annulee')),
  -- Trajet
  depart_adresse             text not null check (char_length(depart_adresse) <= 300),
  depart_lat                 numeric(9,6) not null,
  depart_lng                 numeric(9,6) not null,
  depart_precision           text check (char_length(depart_precision) <= 200),   -- terminal, porte, sortie
  arrivee_adresse            text not null check (char_length(arrivee_adresse) <= 300),
  arrivee_lat                numeric(9,6) not null,
  arrivee_lng                numeric(9,6) not null,
  prise_en_charge_le         timestamptz not null,
  numero_vol                 text check (numero_vol is null or numero_vol ~ '^[A-Z0-9]{2,3}[0-9]{1,4}[A-Z]?$'),
  terminal                   text check (char_length(terminal) <= 40),
  duree_mad_heures           numeric(4,1) check (duree_mad_heures > 0 and duree_mad_heures <= 24),
  distance_km                numeric(7,2) not null check (distance_km >= 0),
  duree_min                  integer not null check (duree_min >= 0),
  -- Prix figé à la commande (prix fixe annoncé) : détail conservé pour la facture
  tarif_id                   uuid references public.tarifs (id),
  forfait_id                 uuid references public.forfaits (id),
  prix_base                  numeric(8,2) not null check (prix_base >= 0),
  majoration_type            text,
  majoration_pourcentage     numeric(5,2) not null default 0,
  supplement                 numeric(8,2) not null default 0 check (supplement >= 0),
  code_promo_id              uuid references public.codes_promo (id),
  remise                     numeric(8,2) not null default 0 check (remise >= 0),
  prix_total                 numeric(8,2) not null check (prix_total >= 0),
  attente_min                integer not null default 0 check (attente_min >= 0),
  frais_attente              numeric(8,2) not null default 0 check (frais_attente >= 0),
  frais_annulation           numeric(8,2) not null default 0 check (frais_annulation >= 0),
  pourboire                  numeric(8,2) not null default 0 check (pourboire >= 0),
  mode_paiement              text not null check (mode_paiement in ('especes', 'carte', 'solde', 'facture_mensuelle')),
  -- Chauffeur et véhicule : copiés à l'attribution (affichage client et historique)
  chauffeur_id               uuid references public.chauffeurs (id),
  vehicule_id                uuid references public.vehicules (id),
  chauffeur_prenom           text,
  chauffeur_telephone        text,
  chauffeur_photo            text,
  vehicule_libelle           text,
  vehicule_couleur           text,
  vehicule_immatriculation   text,
  -- Client (ou proche) : copié à l'attribution, pour le chauffeur
  client_prenom              text,
  client_telephone           text,
  attribution                text check (attribution in ('automatique', 'manuelle', 'prise_directe')),
  attribuee_par              uuid references public.profils (id),
  annulee_par                text check (annulee_par in ('client', 'chauffeur', 'admin', 'systeme')),
  motif_annulation           text check (char_length(motif_annulation) <= 500),
  feuille_de_route_chemin    text,
  acceptee_le                timestamptz,
  arrivee_le                 timestamptz,
  demarree_le                timestamptz,
  terminee_le                timestamptz,
  annulee_le                 timestamptz,
  cree_le                    timestamptz not null default now(),
  maj_le                     timestamptz not null default now(),
  constraint courses_proche check (not pour_proche or (beneficiaire_nom is not null and beneficiaire_telephone is not null)),
  constraint courses_mad check (type <> 'mise_a_disposition' or duree_mad_heures is not null),
  constraint courses_chauffeur_present check (
    statut not in ('acceptee', 'arrivee', 'en_cours', 'terminee') or chauffeur_id is not null)
);
create index courses_client_idx on public.courses (client_id, cree_le desc);
create index courses_chauffeur_idx on public.courses (chauffeur_id, cree_le desc);
create index courses_statut_idx on public.courses (statut);
create index courses_prise_en_charge_idx on public.courses (prise_en_charge_le) where statut in ('planifiee', 'recherche', 'a_attribuer');
create index courses_compte_pro_idx on public.courses (compte_pro_id) where compte_pro_id is not null;
create index courses_categorie_idx on public.courses (categorie_id);
create index courses_vehicule_idx on public.courses (vehicule_id);
create index courses_tarif_idx on public.courses (tarif_id);
create index courses_forfait_idx on public.courses (forfait_id);
create index courses_code_promo_idx on public.courses (code_promo_id);
create index courses_attribuee_par_idx on public.courses (attribuee_par);

-- Arrêts intermédiaires, dans l'ordre.
create table public.course_arrets (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses (id) on delete cascade,
  ordre      integer not null check (ordre between 1 and 5),
  adresse    text not null check (char_length(adresse) <= 300),
  latitude   numeric(9,6) not null,
  longitude  numeric(9,6) not null,
  unique (course_id, ordre)
);

-- Propositions envoyées aux chauffeurs, une à la fois, avec délai de réponse.
create table public.propositions (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses (id) on delete cascade,
  chauffeur_id  uuid not null references public.chauffeurs (id) on delete cascade,
  statut        text not null default 'envoyee' check (statut in ('envoyee', 'acceptee', 'refusee', 'expiree', 'annulee')),
  distance_km   numeric(7,2),                 -- distance du chauffeur au départ, à l'envoi
  envoyee_le    timestamptz not null default now(),
  expire_le     timestamptz not null,
  repondue_le   timestamptz,
  unique (course_id, chauffeur_id)
);
create index propositions_chauffeur_idx on public.propositions (chauffeur_id, statut);
create index propositions_attente_idx on public.propositions (expire_le) where statut = 'envoyee';

-- Position en direct de chaque chauffeur (une ligne par chauffeur).
create table public.positions (
  chauffeur_id  uuid primary key references public.chauffeurs (id) on delete cascade,
  en_ligne      boolean not null default false,
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  cap           numeric(5,1) check (cap >= 0 and cap < 360),
  vitesse_kmh   numeric(5,1) check (vitesse_kmh >= 0),
  maj_le        timestamptz not null default now()
);

-- Chaque étape d'une course, horodatée (preuve en cas de litige).
create table public.evenements_course (
  id         bigint generated always as identity primary key,
  course_id  uuid not null references public.courses (id) on delete cascade,
  type       text not null,
  acteur_id  uuid references public.profils (id),
  details    jsonb,
  cree_le    timestamptz not null default now()
);
create index evenements_course_idx on public.evenements_course (course_id, cree_le);

-- Notes : le client note le chauffeur ; le chauffeur note le client
-- (cette note-là n'est visible que par l'administration).
create table public.evaluations (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references public.courses (id) on delete cascade,
  sens         text not null check (sens in ('client_vers_chauffeur', 'chauffeur_vers_client')),
  auteur_id    uuid not null references public.profils (id),
  cible_id     uuid not null references public.profils (id),
  note         integer not null check (note between 1 and 5),
  commentaire  text check (char_length(commentaire) <= 1000),
  cree_le      timestamptz not null default now(),
  unique (course_id, sens)
);
create index evaluations_cible_idx on public.evaluations (cible_id);

-- Utilisation d'un code promo : une ligne par course qui en a bénéficié.
-- Libérée si la course est annulée sans frais.
create table public.utilisations_promo (
  id             uuid primary key default gen_random_uuid(),
  code_promo_id  uuid not null references public.codes_promo (id),
  client_id      uuid not null references public.profils (id) on delete cascade,
  course_id      uuid not null unique references public.courses (id) on delete cascade,
  remise         numeric(8,2) not null check (remise >= 0),
  cree_le        timestamptz not null default now()
);
create index utilisations_promo_code_client_idx on public.utilisations_promo (code_promo_id, client_id);


-- #############################################################################
-- MODULE PAIEMENTS : paiements, remboursements, factures, soldes, écritures
-- #############################################################################

create table public.paiements (
  id                 uuid primary key default gen_random_uuid(),
  course_id          uuid not null references public.courses (id),
  client_id          uuid not null references public.profils (id),
  nature             text not null check (nature in ('course', 'pourboire', 'frais_annulation')),
  mode               text not null check (mode in ('especes', 'carte', 'solde', 'facture_mensuelle')),
  montant            numeric(10,2) not null check (montant > 0),
  statut             text not null default 'a_encaisser' check (statut in ('a_encaisser', 'encaisse', 'echoue', 'rembourse', 'annule')),
  encaisse_par       uuid references public.profils (id),
  encaisse_le        timestamptz,
  reference_externe  text,                       -- identifiant Stripe, n° de remise…
  cree_le            timestamptz not null default now()
);
create index paiements_course_idx on public.paiements (course_id);
create index paiements_client_idx on public.paiements (client_id, cree_le desc);
create index paiements_statut_idx on public.paiements (statut);

create table public.remboursements (
  id           uuid primary key default gen_random_uuid(),
  paiement_id  uuid not null references public.paiements (id),
  montant      numeric(10,2) not null check (montant > 0),
  motif        text not null check (char_length(motif) <= 500),
  cree_par     uuid references public.profils (id),
  cree_le      timestamptz not null default now()
);
create index remboursements_paiement_idx on public.remboursements (paiement_id);

-- Factures : numérotation continue, HT + TVA 10 % = TTC, pourboire sur sa ligne.
-- Les coordonnées sont copiées à l'émission : une facture ne change plus.
create table public.factures (
  id                  uuid primary key default gen_random_uuid(),
  numero              text not null unique,                  -- FA-2026-000001
  course_id           uuid not null references public.courses (id),
  nature              text not null default 'course' check (nature in ('course', 'frais_annulation')),
  client_id           uuid not null references public.profils (id),
  compte_pro_id       uuid references public.comptes_pro (id),
  destinataire_nom    text not null,
  destinataire_adresse text,
  date_emission       date not null,
  montant_ht          numeric(10,2) not null check (montant_ht >= 0),
  taux_tva            numeric(4,2)  not null,
  montant_tva         numeric(10,2) not null check (montant_tva >= 0),
  montant_ttc         numeric(10,2) not null check (montant_ttc >= 0),
  pourboire           numeric(10,2) not null default 0 check (pourboire >= 0),
  statut              text not null default 'emise' check (statut in ('emise', 'annulee')),
  pdf_chemin          text,
  cree_le             timestamptz not null default now(),
  constraint factures_totaux check (montant_ht + montant_tva = montant_ttc),
  unique (course_id, nature)
);
create index factures_client_idx on public.factures (client_id, date_emission desc);
create index factures_compte_pro_idx on public.factures (compte_pro_id) where compte_pro_id is not null;

-- Solde (crédits de parrainage, gestes commerciaux) : jamais négatif,
-- modifié uniquement par écritures passées par les fonctions serveur.
create table public.soldes (
  profil_id  uuid primary key references public.profils (id) on delete cascade,
  montant    numeric(10,2) not null default 0 check (montant >= 0),
  maj_le     timestamptz not null default now()
);

create table public.ecritures_solde (
  id         uuid primary key default gen_random_uuid(),
  profil_id  uuid not null references public.profils (id) on delete cascade,
  montant    numeric(10,2) not null check (montant <> 0),       -- + crédit / − débit
  motif      text not null check (char_length(motif) <= 300),
  course_id  uuid references public.courses (id),
  cree_par   uuid references public.profils (id),
  cree_le    timestamptz not null default now()
);
create index ecritures_solde_profil_idx on public.ecritures_solde (profil_id, cree_le desc);


-- #############################################################################
-- MODULE RH ET PAIE : salariés, contrats, paramètres de paie, bulletins,
--                     absences, temps de travail
-- #############################################################################

create table public.salaries (
  id                        uuid primary key default gen_random_uuid(),
  profil_id                 uuid unique references public.profils (id),
  matricule                 text not null unique,
  civilite                  text check (civilite in ('Madame', 'Monsieur')),
  prenom                    text not null,
  nom                       text not null,
  date_naissance            date,
  lieu_naissance            text,
  nationalite               text,
  numero_securite_sociale   text check (numero_securite_sociale is null or numero_securite_sociale ~ '^[12][0-9]{12}([0-9]{2})?$'),
  adresse                   text,
  code_postal               text,
  ville                     text,
  emploi                    text not null default 'Conducteur de VTC',
  qualification             text,
  niveau                    text,
  coefficient               text,
  convention_collective     text,
  type_contrat              text not null check (type_contrat in ('CDI', 'CDD', 'apprentissage')),
  temps                     text not null default 'plein' check (temps in ('plein', 'partiel')),
  date_entree               date not null,
  date_sortie               date,
  heures_mensuelles         numeric(6,2) not null default 151.67 check (heures_mensuelles > 0),
  salaire_base_mensuel      numeric(10,2) check (salaire_base_mensuel >= 0),
  taux_horaire              numeric(10,4) check (taux_horaire >= 0),
  taux_pas                  numeric(5,2) check (taux_pas between 0 and 60),    -- prélèvement à la source
  iban                      text,
  bic                       text,
  actif                     boolean not null default true,
  cree_le                   timestamptz not null default now(),
  maj_le                    timestamptz not null default now(),
  constraint salaries_dates check (date_sortie is null or date_sortie >= date_entree)
);

create table public.contrats (
  id               uuid primary key default gen_random_uuid(),
  salarie_id       uuid not null references public.salaries (id) on delete cascade,
  type             text not null check (type in ('CDI', 'CDD', 'apprentissage', 'avenant')),
  date_debut       date not null,
  date_fin         date,
  essai_fin        date,
  champs           jsonb not null default '{}'::jsonb,   -- valeurs reprises dans le modèle de contrat
  pdf_chemin       text,
  statut           text not null default 'brouillon' check (statut in ('brouillon', 'envoye', 'signe', 'termine')),
  signe_le         timestamptz,
  cree_le          timestamptz not null default now(),
  maj_le           timestamptz not null default now()
);
create index contrats_salarie_idx on public.contrats (salarie_id);

-- Constantes légales de l'année (plafond de la Sécurité sociale, SMIC…).
create table public.constantes_paie (
  annee                    integer primary key check (annee between 2020 and 2100),
  plafond_mensuel_ss       numeric(10,2) not null,
  smic_horaire             numeric(8,4) not null,
  valide_par_comptable     boolean not null default false,
  maj_le                   timestamptz not null default now()
);

-- Taux de cotisation par année, validés par l'expert-comptable.
create table public.parametres_paie (
  id               uuid primary key default gen_random_uuid(),
  annee            integer not null references public.constantes_paie (annee),
  code             text not null,
  libelle          text not null,
  section          text not null check (section in ('sante', 'accidents_travail', 'retraite', 'famille', 'chomage', 'autres', 'csg_crds', 'allegements')),
  assiette         text not null check (assiette in ('brut', 'tranche_1', 'tranche_2', 'csg_crds', 'forfait')),
  taux_salarial    numeric(7,4) not null default 0,
  taux_patronal    numeric(7,4) not null default 0,
  deductible       boolean not null default true,      -- CSG déductible ou non (net imposable)
  ordre            integer not null default 0,
  unique (annee, code)
);

create table public.bulletins (
  id                              uuid primary key default gen_random_uuid(),
  salarie_id                      uuid not null references public.salaries (id),
  periode                         date not null check (extract(day from periode) = 1),   -- 1er jour du mois
  date_paiement                   date,
  heures                          numeric(7,2) not null default 0,
  brut                            numeric(10,2) not null default 0,
  total_cotisations_salariales    numeric(10,2) not null default 0,
  total_cotisations_patronales    numeric(10,2) not null default 0,
  net_imposable                   numeric(10,2) not null default 0,
  net_social                      numeric(10,2) not null default 0,
  taux_pas                        numeric(5,2),
  montant_pas                     numeric(10,2) not null default 0,
  net_a_payer                     numeric(10,2) not null default 0,
  cout_employeur                  numeric(10,2) not null default 0,
  allegements                     numeric(10,2) not null default 0,
  cumuls                          jsonb not null default '{}'::jsonb,
  conges                          jsonb not null default '{}'::jsonb,
  statut                          text not null default 'brouillon' check (statut in ('brouillon', 'valide', 'envoye')),
  pdf_chemin                      text,
  valide_par                      uuid references public.profils (id),
  valide_le                       timestamptz,
  cree_le                         timestamptz not null default now(),
  maj_le                          timestamptz not null default now(),
  unique (salarie_id, periode)
);

create table public.bulletin_lignes (
  id                 uuid primary key default gen_random_uuid(),
  bulletin_id        uuid not null references public.bulletins (id) on delete cascade,
  ordre              integer not null,
  section            text not null,
  code               text,
  libelle            text not null,
  base               numeric(12,2),
  taux_salarial      numeric(7,4),
  montant_salarial   numeric(10,2),
  taux_patronal      numeric(7,4),
  montant_patronal   numeric(10,2)
);
create index bulletin_lignes_bulletin_idx on public.bulletin_lignes (bulletin_id, ordre);

create table public.absences (
  id          uuid primary key default gen_random_uuid(),
  salarie_id  uuid not null references public.salaries (id) on delete cascade,
  type        text not null check (type in ('conges_payes', 'maladie', 'accident_travail', 'sans_solde', 'autre')),
  debut       date not null,
  fin         date not null,
  jours       numeric(5,1) not null check (jours > 0),
  statut      text not null default 'demandee' check (statut in ('demandee', 'validee', 'refusee')),
  commentaire text,
  cree_le     timestamptz not null default now(),
  constraint absences_dates check (fin >= debut)
);
create index absences_salarie_idx on public.absences (salarie_id, debut);

create table public.temps_travail (
  id          uuid primary key default gen_random_uuid(),
  salarie_id  uuid not null references public.salaries (id) on delete cascade,
  jour        date not null,
  heures      numeric(4,2) not null check (heures between 0 and 24),
  source      text not null default 'saisie' check (source in ('courses', 'saisie')),
  cree_le     timestamptz not null default now(),
  unique (salarie_id, jour, source)
);


-- #############################################################################
-- MODULE SUPPORT : demandes, messages, objets trouvés, contact et devis du site
-- #############################################################################

create table public.demandes (
  id           uuid primary key default gen_random_uuid(),
  numero       text not null unique,                                   -- S-2026-000001
  auteur_id    uuid not null references public.profils (id),
  course_id    uuid references public.courses (id),
  type         text not null check (type in ('course', 'paiement', 'objet_perdu', 'compte', 'autre')),
  sujet        text not null check (char_length(sujet) between 3 and 200),
  statut       text not null default 'ouverte' check (statut in ('ouverte', 'en_cours', 'resolue', 'fermee')),
  assignee_a   uuid references public.profils (id),
  cree_le      timestamptz not null default now(),
  maj_le       timestamptz not null default now()
);
create index demandes_auteur_idx on public.demandes (auteur_id, cree_le desc);
create index demandes_statut_idx on public.demandes (statut);
create index demandes_course_idx on public.demandes (course_id);
create index demandes_assignee_idx on public.demandes (assignee_a);

-- Messages : conversation client ↔ chauffeur d'une course, ou fil d'une demande.
create table public.messages (
  id                    uuid primary key default gen_random_uuid(),
  course_id             uuid references public.courses (id) on delete cascade,
  demande_id            uuid references public.demandes (id) on delete cascade,
  auteur_id             uuid not null references public.profils (id),
  contenu               text check (char_length(contenu) <= 2000),
  piece_jointe_chemin   text,
  lu_le                 timestamptz,
  cree_le               timestamptz not null default now(),
  constraint messages_un_fil check ((course_id is null) <> (demande_id is null)),
  constraint messages_non_vide check (contenu is not null or piece_jointe_chemin is not null)
);
create index messages_course_idx on public.messages (course_id, cree_le) where course_id is not null;
create index messages_demande_idx on public.messages (demande_id, cree_le) where demande_id is not null;
create index messages_auteur_idx on public.messages (auteur_id);

create table public.objets_trouves (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid references public.courses (id),
  description     text not null check (char_length(description) <= 1000),
  lieu_stockage   text,
  statut          text not null default 'trouve' check (statut in ('trouve', 'signale', 'rendu', 'detruit')),
  declare_par     uuid references public.profils (id),
  cree_le         timestamptz not null default now(),
  maj_le          timestamptz not null default now()
);
create index objets_trouves_course_idx on public.objets_trouves (course_id);

-- Formulaire de contact du site (visiteurs sans compte acceptés).
create table public.messages_contact (
  id         uuid primary key default gen_random_uuid(),
  nom        text not null check (char_length(nom) between 2 and 120),
  email      text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  telephone  text check (char_length(telephone) <= 30),
  sujet      text not null check (char_length(sujet) between 2 and 200),
  message    text not null check (char_length(message) between 5 and 4000),
  traite     boolean not null default false,
  cree_le    timestamptz not null default now()
);

-- Demandes de devis : longues distances, mise à disposition et autres activités du Kbis.
create table public.demandes_devis (
  id               uuid primary key default gen_random_uuid(),
  service          text not null check (service in (
                     'longue_distance', 'mise_a_disposition', 'amo', 'sous_traitance_batiment',
                     'jardinage', 'architecture_interieure', 'nettoyage', 'autre')),
  nom              text not null check (char_length(nom) between 2 and 120),
  email            text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  telephone        text check (char_length(telephone) <= 30),
  adresse          text check (char_length(adresse) <= 300),
  date_souhaitee   date,
  description      text not null check (char_length(description) between 5 and 4000),
  statut           text not null default 'nouvelle' check (statut in ('nouvelle', 'devis_envoye', 'acceptee', 'refusee')),
  montant          numeric(10,2) check (montant >= 0),
  cree_le          timestamptz not null default now(),
  maj_le           timestamptz not null default now()
);


-- #############################################################################
-- MODULE ADMINISTRATION : questions fréquentes, plateformes, campagnes
-- (l'identité de la société et les paramètres sont posés à la migration 1,
--  le journal des modifications est dans le schéma privé)
-- #############################################################################

create table public.faq (
  id          uuid primary key default gen_random_uuid(),
  theme       text not null check (theme in ('commande', 'paiement', 'annulation', 'compte', 'chauffeurs', 'entreprises', 'autre')),
  ordre       integer not null default 0,
  question_fr text not null,
  reponse_fr  text not null,
  question_en text,
  reponse_en  text,
  publie      boolean not null default true,
  maj_le      timestamptz not null default now()
);

-- Relevés hebdomadaires des plateformes (Bolt…) pour la comptabilité.
create table public.releves_plateformes (
  id               uuid primary key default gen_random_uuid(),
  plateforme       text not null check (plateforme in ('bolt', 'uber', 'heetch', 'autre')),
  chauffeur_id     uuid references public.chauffeurs (id),
  debut            date not null,
  fin              date not null,
  nb_courses       integer check (nb_courses >= 0),
  montant_trajets  numeric(10,2) not null default 0,
  frais_service    numeric(10,2) not null default 0,
  pourboires       numeric(10,2) not null default 0,
  ajustements      numeric(10,2) not null default 0,
  montant_net      numeric(10,2) not null default 0,
  fichier_chemin   text,
  cree_par         uuid references public.profils (id),
  cree_le          timestamptz not null default now(),
  constraint releves_dates check (fin >= debut)
);
create index releves_plateformes_chauffeur_idx on public.releves_plateformes (chauffeur_id, debut desc);

-- Notifications groupées (marketing, informations).
create table public.campagnes (
  id          uuid primary key default gen_random_uuid(),
  titre       text not null check (char_length(titre) <= 120),
  message     text not null check (char_length(message) <= 1000),
  cible       text not null check (cible in ('tous', 'clients', 'chauffeurs')),
  canal       text not null check (canal in ('application', 'email', 'whatsapp')),
  envoyee_le  timestamptz,
  cree_par    uuid references public.profils (id),
  cree_le     timestamptz not null default now()
);


-- #############################################################################
-- INDEX SUR TOUTES LES CLÉS ÉTRANGÈRES
-- #############################################################################
-- Chaque colonne qui pointe vers une autre table reçoit un index (si aucun index
-- existant ne commence déjà par elle) : jointures rapides et suppressions en
-- cascade sans parcours complet. Évite l'alerte « clé étrangère sans index ».
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as table_cible,
           a.attname           as colonne,
           c.conrelid          as relid,
           a.attnum            as numcol
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and array_length(c.conkey, 1) = 1
      and c.connamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
      )
  loop
    execute format('create index if not exists %I on %s (%I)',
                   left(replace(r.table_cible::text, 'public.', '') || '_' || r.colonne || '_fk_idx', 63),
                   r.table_cible, r.colonne);
  end loop;
end $$;
