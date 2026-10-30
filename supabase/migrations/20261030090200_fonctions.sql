-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 3/8 : FONCTIONS SERVEUR
-- -----------------------------------------------------------------------------
-- Règle d'or de la version 2 : l'argent, les statuts et les rôles ne changent
-- QUE par ces fonctions, jamais directement depuis le navigateur.
-- Chaque fonction :
--   • s'exécute avec les droits du propriétaire (security definer) mais
--     vérifie elle-même qui l'appelle (auth.uid(), rôle, appartenance) ;
--   • a un chemin de recherche vide (search_path = '') : chaque objet est
--     nommé avec son schéma, impossible de la détourner ;
--   • renvoie des messages d'erreur en français, affichables tels quels.
-- Les droits d'exécution (qui peut appeler quoi) sont posés à la migration 4.
--
-- Sommaire
--   A. Rôles                   E. Commande               I. Paiements et factures
--   B. Inscription             F. Attribution            J. Chauffeurs et flotte
--   C. Notifications           G. Déroulé de la course   K. Administration
--   D. Géographie et prix      H. Annulation, notes      L. Support
-- =============================================================================


-- #############################################################################
-- A. RÔLES
-- #############################################################################

-- Rôle de l'utilisateur connecté (null si non connecté ou bloqué).
create or replace function public.mon_role()
returns text
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profils p where p.id = auth.uid() and p.statut = 'actif'
$$;

create or replace function public.est_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profils p
                 where p.id = auth.uid() and p.role = 'admin' and p.statut = 'actif')
$$;

-- Chauffeur validé et compte actif.
create or replace function public.est_chauffeur_actif()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profils p
                 join public.chauffeurs c on c.id = p.id
                 where p.id = auth.uid() and p.role = 'chauffeur' and p.statut = 'actif' and c.statut = 'valide')
$$;

-- L'utilisateur connecté peut-il voir cette course en entier ? (client,
-- chauffeur attribué, gestionnaire du compte pro, administration)
-- Un chauffeur qui a seulement reçu la demande, ou qui parcourt les
-- réservations libres, n'en voit qu'un résumé sans les coordonnées du client
-- (fonctions demande_recue et reservations_disponibles).
create or replace function public.peut_voir_course(p_course uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.est_admin()
      or exists (
        select 1 from public.courses c
        where c.id = p_course
          and (c.client_id = auth.uid()
               or c.chauffeur_id = auth.uid()
               or (c.compte_pro_id is not null and exists (
                     select 1 from public.comptes_pro_membres m
                     where m.compte_pro_id = c.compte_pro_id and m.profil_id = auth.uid() and m.role = 'gestionnaire')))
      )
$$;


-- #############################################################################
-- B. INSCRIPTION
-- #############################################################################

-- Chaque nouveau compte reçoit un profil « client », quel que soit ce qui a été
-- envoyé dans le formulaire. Prénom, nom, téléphone et langue sont repris s'ils
-- sont fournis ; le code de parrainage saisi relie le filleul à son parrain.
create or replace function prive.creer_profil()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_tel      text  := nullif(regexp_replace(coalesce(v_meta ->> 'telephone', new.phone, ''), '[^0-9+]', '', 'g'), '');
  v_code     text  := nullif(upper(trim(coalesce(v_meta ->> 'code_parrain', ''))), '');
  v_parrain  uuid;
begin
  -- Supabase enregistre les numéros sans « + » : on le remet.
  if v_tel is not null and left(v_tel, 1) <> '+' then
    v_tel := '+' || v_tel;
  end if;
  if v_tel is not null and v_tel !~ '^\+[1-9][0-9]{6,14}$' then
    v_tel := null;
  end if;

  insert into public.profils (id, role, prenom, nom, email, telephone, langue)
  values (
    new.id,
    'client',                                                   -- jamais le rôle demandé
    left(trim(coalesce(v_meta ->> 'prenom', '')), 80),
    left(trim(coalesce(v_meta ->> 'nom', '')), 80),
    new.email,
    v_tel,
    case when v_meta ->> 'langue' in ('fr', 'en') then v_meta ->> 'langue' else 'fr' end
  )
  on conflict (id) do nothing;

  insert into public.soldes (profil_id) values (new.id) on conflict (profil_id) do nothing;

  if v_code is not null then
    select p.id into v_parrain from public.profils p where p.code_parrainage = v_code and p.id <> new.id;
    if v_parrain is not null then
      insert into public.parrainages (parrain_id, filleul_id) values (v_parrain, new.id)
      on conflict (filleul_id) do nothing;
    end if;
  end if;

  return new;
end;
$$;

create trigger creer_profil
  after insert on auth.users
  for each row execute function prive.creer_profil();

-- Si l'e-mail ou le téléphone de connexion change, le profil suit.
create or replace function prive.synchroniser_contact()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_tel text := nullif(regexp_replace(coalesce(new.phone, ''), '[^0-9+]', '', 'g'), '');
begin
  if v_tel is not null and left(v_tel, 1) <> '+' then
    v_tel := '+' || v_tel;
  end if;
  if new.email is distinct from old.email or new.phone is distinct from old.phone then
    update public.profils p
       set email     = new.email,
           telephone = case when v_tel ~ '^\+[1-9][0-9]{6,14}$' then v_tel else p.telephone end
     where p.id = new.id;
  end if;
  return new;
end;
$$;

create trigger synchroniser_contact
  after update of email, phone on auth.users
  for each row execute function prive.synchroniser_contact();


-- #############################################################################
-- C. NOTIFICATIONS
-- #############################################################################

create or replace function prive.notifier(
  p_destinataire uuid, p_type text, p_titre text, p_message text, p_lien text default null
)
returns void
language sql security definer set search_path = ''
as $$
  -- Une information manquante ne doit jamais faire échouer l'opération qui
  -- notifie : un titre ou un message vide est remplacé.
  insert into public.notifications (destinataire_id, type, titre, message, lien)
  select p_destinataire, p_type, coalesce(left(p_titre, 120), 'LOC RÉACTION'), coalesce(left(p_message, 1000), ''), p_lien
  where p_destinataire is not null;
$$;

create or replace function prive.notifier_admins(
  p_type text, p_titre text, p_message text, p_lien text default null
)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (destinataire_id, type, titre, message, lien)
  select p.id, p_type, coalesce(left(p_titre, 120), 'LOC RÉACTION'), coalesce(left(p_message, 1000), ''), p_lien
  from public.profils p
  where p.role = 'admin' and p.statut = 'actif';
$$;

-- Trace horodatée d'une étape de course.
create or replace function prive.evenement(p_course uuid, p_type text, p_details jsonb default null)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.evenements_course (course_id, type, acteur_id, details)
  values (p_course, p_type, auth.uid(), p_details);
$$;

-- Montant en euros à la française : 1234.5 → « 1 234,50 € ».
create or replace function prive.euros(p_montant numeric)
returns text
language sql immutable set search_path = ''
as $$
  select replace(replace(to_char(coalesce(p_montant, 0), 'FM999,999,990.00'), ',', ' '), '.', ',') || ' €'
$$;


-- #############################################################################
-- D. GÉOGRAPHIE ET PRIX
-- #############################################################################

-- Distance à vol d'oiseau entre deux points (formule de haversine), en km.
create or replace function prive.distance_km(
  p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric
)
returns numeric
language sql immutable set search_path = ''
as $$
  select (6371 * 2 * asin(sqrt(
           power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
         + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8))
           * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2)
         )))::numeric
$$;

-- Zone (aéroport, gare, ville) qui contient ce point : la plus précise
-- d'abord (une gare située dans une ville l'emporte sur la ville).
create or replace function prive.zone_de(p_lat numeric, p_lng numeric)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select z.id
  from public.zones z
  where z.active
    and prive.distance_km(p_lat, p_lng, z.latitude, z.longitude) <= z.rayon_km
  order by z.rayon_km, prive.distance_km(p_lat, p_lng, z.latitude, z.longitude)
  limit 1
$$;

create or replace function prive.dans_zone_desservie(p_lat numeric, p_lng numeric)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.parametres p
    where p.id = 1
      and p_lat between p.zone_lat_min and p.zone_lat_max
      and p_lng between p.zone_lng_min and p.zone_lng_max
  )
$$;

-- Tarif en vigueur pour une catégorie à une date donnée (le plus récent).
create or replace function prive.tarif_en_vigueur(p_categorie uuid, p_jour date)
returns public.tarifs
language sql stable security definer set search_path = ''
as $$
  select t.*
  from public.tarifs t
  where t.categorie_id = p_categorie
    and t.valide_du <= p_jour
    and (t.valide_au is null or t.valide_au >= p_jour)
  order by t.valide_du desc
  limit 1
$$;

-- Majoration applicable à un instant : la plus forte (non cumulables).
create or replace function prive.majoration_applicable(
  p_instant timestamptz, out type text, out pourcentage numeric
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_local  timestamp := prive.heure_paris(p_instant);
  v_heure  time      := v_local::time;
  v_jour   date      := v_local::date;
  r        record;
begin
  type := null;
  pourcentage := 0;
  for r in select m.* from public.majorations m where m.active and m.pourcentage > 0 loop
    if (r.type = 'ferie' and exists (select 1 from public.jours_feries j where j.jour = v_jour))
       or (r.type = 'dimanche' and extract(isodow from v_local) = 7)
       or (r.type = 'nuit' and (
             (r.heure_debut <= r.heure_fin and v_heure >= r.heure_debut and v_heure < r.heure_fin)
          or (r.heure_debut >  r.heure_fin and (v_heure >= r.heure_debut or v_heure < r.heure_fin))))
    then
      if r.pourcentage > pourcentage then
        type := r.type;
        pourcentage := r.pourcentage;
      end if;
    end if;
  end loop;
end;
$$;

-- Code promo : remise accordée pour ce client et ce montant, ou motif du refus.
create or replace function prive.remise_promo(
  p_code text, p_client uuid, p_montant numeric,
  out code_id uuid, out remise numeric, out message text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_code        public.codes_promo;
  v_total       integer;
  v_par_client  integer;
begin
  remise := 0;
  select * into v_code from public.codes_promo c where c.code = upper(trim(p_code));
  if v_code.id is null or not v_code.actif then
    message := 'Ce code promo n''existe pas.'; return;
  end if;
  if v_code.debut is not null and now() < v_code.debut then
    message := 'Ce code promo n''est pas encore valable.'; return;
  end if;
  if v_code.fin is not null and now() > v_code.fin then
    message := 'Ce code promo a expiré.'; return;
  end if;
  if p_montant < v_code.minimum_course then
    message := 'Ce code est valable à partir de ' || prive.euros(v_code.minimum_course) || '.'; return;
  end if;
  select count(*) into v_total from public.utilisations_promo u where u.code_promo_id = v_code.id;
  if v_code.utilisations_max is not null and v_total >= v_code.utilisations_max then
    message := 'Ce code promo n''est plus disponible.'; return;
  end if;
  select count(*) into v_par_client from public.utilisations_promo u
   where u.code_promo_id = v_code.id and u.client_id = p_client;
  if v_par_client >= v_code.utilisations_par_client then
    message := 'Vous avez déjà utilisé ce code promo.'; return;
  end if;
  code_id := v_code.id;
  remise  := case when v_code.type = 'pourcentage'
                  then round(p_montant * v_code.valeur / 100, 2)
                  else least(v_code.valeur, p_montant) end;
  message := 'Code promo appliqué.';
end;
$$;

-- Calcul complet du prix (prix fixe annoncé au client).
--   distance = somme des tronçons (départ → arrêts → arrivée) × coefficient de détour
--   durée    = distance ÷ vitesse moyenne
--   prix     = forfait entre deux zones, sinon max(minimum, prise en charge + km + minutes)
--              mise à disposition : tarif horaire × heures
--   + majoration (nuit, dimanche, férié ; pas sur les forfaits) + option chauffeuse − code promo
create or replace function prive.calculer_prix(
  p_categorie_id       uuid,
  p_depart_lat         numeric, p_depart_lng  numeric,
  p_arrivee_lat        numeric, p_arrivee_lng numeric,
  p_arrets             jsonb,                 -- [{ "lat": …, "lng": … }, …] dans l'ordre
  p_quand              timestamptz,
  p_type               text,                  -- immediate | planifiee | mise_a_disposition
  p_duree_mad          numeric,               -- heures (mise à disposition)
  p_option_chauffeuse  boolean,
  p_code_promo         text,
  p_client_id          uuid                   -- null pour un visiteur : pas de code promo
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_param      public.parametres;
  v_categorie  public.categories;
  v_tarif      public.tarifs;
  v_forfait    public.forfaits;
  v_arret      jsonb;
  v_lat        numeric := p_depart_lat;
  v_lng        numeric := p_depart_lng;
  v_distance   numeric := 0;
  v_duree      integer;
  v_base       numeric;
  v_maj_type   text;
  v_maj_pct    numeric := 0;
  v_supplement numeric := 0;
  v_sous_total numeric;
  v_promo      record;
  v_hors_zone  boolean;
  v_nb_arrets  integer := 0;
begin
  -- Pas de code promo par défaut
  select null::uuid as code_id, 0::numeric as remise, null::text as message into v_promo;

  -- Contrôles d'entrée
  if p_depart_lat is null or p_depart_lng is null or p_arrivee_lat is null or p_arrivee_lng is null
     or abs(p_depart_lat) > 90 or abs(p_arrivee_lat) > 90 or abs(p_depart_lng) > 180 or abs(p_arrivee_lng) > 180 then
    raise exception 'Adresse de départ ou d''arrivée invalide.';
  end if;
  if p_type not in ('immediate', 'planifiee', 'mise_a_disposition') then
    raise exception 'Type de course inconnu.';
  end if;

  select * into v_param from public.parametres where id = 1;
  select * into v_categorie from public.categories c where c.id = p_categorie_id and c.active;
  if v_categorie.id is null then
    raise exception 'Catégorie de véhicule inconnue ou indisponible.';
  end if;
  v_tarif := prive.tarif_en_vigueur(p_categorie_id, prive.heure_paris(p_quand)::date);
  if v_tarif.id is null then
    raise exception 'Aucun tarif n''est en vigueur pour cette date.';
  end if;

  -- Distance : départ → arrêts → arrivée
  if p_arrets is not null and jsonb_typeof(p_arrets) = 'array' then
    v_nb_arrets := jsonb_array_length(p_arrets);
    if v_nb_arrets > 5 then
      raise exception 'Cinq arrêts au maximum.';
    end if;
    for v_arret in select value from jsonb_array_elements(p_arrets) loop
      if (v_arret ->> 'lat') is null or (v_arret ->> 'lng') is null then
        raise exception 'Un arrêt n''a pas d''adresse valide.';
      end if;
      v_distance := v_distance + prive.distance_km(v_lat, v_lng, (v_arret ->> 'lat')::numeric, (v_arret ->> 'lng')::numeric);
      v_lat := (v_arret ->> 'lat')::numeric;
      v_lng := (v_arret ->> 'lng')::numeric;
    end loop;
  end if;
  v_distance := round((v_distance + prive.distance_km(v_lat, v_lng, p_arrivee_lat, p_arrivee_lng)) * v_param.coefficient_detour, 2);
  v_duree    := ceil(v_distance / v_param.vitesse_moyenne_kmh * 60)::integer;

  -- Zone desservie (Île-de-France et sud de l'Oise) et distance maximale
  v_hors_zone := not (prive.dans_zone_desservie(p_depart_lat, p_depart_lng)
                      and prive.dans_zone_desservie(p_arrivee_lat, p_arrivee_lng))
                 or v_distance > v_param.distance_max_km;

  -- Prix de base
  if p_type = 'mise_a_disposition' then
    if v_tarif.prix_heure_mad is null then
      raise exception 'La mise à disposition n''est pas encore proposée.';
    end if;
    if p_duree_mad is null or p_duree_mad <= 0 or p_duree_mad > 24 then
      raise exception 'Indiquez une durée de mise à disposition entre 1 et 24 heures.';
    end if;
    v_base := round(v_tarif.prix_heure_mad * p_duree_mad, 2);
  else
    -- Forfait : départ dans l'une des deux zones, arrivée dans l'autre (dans
    -- les deux sens), sans arrêt. Les zones peuvent s'emboîter (une gare dans
    -- une ville) : le forfait entre les zones les plus précises l'emporte.
    if v_nb_arrets = 0 then
      select f.* into v_forfait
      from public.forfaits f
      join public.zones za on za.id = f.zone_a_id and za.active
      join public.zones zb on zb.id = f.zone_b_id and zb.active
      where f.active and f.categorie_id = p_categorie_id
        and ((prive.distance_km(p_depart_lat, p_depart_lng, za.latitude, za.longitude) <= za.rayon_km
              and prive.distance_km(p_arrivee_lat, p_arrivee_lng, zb.latitude, zb.longitude) <= zb.rayon_km)
          or (prive.distance_km(p_depart_lat, p_depart_lng, zb.latitude, zb.longitude) <= zb.rayon_km
              and prive.distance_km(p_arrivee_lat, p_arrivee_lng, za.latitude, za.longitude) <= za.rayon_km))
      order by za.rayon_km + zb.rayon_km, f.prix
      limit 1;
    end if;
    if v_forfait.id is not null then
      v_base := v_forfait.prix;
    else
      v_base := greatest(v_tarif.minimum,
                         round(v_tarif.prise_en_charge + v_distance * v_tarif.prix_km + v_duree * v_tarif.prix_minute, 2));
    end if;
  end if;

  -- Majoration : jamais sur un forfait (un forfait est un prix fixe)
  if v_forfait.id is null then
    select m.type, m.pourcentage into v_maj_type, v_maj_pct from prive.majoration_applicable(p_quand) m;
  end if;
  v_sous_total := round(v_base * (1 + coalesce(v_maj_pct, 0) / 100), 2);

  -- Option « chauffeuse pour clientes »
  if coalesce(p_option_chauffeuse, false) then
    v_supplement := v_tarif.supplement_chauffeuse;
  end if;
  v_sous_total := v_sous_total + v_supplement;

  -- Code promo (clients connectés uniquement)
  if nullif(trim(coalesce(p_code_promo, '')), '') is not null and p_client_id is not null then
    select * into v_promo from prive.remise_promo(p_code_promo, p_client_id, v_sous_total);
  end if;

  return jsonb_build_object(
    'categorie_id',           v_categorie.id,
    'categorie_code',         v_categorie.code,
    'tarif_id',               v_tarif.id,
    'forfait_id',             v_forfait.id,
    'distance_km',            v_distance,
    'duree_min',              v_duree,
    'prix_base',              v_base,
    'majoration_type',        v_maj_type,
    'majoration_pourcentage', coalesce(v_maj_pct, 0),
    'supplement',             v_supplement,
    'code_promo_id',          v_promo.code_id,
    'remise',                 coalesce(v_promo.remise, 0),
    'message_promo',          v_promo.message,
    'prix_total',             greatest(0, v_sous_total - coalesce(v_promo.remise, 0)),
    'frais_annulation',       v_tarif.frais_annulation,
    'hors_zone',              v_hors_zone
  );
end;
$$;

-- Estimation publique (page d'accueil, simulateur, écran de commande).
create or replace function public.estimer_course(
  p_categorie          text,
  p_depart_lat         numeric, p_depart_lng  numeric,
  p_arrivee_lat        numeric, p_arrivee_lng numeric,
  p_arrets             jsonb       default '[]'::jsonb,
  p_quand              timestamptz default null,
  p_type               text        default 'immediate',
  p_duree_mad          numeric     default null,
  p_option_chauffeuse  boolean     default false,
  p_code_promo         text        default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_categorie uuid;
begin
  select c.id into v_categorie from public.categories c where c.code = p_categorie and c.active;
  if v_categorie is null then
    raise exception 'Catégorie de véhicule inconnue ou indisponible.';
  end if;
  return prive.calculer_prix(v_categorie, p_depart_lat, p_depart_lng, p_arrivee_lat, p_arrivee_lng,
                             coalesce(p_arrets, '[]'::jsonb), coalesce(p_quand, now()), p_type, p_duree_mad,
                             p_option_chauffeuse, p_code_promo, auth.uid());
end;
$$;

-- Vérification d'un code promo avant la commande (clients connectés).
create or replace function public.verifier_code_promo(p_code text, p_montant numeric)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v record;
begin
  if auth.uid() is null then
    raise exception 'Connectez-vous pour utiliser un code promo.';
  end if;
  select * into v from prive.remise_promo(p_code, auth.uid(), p_montant);
  return jsonb_build_object('valide', v.code_id is not null, 'remise', v.remise, 'message', v.message);
end;
$$;

-- Voitures en ligne autour d'un point : positions arrondies à ~100 m,
-- sans aucune information sur le chauffeur (affichage sur la carte d'accueil).
create or replace function public.vehicules_a_proximite(p_lat numeric, p_lng numeric)
returns table (latitude numeric, longitude numeric)
language sql stable security definer set search_path = ''
as $$
  select round(po.latitude, 3), round(po.longitude, 3)
  from public.positions po
  join public.chauffeurs c on c.id = po.chauffeur_id and c.statut = 'valide'
  where po.en_ligne
    and po.maj_le > now() - interval '3 minutes'
    and po.latitude is not null
    and prive.distance_km(p_lat, p_lng, po.latitude, po.longitude) <= 10
$$;


-- #############################################################################
-- E. COMMANDE
-- #############################################################################

create or replace function public.commander_course(
  p_categorie                text,
  p_depart_adresse           text,
  p_depart_lat               numeric,
  p_depart_lng               numeric,
  p_arrivee_adresse          text,
  p_arrivee_lat              numeric,
  p_arrivee_lng              numeric,
  p_arrets                   jsonb       default '[]'::jsonb,   -- [{ "adresse", "lat", "lng" }]
  p_type                     text        default 'immediate',
  p_quand                    timestamptz default null,          -- date et heure de prise en charge (planifiée)
  p_duree_mad                numeric     default null,
  p_depart_precision         text        default null,          -- terminal, porte, sortie
  p_numero_vol               text        default null,
  p_terminal                 text        default null,
  p_pour_proche              boolean     default false,
  p_beneficiaire_nom         text        default null,
  p_beneficiaire_telephone   text        default null,
  p_option_chauffeuse        boolean     default false,
  p_mode_paiement            text        default 'especes',
  p_code_promo               text        default null,
  p_compte_pro               uuid        default null,
  p_prix_annonce             numeric     default null           -- prix affiché : doit correspondre au recalcul
)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_client     public.profils;
  v_param      public.parametres;
  v_categorie  uuid;
  v_quand      timestamptz;
  v_prix       jsonb;
  v_course     public.courses;
  v_arret      jsonb;
  v_ordre      integer := 0;
  v_vol        text := nullif(upper(regexp_replace(coalesce(p_numero_vol, ''), '\s', '', 'g')), '');
begin
  -- Qui commande ?
  select * into v_client from public.profils p where p.id = auth.uid();
  if v_client.id is null then
    raise exception 'Connectez-vous pour commander une course.';
  end if;
  if v_client.statut <> 'actif' then
    raise exception 'Votre compte est suspendu : contactez LOC RÉACTION.';
  end if;
  if v_client.telephone is null then
    raise exception 'Ajoutez votre numéro de téléphone dans votre compte avant de commander : le chauffeur doit pouvoir vous joindre.';
  end if;

  -- Une seule course immédiate à la fois
  if p_type in ('immediate', 'mise_a_disposition') and exists (
       select 1 from public.courses c
       where c.client_id = v_client.id and c.type <> 'planifiee'
         and c.statut in ('recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')) then
    raise exception 'Vous avez déjà une course en cours.';
  end if;

  select * into v_param from public.parametres where id = 1;
  select c.id into v_categorie from public.categories c where c.code = p_categorie and c.active;
  if v_categorie is null then
    raise exception 'Catégorie de véhicule inconnue ou indisponible.';
  end if;

  -- Quand ?
  if p_type = 'planifiee' then
    if p_quand is null then
      raise exception 'Indiquez la date et l''heure de prise en charge.';
    end if;
    if p_quand < now() + make_interval(mins => v_param.delai_min_planification_min) then
      raise exception 'Une réservation doit être faite au moins % minutes à l''avance.', v_param.delai_min_planification_min;
    end if;
    if p_quand > now() + interval '90 days' then
      raise exception 'Les réservations sont ouvertes jusqu''à 90 jours à l''avance.';
    end if;
    v_quand := p_quand;
  elsif p_type = 'mise_a_disposition' then
    v_quand := greatest(coalesce(p_quand, now()), now());
    if v_quand > now() + interval '90 days' then
      raise exception 'Les réservations sont ouvertes jusqu''à 90 jours à l''avance.';
    end if;
  elsif p_type = 'immediate' then
    v_quand := now();
  else
    raise exception 'Type de course inconnu.';
  end if;

  -- Paiement
  if p_mode_paiement = 'solde' then
    raise exception 'Le paiement par le solde arrive dans une prochaine version.';
  end if;
  if p_mode_paiement not in ('especes', 'carte', 'facture_mensuelle') then
    raise exception 'Mode de paiement inconnu.';
  end if;
  if p_mode_paiement = 'facture_mensuelle' or p_compte_pro is not null then
    if p_compte_pro is null or not exists (
         select 1 from public.comptes_pro_membres m
         join public.comptes_pro cp on cp.id = m.compte_pro_id and cp.statut = 'actif'
         where m.compte_pro_id = p_compte_pro and m.profil_id = v_client.id) then
      raise exception 'La facturation mensuelle est réservée aux membres d''un compte professionnel actif.';
    end if;
  end if;

  -- Pour un proche
  if coalesce(p_pour_proche, false) and (nullif(trim(coalesce(p_beneficiaire_nom, '')), '') is null
                                         or coalesce(p_beneficiaire_telephone, '') !~ '^\+[1-9][0-9]{6,14}$') then
    raise exception 'Indiquez le nom et le numéro (format international, ex. +33…) de la personne transportée.';
  end if;

  -- Prix (recalculé ici : le navigateur ne fixe jamais le prix)
  v_prix := prive.calculer_prix(v_categorie, p_depart_lat, p_depart_lng, p_arrivee_lat, p_arrivee_lng,
                                coalesce(p_arrets, '[]'::jsonb), v_quand, p_type, p_duree_mad,
                                p_option_chauffeuse, p_code_promo, v_client.id);
  if (v_prix ->> 'hors_zone')::boolean then
    raise exception 'Ce trajet sort de notre zone ou dépasse la distance maximale : demandez un devis.';
  end if;
  if nullif(trim(coalesce(p_code_promo, '')), '') is not null and (v_prix ->> 'code_promo_id') is null then
    raise exception '%', coalesce(v_prix ->> 'message_promo', 'Ce code promo n''est pas valable.');
  end if;
  if p_prix_annonce is not null and abs(p_prix_annonce - (v_prix ->> 'prix_total')::numeric) > 0.009 then
    raise exception 'Le prix a changé depuis l''affichage (nouveau prix : %). Vérifiez avant de commander.',
      prive.euros((v_prix ->> 'prix_total')::numeric);
  end if;

  insert into public.courses (
    numero, client_id, compte_pro_id, pour_proche, beneficiaire_nom, beneficiaire_telephone,
    categorie_id, option_chauffeuse, type, statut,
    depart_adresse, depart_lat, depart_lng, depart_precision,
    arrivee_adresse, arrivee_lat, arrivee_lng,
    prise_en_charge_le, numero_vol, terminal, duree_mad_heures,
    distance_km, duree_min, tarif_id, forfait_id, prix_base, majoration_type, majoration_pourcentage,
    supplement, code_promo_id, remise, prix_total, mode_paiement
  ) values (
    prive.prochain_numero('course', 'C'), v_client.id, p_compte_pro, coalesce(p_pour_proche, false),
    case when p_pour_proche then trim(p_beneficiaire_nom) end,
    case when p_pour_proche then p_beneficiaire_telephone end,
    v_categorie, coalesce(p_option_chauffeuse, false), p_type,
    case when v_quand > now() + interval '15 minutes' then 'planifiee' else 'recherche' end,
    left(trim(p_depart_adresse), 300), p_depart_lat, p_depart_lng, nullif(left(trim(coalesce(p_depart_precision, '')), 200), ''),
    left(trim(p_arrivee_adresse), 300), p_arrivee_lat, p_arrivee_lng,
    v_quand, v_vol, nullif(left(trim(coalesce(p_terminal, '')), 40), ''),
    case when p_type = 'mise_a_disposition' then p_duree_mad end,
    (v_prix ->> 'distance_km')::numeric, (v_prix ->> 'duree_min')::integer,
    (v_prix ->> 'tarif_id')::uuid, (v_prix ->> 'forfait_id')::uuid,
    (v_prix ->> 'prix_base')::numeric, v_prix ->> 'majoration_type', (v_prix ->> 'majoration_pourcentage')::numeric,
    (v_prix ->> 'supplement')::numeric, (v_prix ->> 'code_promo_id')::uuid, (v_prix ->> 'remise')::numeric,
    (v_prix ->> 'prix_total')::numeric, p_mode_paiement
  )
  returning * into v_course;

  -- Arrêts
  if p_arrets is not null and jsonb_typeof(p_arrets) = 'array' then
    for v_arret in select value from jsonb_array_elements(p_arrets) loop
      v_ordre := v_ordre + 1;
      insert into public.course_arrets (course_id, ordre, adresse, latitude, longitude)
      values (v_course.id, v_ordre, left(coalesce(v_arret ->> 'adresse', 'Arrêt ' || v_ordre), 300),
              (v_arret ->> 'lat')::numeric, (v_arret ->> 'lng')::numeric);
    end loop;
  end if;

  -- Code promo consommé
  if v_course.code_promo_id is not null then
    insert into public.utilisations_promo (code_promo_id, client_id, course_id, remise)
    values (v_course.code_promo_id, v_client.id, v_course.id, v_course.remise);
  end if;

  perform prive.evenement(v_course.id, 'commande',
    jsonb_build_object('prix_total', v_course.prix_total, 'type', v_course.type));

  -- Recherche d'un chauffeur tout de suite (sinon : réservation à venir)
  if v_course.statut = 'recherche' then
    perform prive.proposer_course(v_course.id);
  else
    perform prive.notifier_admins('course', 'Nouvelle réservation',
      'Réservation ' || v_course.numero || ' le ' || to_char(prive.heure_paris(v_course.prise_en_charge_le), 'DD/MM/YYYY à HH24:MI') || '.',
      '/admin/dispatch/');
  end if;

  select * into v_course from public.courses c where c.id = v_course.id;
  return v_course;
end;
$$;


-- #############################################################################
-- F. ATTRIBUTION AUX CHAUFFEURS
-- #############################################################################

-- Copie des informations du chauffeur, du véhicule et du client dans la course
-- au moment de l'attribution (affichage côté client et côté chauffeur).
create or replace function prive.attribuer(p_course uuid, p_chauffeur uuid, p_mode text, p_statut text)
returns public.courses
language plpgsql security definer set search_path = ''
as $$
declare
  v_course    public.courses;
  v_profil    public.profils;
  v_vehicule  public.vehicules;
  v_client    public.profils;
begin
  select * into v_course from public.courses c where c.id = p_course for update;
  select * into v_profil from public.profils p where p.id = p_chauffeur;
  select v.* into v_vehicule from public.chauffeurs c join public.vehicules v on v.id = c.vehicule_id where c.id = p_chauffeur;
  select * into v_client from public.profils p where p.id = v_course.client_id;

  update public.courses c set
    chauffeur_id              = p_chauffeur,
    vehicule_id               = v_vehicule.id,
    chauffeur_prenom          = v_profil.prenom,
    chauffeur_telephone       = v_profil.telephone,
    chauffeur_photo           = v_profil.photo_chemin,
    vehicule_libelle          = v_vehicule.marque || ' ' || v_vehicule.modele,
    vehicule_couleur          = v_vehicule.couleur,
    vehicule_immatriculation  = v_vehicule.immatriculation,
    client_prenom             = case when c.pour_proche then c.beneficiaire_nom else v_client.prenom end,
    client_telephone          = case when c.pour_proche then c.beneficiaire_telephone else v_client.telephone end,
    attribution               = p_mode,
    attribuee_par             = case when p_mode = 'manuelle' then auth.uid() end,
    statut                    = p_statut,
    acceptee_le               = case when p_statut = 'acceptee' then now() else c.acceptee_le end
  where c.id = p_course
  returning * into v_course;

  -- Les autres demandes encore en attente pour cette course sont retirées
  update public.propositions p set statut = 'annulee', repondue_le = now()
   where p.course_id = p_course and p.statut = 'envoyee' and p.chauffeur_id <> p_chauffeur;

  return v_course;
end;
$$;

-- Envoie la course au chauffeur disponible le plus proche (un à la fois).
-- S'il n'y en a aucun, la course passe « à attribuer » pour l'administration.
create or replace function prive.proposer_course(p_course uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_course     public.courses;
  v_param      public.parametres;
  v_chauffeur  uuid;
  v_distance   numeric;
  v_prop       uuid;
begin
  select * into v_course from public.courses c where c.id = p_course for update;
  -- « À attribuer » : nouvelle tentative automatique si un chauffeur s'est
  -- libéré ou connecté entre-temps (l'administration garde la main en parallèle).
  if v_course.statut not in ('recherche', 'a_attribuer') then
    return null;
  end if;
  if exists (select 1 from public.propositions p
             where p.course_id = p_course and p.statut = 'envoyee' and p.expire_le > now()) then
    return null;                                      -- une demande attend déjà une réponse
  end if;
  select * into v_param from public.parametres where id = 1;

  select c.id, prive.distance_km(po.latitude, po.longitude, v_course.depart_lat, v_course.depart_lng)
    into v_chauffeur, v_distance
  from public.chauffeurs c
  join public.profils pr  on pr.id = c.id and pr.role = 'chauffeur' and pr.statut = 'actif'
  join public.positions po on po.chauffeur_id = c.id and po.en_ligne
                          and po.maj_le > now() - interval '3 minutes' and po.latitude is not null
  join public.vehicules v on v.id = c.vehicule_id and v.actif and v.categorie_id = v_course.categorie_id
  where c.statut = 'valide'
    and (not v_course.option_chauffeuse or c.chauffeuse)
    -- pas déjà occupé
    and not exists (select 1 from public.courses x
                    where x.chauffeur_id = c.id and x.statut in ('acceptee', 'arrivee', 'en_cours'))
    -- pas déjà sollicité pour cette course
    and not exists (select 1 from public.propositions p
                    where p.course_id = p_course and p.chauffeur_id = c.id)
    -- pas deux demandes à la fois
    and not exists (select 1 from public.propositions p
                    where p.chauffeur_id = c.id and p.statut = 'envoyee' and p.expire_le > now())
    -- filtre de destination : la course doit le rapprocher de sa destination
    and (not c.filtre_destination_actif or c.filtre_destination_lat is null
         or prive.distance_km(v_course.arrivee_lat, v_course.arrivee_lng, c.filtre_destination_lat, c.filtre_destination_lng)
          < prive.distance_km(po.latitude, po.longitude, c.filtre_destination_lat, c.filtre_destination_lng))
  order by prive.distance_km(po.latitude, po.longitude, v_course.depart_lat, v_course.depart_lng)
  limit 1;

  if v_chauffeur is null then
    if v_course.statut = 'a_attribuer' then
      return null;                       -- toujours personne : l'administration est déjà prévenue
    end if;
    update public.courses set statut = 'a_attribuer' where id = p_course;
    perform prive.evenement(p_course, 'aucun_chauffeur_disponible');
    perform prive.notifier_admins('course', 'Course à attribuer',
      'La course ' || v_course.numero || ' n''a trouvé aucun chauffeur disponible : attribuez-la à la main.',
      '/admin/dispatch/');
    perform prive.notifier(v_course.client_id, 'course', 'Recherche en cours',
      'Aucun chauffeur n''est libre à l''instant : notre équipe s''occupe de votre course et vous prévient dès qu''elle est attribuée.');
    return null;
  end if;

  if v_course.statut = 'a_attribuer' then
    update public.courses set statut = 'recherche' where id = p_course;
  end if;
  insert into public.propositions (course_id, chauffeur_id, distance_km, expire_le)
  values (p_course, v_chauffeur, round(v_distance, 2), now() + make_interval(secs => v_param.delai_reponse_chauffeur_s))
  returning id into v_prop;

  update public.chauffeurs set courses_proposees = courses_proposees + 1 where id = v_chauffeur;
  perform prive.evenement(p_course, 'proposee', jsonb_build_object('chauffeur_id', v_chauffeur, 'distance_km', round(v_distance, 2)));
  perform prive.notifier(v_chauffeur, 'course', 'Nouvelle demande de course',
    v_course.depart_adresse || ' → ' || v_course.arrivee_adresse || ' · ' || prive.euros(v_course.prix_total), '/chauffeur/');
  return v_prop;
end;
$$;

-- Relance automatique (appelée toutes les 20 secondes par la planification,
-- et par l'application du chauffeur à la fin du compte à rebours) :
--   1. demandes sans réponse dans le délai → chauffeur suivant ;
--   2. courses en recherche sans demande active, et courses « à attribuer »
--      jusqu'à 30 minutes après l'heure prévue → nouvelle recherche ;
--   3. réservations sans chauffeur à l'approche de l'heure → recherche automatique.
-- Renvoie le nombre de demandes envoyées aux chauffeurs.
create or replace function public.relancer_dispatch()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_param  public.parametres;
  r        record;
  v_total  integer := 0;
begin
  select * into v_param from public.parametres where id = 1;

  for r in
    update public.propositions set statut = 'expiree', repondue_le = now()
    where statut = 'envoyee' and expire_le <= now()
    returning course_id
  loop
    perform prive.evenement(r.course_id, 'demande_expiree');
    if prive.proposer_course(r.course_id) is not null then
      v_total := v_total + 1;
    end if;
  end loop;

  for r in
    select c.id from public.courses c
    where (c.statut = 'recherche'
           or (c.statut = 'a_attribuer' and c.prise_en_charge_le > now() - interval '30 minutes'))
      and not exists (select 1 from public.propositions p where p.course_id = c.id and p.statut = 'envoyee')
  loop
    if prive.proposer_course(r.id) is not null then
      v_total := v_total + 1;
    end if;
  end loop;

  for r in
    update public.courses set statut = 'recherche'
    where statut = 'planifiee' and chauffeur_id is null
      and prise_en_charge_le <= now() + make_interval(mins => v_param.recherche_planifiee_avant_min)
    returning id
  loop
    perform prive.evenement(r.id, 'recherche_automatique');
    if prive.proposer_course(r.id) is not null then
      v_total := v_total + 1;
    end if;
  end loop;

  return v_total;
end;
$$;

-- Le chauffeur accepte la demande reçue.
create or replace function public.accepter_proposition(p_proposition uuid)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_prop    public.propositions;
  v_course  public.courses;
begin
  select * into v_prop from public.propositions p where p.id = p_proposition for update;
  if v_prop.id is null or v_prop.chauffeur_id <> auth.uid() then
    raise exception 'Demande introuvable.';
  end if;
  if not public.est_chauffeur_actif() then
    raise exception 'Votre compte chauffeur n''est pas actif.';
  end if;
  if v_prop.statut <> 'envoyee' then
    raise exception 'Cette demande n''est plus disponible.';
  end if;
  if v_prop.expire_le < now() then
    raise exception 'Le délai de réponse est dépassé : la course a été proposée à un autre chauffeur.';
  end if;

  select * into v_course from public.courses c where c.id = v_prop.course_id for update;
  if v_course.statut <> 'recherche' then
    raise exception 'Cette course a déjà été attribuée ou annulée.';
  end if;
  if exists (select 1 from public.courses x
             where x.chauffeur_id = auth.uid() and x.statut in ('acceptee', 'arrivee', 'en_cours')) then
    raise exception 'Terminez d''abord votre course en cours.';
  end if;

  update public.propositions set statut = 'acceptee', repondue_le = now() where id = p_proposition;
  v_course := prive.attribuer(v_course.id, auth.uid(), 'automatique', 'acceptee');
  update public.chauffeurs set courses_acceptees = courses_acceptees + 1 where id = auth.uid();

  perform prive.evenement(v_course.id, 'acceptee', jsonb_build_object('chauffeur_id', auth.uid()));
  perform prive.notifier(v_course.client_id, 'course', 'Chauffeur trouvé',
    v_course.chauffeur_prenom || ' arrive en ' || v_course.vehicule_libelle
    || coalesce(' ' || v_course.vehicule_couleur, '') || ' (' || v_course.vehicule_immatriculation || ').',
    '/client/course/?id=' || v_course.id);
  return v_course;
end;
$$;

-- Le chauffeur refuse : la course passe au chauffeur suivant.
create or replace function public.refuser_proposition(p_proposition uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_prop public.propositions;
begin
  select * into v_prop from public.propositions p where p.id = p_proposition for update;
  if v_prop.id is null or v_prop.chauffeur_id <> auth.uid() then
    raise exception 'Demande introuvable.';
  end if;
  if v_prop.statut <> 'envoyee' then
    return;                                   -- déjà traitée : rien à faire
  end if;
  update public.propositions set statut = 'refusee', repondue_le = now() where id = p_proposition;
  perform prive.evenement(v_prop.course_id, 'refusee', jsonb_build_object('chauffeur_id', auth.uid()));
  perform prive.proposer_course(v_prop.course_id);
end;
$$;

-- Écran « Nouvelle demande » du chauffeur : résumé de la course proposée, sans
-- les coordonnées du client (elles n'apparaissent qu'après acceptation).
create or replace function public.demande_recue(p_proposition uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_prop   public.propositions;
  v_course public.courses;
begin
  select * into v_prop from public.propositions p where p.id = p_proposition;
  if v_prop.id is null or v_prop.chauffeur_id <> auth.uid() then
    raise exception 'Demande introuvable.';
  end if;
  select * into v_course from public.courses c where c.id = v_prop.course_id;
  return jsonb_build_object(
    'proposition_id',        v_prop.id,
    'statut',                v_prop.statut,
    'expire_le',             v_prop.expire_le,
    'distance_approche_km',  v_prop.distance_km,
    'course_id',             v_course.id,
    'numero',                v_course.numero,
    'type',                  v_course.type,
    'categorie',             (select cat.nom_fr from public.categories cat where cat.id = v_course.categorie_id),
    'option_chauffeuse',     v_course.option_chauffeuse,
    'depart_adresse',        v_course.depart_adresse,
    'depart_lat',            v_course.depart_lat,
    'depart_lng',            v_course.depart_lng,
    'depart_precision',      v_course.depart_precision,
    'arrivee_adresse',       v_course.arrivee_adresse,
    'arrivee_lat',           v_course.arrivee_lat,
    'arrivee_lng',           v_course.arrivee_lng,
    'arrets',                coalesce((select jsonb_agg(jsonb_build_object('ordre', a.ordre, 'adresse', a.adresse,
                                                                           'lat', a.latitude, 'lng', a.longitude) order by a.ordre)
                                       from public.course_arrets a where a.course_id = v_course.id), '[]'::jsonb),
    'prise_en_charge_le',    v_course.prise_en_charge_le,
    'numero_vol',            v_course.numero_vol,
    'terminal',              v_course.terminal,
    'duree_mad_heures',      v_course.duree_mad_heures,
    'distance_km',           v_course.distance_km,
    'duree_min',             v_course.duree_min,
    'prix_total',            v_course.prix_total,
    'mode_paiement',         v_course.mode_paiement
  );
end;
$$;

-- Onglet « Trajets planifiés » du chauffeur validé : réservations à venir
-- encore sans chauffeur, en résumé (sans les coordonnées du client).
create or replace function public.reservations_disponibles()
returns table (
  course_id           uuid,
  numero              text,
  type                text,
  categorie           text,
  option_chauffeuse   boolean,
  depart_adresse      text,
  depart_lat          numeric,
  depart_lng          numeric,
  arrivee_adresse     text,
  arrivee_lat         numeric,
  arrivee_lng         numeric,
  nb_arrets           integer,
  prise_en_charge_le  timestamptz,
  numero_vol          text,
  terminal            text,
  duree_mad_heures    numeric,
  distance_km         numeric,
  duree_min           integer,
  prix_total          numeric,
  mode_paiement       text
)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.numero, c.type, cat.nom_fr, c.option_chauffeuse,
         c.depart_adresse, c.depart_lat, c.depart_lng,
         c.arrivee_adresse, c.arrivee_lat, c.arrivee_lng,
         (select count(*)::integer from public.course_arrets a where a.course_id = c.id),
         c.prise_en_charge_le, c.numero_vol, c.terminal, c.duree_mad_heures,
         c.distance_km, c.duree_min, c.prix_total, c.mode_paiement
  from public.courses c
  join public.categories cat on cat.id = c.categorie_id
  where public.est_chauffeur_actif()
    and c.statut = 'planifiee' and c.chauffeur_id is null and c.prise_en_charge_le > now()
    and (not c.option_chauffeuse
         or exists (select 1 from public.chauffeurs ch where ch.id = auth.uid() and ch.chauffeuse))
  order by c.prise_en_charge_le
$$;

-- Le chauffeur prend une réservation à venir dans la liste des trajets planifiés.
create or replace function public.prendre_course_planifiee(p_course uuid)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course public.courses;
begin
  if not public.est_chauffeur_actif() then
    raise exception 'Votre compte chauffeur n''est pas actif.';
  end if;
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null or v_course.statut <> 'planifiee' or v_course.chauffeur_id is not null then
    raise exception 'Cette réservation n''est plus disponible.';
  end if;
  if v_course.option_chauffeuse and not exists (select 1 from public.chauffeurs c where c.id = auth.uid() and c.chauffeuse) then
    raise exception 'Cette réservation est réservée à une chauffeuse.';
  end if;
  if not exists (select 1 from public.chauffeurs c
                 join public.vehicules v on v.id = c.vehicule_id and v.actif and v.categorie_id = v_course.categorie_id
                 where c.id = auth.uid()) then
    raise exception 'Aucun véhicule de cette catégorie ne vous est attribué : contactez l''administration.';
  end if;
  if exists (select 1 from public.courses x
             where x.chauffeur_id = auth.uid() and x.statut in ('planifiee', 'acceptee', 'arrivee', 'en_cours')
               and abs(extract(epoch from (x.prise_en_charge_le - v_course.prise_en_charge_le))) < 5400) then
    raise exception 'Vous avez déjà une course prévue à moins d''1 h 30 de celle-ci.';
  end if;
  v_course := prive.attribuer(p_course, auth.uid(), 'prise_directe', 'planifiee');
  perform prive.evenement(p_course, 'prise_par_chauffeur', jsonb_build_object('chauffeur_id', auth.uid()));
  perform prive.notifier(v_course.client_id, 'course', 'Réservation confirmée',
    'Votre chauffeur pour le ' || to_char(prive.heure_paris(v_course.prise_en_charge_le), 'DD/MM à HH24:MI')
    || ' : ' || v_course.chauffeur_prenom || ', ' || v_course.vehicule_libelle || '.',
    '/client/course/?id=' || v_course.id);
  return v_course;
end;
$$;

-- L'administration attribue une course à la main.
create or replace function public.attribuer_course(p_course uuid, p_chauffeur uuid)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course  public.courses;
  v_param   public.parametres;
  v_statut  text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut not in ('planifiee', 'recherche', 'a_attribuer') then
    raise exception 'Cette course est déjà en cours, terminée ou annulée.';
  end if;
  if not exists (select 1 from public.chauffeurs c
                 join public.profils p on p.id = c.id and p.role = 'chauffeur' and p.statut = 'actif'
                 join public.vehicules v on v.id = c.vehicule_id and v.actif
                 where c.id = p_chauffeur and c.statut = 'valide') then
    raise exception 'Ce chauffeur n''est pas validé ou n''a pas de véhicule.';
  end if;
  if v_course.option_chauffeuse and not exists (select 1 from public.chauffeurs c where c.id = p_chauffeur and c.chauffeuse) then
    raise exception 'La cliente a demandé une chauffeuse.';
  end if;

  select * into v_param from public.parametres where id = 1;
  -- Réservation encore lointaine : elle reste « planifiée », chauffeur désigné.
  v_statut := case when v_course.prise_en_charge_le > now() + make_interval(mins => v_param.recherche_planifiee_avant_min)
                   then 'planifiee' else 'acceptee' end;

  -- Si une autre course avait été retenue, ses demandes en attente sont closes
  update public.propositions set statut = 'annulee', repondue_le = now()
   where course_id = p_course and statut = 'envoyee';

  v_course := prive.attribuer(p_course, p_chauffeur, 'manuelle', v_statut);
  perform prive.evenement(p_course, 'attribution_manuelle', jsonb_build_object('chauffeur_id', p_chauffeur));
  perform prive.journaliser_action('attribution_manuelle', 'courses', p_course::text,
    jsonb_build_object('chauffeur_id', p_chauffeur, 'statut', v_statut));
  perform prive.notifier(p_chauffeur, 'course', 'Course attribuée',
    v_course.numero || ' · ' || to_char(prive.heure_paris(v_course.prise_en_charge_le), 'DD/MM HH24:MI') || ' · '
    || v_course.depart_adresse, '/chauffeur/');
  perform prive.notifier(v_course.client_id, 'course', 'Chauffeur attribué',
    v_course.chauffeur_prenom || ' assurera votre course en ' || v_course.vehicule_libelle
    || ' (' || v_course.vehicule_immatriculation || ').', '/client/course/?id=' || v_course.id);
  return v_course;
end;
$$;


-- #############################################################################
-- G. DÉROULÉ DE LA COURSE
-- #############################################################################

-- Étapes, dans l'ordre, déclenchées par le chauffeur de la course :
--   en_route (réservation planifiée → acceptee), arrivee, a_bord, terminee
create or replace function public.avancer_course(p_course uuid, p_etape text)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course  public.courses;
  v_param   public.parametres;
  v_tarif   public.tarifs;
  v_attente integer;
begin
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null or (v_course.chauffeur_id is distinct from auth.uid() and not public.est_admin()) then
    raise exception 'Course introuvable.';
  end if;
  select * into v_param from public.parametres where id = 1;

  if p_etape = 'en_route' then
    if v_course.statut <> 'planifiee' then
      raise exception 'Cette course n''est pas une réservation à venir.';
    end if;
    update public.courses set statut = 'acceptee', acceptee_le = now() where id = p_course returning * into v_course;
    perform prive.notifier(v_course.client_id, 'course', 'Votre chauffeur est en route',
      v_course.chauffeur_prenom || ' arrive en ' || v_course.vehicule_libelle || ' (' || v_course.vehicule_immatriculation || ').',
      '/client/course/?id=' || p_course);

  elsif p_etape = 'arrivee' then
    if v_course.statut <> 'acceptee' then
      raise exception 'Étape impossible : la course n''est pas en approche.';
    end if;
    update public.courses set statut = 'arrivee', arrivee_le = now() where id = p_course returning * into v_course;
    perform prive.notifier(v_course.client_id, 'course', 'Votre chauffeur est arrivé',
      v_course.vehicule_libelle || coalesce(' ' || v_course.vehicule_couleur, '') || ' · ' || v_course.vehicule_immatriculation
      || coalesce(' · ' || v_course.depart_precision, ''), '/client/course/?id=' || p_course);

  elsif p_etape = 'a_bord' then
    if v_course.statut <> 'arrivee' then
      raise exception 'Étape impossible : signalez d''abord votre arrivée.';
    end if;
    -- Attente facturée au-delà des minutes gratuites, comptée depuis l'arrivée
    -- (ou depuis l'heure prévue si le chauffeur était en avance).
    v_attente := greatest(0, floor(extract(epoch from (now() - greatest(v_course.arrivee_le, v_course.prise_en_charge_le))) / 60)::integer
                             - v_param.attente_gratuite_min);
    select * into v_tarif from public.tarifs t where t.id = v_course.tarif_id;
    update public.courses
       set statut = 'en_cours', demarree_le = now(),
           attente_min = v_attente,
           frais_attente = round(v_attente * coalesce(v_tarif.prix_attente_minute, 0), 2)
     where id = p_course
    returning * into v_course;

  elsif p_etape = 'terminee' then
    if v_course.statut <> 'en_cours' then
      raise exception 'Étape impossible : le client n''est pas à bord.';
    end if;
    v_course := prive.cloturer_course(p_course);

  else
    raise exception 'Étape inconnue.';
  end if;

  perform prive.evenement(p_course, p_etape);
  return v_course;
end;
$$;

-- Fin de course : paiement à encaisser, facture, statistiques, parrainage.
create or replace function prive.cloturer_course(p_course uuid)
returns public.courses
language plpgsql security definer set search_path = ''
as $$
declare
  v_course     public.courses;
  v_parrainage public.parrainages;
begin
  update public.courses set statut = 'terminee', terminee_le = now()
   where id = p_course
  returning * into v_course;

  -- Paiement de la course (espèces, carte au terminal ou facture mensuelle)
  if v_course.prix_total + v_course.frais_attente > 0 then
    insert into public.paiements (course_id, client_id, nature, mode, montant)
    values (v_course.id, v_course.client_id, 'course', v_course.mode_paiement,
            v_course.prix_total + v_course.frais_attente);
  end if;

  perform prive.emettre_facture(v_course.id, 'course');

  -- Parrainage : récompenses à la première course terminée du filleul
  select * into v_parrainage from public.parrainages p
   where p.filleul_id = v_course.client_id and p.statut = 'en_attente' for update;
  if v_parrainage.id is not null
     and not exists (select 1 from public.courses c
                     where c.client_id = v_course.client_id and c.statut = 'terminee' and c.id <> v_course.id) then
    update public.parrainages p
       set statut = 'valide', valide_le = now(),
           recompense_parrain = (select recompense_parrain from public.parametres where id = 1),
           recompense_filleul = (select recompense_filleul from public.parametres where id = 1)
     where p.id = v_parrainage.id
    returning * into v_parrainage;
    if v_parrainage.recompense_parrain > 0 then
      perform prive.ecrire_solde(v_parrainage.parrain_id, v_parrainage.recompense_parrain, 'Parrainage validé', v_course.id);
    end if;
    if v_parrainage.recompense_filleul > 0 then
      perform prive.ecrire_solde(v_parrainage.filleul_id, v_parrainage.recompense_filleul, 'Bienvenue : parrainage', v_course.id);
    end if;
  end if;

  perform prive.notifier(v_course.client_id, 'course', 'Course terminée',
    'Merci d''avoir voyagé avec LOC RÉACTION. Total : ' || prive.euros(v_course.prix_total + v_course.frais_attente)
    || '. Notez votre chauffeur et retrouvez votre facture.', '/client/course/?id=' || v_course.id);
  return v_course;
end;
$$;


-- #############################################################################
-- H. ANNULATION, NOTES, POURBOIRE
-- #############################################################################

create or replace function public.annuler_course(p_course uuid, p_motif text default null)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course  public.courses;
  v_param   public.parametres;
  v_tarif   public.tarifs;
  v_frais   numeric := 0;
  v_motif   text := nullif(left(trim(coalesce(p_motif, '')), 500), '');
begin
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut in ('en_cours', 'terminee', 'annulee') then
    raise exception 'Cette course ne peut plus être annulée.';
  end if;
  select * into v_param from public.parametres where id = 1;

  -- 1. Le client annule
  if v_course.client_id = auth.uid() then
    select * into v_tarif from public.tarifs t where t.id = v_course.tarif_id;
    -- Gratuit tant qu'aucun chauffeur n'a accepté ; réservation gratuite
    -- jusqu'au délai prévu avant l'heure de prise en charge.
    if v_course.statut in ('acceptee', 'arrivee') then
      v_frais := coalesce(v_tarif.frais_annulation, 0);
    elsif v_course.statut = 'planifiee' and v_course.chauffeur_id is not null
          and v_course.prise_en_charge_le < now() + make_interval(mins => v_param.annulation_gratuite_planifiee_min) then
      v_frais := coalesce(v_tarif.frais_annulation, 0);
    end if;

    update public.courses
       set statut = 'annulee', annulee_par = 'client', annulee_le = now(),
           motif_annulation = v_motif, frais_annulation = v_frais
     where id = p_course
    returning * into v_course;

    if v_frais > 0 then
      insert into public.paiements (course_id, client_id, nature, mode, montant)
      values (v_course.id, v_course.client_id, 'frais_annulation', v_course.mode_paiement, v_frais);
      perform prive.emettre_facture(v_course.id, 'frais_annulation');
    else
      delete from public.utilisations_promo where course_id = v_course.id;   -- le code promo est rendu
    end if;
    perform prive.notifier(v_course.chauffeur_id, 'course', 'Course annulée par le client',
      v_course.numero || coalesce(' · ' || v_motif, ''), '/chauffeur/');

  -- 2. Le chauffeur se désiste : la course repart en recherche
  elsif v_course.chauffeur_id = auth.uid() then
    if v_course.statut not in ('planifiee', 'acceptee', 'arrivee') then
      raise exception 'Cette course ne peut plus être rendue.';
    end if;
    update public.courses
       set chauffeur_id = null, vehicule_id = null, chauffeur_prenom = null, chauffeur_telephone = null,
           chauffeur_photo = null, vehicule_libelle = null, vehicule_couleur = null, vehicule_immatriculation = null,
           client_prenom = null, client_telephone = null, attribution = null, attribuee_par = null,
           acceptee_le = null, arrivee_le = null,
           statut = case when prise_en_charge_le > now() + make_interval(mins => v_param.recherche_planifiee_avant_min)
                         then 'planifiee' else 'recherche' end
     where id = p_course
    returning * into v_course;
    perform prive.evenement(p_course, 'desistement_chauffeur', jsonb_build_object('chauffeur_id', auth.uid(), 'motif', v_motif));
    perform prive.notifier(v_course.client_id, 'course', 'Changement de chauffeur',
      'Votre chauffeur a dû se désister : nous vous en attribuons un autre.', '/client/course/?id=' || p_course);
    perform prive.notifier_admins('alerte', 'Désistement d''un chauffeur', v_course.numero || coalesce(' · ' || v_motif, ''), '/admin/dispatch/');
    if v_course.statut = 'recherche' then
      perform prive.proposer_course(p_course);
    end if;
    select * into v_course from public.courses c where c.id = p_course;
    return v_course;

  -- 3. L'administration annule (sans frais ; frais éventuels ajoutés à part)
  elsif public.est_admin() then
    update public.courses
       set statut = 'annulee', annulee_par = 'admin', annulee_le = now(), motif_annulation = v_motif
     where id = p_course
    returning * into v_course;
    delete from public.utilisations_promo where course_id = v_course.id;
    perform prive.journaliser_action('annulation_admin', 'courses', p_course::text, jsonb_build_object('motif', v_motif));
    perform prive.notifier(v_course.client_id, 'course', 'Course annulée',
      'LOC RÉACTION a annulé la course ' || v_course.numero || coalesce(' : ' || v_motif, '.'), '/client/activite/');
    perform prive.notifier(v_course.chauffeur_id, 'course', 'Course annulée', v_course.numero, '/chauffeur/');

  else
    raise exception 'Vous ne pouvez pas annuler cette course.';
  end if;

  -- Demandes encore en attente : closes
  update public.propositions set statut = 'annulee', repondue_le = now()
   where course_id = p_course and statut = 'envoyee';
  perform prive.evenement(p_course, 'annulee', jsonb_build_object('par', v_course.annulee_par, 'frais', v_frais));
  return v_course;
end;
$$;

-- Note de fin de course : le client note le chauffeur, le chauffeur note le client.
create or replace function public.noter_course(p_course uuid, p_note integer, p_commentaire text default null)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course public.courses;
  v_sens   text;
  v_cible  uuid;
begin
  select * into v_course from public.courses c where c.id = p_course;
  if v_course.id is null or v_course.statut <> 'terminee' then
    raise exception 'Seule une course terminée peut être notée.';
  end if;
  if p_note is null or p_note not between 1 and 5 then
    raise exception 'La note va de 1 à 5 étoiles.';
  end if;
  if v_course.client_id = auth.uid() then
    v_sens := 'client_vers_chauffeur'; v_cible := v_course.chauffeur_id;
  elsif v_course.chauffeur_id = auth.uid() then
    v_sens := 'chauffeur_vers_client'; v_cible := v_course.client_id;
  else
    raise exception 'Course introuvable.';
  end if;
  if exists (select 1 from public.evaluations e where e.course_id = p_course and e.sens = v_sens) then
    raise exception 'Vous avez déjà noté cette course.';
  end if;

  insert into public.evaluations (course_id, sens, auteur_id, cible_id, note, commentaire)
  values (p_course, v_sens, auth.uid(), v_cible, p_note, nullif(left(trim(coalesce(p_commentaire, '')), 1000), ''));

  if v_sens = 'client_vers_chauffeur' then
    update public.chauffeurs c
       set note_moyenne = s.moyenne, nb_notes = s.nombre
      from (select round(avg(e.note)::numeric, 2) as moyenne, count(*)::integer as nombre
            from public.evaluations e where e.cible_id = v_cible and e.sens = 'client_vers_chauffeur') s
     where c.id = v_cible;
  end if;
end;
$$;

-- Pourboire laissé par le client après la course (une seule fois).
create or replace function public.ajouter_pourboire(p_course uuid, p_montant numeric)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course public.courses;
begin
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null or v_course.client_id <> auth.uid() then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut <> 'terminee' then
    raise exception 'Le pourboire se donne une fois la course terminée.';
  end if;
  if v_course.pourboire > 0 then
    raise exception 'Vous avez déjà laissé un pourboire pour cette course.';
  end if;
  if p_montant is null or p_montant < 0.5 or p_montant > 100 then
    raise exception 'Le pourboire va de 0,50 € à 100 €.';
  end if;
  update public.courses set pourboire = round(p_montant, 2) where id = p_course returning * into v_course;
  insert into public.paiements (course_id, client_id, nature, mode, montant)
  values (p_course, v_course.client_id, 'pourboire', v_course.mode_paiement, round(p_montant, 2));
  -- La facture déjà émise ne change pas : le pourboire (hors TVA, reversé au
  -- chauffeur) figure sur son propre reçu, établi à partir de ce paiement.
  perform prive.evenement(p_course, 'pourboire', jsonb_build_object('montant', round(p_montant, 2)));
  perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire reçu',
    prive.euros(p_montant) || ' pour la course ' || v_course.numero || '. Merci !', '/chauffeur/revenus/');
  return v_course;
end;
$$;


-- #############################################################################
-- I. PAIEMENTS ET FACTURES
-- #############################################################################

-- Facture : numéro continu, TTC décomposé en HT + TVA (taux des paramètres).
create or replace function prive.emettre_facture(p_course uuid, p_nature text)
returns public.factures
language plpgsql security definer set search_path = ''
as $$
declare
  v_course   public.courses;
  v_param    public.parametres;
  v_client   public.profils;
  v_compte   public.comptes_pro;
  v_facture  public.factures;
  v_ttc      numeric;
  v_ht       numeric;
begin
  select * into v_facture from public.factures f where f.course_id = p_course and f.nature = p_nature;
  if v_facture.id is not null then
    return v_facture;                                   -- déjà émise : jamais de doublon
  end if;
  select * into v_course from public.courses c where c.id = p_course;
  select * into v_param  from public.parametres where id = 1;
  select * into v_client from public.profils p where p.id = v_course.client_id;
  select * into v_compte from public.comptes_pro cp where cp.id = v_course.compte_pro_id;

  v_ttc := case when p_nature = 'course' then v_course.prix_total + v_course.frais_attente
                else v_course.frais_annulation end;
  if p_nature = 'frais_annulation' and v_ttc <= 0 then
    return null;
  end if;
  v_ht := round(v_ttc / (1 + v_param.taux_tva_transport / 100), 2);

  insert into public.factures (
    numero, course_id, nature, client_id, compte_pro_id, destinataire_nom, destinataire_adresse,
    date_emission, montant_ht, taux_tva, montant_tva, montant_ttc, pourboire
  ) values (
    prive.prochain_numero('facture', 'FA'), v_course.id, p_nature, v_course.client_id, v_course.compte_pro_id,
    coalesce(v_compte.raison_sociale, nullif(trim(v_client.prenom || ' ' || v_client.nom), ''), v_client.email, 'Client'),
    case when v_compte.id is not null
         then concat_ws(', ', v_compte.adresse, nullif(trim(coalesce(v_compte.code_postal, '') || ' ' || coalesce(v_compte.ville, '')), '')) end,
    prive.heure_paris()::date, v_ht, v_param.taux_tva_transport, v_ttc - v_ht, v_ttc,
    case when p_nature = 'course' then v_course.pourboire else 0 end
  )
  returning * into v_facture;
  return v_facture;
end;
$$;

-- Le chauffeur (ou l'administration) confirme l'encaissement : espèces, carte au terminal.
create or replace function public.confirmer_encaissement(p_paiement uuid)
returns public.paiements
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement public.paiements;
  v_course   public.courses;
begin
  select * into v_paiement from public.paiements p where p.id = p_paiement for update;
  if v_paiement.id is null then
    raise exception 'Paiement introuvable.';
  end if;
  select * into v_course from public.courses c where c.id = v_paiement.course_id;
  if v_course.chauffeur_id is distinct from auth.uid() and not public.est_admin() then
    raise exception 'Paiement introuvable.';
  end if;
  if v_paiement.statut <> 'a_encaisser' then
    raise exception 'Ce paiement a déjà été traité.';
  end if;
  if v_paiement.mode = 'facture_mensuelle' and not public.est_admin() then
    raise exception 'Les paiements sur facture mensuelle sont encaissés par l''administration.';
  end if;
  update public.paiements set statut = 'encaisse', encaisse_par = auth.uid(), encaisse_le = now()
   where id = p_paiement returning * into v_paiement;
  perform prive.evenement(v_course.id, 'paiement_encaisse',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_paiement.montant, 'mode', v_paiement.mode));
  return v_paiement;
end;
$$;

-- Remboursement (administration) : partiel ou total, jamais au-delà du payé.
create or replace function public.rembourser(p_paiement uuid, p_montant numeric, p_motif text)
returns public.remboursements
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement      public.paiements;
  v_deja          numeric;
  v_remboursement public.remboursements;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if nullif(trim(coalesce(p_motif, '')), '') is null then
    raise exception 'Indiquez le motif du remboursement.';
  end if;
  select * into v_paiement from public.paiements p where p.id = p_paiement for update;
  if v_paiement.id is null or v_paiement.statut not in ('encaisse', 'rembourse') then
    raise exception 'Seul un paiement encaissé peut être remboursé.';
  end if;
  select coalesce(sum(r.montant), 0) into v_deja from public.remboursements r where r.paiement_id = p_paiement;
  if p_montant is null or p_montant <= 0 or v_deja + p_montant > v_paiement.montant then
    raise exception 'Montant invalide : il reste % à rembourser au maximum.', prive.euros(v_paiement.montant - v_deja);
  end if;
  insert into public.remboursements (paiement_id, montant, motif, cree_par)
  values (p_paiement, round(p_montant, 2), left(trim(p_motif), 500), auth.uid())
  returning * into v_remboursement;
  if v_deja + p_montant = v_paiement.montant then
    update public.paiements set statut = 'rembourse' where id = p_paiement;
  end if;
  perform prive.notifier(v_paiement.client_id, 'paiement', 'Remboursement',
    prive.euros(p_montant) || ' vous sont remboursés : ' || left(trim(p_motif), 200), '/client/activite/');
  return v_remboursement;
end;
$$;

-- Écriture sur le solde (crédit > 0, débit < 0). Le solde ne peut pas
-- devenir négatif : la contrainte de la table refuse l'opération.
create or replace function prive.ecrire_solde(p_profil uuid, p_montant numeric, p_motif text, p_course uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_solde numeric;
begin
  insert into public.soldes (profil_id) values (p_profil) on conflict (profil_id) do nothing;
  -- Verrou sur la ligne : deux écritures simultanées ne peuvent pas passer
  -- toutes les deux sous zéro ; message clair plutôt qu'une erreur technique.
  select s.montant into v_solde from public.soldes s where s.profil_id = p_profil for update;
  if v_solde + p_montant < 0 then
    raise exception 'Solde insuffisant : il reste %.', prive.euros(v_solde);
  end if;
  update public.soldes set montant = montant + p_montant, maj_le = now() where profil_id = p_profil;
  insert into public.ecritures_solde (profil_id, montant, motif, course_id, cree_par)
  values (p_profil, p_montant, left(p_motif, 300), p_course, auth.uid());
end;
$$;

-- Geste commercial (administration).
create or replace function public.ajuster_solde(p_profil uuid, p_montant numeric, p_motif text)
returns public.soldes
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_solde public.soldes;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_montant is null or p_montant = 0 or nullif(trim(coalesce(p_motif, '')), '') is null then
    raise exception 'Indiquez un montant et un motif.';
  end if;
  if not exists (select 1 from public.profils p where p.id = p_profil) then
    raise exception 'Compte introuvable.';
  end if;
  perform prive.ecrire_solde(p_profil, round(p_montant, 2), trim(p_motif));
  select * into v_solde from public.soldes s where s.profil_id = p_profil;
  return v_solde;
end;
$$;


-- #############################################################################
-- J. CHAUFFEURS ET FLOTTE
-- #############################################################################

-- Le chauffeur passe en ligne (ou hors ligne). Refusé si un document a expiré.
create or replace function public.mettre_en_ligne(
  p_en_ligne boolean, p_lat numeric default null, p_lng numeric default null
)
returns public.positions
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_chauffeur public.chauffeurs;
  v_vehicule  public.vehicules;
  v_position  public.positions;
  v_jour      date := prive.heure_paris()::date;
begin
  select * into v_chauffeur from public.chauffeurs c where c.id = auth.uid();
  if v_chauffeur.id is null then
    raise exception 'Votre compte chauffeur n''est pas encore validé.';
  end if;

  -- Passer hors ligne est toujours possible ; passer en ligne demande un
  -- compte validé, un véhicule et des documents à jour.
  if p_en_ligne then
    if not public.est_chauffeur_actif() then
      raise exception 'Votre compte chauffeur n''est pas encore validé.';
    end if;
    select * into v_vehicule from public.vehicules v where v.id = v_chauffeur.vehicule_id;
    if v_vehicule.id is null or not v_vehicule.actif then
      raise exception 'Aucun véhicule ne vous est attribué : contactez l''administration.';
    end if;
    if v_chauffeur.carte_vtc_expiration is null or v_chauffeur.carte_vtc_expiration < v_jour then
      raise exception 'Votre carte VTC est manquante ou expirée : mettez-la à jour dans Documents.';
    end if;
    if v_chauffeur.permis_expiration is not null and v_chauffeur.permis_expiration < v_jour then
      raise exception 'Votre permis de conduire a expiré : mettez-le à jour dans Documents.';
    end if;
    if v_vehicule.assurance_expiration is null or v_vehicule.assurance_expiration < v_jour then
      raise exception 'L''assurance du véhicule est manquante ou expirée.';
    end if;
    if v_vehicule.controle_technique_expiration is not null and v_vehicule.controle_technique_expiration < v_jour then
      raise exception 'Le contrôle technique du véhicule a expiré.';
    end if;
    if v_vehicule.vignette_vtc_expiration is not null and v_vehicule.vignette_vtc_expiration < v_jour then
      raise exception 'La vignette VTC du véhicule a expiré.';
    end if;
    if p_lat is null or p_lng is null then
      raise exception 'Activez la localisation pour passer en ligne.';
    end if;
  end if;

  insert into public.positions (chauffeur_id, en_ligne, latitude, longitude, maj_le)
  values (auth.uid(), p_en_ligne, p_lat, p_lng, now())
  on conflict (chauffeur_id) do update
    set en_ligne  = excluded.en_ligne,
        latitude  = coalesce(excluded.latitude, public.positions.latitude),
        longitude = coalesce(excluded.longitude, public.positions.longitude),
        maj_le    = now()
  returning * into v_position;

  -- Hors ligne avec une demande en attente : elle passe au chauffeur suivant
  if not p_en_ligne then
    perform public.refuser_proposition(p.id)
    from public.propositions p
    where p.chauffeur_id = auth.uid() and p.statut = 'envoyee';
  end if;
  return v_position;
end;
$$;

-- Revenus du chauffeur sur une période, jour par jour (onglet Revenus).
create or replace function public.revenus_chauffeur(p_debut date, p_fin date)
returns table (
  jour              date,
  courses           integer,
  chiffre_affaires  numeric,
  attente           numeric,
  pourboires        numeric,
  frais_annulation  numeric,
  remboursements    numeric,
  minutes_en_course integer
)
language sql stable security definer set search_path = ''
as $$
  with mes_courses as (
    select c.*, prive.heure_paris(coalesce(c.terminee_le, c.annulee_le))::date as jour_local
    from public.courses c
    where c.chauffeur_id = auth.uid()
      and c.statut in ('terminee', 'annulee')
      and prive.heure_paris(coalesce(c.terminee_le, c.annulee_le))::date between p_debut and p_fin
  )
  select m.jour_local,
         count(*) filter (where m.statut = 'terminee')::integer,
         coalesce(sum(m.prix_total) filter (where m.statut = 'terminee'), 0),
         coalesce(sum(m.frais_attente) filter (where m.statut = 'terminee'), 0),
         coalesce(sum(m.pourboire), 0),
         coalesce(sum(m.frais_annulation) filter (where m.statut = 'annulee'), 0),
         coalesce((select sum(r.montant) from public.remboursements r
                   join public.paiements p on p.id = r.paiement_id
                   where p.course_id in (select x.id from mes_courses x where x.jour_local = m.jour_local)), 0),
         coalesce(sum(extract(epoch from (m.terminee_le - m.demarree_le)) / 60)
                  filter (where m.statut = 'terminee'), 0)::integer
  from mes_courses m
  group by m.jour_local
  order by m.jour_local
$$;

-- Candidature « Devenir chauffeur » (le candidat a déjà un compte client).
create or replace function public.deposer_candidature(
  p_ville                 text,
  p_experience            text,
  p_a_carte_vtc           boolean,
  p_message               text    default null,
  p_carte_vtc_numero      text    default null,
  p_carte_vtc_expiration  date    default null,
  p_permis_numero         text    default null,
  p_permis_expiration     date    default null
)
returns public.candidatures
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil      public.profils;
  v_candidature public.candidatures;
begin
  select * into v_profil from public.profils p where p.id = auth.uid() and p.statut = 'actif';
  if v_profil.id is null then
    raise exception 'Créez votre compte ou connectez-vous pour postuler.';
  end if;
  if v_profil.role <> 'client' then
    raise exception 'Votre compte a déjà le rôle « % ».', v_profil.role;
  end if;
  if v_profil.prenom = '' or v_profil.nom = '' or v_profil.telephone is null then
    raise exception 'Complétez votre prénom, votre nom et votre téléphone dans votre compte avant de postuler.';
  end if;
  if exists (select 1 from public.candidatures c where c.profil_id = v_profil.id) then
    raise exception 'Vous avez déjà envoyé une candidature : nous revenons vers vous rapidement.';
  end if;

  insert into public.candidatures (profil_id, ville, experience, a_carte_vtc, message)
  values (v_profil.id, left(trim(coalesce(p_ville, '')), 120), left(trim(coalesce(p_experience, '')), 2000),
          coalesce(p_a_carte_vtc, false), nullif(left(trim(coalesce(p_message, '')), 2000), ''))
  returning * into v_candidature;

  insert into public.chauffeurs (id, statut, carte_vtc_numero, carte_vtc_expiration, permis_numero, permis_expiration)
  values (v_profil.id, 'candidat', nullif(trim(coalesce(p_carte_vtc_numero, '')), ''), p_carte_vtc_expiration,
          nullif(trim(coalesce(p_permis_numero, '')), ''), p_permis_expiration)
  on conflict (id) do nothing;

  perform prive.notifier_admins('document', 'Nouvelle candidature chauffeur',
    trim(v_profil.prenom || ' ' || v_profil.nom) || coalesce(' · ' || nullif(trim(coalesce(p_ville, '')), ''), ''),
    '/admin/chauffeurs/');
  return v_candidature;
end;
$$;

-- Validation d'une candidature : le compte devient « chauffeur ».
create or replace function public.valider_candidature(
  p_profil uuid, p_vehicule uuid default null, p_chauffeuse boolean default false
)
returns public.chauffeurs
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_chauffeur public.chauffeurs;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if not exists (select 1 from public.profils p where p.id = p_profil) then
    raise exception 'Compte introuvable.';
  end if;
  -- Salarié embauché directement : la fiche chauffeur est créée ici
  insert into public.chauffeurs (id, statut) values (p_profil, 'candidat') on conflict (id) do nothing;
  if p_vehicule is not null and not exists (select 1 from public.vehicules v where v.id = p_vehicule and v.actif) then
    raise exception 'Véhicule introuvable ou inactif.';
  end if;

  update public.candidatures set statut = 'acceptee', traitee_par = auth.uid(), traitee_le = now()
   where profil_id = p_profil;
  update public.chauffeurs
     set statut = 'valide', valide_le = now(), valide_par = auth.uid(),
         chauffeuse = coalesce(p_chauffeuse, false),
         vehicule_id = coalesce(p_vehicule, vehicule_id)
   where id = p_profil
  returning * into v_chauffeur;
  update public.profils set role = 'chauffeur' where id = p_profil and role = 'client';
  insert into public.positions (chauffeur_id, en_ligne) values (p_profil, false) on conflict (chauffeur_id) do nothing;

  perform prive.journaliser_action('validation_chauffeur', 'chauffeurs', p_profil::text,
    jsonb_build_object('vehicule_id', v_chauffeur.vehicule_id, 'chauffeuse', v_chauffeur.chauffeuse));
  perform prive.notifier(p_profil, 'document', 'Bienvenue chez LOC RÉACTION',
    'Votre compte chauffeur est validé. Vous pouvez passer en ligne depuis l''application.', '/chauffeur/');
  return v_chauffeur;
end;
$$;

create or replace function public.refuser_candidature(p_profil uuid, p_motif text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  update public.candidatures
     set statut = 'refusee', motif_refus = nullif(left(trim(coalesce(p_motif, '')), 500), ''),
         traitee_par = auth.uid(), traitee_le = now()
   where profil_id = p_profil;
  update public.chauffeurs set statut = 'refuse' where id = p_profil and statut = 'candidat';
  perform prive.journaliser_action('refus_candidature', 'candidatures', p_profil::text, jsonb_build_object('motif', p_motif));
  perform prive.notifier(p_profil, 'document', 'Votre candidature',
    'Nous ne pouvons pas donner suite à votre candidature' || coalesce(' : ' || nullif(trim(coalesce(p_motif, '')), ''), '.'));
end;
$$;

-- Vérification d'un document ; un document validé met à jour les dates
-- d'expiration de la fiche chauffeur ou véhicule.
create or replace function public.verifier_document(p_document uuid, p_statut text, p_commentaire text default null)
returns public.documents
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_document public.documents;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut not in ('valide', 'refuse') then
    raise exception 'Statut inconnu.';
  end if;
  update public.documents
     set statut = p_statut, commentaire = nullif(left(trim(coalesce(p_commentaire, '')), 500), ''),
         verifie_par = auth.uid(), verifie_le = now()
   where id = p_document
  returning * into v_document;
  if v_document.id is null then
    raise exception 'Document introuvable.';
  end if;

  if p_statut = 'valide' then
    if v_document.chauffeur_id is not null then
      update public.chauffeurs c set
        carte_vtc_numero     = case when v_document.type = 'carte_vtc' then coalesce(v_document.numero, c.carte_vtc_numero) else c.carte_vtc_numero end,
        carte_vtc_expiration = case when v_document.type = 'carte_vtc' then coalesce(v_document.expire_le, c.carte_vtc_expiration) else c.carte_vtc_expiration end,
        permis_numero        = case when v_document.type = 'permis' then coalesce(v_document.numero, c.permis_numero) else c.permis_numero end,
        permis_expiration    = case when v_document.type = 'permis' then coalesce(v_document.expire_le, c.permis_expiration) else c.permis_expiration end
      where c.id = v_document.chauffeur_id;
    else
      update public.vehicules v set
        assurance_expiration          = case when v_document.type = 'assurance' then coalesce(v_document.expire_le, v.assurance_expiration) else v.assurance_expiration end,
        controle_technique_expiration = case when v_document.type = 'controle_technique' then coalesce(v_document.expire_le, v.controle_technique_expiration) else v.controle_technique_expiration end,
        vignette_vtc_expiration       = case when v_document.type = 'vignette_vtc' then coalesce(v_document.expire_le, v.vignette_vtc_expiration) else v.vignette_vtc_expiration end,
        vignette_vtc_numero           = case when v_document.type = 'vignette_vtc' then coalesce(v_document.numero, v.vignette_vtc_numero) else v.vignette_vtc_numero end
      where v.id = v_document.vehicule_id;
    end if;
  end if;

  perform prive.notifier(v_document.chauffeur_id, 'document',
    case when p_statut = 'valide' then 'Document validé' else 'Document refusé' end,
    case v_document.type when 'carte_vtc' then 'Carte VTC' when 'permis' then 'Permis de conduire'
                         when 'registre_vtc' then 'Attestation d''inscription au registre VTC' else 'Document' end
    || coalesce(' : ' || v_document.commentaire, '.'), '/chauffeur/documents/');
  return v_document;
end;
$$;

create or replace function public.affecter_vehicule(p_chauffeur uuid, p_vehicule uuid)
returns public.chauffeurs
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_chauffeur public.chauffeurs;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_vehicule is not null and not exists (select 1 from public.vehicules v where v.id = p_vehicule and v.actif) then
    raise exception 'Véhicule introuvable ou inactif.';
  end if;
  update public.chauffeurs set vehicule_id = p_vehicule where id = p_chauffeur returning * into v_chauffeur;
  if v_chauffeur.id is null then
    raise exception 'Chauffeur introuvable.';
  end if;
  perform prive.journaliser_action('affectation_vehicule', 'chauffeurs', p_chauffeur::text, jsonb_build_object('vehicule_id', p_vehicule));
  return v_chauffeur;
end;
$$;


-- #############################################################################
-- K. ADMINISTRATION
-- #############################################################################

create or replace function public.admin_definir_role(p_profil uuid, p_role text)
returns public.profils
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil public.profils;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_role not in ('client', 'chauffeur', 'admin') then
    raise exception 'Rôle inconnu.';
  end if;
  if p_role = 'chauffeur' and not exists (select 1 from public.chauffeurs c where c.id = p_profil and c.statut = 'valide') then
    raise exception 'Validez d''abord la candidature de ce chauffeur.';
  end if;
  if p_profil = auth.uid() and p_role <> 'admin'
     and (select count(*) from public.profils p where p.role = 'admin' and p.statut = 'actif') <= 1 then
    raise exception 'Vous êtes le dernier administrateur : nommez-en un autre avant de changer votre rôle.';
  end if;
  update public.profils set role = p_role where id = p_profil returning * into v_profil;
  if v_profil.id is null then
    raise exception 'Compte introuvable.';
  end if;
  return v_profil;
end;
$$;

create or replace function public.admin_definir_statut(p_profil uuid, p_statut text)
returns public.profils
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil public.profils;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut not in ('actif', 'bloque') then
    raise exception 'Statut inconnu.';
  end if;
  if p_profil = auth.uid() and p_statut = 'bloque' then
    raise exception 'Vous ne pouvez pas bloquer votre propre compte.';
  end if;
  update public.profils set statut = p_statut where id = p_profil returning * into v_profil;
  if v_profil.id is null then
    raise exception 'Compte introuvable.';
  end if;
  -- Un chauffeur bloqué passe hors ligne
  if p_statut = 'bloque' then
    update public.positions set en_ligne = false where chauffeur_id = p_profil;
  end if;
  return v_profil;
end;
$$;

-- Lecture du journal des modifications (administration).
create or replace function public.journal_lister(
  p_table text default null, p_ligne text default null, p_limite integer default 100, p_avant timestamptz default null
)
returns table (
  id bigint, cree_le timestamptz, acteur_id uuid, acteur_nom text, acteur_role text,
  action text, table_cible text, ligne_id text, avant jsonb, apres jsonb
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  return query
    select j.id, j.cree_le, j.acteur_id, nullif(trim(coalesce(p.prenom, '') || ' ' || coalesce(p.nom, '')), ''),
           j.acteur_role, j.action, j.table_cible, j.ligne_id, j.avant, j.apres
    from prive.journal j
    left join public.profils p on p.id = j.acteur_id
    where (p_table is null or j.table_cible = p_table)
      and (p_ligne is null or j.ligne_id = p_ligne)
      and (p_avant is null or j.cree_le < p_avant)
    order by j.cree_le desc
    limit least(greatest(coalesce(p_limite, 100), 1), 500);
end;
$$;


-- #############################################################################
-- L. SUPPORT
-- #############################################################################

create or replace function public.ouvrir_demande(
  p_type text, p_sujet text, p_message text, p_course uuid default null
)
returns public.demandes
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_demande public.demandes;
begin
  if public.mon_role() is null then
    raise exception 'Connectez-vous pour contacter le support.';
  end if;
  if p_course is not null and not exists (
       select 1 from public.courses c where c.id = p_course
       and (c.client_id = auth.uid() or c.chauffeur_id = auth.uid())) then
    raise exception 'Course introuvable.';
  end if;
  if nullif(trim(coalesce(p_message, '')), '') is null then
    raise exception 'Décrivez votre demande.';
  end if;

  insert into public.demandes (numero, auteur_id, course_id, type, sujet)
  values (prive.prochain_numero('demande', 'S'), auth.uid(), p_course, p_type, left(trim(p_sujet), 200))
  returning * into v_demande;
  insert into public.messages (demande_id, auteur_id, contenu)
  values (v_demande.id, auth.uid(), left(trim(p_message), 2000));

  perform prive.notifier_admins('alerte', 'Nouvelle demande au support', v_demande.numero || ' · ' || v_demande.sujet, '/admin/support/');
  return v_demande;
end;
$$;
