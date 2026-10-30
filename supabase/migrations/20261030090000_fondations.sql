-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 1/8 : FONDATIONS
-- -----------------------------------------------------------------------------
-- Ce fichier pose ce dont tous les modules ont besoin :
--   1. le schéma « prive » : tout ce que le site ne doit jamais lire ni écrire
--      directement (journal, compteurs). Seules les fonctions serveur y accèdent ;
--   2. l'heure de Paris (Supabase tourne en UTC, les règles métier non) ;
--   3. la numérotation continue (courses, factures, demandes de support) ;
--   4. le journal des modifications : qui a changé quoi, et quand ;
--   5. la mise à jour automatique des dates « maj_le » ;
--   6. l'identité de la société (une seule ligne, reprise partout) ;
--   7. les paramètres de la plateforme (une seule ligne, modifiable par l'admin).
-- Convention : noms en français, sans accents, en minuscules_avec_tirets_bas.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Schéma privé
-- ---------------------------------------------------------------------------
-- L'API de Supabase n'expose que le schéma « public ». Tout ce qui est rangé dans
-- « prive » est donc invisible depuis le navigateur, même avec une clé valide.
create schema if not exists prive;
comment on schema prive is
  'Données et fonctions internes (journal, compteurs) : jamais accessibles depuis le site, seulement via les fonctions serveur.';
revoke all on schema prive from public;


-- ---------------------------------------------------------------------------
-- 2. Heure de Paris
-- ---------------------------------------------------------------------------
-- Les majorations de nuit, le dimanche, les jours fériés et l'année des numéros
-- se calculent à l'heure légale française, été comme hiver.
create or replace function prive.heure_paris(p_instant timestamptz default now())
returns timestamp
language sql
stable
set search_path = ''
as $$
  select p_instant at time zone 'Europe/Paris'
$$;
comment on function prive.heure_paris(timestamptz) is
  'Convertit un instant en date et heure locales de Paris (gère l''heure d''été).';


-- ---------------------------------------------------------------------------
-- 3. Numérotation continue
-- ---------------------------------------------------------------------------
-- Une facture doit porter un numéro continu, sans trou ni doublon.
-- Le compteur est incrémenté dans la même transaction que la création du
-- document : si la création échoue, l'incrément est annulé avec elle.
create table prive.compteurs (
  nom    text    not null,                 -- 'course', 'facture', 'demande'
  annee  integer not null,                 -- année civile, à l'heure de Paris
  valeur bigint  not null default 0 check (valeur >= 0),
  primary key (nom, annee)
);
comment on table prive.compteurs is 'Dernier numéro attribué, par type de document et par année.';

create or replace function prive.prochain_numero(p_nom text, p_prefixe text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_annee  integer := extract(year from prive.heure_paris())::integer;
  v_valeur bigint;
begin
  -- « on conflict … do update » pose un verrou sur la ligne : deux créations
  -- simultanées reçoivent forcément deux numéros différents et consécutifs.
  insert into prive.compteurs (nom, annee, valeur)
  values (p_nom, v_annee, 1)
  on conflict (nom, annee) do update set valeur = prive.compteurs.valeur + 1
  returning valeur into v_valeur;

  -- Exemple : FA-2026-000001
  return p_prefixe || '-' || v_annee || '-' || lpad(v_valeur::text, 6, '0');
end;
$$;
comment on function prive.prochain_numero(text, text) is
  'Renvoie le numéro suivant (préfixe-année-000001) pour un type de document, sans trou ni doublon.';


-- ---------------------------------------------------------------------------
-- 4. Journal des modifications
-- ---------------------------------------------------------------------------
create table prive.journal (
  id          bigint generated always as identity primary key,
  cree_le     timestamptz not null default now(),
  acteur_id   uuid,              -- utilisateur connecté (null = traitement automatique)
  acteur_role text,              -- son rôle au moment de l'action
  action      text not null,     -- INSERT / UPDATE / DELETE, ou action métier nommée
  table_cible text,
  ligne_id    text,
  avant       jsonb,             -- état avant (UPDATE, DELETE)
  apres       jsonb              -- état après (INSERT, UPDATE)
);
create index journal_table_ligne_idx on prive.journal (table_cible, ligne_id);
create index journal_date_idx on prive.journal (cree_le desc);
comment on table prive.journal is 'Qui a modifié quoi, et quand. Alimenté par déclencheurs et par les fonctions métier.';

-- Déclencheur générique, branché sur les tables sensibles (migration 5).
-- Il s'exécute avec les droits du propriétaire : l'utilisateur n'a besoin
-- d'aucun droit sur le journal pour y être inscrit, et ne peut pas l'effacer.
-- Création et suppression : la ligne entière est gardée. Modification :
-- seules les colonnes qui ont changé sont gardées (« prix_total : 32,50 →
-- 28,00 »), ce qui garde le journal lisible et léger.
create or replace function prive.journaliser()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ancien  jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_nouveau jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_ligne   jsonb := coalesce(v_nouveau, v_ancien);
  v_avant   jsonb := v_ancien;
  v_apres   jsonb := v_nouveau;
  v_cle     text;
begin
  if tg_op = 'UPDATE' then
    v_avant := '{}'::jsonb;
    v_apres := '{}'::jsonb;
    for v_cle in select jsonb_object_keys(v_nouveau) loop
      if v_cle <> 'maj_le' and (v_ancien -> v_cle) is distinct from (v_nouveau -> v_cle) then
        v_avant := v_avant || jsonb_build_object(v_cle, v_ancien -> v_cle);
        v_apres := v_apres || jsonb_build_object(v_cle, v_nouveau -> v_cle);
      end if;
    end loop;
    if v_apres = '{}'::jsonb then
      return new;                                   -- rien de significatif n'a changé
    end if;
  end if;

  insert into prive.journal (acteur_id, acteur_role, action, table_cible, ligne_id, avant, apres)
  values (
    auth.uid(),
    (select p.role from public.profils p where p.id = auth.uid()),
    tg_op,
    tg_table_name,
    -- identifiant de la ligne, selon la clé de la table
    coalesce(v_ligne ->> 'id', v_ligne ->> 'type', v_ligne ->> 'annee', v_ligne ->> 'jour',
             v_ligne ->> 'profil_id', v_ligne ->> 'chauffeur_id'),
    v_avant,
    v_apres
  );
  return coalesce(new, old);
end;
$$;

-- Inscription d'une action métier nommée (ex. « attribution_manuelle »).
-- Écrite en plpgsql : la table des profils n'existe qu'à la migration 2, et
-- plpgsql ne vérifie les tables qu'à l'exécution (le SQL simple, dès la création).
create or replace function prive.journaliser_action(
  p_action text, p_table text, p_ligne_id text, p_details jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into prive.journal (acteur_id, acteur_role, action, table_cible, ligne_id, apres)
  values (
    auth.uid(),
    (select p.role from public.profils p where p.id = auth.uid()),
    p_action, p_table, p_ligne_id, p_details
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. Date de dernière modification automatique
-- ---------------------------------------------------------------------------
create or replace function prive.maj_horodatage()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.maj_le := now();
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. Codes de parrainage
-- ---------------------------------------------------------------------------
-- 8 caractères sans lettres ni chiffres ambigus (pas de 0/O, 1/I/L).
create or replace function prive.nouveau_code_parrainage()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1);
    end loop;
    -- La table des profils est créée à la migration 2 ; la vérification
    -- n'est faite qu'à l'exécution, quand elle existe.
    exit when not exists (select 1 from public.profils p where p.code_parrainage = v_code);
  end loop;
  return v_code;
end;
$$;


-- ---------------------------------------------------------------------------
-- 7. Identité de la société (une seule ligne)
-- ---------------------------------------------------------------------------
-- Saisie une fois ici, reprise sur les factures, feuilles de route, bulletins,
-- contrats et pages légales : plus jamais deux raisons sociales différentes.
create table public.societe (
  id                       smallint primary key default 1 check (id = 1),
  raison_sociale           text not null,
  forme_juridique          text,
  capital                  numeric(12,2) check (capital >= 0),
  siren                    text check (siren ~ '^[0-9]{9}$'),
  siret                    text check (siret ~ '^[0-9]{14}$'),
  rcs                      text,
  code_ape                 text,
  tva_intracommunautaire   text,
  numero_urssaf            text,
  registre_vtc_numero      text,          -- n° d'inscription au registre des exploitants VTC
  adresse                  text,
  code_postal              text,
  ville                    text,
  pays                     text not null default 'France',
  representant_nom         text,
  representant_qualite     text,
  telephone                text,
  whatsapp                 text,
  email                    text,
  site_web                 text,
  mentions_factures        text,          -- mentions libres en pied de facture
  maj_le                   timestamptz not null default now()
);
comment on table public.societe is 'Identité légale de LOC RÉACTION S.A.S : une seule ligne, reprise sur tous les documents.';


-- ---------------------------------------------------------------------------
-- 8. Paramètres de la plateforme (une seule ligne)
-- ---------------------------------------------------------------------------
create table public.parametres (
  id                                 smallint primary key default 1 check (id = 1),
  -- Calcul des distances : la distance à vol d'oiseau est multipliée par ce
  -- coefficient pour approcher la distance par la route (1,30 = +30 %).
  coefficient_detour                 numeric(4,2) not null default 1.30 check (coefficient_detour between 1 and 2),
  vitesse_moyenne_kmh                numeric(5,1) not null default 30   check (vitesse_moyenne_kmh between 5 and 130),
  -- Dispatch
  delai_reponse_chauffeur_s          integer not null default 30  check (delai_reponse_chauffeur_s between 10 and 300),
  delai_min_planification_min        integer not null default 60  check (delai_min_planification_min >= 0),
  recherche_planifiee_avant_min      integer not null default 45  check (recherche_planifiee_avant_min >= 5),
  -- Annulation et attente
  annulation_gratuite_planifiee_min  integer not null default 120 check (annulation_gratuite_planifiee_min >= 0),
  attente_gratuite_min               integer not null default 5   check (attente_gratuite_min >= 0),
  -- Zone desservie : Île-de-France et sud de l'Oise (rectangle), au-delà sur devis
  distance_max_km                    numeric(6,1) not null default 150 check (distance_max_km > 0),
  zone_lat_min                       numeric(8,5) not null default 48.10,
  zone_lat_max                       numeric(8,5) not null default 49.45,
  zone_lng_min                       numeric(8,5) not null default 1.40,
  zone_lng_max                       numeric(8,5) not null default 3.60,
  -- Fiscalité : TVA du transport de personnes
  taux_tva_transport                 numeric(4,2) not null default 10.00 check (taux_tva_transport between 0 and 30),
  -- Parrainage (montants crédités sur le solde, 0 = désactivé)
  recompense_parrain                 numeric(8,2) not null default 0 check (recompense_parrain >= 0),
  recompense_filleul                 numeric(8,2) not null default 0 check (recompense_filleul >= 0),
  maj_le                             timestamptz not null default now(),
  constraint parametres_zone check (zone_lat_min < zone_lat_max and zone_lng_min < zone_lng_max)
);
comment on table public.parametres is 'Réglages de la plateforme (une seule ligne), modifiables depuis l''administration.';
