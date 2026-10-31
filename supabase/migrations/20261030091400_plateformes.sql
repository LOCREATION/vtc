-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 15 : PLATEFORMES
-- -----------------------------------------------------------------------------
-- Module « Plateformes » de l'administration : relevés des plateformes de
-- réservation (Bolt, Uber, Heetch), chauffeur par chauffeur, et rentabilité
-- de chaque chauffeur.
--   1. Structure : un relevé reprend les chiffres de la plateforme (trajets,
--      frais de service, pourboires, ajustements) et les espèces collectées
--      par le chauffeur ; le net et le montant viré se calculent :
--        net   = trajets − frais de service + pourboires + ajustements ;
--        viré  = net − espèces (déjà dans la poche du chauffeur).
--      Un relevé couvre au plus 35 jours ; un seul par chauffeur, plateforme
--      et date de début, sans chevauchement.
--   2. Actions : enregistrer ou corriger un relevé, joindre le PDF de la
--      plateforme. Un relevé saisi par erreur se supprime directement depuis
--      la page (règle d'accès de la migration 4 : administration seulement) ;
--      le journal des modifications en garde la trace complète.
--   3. Lectures : relevés d'une période (un relevé compte dans la période où
--      il se termine), rentabilité par chauffeur.
--   4. Droits d'exécution.
-- Comme partout : chaque fonction vérifie elle-même l'appelant (double
-- authentification comprise), chemin de recherche vide, messages d'erreur en
-- français affichables tels quels.
-- =============================================================================


-- #############################################################################
-- 1. STRUCTURE
-- #############################################################################

-- 1a. Colonnes complémentaires
alter table public.releves_plateformes
  add column especes    numeric(10,2) not null default 0,
  add column reference  text,
  add column note       text,
  add column maj_le     timestamptz not null default now();

-- Montant viré par la plateforme : le net, moins les espèces que le chauffeur
-- a déjà reçues des passagers (négatif : la plateforme réclame la différence)
alter table public.releves_plateformes
  add column virement numeric(10,2) generated always as (montant_net - especes) stored;

alter table public.releves_plateformes
  add constraint releves_montants  check (montant_trajets >= 0 and frais_service >= 0 and pourboires >= 0 and especes >= 0),
  add constraint releves_net       check (montant_net = montant_trajets - frais_service + pourboires + ajustements),
  add constraint releves_duree     check (fin - debut <= 34),
  add constraint releves_reference check (char_length(reference) <= 80),
  add constraint releves_note      check (char_length(note) <= 500);

comment on column public.releves_plateformes.montant_trajets is
  'Montant des trajets payé par les passagers (TTC, frais d''annulation compris, hors pourboires).';
comment on column public.releves_plateformes.frais_service is
  'Frais de service (commission) retenus par la plateforme.';
comment on column public.releves_plateformes.ajustements is
  'Bonus, compensations, péages et autres corrections de la plateforme (positifs ou négatifs).';
comment on column public.releves_plateformes.montant_net is
  'Net : trajets − frais de service + pourboires + ajustements.';
comment on column public.releves_plateformes.especes is
  'Espèces collectées par le chauffeur auprès des passagers (déduites du virement de la plateforme).';
comment on column public.releves_plateformes.virement is
  'Montant viré par la plateforme : net − espèces.';

-- 1b. Un seul relevé par chauffeur, plateforme et date de début ; recherche
--     par date de fin (un relevé compte dans la période où il se termine)
create unique index releves_plateformes_periode_idx
  on public.releves_plateformes (plateforme, chauffeur_id, debut) nulls not distinct;
create index releves_plateformes_fin_idx on public.releves_plateformes (fin);

-- 1c. Date de dernière modification (le journal des modifications suit déjà
--     cette table depuis la migration 5)
create trigger maj_horodatage
  before update on public.releves_plateformes
  for each row execute function prive.maj_horodatage();

-- 1d. Nom affiché d'une plateforme
create or replace function prive.nom_plateforme(p_code text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_code when 'bolt' then 'Bolt' when 'uber' then 'Uber' when 'heetch' then 'Heetch'
                     else 'autre plateforme' end
$$;


-- #############################################################################
-- 2. ACTIONS
-- #############################################################################

-- 2a. Enregistrer un relevé (p_releve vide) ou le corriger (p_releve donné).
--     Les montants se saisissent tels qu'imprimés sur le relevé de la
--     plateforme ; le net est recalculé ici, pour qu'une faute de frappe se
--     voie en le comparant à celui du relevé.
create or replace function public.admin_enregistrer_releve(
  p_releve       uuid,
  p_plateforme   text,
  p_chauffeur    uuid,
  p_debut        date,
  p_fin          date,
  p_nb_courses   integer,
  p_trajets      numeric,
  p_frais        numeric,
  p_pourboires   numeric,
  p_ajustements  numeric,
  p_especes      numeric,
  p_reference    text default null,
  p_note         text default null
)
returns public.releves_plateformes
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_releve   public.releves_plateformes;
  v_autre    public.releves_plateformes;
  v_nom      text;
  v_trajets  numeric := round(coalesce(p_trajets, 0), 2);
  v_frais    numeric := round(coalesce(p_frais, 0), 2);
  v_pourb    numeric := round(coalesce(p_pourboires, 0), 2);
  v_ajust    numeric := round(coalesce(p_ajustements, 0), 2);
  v_especes  numeric := round(coalesce(p_especes, 0), 2);
  v_ref      text := nullif(left(trim(coalesce(p_reference, '')), 80), '');
  v_note     text := nullif(left(trim(coalesce(p_note, '')), 500), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_plateforme is null or p_plateforme not in ('bolt', 'uber', 'heetch', 'autre') then
    raise exception 'Plateforme inconnue : Bolt, Uber, Heetch ou autre.';
  end if;
  if p_chauffeur is null then
    raise exception 'Choisissez le chauffeur : la rentabilité se calcule chauffeur par chauffeur.';
  end if;
  select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Ce chauffeur') into v_nom
    from public.chauffeurs c join public.profils p on p.id = c.id
   where c.id = p_chauffeur;
  if v_nom is null then
    raise exception 'Chauffeur introuvable.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);
  if p_fin - p_debut > 34 then
    raise exception 'Un relevé couvre au plus 35 jours : saisissez un relevé par semaine ou par mois.';
  end if;
  if p_fin > prive.heure_paris()::date then
    raise exception 'Le relevé se termine après aujourd''hui : saisissez-le une fois la période écoulée.';
  end if;
  if p_nb_courses is not null and p_nb_courses < 0 then
    raise exception 'Nombre de courses invalide.';
  end if;
  if v_trajets < 0 or v_frais < 0 or v_pourb < 0 or v_especes < 0 then
    raise exception 'Trajets, frais de service, pourboires et espèces ne peuvent pas être négatifs : seuls les ajustements le peuvent.';
  end if;
  if v_trajets = 0 and v_frais = 0 and v_pourb = 0 and v_ajust = 0 and v_especes = 0 then
    raise exception 'Le relevé est vide : indiquez au moins le montant des trajets.';
  end if;

  -- Pas deux relevés de la même plateforme pour le même chauffeur sur des
  -- jours communs (les chiffres seraient comptés deux fois)
  select * into v_autre from public.releves_plateformes r
   where r.plateforme = p_plateforme and r.chauffeur_id = p_chauffeur
     and r.id is distinct from p_releve
     and r.debut <= p_fin and r.fin >= p_debut
   order by r.debut
   limit 1;
  if v_autre.id is not null then
    raise exception '% a déjà un relevé % du % au % qui couvre une partie de ces dates : corrigez-le plutôt que d''en saisir un second.',
      v_nom, prive.nom_plateforme(p_plateforme), to_char(v_autre.debut, 'DD/MM/YYYY'), to_char(v_autre.fin, 'DD/MM/YYYY');
  end if;

  if p_releve is null then
    insert into public.releves_plateformes (
      plateforme, chauffeur_id, debut, fin, nb_courses, montant_trajets, frais_service, pourboires, ajustements,
      montant_net, especes, reference, note, cree_par
    ) values (
      p_plateforme, p_chauffeur, p_debut, p_fin, p_nb_courses, v_trajets, v_frais, v_pourb, v_ajust,
      v_trajets - v_frais + v_pourb + v_ajust, v_especes, v_ref, v_note, auth.uid()
    )
    returning * into v_releve;
  else
    update public.releves_plateformes r
       set plateforme = p_plateforme, chauffeur_id = p_chauffeur, debut = p_debut, fin = p_fin,
           nb_courses = p_nb_courses, montant_trajets = v_trajets, frais_service = v_frais, pourboires = v_pourb,
           ajustements = v_ajust, montant_net = v_trajets - v_frais + v_pourb + v_ajust, especes = v_especes,
           reference = v_ref, note = v_note
     where r.id = p_releve
    returning * into v_releve;
    if v_releve.id is null then
      raise exception 'Relevé introuvable.';
    end if;
  end if;
  return v_releve;
end;
$$;

-- 2b. Joindre (ou retirer : p_chemin vide) le PDF du relevé, déposé par la
--     page dans le dossier privé « administration », sous releves/{relevé}/.
--     Renvoie l'emplacement du fichier remplacé, que la page retire du dossier.
create or replace function public.admin_fichier_releve(p_releve uuid, p_chemin text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_releve public.releves_plateformes;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_releve from public.releves_plateformes r where r.id = p_releve for update;
  if v_releve.id is null then
    raise exception 'Relevé introuvable.';
  end if;
  if p_chemin is not null and (p_chemin not like 'releves/' || p_releve || '/%' or p_chemin like '%..%') then
    raise exception 'Emplacement du fichier invalide.';
  end if;
  update public.releves_plateformes set fichier_chemin = p_chemin where id = p_releve;
  return case when v_releve.fichier_chemin is distinct from p_chemin then v_releve.fichier_chemin end;
end;
$$;


-- #############################################################################
-- 3. LECTURES
-- #############################################################################

-- 3a. Relevés d'une période (date de fin comprise dans la période), d'un
--     chauffeur et d'une plateforme si choisis : totaux, taux des frais de
--     service, répartition par plateforme, et la liste des chauffeurs pour
--     les filtres et le formulaire.
create or replace function public.admin_lister_releves(
  p_debut       date,
  p_fin         date,
  p_chauffeur   uuid default null,
  p_plateforme  text default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);
  if p_plateforme is not null and p_plateforme not in ('bolt', 'uber', 'heetch', 'autre') then
    raise exception 'Plateforme inconnue : Bolt, Uber, Heetch ou autre.';
  end if;

  return (
    with choisis as (
      select r.*, coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom') as chauffeur_nom
      from public.releves_plateformes r
      left join public.profils p on p.id = r.chauffeur_id
      where r.fin between p_debut and p_fin
        and (p_chauffeur is null or r.chauffeur_id = p_chauffeur)
        and (p_plateforme is null or r.plateforme = p_plateforme)
    )
    select jsonb_build_object(
      'total', (select count(*) from choisis),
      'totaux', (select jsonb_build_object(
          'nb_courses', coalesce(sum(x.nb_courses), 0),
          'trajets', coalesce(sum(x.montant_trajets), 0), 'frais', coalesce(sum(x.frais_service), 0),
          'pourboires', coalesce(sum(x.pourboires), 0), 'ajustements', coalesce(sum(x.ajustements), 0),
          'net', coalesce(sum(x.montant_net), 0), 'especes', coalesce(sum(x.especes), 0),
          'virement', coalesce(sum(x.virement), 0),
          'taux_frais', case when sum(x.montant_trajets) > 0 then round(100 * sum(x.frais_service) / sum(x.montant_trajets), 1) end)
        from choisis x),
      'par_plateforme', coalesce((select jsonb_agg(jsonb_build_object(
          'plateforme', g.plateforme, 'nb', g.nb, 'trajets', g.trajets, 'frais', g.frais, 'net', g.net,
          'taux_frais', case when g.trajets > 0 then round(100 * g.frais / g.trajets, 1) end) order by g.trajets desc)
        from (select x.plateforme, count(*) as nb, sum(x.montant_trajets) as trajets, sum(x.frais_service) as frais,
                     sum(x.montant_net) as net
              from choisis x group by x.plateforme) g), '[]'::jsonb),
      'lignes', coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object(
          'cree_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = x.cree_par),
          'taux_frais', case when x.montant_trajets > 0 then round(100 * x.frais_service / x.montant_trajets, 1) end)
          order by x.fin desc, x.debut desc, x.chauffeur_nom, x.plateforme)
        from choisis x), '[]'::jsonb),
      'chauffeurs', coalesce((select jsonb_agg(jsonb_build_object(
          'id', c.id, 'nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom'), 'statut', c.statut)
          order by lower(coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom')))
        from public.chauffeurs c join public.profils p on p.id = c.id
        where c.statut in ('valide', 'suspendu')
           or exists (select 1 from public.releves_plateformes r where r.chauffeur_id = c.id)), '[]'::jsonb)
    )
  );
end;
$$;

-- 3b. Rentabilité par chauffeur sur une période (jours de Paris, bornes
--     comprises) :
--       - en direct : factures des courses terminées dans la période et des
--         frais d'annulation des courses annulées dans la période, avoirs
--         déduits (HT et TTC) ; pourboires à part (reversés au chauffeur) ;
--       - plateformes : relevés qui se terminent dans la période ; le HT des
--         trajets suit le taux de TVA du transport ;
--       - coût salarial : bulletins validés des mois qui commencent dans la
--         période (coût total employeur) ;
--       - marge après salaire = chiffre d'affaires HT − frais de service −
--         coût salarial (hors véhicule et frais généraux) ;
--       - commission évitée : ce que les courses en direct auraient coûté en
--         frais de service, au taux moyen constaté sur les relevés.
create or replace function public.admin_rentabilite_chauffeurs(p_debut date, p_fin date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_debut timestamptz;
  v_fin   timestamptz;
  v_tva   numeric;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);
  v_debut := prive.debut_jour_paris(p_debut);
  v_fin   := prive.debut_jour_paris(p_fin + 1);
  select pa.taux_tva_transport into v_tva from public.parametres pa where pa.id = 1;

  return (
    with direct as (
      select c.chauffeur_id,
             count(*) filter (where f.nature = 'course') as courses,
             sum(f.montant_ht - coalesce(av.ht, 0)) as ht,
             sum(f.montant_ttc - coalesce(av.ttc, 0)) as ttc
      from public.factures f
      join public.courses c on c.id = f.course_id
      left join lateral (select sum(a.montant_ht) as ht, sum(a.montant_ttc) as ttc
                         from public.avoirs a where a.facture_id = f.id) av on true
      where c.chauffeur_id is not null
        and ((f.nature = 'course' and c.statut = 'terminee' and c.terminee_le >= v_debut and c.terminee_le < v_fin)
          or (f.nature = 'frais_annulation' and c.statut = 'annulee' and c.annulee_le >= v_debut and c.annulee_le < v_fin))
      group by c.chauffeur_id
    ),
    pourboires as (
      select c.chauffeur_id, sum(c.pourboire) as montant
      from public.courses c
      where c.chauffeur_id is not null and c.statut = 'terminee' and c.terminee_le >= v_debut and c.terminee_le < v_fin
      group by c.chauffeur_id
    ),
    releves as (
      select r.chauffeur_id, count(*) as nb, coalesce(sum(r.nb_courses), 0) as courses,
             sum(r.montant_trajets) as trajets, sum(r.frais_service) as frais, sum(r.pourboires) as pourboires,
             sum(r.ajustements) as ajustements, sum(r.montant_net) as net, sum(r.especes) as especes
      from public.releves_plateformes r
      where r.chauffeur_id is not null and r.fin between p_debut and p_fin
      group by r.chauffeur_id
    ),
    salaires as (
      select s.profil_id as chauffeur_id, count(*) as nb, sum(b.cout_employeur) as montant
      from public.bulletins b
      join public.salaries s on s.id = b.salarie_id
      where s.profil_id is not null and b.statut in ('valide', 'envoye') and b.periode between p_debut and p_fin
      group by s.profil_id
    ),
    concernes as (
      select c.id from public.chauffeurs c where c.statut in ('valide', 'suspendu')
      union select d.chauffeur_id from direct d
      union select r.chauffeur_id from releves r
      union select s.chauffeur_id from salaires s
    ),
    base as (
      select ch.id as chauffeur_id, coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom') as nom,
             ch.statut, ch.salarie,
             coalesce(d.courses, 0) as d_courses, coalesce(d.ht, 0) as d_ht, coalesce(d.ttc, 0) as d_ttc,
             coalesce(pb.montant, 0) as d_pourboires,
             coalesce(r.nb, 0) as r_nb, coalesce(r.courses, 0) as r_courses, coalesce(r.trajets, 0) as r_trajets,
             round(coalesce(r.trajets, 0) / (1 + v_tva / 100), 2) as r_ht,
             coalesce(r.frais, 0) as r_frais, coalesce(r.pourboires, 0) as r_pourboires,
             coalesce(r.ajustements, 0) as r_ajustements, coalesce(r.net, 0) as r_net, coalesce(r.especes, 0) as r_especes,
             coalesce(s.nb, 0) as s_nb, coalesce(s.montant, 0) as s_montant
      from concernes k
      join public.chauffeurs ch on ch.id = k.id
      join public.profils p on p.id = ch.id
      left join direct d on d.chauffeur_id = ch.id
      left join pourboires pb on pb.chauffeur_id = ch.id
      left join releves r on r.chauffeur_id = ch.id
      left join salaires s on s.chauffeur_id = ch.id
    ),
    taux as (
      select case when sum(b.r_trajets) > 0 then sum(b.r_frais) / sum(b.r_trajets) end as frais from base b
    )
    select jsonb_build_object(
      'debut', p_debut, 'fin', p_fin, 'taux_tva', v_tva,
      'taux_frais_moyen', (select round(100 * t.frais, 1) from taux t),
      'chauffeurs', coalesce((select jsonb_agg(jsonb_build_object(
          'chauffeur_id', b.chauffeur_id, 'nom', b.nom, 'statut', b.statut, 'salarie', b.salarie,
          'direct', jsonb_build_object('courses', b.d_courses, 'ht', b.d_ht, 'ttc', b.d_ttc, 'pourboires', b.d_pourboires),
          'plateformes', jsonb_build_object('releves', b.r_nb, 'courses', b.r_courses, 'trajets', b.r_trajets, 'ht', b.r_ht,
                                            'frais', b.r_frais,
                                            'taux_frais', case when b.r_trajets > 0 then round(100 * b.r_frais / b.r_trajets, 1) end,
                                            'pourboires', b.r_pourboires, 'ajustements', b.r_ajustements, 'net', b.r_net,
                                            'especes', b.r_especes),
          'cout_salarial', jsonb_build_object('bulletins', b.s_nb, 'montant', b.s_montant),
          'ca_ht', b.d_ht + b.r_ht,
          'part_direct', case when b.d_ht + b.r_ht > 0 then round(100 * b.d_ht / (b.d_ht + b.r_ht), 1) end,
          'marge', b.d_ht + b.r_ht - b.r_frais - b.s_montant,
          'commission_evitee', case when t.frais is not null then round(b.d_ttc * t.frais, 2) end)
          order by b.d_ht + b.r_ht desc, lower(b.nom))
        from base b cross join taux t), '[]'::jsonb),
      'totaux', (select jsonb_build_object(
          'direct', jsonb_build_object('courses', coalesce(sum(b.d_courses), 0), 'ht', coalesce(sum(b.d_ht), 0),
                                       'ttc', coalesce(sum(b.d_ttc), 0), 'pourboires', coalesce(sum(b.d_pourboires), 0)),
          'plateformes', jsonb_build_object('releves', coalesce(sum(b.r_nb), 0), 'courses', coalesce(sum(b.r_courses), 0),
                                            'trajets', coalesce(sum(b.r_trajets), 0), 'ht', coalesce(sum(b.r_ht), 0),
                                            'frais', coalesce(sum(b.r_frais), 0), 'pourboires', coalesce(sum(b.r_pourboires), 0),
                                            'ajustements', coalesce(sum(b.r_ajustements), 0), 'net', coalesce(sum(b.r_net), 0),
                                            'especes', coalesce(sum(b.r_especes), 0)),
          'cout_salarial', jsonb_build_object('bulletins', coalesce(sum(b.s_nb), 0), 'montant', coalesce(sum(b.s_montant), 0)),
          'ca_ht', coalesce(sum(b.d_ht + b.r_ht), 0),
          'part_direct', case when sum(b.d_ht + b.r_ht) > 0 then round(100 * sum(b.d_ht) / sum(b.d_ht + b.r_ht), 1) end,
          'marge', coalesce(sum(b.d_ht + b.r_ht - b.r_frais - b.s_montant), 0),
          'commission_evitee', case when max(t.frais) is not null then round(sum(b.d_ttc) * max(t.frais), 2) end)
        from base b cross join taux t)
    )
  );
end;
$$;


-- #############################################################################
-- 4. DROITS D'EXÉCUTION
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout, puis on n'accorde que l'utile.
revoke all on function prive.nom_plateforme(text) from public, anon, authenticated;

revoke all on function
  public.admin_enregistrer_releve(uuid, text, uuid, date, date, integer, numeric, numeric, numeric, numeric, numeric, text, text),
  public.admin_fichier_releve(uuid, text),
  public.admin_lister_releves(date, date, uuid, text),
  public.admin_rentabilite_chauffeurs(date, date)
  from public, anon;

grant execute on function
  public.admin_enregistrer_releve(uuid, text, uuid, date, date, integer, numeric, numeric, numeric, numeric, numeric, text, text),
  public.admin_fichier_releve(uuid, text),
  public.admin_lister_releves(date, date, uuid, text),
  public.admin_rentabilite_chauffeurs(date, date)
  to authenticated;
