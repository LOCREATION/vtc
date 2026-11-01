-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 18 : MARKETING — codes promo, parrainage, notifications groupées
-- -----------------------------------------------------------------------------
-- Les codes promo, les parrainages et les campagnes existent depuis la
-- migration 2 (le code promo s'applique à la commande, le parrainage se
-- valide à la première course terminée du filleul et crédite les deux soldes).
-- Cette migration donne à l'administration de quoi les piloter :
--   1. Codes promo : liste et statistiques (utilisations, clients, remises
--      accordées, chiffre d'affaires des courses terminées), statut calculé
--      (actif, à venir, expiré, épuisé, désactivé) ; création et
--      modification contrôlées (messages précis) ; utilisations d'un code.
--   2. Parrainage : liste (parrain et son code, filleul, statut,
--      récompenses), chiffres clés, meilleurs parrains, récompenses en
--      vigueur ; annulation motivée d'un parrainage en attente (abus).
--   3. Notifications groupées : brouillon, nombre de destinataires, envoi
--      dans l'application à tous les clients, à tous les chauffeurs, ou à
--      tous (comptes actifs) ; lectures comptées. Une campagne envoyée ne se
--      modifie plus. L'e-mail et WhatsApp attendent un service d'envoi : ils
--      sont refusés avec un message clair.
-- Aucune instruction de suppression : un code jamais utilisé ou un brouillon
-- se supprime depuis la page (règles d'accès de l'administration).
-- =============================================================================


-- #############################################################################
-- 1. STRUCTURE
-- #############################################################################

-- 1a. Notifications envoyées par une campagne : comptées (destinataires, lus)
alter table public.notifications
  add column campagne_id uuid references public.campagnes (id) on delete set null;
create index notifications_campagne_fk_idx on public.notifications (campagne_id) where campagne_id is not null;

-- 1b. Campagnes : nombre de destinataires à l'envoi, qui l'a envoyée
alter table public.campagnes
  add column nb_destinataires integer check (nb_destinataires >= 0),
  add column envoyee_par      uuid references public.profils (id) on delete set null;
create index campagnes_envoyee_par_fk_idx on public.campagnes (envoyee_par);

-- 1c. Une campagne envoyée ne se modifie plus et ne se supprime plus
create or replace function prive.proteger_campagne()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.envoyee_le is not null then
    raise exception 'Cette notification groupée est déjà envoyée : elle ne se modifie plus.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger proteger_campagne
  before update or delete on public.campagnes
  for each row execute function prive.proteger_campagne();

-- 1d. Écritures directes : plus d'ajout ni de modification depuis la page
--     (fonctions contrôlées ci-dessous) ; la suppression d'un brouillon ou
--     d'un code jamais utilisé reste possible (règles d'accès inchangées)
revoke insert, update on public.campagnes, public.codes_promo from authenticated;

-- 1e. Journal des parrainages (annulation par l'administration)
create trigger journal
  after update or delete on public.parrainages
  for each row execute function prive.journaliser();


-- #############################################################################
-- 2. CODES PROMO
-- #############################################################################

-- 2a. Statut d'un code à un instant
create or replace function prive.statut_code_promo(c public.codes_promo, p_utilisations integer)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when not c.actif then 'desactive'
    when c.debut is not null and c.debut > now() then 'a_venir'
    when c.fin is not null and c.fin < now() then 'expire'
    when c.utilisations_max is not null and p_utilisations >= c.utilisations_max then 'epuise'
    else 'actif' end;
$$;

-- 2b. Liste et statistiques
create or replace function public.admin_lister_codes_promo()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  return jsonb_build_object(
    'lignes', (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
        'statut', prive.statut_code_promo(c, s.utilisations),
        'utilisations', s.utilisations, 'clients', s.clients, 'remises', s.remises,
        'courses_terminees', s.courses_terminees, 'chiffre_affaires', s.chiffre_affaires, 'derniere_utilisation', s.derniere)
        order by c.actif desc, c.cree_le desc), '[]'::jsonb)
      from public.codes_promo c
      cross join lateral (
        select count(u.id)::integer as utilisations, count(distinct u.client_id)::integer as clients,
               coalesce(sum(u.remise), 0) as remises, max(u.cree_le) as derniere,
               (count(*) filter (where co.statut = 'terminee'))::integer as courses_terminees,
               coalesce(sum(co.prix_total + co.frais_attente) filter (where co.statut = 'terminee'), 0) as chiffre_affaires
        from public.utilisations_promo u
        left join public.courses co on co.id = u.course_id
        where u.code_promo_id = c.id) s),
    'totaux', (select jsonb_build_object('utilisations', count(*), 'remises', coalesce(sum(u.remise), 0),
                                         'clients', count(distinct u.client_id))
               from public.utilisations_promo u));
end;
$$;

-- 2c. Création ou modification : code en majuscules (3 à 20 lettres,
--     chiffres, « - » ou « _ »), remise en pourcentage (100 % au plus) ou en
--     euros, période (dates de Paris, bornes comprises), plafonds, minimum
create or replace function public.admin_enregistrer_code_promo(p_code uuid, p_donnees jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f          jsonb := coalesce(p_donnees, '{}'::jsonb);
  c          public.codes_promo;
  v_code     text := upper(regexp_replace(coalesce(f ->> 'code', ''), '\s', '', 'g'));
  v_libelle  text := nullif(trim(coalesce(f ->> 'libelle', '')), '');
  v_type     text := f ->> 'type';
  v_valeur   numeric := prive.nombre_json(f, 'valeur', 'Remise');
  v_max      numeric := prive.nombre_json(f, 'utilisations_max', 'Utilisations au total');
  v_client   numeric := coalesce(prive.nombre_json(f, 'utilisations_par_client', 'Utilisations par client'), 1);
  v_minimum  numeric := coalesce(prive.nombre_json(f, 'minimum_course', 'Montant minimum de la course'), 0);
  v_du       date := prive.date_json(f, 'debut', 'Début');
  v_au       date := prive.date_json(f, 'fin', 'Fin');
  v_actif    boolean := coalesce((f ->> 'actif')::boolean, true);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_code is not null then
    select * into c from public.codes_promo x where x.id = p_code for update;
    if not found then
      raise exception 'Code promo introuvable.';
    end if;
  end if;
  if v_code !~ '^[A-Z0-9_-]{3,20}$' then
    raise exception 'Code : de 3 à 20 lettres, chiffres, « - » ou « _ », sans espace (ex. BIENVENUE10).';
  end if;
  if exists (select 1 from public.codes_promo x where x.code = v_code and x.id is distinct from p_code) then
    raise exception 'Le code % existe déjà : choisissez-en un autre.', v_code;
  end if;
  if char_length(v_libelle) > 120 then
    raise exception 'Libellé : 120 caractères au plus.';
  end if;
  if v_type is null or v_type not in ('pourcentage', 'montant') then
    raise exception 'Type de remise : pourcentage ou montant en euros.';
  end if;
  if v_valeur is null or v_valeur <= 0 or (v_type = 'pourcentage' and v_valeur > 100) or (v_type = 'montant' and v_valeur > 1000) then
    raise exception '%', case when v_type = 'pourcentage' then 'Remise : plus de 0 et 100 % au plus.' else 'Remise : plus de 0 € et 1 000 € au plus.' end;
  end if;
  if v_max is not null and (v_max < 1 or v_max <> trunc(v_max)) then
    raise exception 'Utilisations au total : un nombre entier, 1 au moins (vide = sans limite).';
  end if;
  if v_client < 1 or v_client <> trunc(v_client) then
    raise exception 'Utilisations par client : un nombre entier, 1 au moins.';
  end if;
  if v_minimum < 0 or v_minimum > 10000 then
    raise exception 'Montant minimum de la course : entre 0 et 10 000 €.';
  end if;
  if v_du is not null and v_au is not null and v_au < v_du then
    raise exception 'La fin de validité est avant le début.';
  end if;
  if p_code is not null and c.code <> v_code and exists (select 1 from public.utilisations_promo u where u.code_promo_id = c.id) then
    raise exception 'Ce code a déjà servi : son nom ne change plus (créez-en un nouveau).';
  end if;

  if p_code is null then
    insert into public.codes_promo (code, libelle, type, valeur, debut, fin, utilisations_max, utilisations_par_client, minimum_course, actif)
    values (v_code, v_libelle, v_type, round(v_valeur, 2), prive.debut_jour_paris(v_du), prive.debut_jour_paris(v_au + 1),
            v_max::integer, v_client::integer, round(v_minimum, 2), v_actif)
    returning * into c;
  else
    update public.codes_promo set code = v_code, libelle = v_libelle, type = v_type, valeur = round(v_valeur, 2),
      debut = prive.debut_jour_paris(v_du), fin = prive.debut_jour_paris(v_au + 1), utilisations_max = v_max::integer,
      utilisations_par_client = v_client::integer, minimum_course = round(v_minimum, 2), actif = v_actif
    where id = c.id
    returning * into c;
  end if;
  return to_jsonb(c);
end;
$$;

-- 2d. Activer ou désactiver
create or replace function public.admin_activer_code_promo(p_code uuid, p_actif boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_actif is null then
    raise exception 'Indiquez s''il faut activer ou désactiver le code.';
  end if;
  update public.codes_promo set actif = p_actif where id = p_code;
  if not found then
    raise exception 'Code promo introuvable.';
  end if;
end;
$$;

-- 2e. Utilisations d'un code : client, course, remise
create or replace function public.admin_utilisations_code(p_code uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if not exists (select 1 from public.codes_promo c where c.id = p_code) then
    raise exception 'Code promo introuvable.';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'cree_le', u.cree_le, 'remise', u.remise,
      'client_id', u.client_id, 'client', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email),
      'course_id', co.id, 'course_numero', co.numero, 'course_statut', co.statut, 'prix_total', co.prix_total)
      order by u.cree_le desc), '[]'::jsonb)
    from public.utilisations_promo u
    join public.profils p on p.id = u.client_id
    join public.courses co on co.id = u.course_id
    where u.code_promo_id = p_code);
end;
$$;


-- #############################################################################
-- 3. PARRAINAGE
-- #############################################################################

-- 3a. Liste, chiffres clés, meilleurs parrains, récompenses en vigueur
create or replace function public.admin_lister_parrainages(p_statut text default null, p_texte text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_texte text := nullif(trim(coalesce(p_texte, '')), '');
  v_motif text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut is not null and p_statut not in ('en_attente', 'valide', 'annule') then
    raise exception 'Statut inconnu.';
  end if;
  if v_texte is not null then
    v_motif := '%' || replace(replace(replace(v_texte, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return jsonb_build_object(
    'lignes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', pa.id, 'statut', pa.statut, 'cree_le', pa.cree_le, 'valide_le', pa.valide_le,
        'recompense_parrain', pa.recompense_parrain, 'recompense_filleul', pa.recompense_filleul,
        'parrain', jsonb_build_object('id', pr.id, 'nom', coalesce(nullif(trim(pr.prenom || ' ' || pr.nom), ''), pr.email),
                                      'code', pr.code_parrainage, 'role', pr.role),
        'filleul', jsonb_build_object('id', fi.id, 'nom', coalesce(nullif(trim(fi.prenom || ' ' || fi.nom), ''), fi.email, fi.telephone),
                                      'inscrit_le', fi.cree_le,
                                      'courses_terminees', (select count(*) from public.courses c where c.client_id = fi.id and c.statut = 'terminee')))
        order by pa.cree_le desc), '[]'::jsonb)
      from public.parrainages pa
      join public.profils pr on pr.id = pa.parrain_id
      join public.profils fi on fi.id = pa.filleul_id
      where (p_statut is null or pa.statut = p_statut)
        and (v_motif is null or concat_ws(' ', pr.prenom, pr.nom, pr.email, pr.code_parrainage, fi.prenom, fi.nom, fi.email, fi.telephone) ilike v_motif)),
    'compteurs', (select jsonb_build_object(
        'tous', count(*), 'en_attente', count(*) filter (where pa.statut = 'en_attente'),
        'valides', count(*) filter (where pa.statut = 'valide'), 'annules', count(*) filter (where pa.statut = 'annule'),
        'credits', coalesce(sum(pa.recompense_parrain + pa.recompense_filleul) filter (where pa.statut = 'valide'), 0))
      from public.parrainages pa),
    'meilleurs', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nom', x.nom, 'code', x.code, 'filleuls', x.filleuls,
                                                             'valides', x.valides) order by x.valides desc, x.filleuls desc, x.nom), '[]'::jsonb)
                  from (select pr.id, coalesce(nullif(trim(pr.prenom || ' ' || pr.nom), ''), pr.email) as nom, pr.code_parrainage as code,
                               count(*) as filleuls, count(*) filter (where pa.statut = 'valide') as valides
                        from public.parrainages pa join public.profils pr on pr.id = pa.parrain_id
                        where pa.statut <> 'annule'
                        group by pr.id order by 5 desc, 4 desc limit 5) x),
    'recompenses', (select jsonb_build_object('parrain', p.recompense_parrain, 'filleul', p.recompense_filleul)
                    from public.parametres p where p.id = 1));
end;
$$;

-- 3b. Annuler un parrainage encore en attente (abus : même personne, compte
--     créé pour la récompense) ; le parrain et le filleul ne reçoivent rien
create or replace function public.admin_annuler_parrainage(p_parrainage uuid, p_motif text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pa       public.parrainages;
  v_motif  text := nullif(trim(coalesce(p_motif, '')), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into pa from public.parrainages x where x.id = p_parrainage for update;
  if not found then
    raise exception 'Parrainage introuvable.';
  end if;
  if pa.statut <> 'en_attente' then
    raise exception 'Seul un parrainage en attente s''annule : les récompenses d''un parrainage validé sont déjà créditées.';
  end if;
  if v_motif is null or char_length(v_motif) > 300 then
    raise exception 'Indiquez le motif de l''annulation (300 caractères au plus) : il est conservé dans le journal.';
  end if;
  update public.parrainages set statut = 'annule' where id = pa.id;
  perform prive.journaliser_action('annulation_parrainage', 'parrainages', pa.id::text, jsonb_build_object('motif', v_motif));
end;
$$;


-- #############################################################################
-- 4. NOTIFICATIONS GROUPÉES
-- #############################################################################

-- 4a. Destinataires d'une cible : comptes actifs (chauffeurs validés)
create or replace function prive.destinataires_campagne(p_cible text)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  select p.id from public.profils p
  where p.statut = 'actif'
    and ((p_cible in ('tous', 'clients') and p.role = 'client')
         or (p_cible in ('tous', 'chauffeurs') and p.role = 'chauffeur'
             and exists (select 1 from public.chauffeurs c where c.id = p.id and c.statut = 'valide')));
$$;

-- 4b. Liste : brouillons et envoyées, destinataires, lectures ; nombre de
--     destinataires de chaque cible aujourd'hui
create or replace function public.admin_lister_campagnes()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  return jsonb_build_object(
    'lignes', (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
        'cree_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.cree_par),
        'envoyee_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.envoyee_par),
        'lus', (select count(*) from public.notifications n where n.campagne_id = c.id and n.lu_le is not null))
        order by c.envoyee_le desc nulls first, c.cree_le desc), '[]'::jsonb)
      from public.campagnes c),
    'cibles', jsonb_build_object(
      'tous', (select count(*) from prive.destinataires_campagne('tous')),
      'clients', (select count(*) from prive.destinataires_campagne('clients')),
      'chauffeurs', (select count(*) from prive.destinataires_campagne('chauffeurs'))));
end;
$$;

-- 4c. Brouillon : création ou modification (avant l'envoi seulement)
create or replace function public.admin_enregistrer_campagne(
  p_campagne uuid, p_titre text, p_message text, p_cible text, p_canal text default 'application'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c          public.campagnes;
  v_titre    text := nullif(trim(coalesce(p_titre, '')), '');
  v_message  text := nullif(trim(coalesce(p_message, '')), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_campagne is not null then
    select * into c from public.campagnes x where x.id = p_campagne for update;
    if not found then
      raise exception 'Notification groupée introuvable.';
    end if;
    if c.envoyee_le is not null then
      raise exception 'Cette notification groupée est déjà envoyée : elle ne se modifie plus.';
    end if;
  end if;
  if v_titre is null or char_length(v_titre) > 120 then
    raise exception 'Titre : obligatoire, 120 caractères au plus.';
  end if;
  if v_message is null or char_length(v_message) > 1000 then
    raise exception 'Message : obligatoire, 1 000 caractères au plus.';
  end if;
  if p_cible is null or p_cible not in ('tous', 'clients', 'chauffeurs') then
    raise exception 'Destinataires : tous, les clients ou les chauffeurs.';
  end if;
  if p_canal is null or p_canal not in ('application', 'email', 'whatsapp') then
    raise exception 'Canal inconnu.';
  end if;
  if p_canal <> 'application' then
    raise exception 'Envoi par % : pas encore relié à un service d''envoi. Choisissez l''application.',
      case when p_canal = 'email' then 'e-mail' else 'WhatsApp' end;
  end if;
  if p_campagne is null then
    insert into public.campagnes (titre, message, cible, canal, cree_par)
    values (v_titre, v_message, p_cible, p_canal, auth.uid())
    returning * into c;
  else
    update public.campagnes set titre = v_titre, message = v_message, cible = p_cible, canal = p_canal where id = c.id
    returning * into c;
  end if;
  return to_jsonb(c);
end;
$$;

-- 4d. Envoi : une notification par destinataire, dans l'application
create or replace function public.admin_envoyer_campagne(p_campagne uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c     public.campagnes;
  v_nb  integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into c from public.campagnes x where x.id = p_campagne for update;
  if not found then
    raise exception 'Notification groupée introuvable.';
  end if;
  if c.envoyee_le is not null then
    raise exception 'Cette notification groupée est déjà envoyée (le %).', to_char(c.envoyee_le at time zone 'Europe/Paris', 'DD/MM/YYYY à HH24:MI');
  end if;
  if c.canal <> 'application' then
    raise exception 'Envoi par ce canal : pas encore relié à un service d''envoi.';
  end if;
  insert into public.notifications (destinataire_id, type, titre, message, lien, campagne_id)
  select d.id, 'info', c.titre, c.message, null, c.id
  from prive.destinataires_campagne(c.cible) as d(id);
  get diagnostics v_nb = row_count;
  if v_nb = 0 then
    raise exception 'Aucun destinataire : personne ne correspond à cette cible aujourd''hui.';
  end if;
  update public.campagnes set envoyee_le = now(), envoyee_par = auth.uid(), nb_destinataires = v_nb where id = c.id;
  return jsonb_build_object('destinataires', v_nb);
end;
$$;


-- #############################################################################
-- 5. DROITS D'EXÉCUTION
-- #############################################################################
revoke all on function
  prive.proteger_campagne(),
  prive.statut_code_promo(public.codes_promo, integer),
  prive.destinataires_campagne(text)
  from public, anon, authenticated;

revoke all on function
  public.admin_lister_codes_promo(),
  public.admin_enregistrer_code_promo(uuid, jsonb),
  public.admin_activer_code_promo(uuid, boolean),
  public.admin_utilisations_code(uuid),
  public.admin_lister_parrainages(text, text),
  public.admin_annuler_parrainage(uuid, text),
  public.admin_lister_campagnes(),
  public.admin_enregistrer_campagne(uuid, text, text, text, text),
  public.admin_envoyer_campagne(uuid)
  from public, anon;

grant execute on function
  public.admin_lister_codes_promo(),
  public.admin_enregistrer_code_promo(uuid, jsonb),
  public.admin_activer_code_promo(uuid, boolean),
  public.admin_utilisations_code(uuid),
  public.admin_lister_parrainages(text, text),
  public.admin_annuler_parrainage(uuid, text),
  public.admin_lister_campagnes(),
  public.admin_enregistrer_campagne(uuid, text, text, text, text),
  public.admin_envoyer_campagne(uuid)
  to authenticated;
