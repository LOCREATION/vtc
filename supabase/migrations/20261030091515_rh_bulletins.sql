-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 16c : RH ET PAIE (3/5) — vie des bulletins de paie
-- -----------------------------------------------------------------------------
-- Le bulletin est calculé par la base (prive.calculer_bulletin, migration
-- 16b), jamais par la page :
--   1. Préparer le bulletin d'un mois : variables du brouillon, ou
--      suggestions (heures majorées des semaines payées ce mois-ci, absences
--      validées), primes et indemnités du mois précédent.
--   2. Aperçu (sans rien écrire), brouillon (recalculé à chaque
--      enregistrement), validation (nouveau calcul avec les paramètres du
--      moment, refusée si un contrôle est bloquant ; lignes recopiées et
--      figées ; salarié prévenu), remise au salarié (PDF facultatif).
--   3. Lectures : bulletins d'un mois et leurs totaux, document imprimable
--      (le bulletin tel qu'il a été calculé et validé).
-- Aucune instruction de suppression : un brouillon se supprime depuis la
-- page (règle d'accès de l'administration, bulletin validé protégé).
-- =============================================================================


-- #############################################################################
-- 0. OUTILS : HEURES MAJORÉES DES SEMAINES DE TRAVAIL
-- #############################################################################

-- 0a. Heures majorées d'une semaine de travail :
--     temps plein : de la 36e à la 43e heure à 25 %, au-delà à 50 % ;
--     temps partiel : heures complémentaires à 10 % dans la limite du
--     dixième de la durée du contrat, au-delà à 25 %.
create or replace function prive.heures_majorees(p_total numeric, p_partiel boolean, p_hebdo numeric)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_partiel then
    jsonb_build_object('sup_25', 0, 'sup_50', 0,
      'comp_10', least(greatest(p_total - p_hebdo, 0), round(p_hebdo / 10, 2)),
      'comp_25', greatest(greatest(p_total - p_hebdo, 0) - round(p_hebdo / 10, 2), 0))
  else
    jsonb_build_object('sup_25', least(greatest(p_total - 35, 0), 8), 'sup_50', greatest(p_total - 43, 0),
      'comp_10', 0, 'comp_25', 0)
  end;
$$;

-- 0b. Semaines payées avec un mois (celles dont le dimanche tombe dans le
--     mois) : heures saisies et heures majorées de chaque semaine
create or replace function prive.semaines_payees(p_salarie uuid, p_mois date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with s as (
    select sa.temps, sa.heures_mensuelles from public.salaries sa where sa.id = p_salarie
  ),
  semaines as (
    select d::date as lundi
    from generate_series(date_trunc('week', p_mois)::date, (p_mois + interval '1 month')::date - 1, interval '7 days') as g(d)
  ),
  w as (
    select sm.lundi, sm.lundi + 6 as dimanche,
           coalesce(sum(t.heures), 0) as heures, count(t.id) as jours_saisis
    from semaines sm
    left join public.temps_travail t
      on t.salarie_id = p_salarie and t.source = 'saisie' and t.jour between sm.lundi and sm.lundi + 6
    where sm.lundi + 6 between p_mois and (p_mois + interval '1 month')::date - 1
    group by sm.lundi
  )
  select coalesce(jsonb_agg(jsonb_build_object('lundi', w.lundi, 'dimanche', w.dimanche, 'heures', w.heures, 'jours_saisis', w.jours_saisis)
                            || prive.heures_majorees(w.heures, s.temps = 'partiel', round(s.heures_mensuelles * 12 / 52, 2))
                            order by w.lundi), '[]'::jsonb)
  from w cross join s;
$$;


-- #############################################################################
-- 1. PRÉPARATION, APERÇU, BROUILLON, VALIDATION, REMISE
-- #############################################################################

-- 1a. Préparer le bulletin d'un mois : variables du brouillon s'il existe,
--     sinon suggestions (heures majorées des semaines payées ce mois-ci,
--     absences validées), primes et indemnités du mois précédent
create or replace function public.admin_preparer_bulletin(p_salarie uuid, p_periode date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s             public.salaries;
  b             public.bulletins;
  bp            public.bulletins;
  v_debut       date := date_trunc('month', p_periode)::date;
  v_fin         date;
  v_du          date;
  v_au          date;
  v_heures_jour numeric;
  v_semaines    jsonb;
  v_absences    jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into s from public.salaries sa where sa.id = p_salarie;
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  v_fin := (v_debut + interval '1 month')::date - 1;
  v_du := greatest(v_debut, s.date_entree);
  v_au := least(v_fin, coalesce(s.date_sortie, v_fin));
  v_heures_jour := round(case when s.heures_mensuelles = 151.67 then 1820.0 / 12 else s.heures_mensuelles end * 12 / 52 / 5, 2);
  select * into b from public.bulletins x where x.salarie_id = s.id and x.periode = v_debut;
  select * into bp from public.bulletins x where x.salarie_id = s.id and x.periode = (v_debut - interval '1 month')::date;
  v_semaines := prive.semaines_payees(s.id, v_debut);

  -- Absences non rémunérées suggérées : absences validées autres que les
  -- congés payés, en heures (jours ouvrés × durée d'une journée)
  select coalesce(jsonb_agg(jsonb_build_object(
           'libelle', case a.type when 'maladie' then 'Absence maladie' when 'accident_travail' then 'Absence accident du travail'
                                  else 'Absence non rémunérée' end
                      || ' du ' || to_char(greatest(a.debut, v_du), 'DD/MM') || ' au ' || to_char(least(a.fin, v_au), 'DD/MM'),
           'heures', round(prive.jours_ouvres(greatest(a.debut, v_du), least(a.fin, v_au)) * v_heures_jour, 2))
         order by a.debut), '[]'::jsonb)
    into v_absences
    from public.absences a
   where a.salarie_id = s.id and a.statut = 'validee' and a.type <> 'conges_payes'
     and a.debut <= v_au and a.fin >= v_du and v_du <= v_au
     and prive.jours_ouvres(greatest(a.debut, v_du), least(a.fin, v_au)) > 0;

  return jsonb_build_object(
    'salarie', jsonb_build_object('id', s.id, 'nom', s.prenom || ' ' || s.nom, 'matricule', s.matricule, 'emploi', s.emploi,
      'temps', s.temps, 'heures_mensuelles', s.heures_mensuelles, 'cadre', s.cadre, 'taux_pas', s.taux_pas,
      'salaire_base_mensuel', s.salaire_base_mensuel, 'taux_horaire', s.taux_horaire, 'date_entree', s.date_entree, 'date_sortie', s.date_sortie),
    'periode', v_debut,
    'existant', case when b.id is null then null
                     else jsonb_build_object('id', b.id, 'statut', b.statut, 'variables', b.variables) end,
    'suggestion', jsonb_build_object(
      'heures_sup_25', coalesce((select sum((w ->> 'sup_25')::numeric) from jsonb_array_elements(v_semaines) as t(w)), 0),
      'heures_sup_50', coalesce((select sum((w ->> 'sup_50')::numeric) from jsonb_array_elements(v_semaines) as t(w)), 0),
      'heures_comp_10', coalesce((select sum((w ->> 'comp_10')::numeric) from jsonb_array_elements(v_semaines) as t(w)), 0),
      'heures_comp_25', coalesce((select sum((w ->> 'comp_25')::numeric) from jsonb_array_elements(v_semaines) as t(w)), 0),
      'absences', v_absences,
      'date_paiement', v_fin),
    'semaines', v_semaines,
    'precedent', case when bp.id is null then null
                      else jsonb_build_object('statut', bp.statut,
                             'primes', coalesce(bp.variables -> 'primes', '[]'::jsonb),
                             'avantages', coalesce(bp.variables -> 'avantages', '[]'::jsonb),
                             'non_soumis', coalesce(bp.variables -> 'non_soumis', '[]'::jsonb)) end);
end;
$$;

-- 1b. Aperçu : calcul complet sans rien enregistrer
create or replace function public.admin_calculer_bulletin(p_salarie uuid, p_periode date, p_variables jsonb)
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
  return prive.calculer_bulletin(p_salarie, date_trunc('month', p_periode)::date, coalesce(p_variables, '{}'::jsonb));
end;
$$;

-- 1c. Enregistrer le brouillon (créé ou recalculé)
create or replace function public.admin_enregistrer_bulletin(p_salarie uuid, p_periode date, p_variables jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_periode date := date_trunc('month', p_periode)::date;
  v         jsonb;
  b         public.bulletins;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  v := prive.calculer_bulletin(p_salarie, v_periode, coalesce(p_variables, '{}'::jsonb));
  select * into b from public.bulletins x where x.salarie_id = p_salarie and x.periode = v_periode for update;
  if b.id is not null and b.statut <> 'brouillon' then
    raise exception 'Le bulletin % est déjà validé : il ne se modifie plus.', prive.de_mois(v_periode);
  end if;
  if b.id is null then
    insert into public.bulletins (salarie_id, periode, statut)
    values (p_salarie, v_periode, 'brouillon')
    returning * into b;
  end if;
  update public.bulletins set
    date_paiement = (v ->> 'date_paiement')::date,
    heures = (v -> 'heures' ->> 'payees')::numeric,
    brut = (v ->> 'brut')::numeric,
    total_cotisations_salariales = (v -> 'totaux' ->> 'cotisations_salariales')::numeric,
    total_cotisations_patronales = (v -> 'totaux' ->> 'cotisations_patronales')::numeric,
    net_avant_impot = (v ->> 'net_avant_impot')::numeric,
    net_imposable = (v ->> 'net_imposable')::numeric,
    net_social = (v ->> 'net_social')::numeric,
    taux_pas = (v -> 'pas' ->> 'taux')::numeric,
    montant_pas = (v -> 'pas' ->> 'montant')::numeric,
    net_a_payer = (v ->> 'net_a_payer')::numeric,
    cout_employeur = (v ->> 'cout_employeur')::numeric,
    allegements = (v -> 'totaux' ->> 'allegements')::numeric,
    salaire_base = (v ->> 'salaire_base')::numeric,
    taux_horaire = (v ->> 'taux_horaire')::numeric,
    cumuls = v -> 'cumuls',
    conges = v -> 'conges',
    variables = v -> 'variables',
    calcul = v
  where id = b.id;
  return jsonb_build_object('id', b.id, 'statut', 'brouillon', 'calcul', v);
end;
$$;

-- 1d. Valider : nouveau calcul avec les paramètres du moment, refus si un
--     contrôle est bloquant ; lignes recopiées et figées ; salarié prévenu
create or replace function public.admin_valider_bulletin(p_bulletin uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b           public.bulletins;
  s           public.salaries;
  v           jsonb;
  v_bloquants text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into b from public.bulletins x where x.id = p_bulletin for update;
  if not found then
    raise exception 'Bulletin introuvable.';
  end if;
  if b.statut <> 'brouillon' then
    raise exception 'Ce bulletin est déjà validé.';
  end if;
  select * into s from public.salaries sa where sa.id = b.salarie_id;
  v := prive.calculer_bulletin(b.salarie_id, b.periode, b.variables);
  select string_agg(x ->> 'message', ' ') into v_bloquants
    from jsonb_array_elements(v -> 'controles') as t(x) where x ->> 'niveau' = 'bloquant';
  if v_bloquants is not null then
    raise exception 'Validation impossible. %', v_bloquants;
  end if;

  update public.bulletins set
    date_paiement = (v ->> 'date_paiement')::date,
    heures = (v -> 'heures' ->> 'payees')::numeric,
    brut = (v ->> 'brut')::numeric,
    total_cotisations_salariales = (v -> 'totaux' ->> 'cotisations_salariales')::numeric,
    total_cotisations_patronales = (v -> 'totaux' ->> 'cotisations_patronales')::numeric,
    net_avant_impot = (v ->> 'net_avant_impot')::numeric,
    net_imposable = (v ->> 'net_imposable')::numeric,
    net_social = (v ->> 'net_social')::numeric,
    taux_pas = (v -> 'pas' ->> 'taux')::numeric,
    montant_pas = (v -> 'pas' ->> 'montant')::numeric,
    net_a_payer = (v ->> 'net_a_payer')::numeric,
    cout_employeur = (v ->> 'cout_employeur')::numeric,
    allegements = (v -> 'totaux' ->> 'allegements')::numeric,
    salaire_base = (v ->> 'salaire_base')::numeric,
    taux_horaire = (v ->> 'taux_horaire')::numeric,
    cumuls = v -> 'cumuls',
    conges = v -> 'conges',
    variables = v -> 'variables',
    calcul = v,
    statut = 'valide',
    valide_par = auth.uid(),
    valide_le = now()
  where id = b.id;

  -- Lignes figées : rémunération, cotisations, allègements, impôt, après le net
  insert into public.bulletin_lignes (bulletin_id, ordre, section, code, libelle, base, taux_salarial, montant_salarial, taux_patronal, montant_patronal)
  select b.id, row_number() over (order by g.rang, g.n), g.section, g.code, g.libelle, g.base, g.taux_salarial, g.montant_salarial,
         g.taux_patronal, g.montant_patronal
  from (
    select 1 as rang, r.n, 'remuneration' as section, r.x ->> 'code' as code, r.x ->> 'libelle' as libelle, (r.x ->> 'base')::numeric as base,
           (r.x ->> 'taux')::numeric as taux_salarial, (r.x ->> 'montant')::numeric as montant_salarial, null::numeric as taux_patronal,
           null::numeric as montant_patronal
      from jsonb_array_elements(v -> 'remuneration') with ordinality as r(x, n)
    union all
    select 2, k.n, k.x ->> 'section', k.x ->> 'code', k.x ->> 'libelle', (k.x ->> 'base')::numeric, (k.x ->> 'taux_salarial')::numeric,
           (k.x ->> 'montant_salarial')::numeric, (k.x ->> 'taux_patronal')::numeric, (k.x ->> 'montant_patronal')::numeric
      from jsonb_array_elements((v -> 'cotisations') || (v -> 'allegements')) with ordinality as k(x, n)
    union all
    select 3, 1, 'impot', 'prelevement_source', 'Impôt sur le revenu prélevé à la source'
           || case when v -> 'pas' ->> 'type' = 'neutre' then ' (taux non personnalisé)' else ' (taux personnalisé)' end,
           (v -> 'pas' ->> 'base')::numeric, (v -> 'pas' ->> 'taux')::numeric, (v -> 'pas' ->> 'montant')::numeric, null, null
    union all
    select 4, a.n, 'apres_net', a.x ->> 'code', a.x ->> 'libelle', null, null, (a.x ->> 'montant')::numeric, null, null
      from jsonb_array_elements(v -> 'apres_net') with ordinality as a(x, n)
  ) as g;

  perform prive.notifier(s.profil_id, 'document', 'Bulletin de paie disponible',
    'Votre bulletin de paie ' || prive.de_mois(b.periode) || ' est disponible : net à payer '
    || prive.euros((v ->> 'net_a_payer')::numeric) || '.', null);
  return jsonb_build_object('id', b.id, 'statut', 'valide', 'net_a_payer', (v ->> 'net_a_payer')::numeric);
end;
$$;

-- 1e. Remis au salarié (avec le PDF imprimé, facultatif) ; renvoie le
--     chemin de l'ancien PDF remplacé, à retirer du dossier
create or replace function public.admin_remettre_bulletin(p_bulletin uuid, p_chemin text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.bulletins;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into b from public.bulletins x where x.id = p_bulletin for update;
  if not found then
    raise exception 'Bulletin introuvable.';
  end if;
  if b.statut = 'brouillon' then
    raise exception 'Validez d''abord le bulletin.';
  end if;
  if p_chemin is not null and (p_chemin not like b.salarie_id::text || '/bulletins/%' or p_chemin like '%..%') then
    raise exception 'Chemin du fichier invalide.';
  end if;
  update public.bulletins set statut = 'envoye', pdf_chemin = coalesce(p_chemin, pdf_chemin) where id = b.id;
  return case when p_chemin is not null and b.pdf_chemin is distinct from p_chemin then b.pdf_chemin end;
end;
$$;


-- #############################################################################
-- 2. LECTURES
-- #############################################################################

-- 2a. Bulletins d'un mois : chaque salarié sous contrat ce mois-là (ou qui a
--     un bulletin), l'état de son bulletin, les totaux du mois
create or replace function public.admin_lister_bulletins(p_periode date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_debut  date := date_trunc('month', p_periode)::date;
  v_fin    date := (date_trunc('month', p_periode) + interval '1 month')::date - 1;
  c        public.constantes_paie;
  v_lignes jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into c from public.constantes_paie cp where cp.annee = extract(year from v_debut)::integer;

  select coalesce(jsonb_agg(jsonb_build_object(
           'salarie_id', s.id, 'nom', s.prenom || ' ' || s.nom, 'matricule', s.matricule, 'emploi', s.emploi,
           'date_entree', s.date_entree, 'date_sortie', s.date_sortie, 'compte', s.profil_id is not null,
           'present', s.date_entree <= v_fin and (s.date_sortie is null or s.date_sortie >= v_debut),
           'bulletin', case when b.id is null then null else jsonb_build_object(
             'id', b.id, 'statut', b.statut, 'brut', b.brut, 'net_a_payer', b.net_a_payer, 'net_imposable', b.net_imposable,
             'montant_pas', b.montant_pas, 'cout_employeur', b.cout_employeur, 'pdf_chemin', b.pdf_chemin, 'valide_le', b.valide_le,
             'bloquants', (select count(*) from jsonb_array_elements(coalesce(b.calcul -> 'controles', '[]'::jsonb)) as t(x)
                            where x ->> 'niveau' = 'bloquant')) end)
         order by s.nom, s.prenom), '[]'::jsonb)
    into v_lignes
    from public.salaries s
    left join public.bulletins b on b.salarie_id = s.id and b.periode = v_debut
   where (s.date_entree <= v_fin and (s.date_sortie is null or s.date_sortie >= v_debut)) or b.id is not null;

  return jsonb_build_object(
    'periode', v_debut, 'mois', prive.mois_lisible(v_debut),
    'parametres', jsonb_build_object('annee', extract(year from v_debut)::integer, 'existent', c.annee is not null,
      'valides', coalesce(c.valide_par_comptable, false), 'valide_le', c.valide_le),
    'lignes', v_lignes,
    'totaux', (select jsonb_build_object(
        'brut', coalesce(sum(b.brut), 0), 'net_a_payer', coalesce(sum(b.net_a_payer), 0), 'pas', coalesce(sum(b.montant_pas), 0),
        'cout_employeur', coalesce(sum(b.cout_employeur), 0), 'cotisations', coalesce(sum(b.total_cotisations_salariales + b.total_cotisations_patronales), 0),
        'valides', count(*) filter (where b.statut <> 'brouillon'), 'brouillons', count(*) filter (where b.statut = 'brouillon'))
      from public.bulletins b where b.periode = v_debut),
    'manquants', (select count(*) from public.salaries s
                   where s.date_entree <= v_fin and (s.date_sortie is null or s.date_sortie >= v_debut)
                     and not exists (select 1 from public.bulletins b where b.salarie_id = s.id and b.periode = v_debut)
                     and not exists (select 1 from public.reprises_paie r where r.salarie_id = s.id and r.mois >= v_debut)));
end;
$$;

-- 2b. Document imprimable : le bulletin tel qu'il a été calculé et validé
create or replace function public.admin_document_bulletin(p_bulletin uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bulletins;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into b from public.bulletins x where x.id = p_bulletin;
  if not found then
    raise exception 'Bulletin introuvable.';
  end if;
  return jsonb_build_object('id', b.id, 'salarie_id', b.salarie_id, 'periode', b.periode, 'statut', b.statut,
    'pdf_chemin', b.pdf_chemin, 'valide_le', b.valide_le,
    'valide_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = b.valide_par),
    'calcul', b.calcul);
end;
$$;


-- #############################################################################
-- 3. DROITS D'EXÉCUTION
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout, puis on n'accorde que l'utile.
revoke all on function
  prive.heures_majorees(numeric, boolean, numeric),
  prive.semaines_payees(uuid, date)
  from public, anon, authenticated;

revoke all on function
  public.admin_preparer_bulletin(uuid, date),
  public.admin_calculer_bulletin(uuid, date, jsonb),
  public.admin_enregistrer_bulletin(uuid, date, jsonb),
  public.admin_valider_bulletin(uuid),
  public.admin_remettre_bulletin(uuid, text),
  public.admin_lister_bulletins(date),
  public.admin_document_bulletin(uuid)
  from public, anon;

grant execute on function
  public.admin_preparer_bulletin(uuid, date),
  public.admin_calculer_bulletin(uuid, date, jsonb),
  public.admin_enregistrer_bulletin(uuid, date, jsonb),
  public.admin_valider_bulletin(uuid),
  public.admin_remettre_bulletin(uuid, text),
  public.admin_lister_bulletins(date),
  public.admin_document_bulletin(uuid)
  to authenticated;
