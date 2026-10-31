-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 16e : RH ET PAIE (5/5) — congés et absences, temps de travail,
--                 paramètres de paie
-- -----------------------------------------------------------------------------
--   1. Congés et absences : liste d'une période, demandes en attente, soldes
--      de congés payés ; saisie par l'administration (jours décomptés
--      calculés), décision sur une demande du salarié (prévenu). Une absence
--      d'un mois dont le bulletin est validé ne s'enregistre plus.
--   2. Temps de travail : semaines du mois jour par jour (heures saisies,
--      heures de courses à titre indicatif, absences, jours fériés), heures
--      majorées de chaque semaine (payées avec le mois du dimanche) ; saisie.
--   3. Paramètres de paie : lecture d'une année, validation par
--      l'expert-comptable (nom et date inscrits), retrait de la validation
--      (motif), copie vers une nouvelle année.
-- Aucune instruction de suppression : une absence ou une ligne de paramètre
-- se supprime depuis la page (règles d'accès de l'administration).
-- =============================================================================


-- #############################################################################
-- 1. CONGÉS ET ABSENCES
-- #############################################################################

-- 1a. Absences d'une période (et toutes les demandes en attente), soldes de
--     congés payés au dernier bulletin validé de chaque salarié
create or replace function public.admin_lister_absences(p_debut date, p_fin date, p_salarie uuid default null)
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
  if p_debut is null or p_fin is null or p_fin < p_debut then
    raise exception 'Période invalide.';
  end if;
  return jsonb_build_object(
    'lignes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'salarie_id', a.salarie_id, 'nom', s.prenom || ' ' || s.nom, 'type', a.type, 'debut', a.debut, 'fin', a.fin,
        'jours', a.jours, 'statut', a.statut, 'commentaire', a.commentaire, 'decision_note', a.decision_note, 'decide_le', a.decide_le,
        'decide_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = a.decide_par),
        'cree_le', a.cree_le, 'verrouille', prive.mois_valide(a.salarie_id, a.debut, a.fin) is not null)
        order by a.debut desc, s.nom), '[]'::jsonb)
      from public.absences a join public.salaries s on s.id = a.salarie_id
      where a.debut <= p_fin and a.fin >= p_debut and (p_salarie is null or a.salarie_id = p_salarie)),
    'demandes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'salarie_id', a.salarie_id, 'nom', s.prenom || ' ' || s.nom, 'type', a.type, 'debut', a.debut, 'fin', a.fin,
        'jours', a.jours, 'commentaire', a.commentaire, 'cree_le', a.cree_le) order by a.debut), '[]'::jsonb)
      from public.absences a join public.salaries s on s.id = a.salarie_id
      where a.statut = 'demandee' and (p_salarie is null or a.salarie_id = p_salarie)),
    'soldes', (select coalesce(jsonb_agg(jsonb_build_object(
        'salarie_id', s.id, 'nom', s.prenom || ' ' || s.nom,
        'n1_solde', b.conges -> 'n1_solde', 'n_solde', b.conges -> 'n_solde', 'au', b.periode,
        'reprise', case when b.periode is null and r.salarie_id is not null
                        then jsonb_build_object('mois', r.mois, 'n1_solde', r.cp_n1, 'n_solde', r.cp_n) end,
        'pris_ensuite', (select coalesce(sum(a.jours), 0) from public.absences a
                          where a.salarie_id = s.id and a.statut = 'validee' and a.type = 'conges_payes'
                            and a.debut > coalesce((b.periode + interval '1 month')::date - 1, (r.mois + interval '1 month')::date - 1, date '1900-01-01')))
        order by s.nom, s.prenom), '[]'::jsonb)
      from public.salaries s
      left join lateral (select x.periode, x.conges from public.bulletins x
                          where x.salarie_id = s.id and x.statut <> 'brouillon' order by x.periode desc limit 1) b on true
      left join public.reprises_paie r on r.salarie_id = s.id
      where (s.date_sortie is null or s.date_sortie >= p_debut) and (p_salarie is null or s.id = p_salarie)),
    'salaries', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nom', s.prenom || ' ' || s.nom, 'date_entree', s.date_entree,
                                                          'date_sortie', s.date_sortie) order by s.nom, s.prenom), '[]'::jsonb)
                   from public.salaries s));
end;
$$;

-- 1b. Saisie ou correction d'une absence par l'administration (validée
--     d'office) ; jours décomptés calculés si non indiqués
create or replace function public.admin_enregistrer_absence(
  p_absence uuid, p_salarie uuid, p_type text, p_debut date, p_fin date, p_jours numeric default null, p_commentaire text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s        public.salaries;
  a        public.absences;
  v_autre  public.absences;
  v_mois   date;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_absence is not null then
    select * into a from public.absences x where x.id = p_absence for update;
    if not found then
      raise exception 'Absence introuvable.';
    end if;
    v_mois := prive.mois_valide(a.salarie_id, a.debut, a.fin);
    if v_mois is not null then
      raise exception 'Le bulletin % est validé : cette absence ne se modifie plus (régularisez sur le bulletin suivant).', prive.de_mois(v_mois);
    end if;
  end if;
  select * into s from public.salaries x where x.id = coalesce(a.salarie_id, p_salarie);
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  if p_type is null or p_type not in ('conges_payes', 'maladie', 'accident_travail', 'sans_solde', 'autre') then
    raise exception 'Type d''absence inconnu.';
  end if;
  if p_debut is null or p_fin is null or p_fin < p_debut then
    raise exception 'Indiquez le premier et le dernier jour d''absence (le dernier après le premier).';
  end if;
  if p_fin - p_debut > 366 then
    raise exception 'Une absence se saisit sur un an au plus.';
  end if;
  if p_debut < s.date_entree or (s.date_sortie is not null and p_fin > s.date_sortie) then
    raise exception 'L''absence sort du contrat (entrée le %).', to_char(s.date_entree, 'DD/MM/YYYY')
      || coalesce(', sortie le ' || to_char(s.date_sortie, 'DD/MM/YYYY'), '');
  end if;
  if p_jours is not null and (p_jours <= 0 or p_jours > p_fin - p_debut + 1) then
    raise exception 'Jours décomptés : plus de 0 et au plus le nombre de jours de la période.';
  end if;
  v_mois := prive.mois_valide(s.id, p_debut, p_fin);
  if v_mois is not null then
    raise exception 'Le bulletin % est validé : une absence de ce mois ne s''enregistre plus (régularisez sur le bulletin suivant).', prive.de_mois(v_mois);
  end if;
  select * into v_autre from public.absences x
   where x.salarie_id = s.id and x.statut <> 'refusee' and x.id is distinct from p_absence and x.debut <= p_fin and x.fin >= p_debut
   order by x.debut limit 1;
  if v_autre.id is not null then
    raise exception 'Une absence est déjà enregistrée du % au % : corrigez-la plutôt.', to_char(v_autre.debut, 'DD/MM/YYYY'), to_char(v_autre.fin, 'DD/MM/YYYY');
  end if;
  if p_absence is null then
    insert into public.absences (salarie_id, type, debut, fin, jours, statut, commentaire, decide_par, decide_le)
    values (s.id, p_type, p_debut, p_fin, p_jours, 'validee', nullif(left(trim(coalesce(p_commentaire, '')), 500), ''), auth.uid(), now())
    returning * into a;
  else
    update public.absences set type = p_type, debut = p_debut, fin = p_fin, jours = p_jours, statut = 'validee',
      commentaire = nullif(left(trim(coalesce(p_commentaire, '')), 500), ''), decide_par = auth.uid(), decide_le = now()
    where id = a.id
    returning * into a;
  end if;
  return to_jsonb(a);
end;
$$;

-- 1c. Décision sur une demande du salarié : validée ou refusée (motif) ; le
--     salarié est prévenu
create or replace function public.admin_decider_absence(p_absence uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a       public.absences;
  s       public.salaries;
  v_note  text := nullif(left(trim(coalesce(p_note, '')), 300), '');
  v_mois  date;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into a from public.absences x where x.id = p_absence for update;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  if a.statut <> 'demandee' then
    raise exception 'Cette demande a déjà reçu une réponse.';
  end if;
  if p_decision is null or p_decision not in ('validee', 'refusee') then
    raise exception 'Décision : accepter ou refuser.';
  end if;
  if p_decision = 'refusee' and v_note is null then
    raise exception 'Indiquez le motif du refus : il est transmis au salarié.';
  end if;
  v_mois := prive.mois_valide(a.salarie_id, a.debut, a.fin);
  if p_decision = 'validee' and v_mois is not null then
    raise exception 'Le bulletin % est validé : cette absence ne peut plus être acceptée telle quelle.', prive.de_mois(v_mois);
  end if;
  update public.absences set statut = p_decision, decision_note = v_note, decide_par = auth.uid(), decide_le = now()
  where id = a.id returning * into a;
  select * into s from public.salaries x where x.id = a.salarie_id;
  perform prive.notifier(s.profil_id, 'info',
    case when p_decision = 'validee' then 'Demande d''absence acceptée' else 'Demande d''absence refusée' end,
    'Votre demande du ' || to_char(a.debut, 'DD/MM/YYYY') || ' au ' || to_char(a.fin, 'DD/MM/YYYY')
    || case when p_decision = 'validee' then ' est acceptée.' else ' est refusée : ' || v_note end, null);
  return to_jsonb(a);
end;
$$;


-- #############################################################################
-- 2. TEMPS DE TRAVAIL
-- #############################################################################

-- 2a. Semaines (du lundi au dimanche) qui touchent le mois, jour par jour :
--     heures saisies, heures de courses (de l'acceptation à la fin, à titre
--     indicatif), absences validées, jours fériés ; heures majorées de chaque
--     semaine, payées avec le mois de son dimanche
create or replace function public.admin_temps_travail(p_salarie uuid, p_mois date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s        public.salaries;
  v_debut  date := date_trunc('month', p_mois)::date;
  v_fin    date := (date_trunc('month', p_mois) + interval '1 month')::date - 1;
  v_hebdo  numeric;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into s from public.salaries x where x.id = p_salarie;
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  v_hebdo := round(s.heures_mensuelles * 12 / 52, 2);
  return jsonb_build_object(
    'salarie', jsonb_build_object('id', s.id, 'nom', s.prenom || ' ' || s.nom, 'temps', s.temps, 'heures_mensuelles', s.heures_mensuelles,
      'heures_hebdo', case when s.heures_mensuelles = 151.67 then 35 else v_hebdo end, 'date_entree', s.date_entree, 'date_sortie', s.date_sortie,
      'compte', s.profil_id is not null),
    'mois', v_debut,
    'semaines', (
      select coalesce(jsonb_agg(sem.objet order by sem.lundi), '[]'::jsonb)
      from (
        select w.lundi,
               jsonb_build_object(
                 'lundi', w.lundi, 'dimanche', w.lundi + 6, 'paye_en', date_trunc('month', w.lundi + 6)::date,
                 'verrouille', exists (select 1 from public.bulletins b where b.salarie_id = s.id and b.statut <> 'brouillon'
                                         and b.periode = date_trunc('month', w.lundi + 6)::date),
                 'jours', (select jsonb_agg(jsonb_build_object(
                             'jour', j.jour,
                             'heures', (select t.heures from public.temps_travail t where t.salarie_id = s.id and t.jour = j.jour and t.source = 'saisie'),
                             'courses', (select round(coalesce(sum(extract(epoch from (c.terminee_le - coalesce(c.acceptee_le, c.demarree_le)))) / 3600, 0)::numeric, 2)
                                           from public.courses c
                                          where s.profil_id is not null and c.chauffeur_id = s.profil_id and c.statut = 'terminee'
                                            and (c.terminee_le at time zone 'Europe/Paris')::date = j.jour),
                             'absence', (select a.type from public.absences a where a.salarie_id = s.id and a.statut = 'validee'
                                           and j.jour between a.debut and a.fin limit 1),
                             'ferie', (select f.libelle from public.jours_feries f where f.jour = j.jour),
                             'sous_contrat', j.jour >= s.date_entree and (s.date_sortie is null or j.jour <= s.date_sortie))
                             order by j.jour)
                           from (select (w.lundi + n)::date as jour from generate_series(0, 6) as g(n)) j),
                 'total', coalesce((select sum(t.heures) from public.temps_travail t
                                     where t.salarie_id = s.id and t.source = 'saisie' and t.jour between w.lundi and w.lundi + 6), 0))
               || prive.heures_majorees(coalesce((select sum(t.heures) from public.temps_travail t
                                                   where t.salarie_id = s.id and t.source = 'saisie' and t.jour between w.lundi and w.lundi + 6), 0),
                                        s.temps = 'partiel', v_hebdo) as objet
        from (select d::date as lundi from generate_series(date_trunc('week', v_debut)::date, v_fin, interval '7 days') as g(d)) w
      ) sem),
    'payees_ce_mois', prive.semaines_payees(s.id, v_debut));
end;
$$;

-- 2b. Saisie des heures : [{ jour, heures }] ; 0 = jour non travaillé
create or replace function public.admin_enregistrer_temps(p_salarie uuid, p_jours jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s        public.salaries;
  e        jsonb;
  v_jour   date;
  v_heures numeric;
  v_nombre integer := 0;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into s from public.salaries x where x.id = p_salarie;
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  if p_jours is null or jsonb_typeof(p_jours) <> 'array' or jsonb_array_length(p_jours) = 0 or jsonb_array_length(p_jours) > 62 then
    raise exception 'Aucune heure à enregistrer.';
  end if;
  for e in select x from jsonb_array_elements(p_jours) as t(x) loop
    v_jour := prive.date_json(e, 'jour', 'Jour');
    if v_jour is null then
      raise exception 'Jour manquant.';
    end if;
    if jsonb_typeof(e -> 'heures') is distinct from 'number' then
      raise exception 'Heures du % : nombre attendu.', to_char(v_jour, 'DD/MM/YYYY');
    end if;
    v_heures := round((e ->> 'heures')::numeric, 2);
    if v_heures < 0 or v_heures > 24 then
      raise exception 'Heures du % : entre 0 et 24.', to_char(v_jour, 'DD/MM/YYYY');
    end if;
    if v_heures > 0 and (v_jour < s.date_entree or (s.date_sortie is not null and v_jour > s.date_sortie)) then
      raise exception 'Le % est hors du contrat du salarié.', to_char(v_jour, 'DD/MM/YYYY');
    end if;
    -- Semaine payée avec le mois de son dimanche : figée si ce bulletin est validé
    if exists (select 1 from public.bulletins b where b.salarie_id = s.id and b.statut <> 'brouillon'
                and b.periode = date_trunc('month', date_trunc('week', v_jour)::date + 6)::date) then
      raise exception 'La semaine du % est payée sur un bulletin validé : ses heures ne se modifient plus.', to_char(v_jour, 'DD/MM/YYYY');
    end if;
    insert into public.temps_travail (salarie_id, jour, heures, source)
    values (s.id, v_jour, v_heures, 'saisie')
    on conflict (salarie_id, jour, source) do update set heures = excluded.heures;
    v_nombre := v_nombre + 1;
  end loop;
  return v_nombre;
end;
$$;


-- #############################################################################
-- 3. PARAMÈTRES DE PAIE
-- #############################################################################

-- 3a. Une année : constantes, lignes de cotisation, SMIC, grille du taux
--     neutre en vigueur, points à régler avant la validation
create or replace function public.admin_parametres_paie(p_annee integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c         public.constantes_paie;
  v_grille  date;
  v_points  jsonb := '[]'::jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into c from public.constantes_paie x where x.annee = p_annee;
  select max(g.valable_du) into v_grille from public.grille_taux_neutre g where g.valable_du <= make_date(p_annee, 12, 31);
  if c.annee is not null then
    if exists (select 1 from public.parametres_paie l where l.annee = p_annee and l.actif and l.section = 'accidents_travail' and l.taux_patronal = 0) then
      v_points := v_points || prive.controle('bloquant', 'at_mp', 'Taux accidents du travail à 0 : saisissez le taux notifié à l''entreprise.');
    end if;
    if not exists (select 1 from public.parametres_paie l where l.annee = p_annee and l.actif and l.protection = 'sante') then
      v_points := v_points || prive.controle('attention', 'sante', 'Complémentaire santé inactive : renseignez les montants du contrat d''entreprise et activez la ligne.');
    end if;
    if c.smic_horaire_rgdu is null then
      v_points := v_points || prive.controle('attention', 'rgdu', 'Réduction générale non paramétrée : aucune réduction ne sera calculée.');
    end if;
    if not exists (select 1 from public.smic m where m.valable_du <= make_date(p_annee, 1, 1)) then
      v_points := v_points || prive.controle('attention', 'smic', 'Aucun SMIC en vigueur au 1er janvier ' || p_annee || ' dans la liste des SMIC.');
    end if;
    if v_grille is null then
      v_points := v_points || prive.controle('bloquant', 'grille', 'Aucune grille du taux neutre du prélèvement à la source.');
    end if;
  end if;
  return jsonb_build_object(
    'annee', p_annee,
    'annees', (select coalesce(jsonb_agg(x.annee order by x.annee desc), '[]'::jsonb) from public.constantes_paie x),
    'constantes', case when c.annee is null then null else to_jsonb(c) || jsonb_build_object(
      'valide_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.valide_par)) end,
    'lignes', (select coalesce(jsonb_agg(to_jsonb(l) order by l.ordre, l.code), '[]'::jsonb) from public.parametres_paie l where l.annee = p_annee),
    'smic', (select coalesce(jsonb_agg(to_jsonb(m) order by m.valable_du desc), '[]'::jsonb) from public.smic m),
    'grille', jsonb_build_object('valable_du', v_grille,
      'tranches', (select coalesce(jsonb_agg(jsonb_build_object('de', g.de, 'taux', g.taux) order by g.de), '[]'::jsonb)
                     from public.grille_taux_neutre g where g.valable_du = v_grille)),
    'grilles', (select coalesce(jsonb_agg(distinct g.valable_du), '[]'::jsonb) from public.grille_taux_neutre g),
    'points', v_points,
    'bulletins_valides', (select count(*) from public.bulletins b where b.statut <> 'brouillon' and extract(year from b.periode) = p_annee));
end;
$$;

-- 3b. Validation par l'expert-comptable : qui et quand (note obligatoire) ;
--     refusée tant qu'un point bloquant reste à régler
create or replace function public.admin_valider_parametres_paie(p_annee integer, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c       public.constantes_paie;
  v_note  text := nullif(left(trim(coalesce(p_note, '')), 300), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into c from public.constantes_paie x where x.annee = p_annee for update;
  if not found then
    raise exception 'Paramètres de paie % absents.', p_annee;
  end if;
  if c.valide_par_comptable then
    raise exception 'Les paramètres de paie % sont déjà validés.', p_annee;
  end if;
  if v_note is null or char_length(v_note) < 5 then
    raise exception 'Indiquez qui a validé (cabinet ou expert-comptable) et quand : c''est inscrit avec la validation.';
  end if;
  if exists (select 1 from public.parametres_paie l where l.annee = p_annee and l.actif and l.section = 'accidents_travail' and l.taux_patronal = 0) then
    raise exception 'Taux accidents du travail à 0 : saisissez d''abord le taux notifié à l''entreprise.';
  end if;
  if not exists (select 1 from public.grille_taux_neutre g where g.valable_du <= make_date(p_annee, 12, 31)) then
    raise exception 'Aucune grille du taux neutre du prélèvement à la source.';
  end if;
  update public.constantes_paie set valide_par_comptable = true, valide_le = now(), valide_par = auth.uid(), validation_note = v_note
  where annee = p_annee;
end;
$$;

-- 3c. Retrait de la validation (motif inscrit au journal) pour corriger
create or replace function public.admin_retirer_validation_paie(p_annee integer, p_motif text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c        public.constantes_paie;
  v_motif  text := nullif(left(trim(coalesce(p_motif, '')), 280), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into c from public.constantes_paie x where x.annee = p_annee for update;
  if not found or not c.valide_par_comptable then
    raise exception 'Les paramètres de paie % ne sont pas validés.', p_annee;
  end if;
  if v_motif is null then
    raise exception 'Indiquez le motif du retrait : il est conservé dans le journal.';
  end if;
  update public.constantes_paie set valide_par_comptable = false, valide_le = null, valide_par = null,
    validation_note = 'Validation retirée : ' || v_motif
  where annee = p_annee;
end;
$$;

-- 3d. Copie d'une année vers une autre (non validée : à mettre à jour avec
--     les nouvelles valeurs, puis à faire valider)
create or replace function public.admin_copier_parametres_paie(p_source integer, p_cible integer)
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
  if p_cible is null or p_cible < 2020 or p_cible > 2100 then
    raise exception 'Année invalide.';
  end if;
  if not exists (select 1 from public.constantes_paie x where x.annee = p_source) then
    raise exception 'Paramètres de paie % absents.', p_source;
  end if;
  if exists (select 1 from public.constantes_paie x where x.annee = p_cible) then
    raise exception 'Les paramètres de paie % existent déjà.', p_cible;
  end if;
  insert into public.constantes_paie (annee, plafond_mensuel_ss, smic_horaire, smic_horaire_rgdu, rgdu_tmin, rgdu_tdelta, rgdu_p,
    rgdu_taux_at, abattement_csg, reduction_salariale_hs, deduction_patronale_hs, plafond_exoneration_hs, valide_par_comptable,
    validation_note)
  select p_cible, x.plafond_mensuel_ss, x.smic_horaire, x.smic_horaire_rgdu, x.rgdu_tmin, x.rgdu_tdelta, x.rgdu_p, x.rgdu_taux_at,
         x.abattement_csg, x.reduction_salariale_hs, x.deduction_patronale_hs, x.plafond_exoneration_hs, false,
         'Copie des paramètres ' || p_source || ' : à mettre à jour, puis à faire valider.'
  from public.constantes_paie x where x.annee = p_source;
  insert into public.parametres_paie (annee, code, libelle, section, assiette, taux_salarial, taux_patronal, deductible, ordre,
    montant_salarial, montant_patronal, plafond_pmss, condition, protection, rgdu, actif)
  select p_cible, l.code, l.libelle, l.section, l.assiette, l.taux_salarial, l.taux_patronal, l.deductible, l.ordre,
         l.montant_salarial, l.montant_patronal, l.plafond_pmss, l.condition, l.protection, l.rgdu, l.actif
  from public.parametres_paie l where l.annee = p_source;
end;
$$;


-- #############################################################################
-- 4. DROITS D'EXÉCUTION
-- #############################################################################
revoke all on function
  public.admin_lister_absences(date, date, uuid),
  public.admin_enregistrer_absence(uuid, uuid, text, date, date, numeric, text),
  public.admin_decider_absence(uuid, text, text),
  public.admin_temps_travail(uuid, date),
  public.admin_enregistrer_temps(uuid, jsonb),
  public.admin_parametres_paie(integer),
  public.admin_valider_parametres_paie(integer, text),
  public.admin_retirer_validation_paie(integer, text),
  public.admin_copier_parametres_paie(integer, integer)
  from public, anon;

grant execute on function
  public.admin_lister_absences(date, date, uuid),
  public.admin_enregistrer_absence(uuid, uuid, text, date, date, numeric, text),
  public.admin_decider_absence(uuid, text, text),
  public.admin_temps_travail(uuid, date),
  public.admin_enregistrer_temps(uuid, jsonb),
  public.admin_parametres_paie(integer),
  public.admin_valider_parametres_paie(integer, text),
  public.admin_retirer_validation_paie(integer, text),
  public.admin_copier_parametres_paie(integer, integer)
  to authenticated;
