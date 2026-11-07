-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Environnement local qui imite Supabase
-- -----------------------------------------------------------------------------
-- Sert UNIQUEMENT aux tests sur un Postgres local (jamais appliqué en ligne).
-- Reproduit ce que Supabase fournit avant nos migrations :
--   - les rôles de l'API : anon (visiteur), authenticated (connecté),
--     service_role (serveur), supabase_auth_admin (service d'inscription) ;
--   - les droits par défaut de Supabase sur le schéma public (tout est accordé
--     à anon et authenticated : nos migrations doivent donc tout retirer
--     explicitement, exactement comme en ligne) ;
--   - le schéma auth (comptes, sessions, jetons, identités ; fonctions
--     uid/role/jwt) ;
--   - le schéma storage (buckets, objects, fonctions de chemin) ;
--   - la publication du temps réel « supabase_realtime ».
-- Les définitions reprennent celles de Supabase (auth.uid() à l'identique).
-- =============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Rôles de l'API
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Droits par défaut de Supabase sur le schéma public
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Schéma auth (comptes)
-- ---------------------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;

create table auth.users (
  instance_id          uuid,
  id                   uuid primary key default gen_random_uuid(),
  aud                  varchar(255),
  role                 varchar(255),
  email                varchar(255),
  encrypted_password   varchar(255),
  email_confirmed_at   timestamptz,
  raw_app_meta_data    jsonb,
  raw_user_meta_data   jsonb,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  phone                text unique default null,
  phone_confirmed_at   timestamptz,
  last_sign_in_at      timestamptz,
  is_anonymous         boolean not null default false,
  -- Jetons et marques du service de connexion (mêmes noms et types qu'en
  -- ligne), effacés par la suppression d'un compte (migration 27)
  confirmation_token          varchar(255),
  recovery_token              varchar(255),
  email_change_token_new      varchar(255),
  email_change                varchar(255),
  email_change_token_current  varchar(255) default '',
  phone_change                text default '',
  phone_change_token          varchar(255) default '',
  reauthentication_token      varchar(255) default '',
  banned_until                timestamptz,
  deleted_at                  timestamptz
);
grant select, insert, update, delete on auth.users to supabase_auth_admin;

-- Sessions, jetons de renouvellement, identités, facteurs, jetons à usage
-- unique : colonnes utiles aux essais, types identiques à Supabase
create table auth.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  user_agent  text
);
create table auth.refresh_tokens (
  instance_id  uuid,
  id           bigserial primary key,
  token        varchar(255),
  user_id      varchar(255),
  revoked      boolean,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  parent       varchar(255),
  session_id   uuid references auth.sessions (id) on delete cascade
);
create table auth.identities (
  provider_id    text not null,
  user_id        uuid not null references auth.users (id) on delete cascade,
  identity_data  jsonb not null,
  provider       text not null,
  last_sign_in_at timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  email          text generated always as (lower(identity_data ->> 'email')) stored,
  id             uuid primary key default gen_random_uuid()
);
create table auth.mfa_factors (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  friendly_name  text,
  factor_type    text not null,
  status         text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  secret         text
);
create table auth.one_time_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  token_type  text not null,
  token_hash  text not null,
  relates_to  text not null,
  created_at  timestamp not null default now(),
  updated_at  timestamp not null default now()
);
grant select, insert, update, delete on auth.sessions, auth.refresh_tokens, auth.identities, auth.mfa_factors,
  auth.one_time_tokens to supabase_auth_admin;
grant usage on sequence auth.refresh_tokens_id_seq to supabase_auth_admin;

-- Définitions identiques à Supabase
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.jwt()
  to anon, authenticated, service_role, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 4. Schéma storage (fichiers)
-- ---------------------------------------------------------------------------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id                  text primary key,
  name                text not null,
  owner               uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  public              boolean default false,
  avif_autodetection  boolean default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  owner_id            text
);
create unique index bname on storage.buckets (name);

create table storage.objects (
  id                uuid primary key default gen_random_uuid(),
  bucket_id         text references storage.buckets (id),
  name              text,
  owner             uuid,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  last_accessed_at  timestamptz default now(),
  metadata          jsonb,
  path_tokens       text[] generated always as (string_to_array(name, '/')) stored,
  version           text,
  owner_id          text,
  user_metadata     jsonb
);
create unique index bucketid_objname on storage.objects (bucket_id, name);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- Fonctions de chemin, identiques à Supabase
create or replace function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
create or replace function storage.filename(name text) returns text language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;
create or replace function storage.extension(name text) returns text language plpgsql as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Temps réel
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
