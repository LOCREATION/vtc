-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 16b : RH ET PAIE (2/5) — calcul d'un bulletin de paie
-- -----------------------------------------------------------------------------
-- Le bulletin est calculé par la base, jamais par la page : à partir de la
-- fiche du salarié, des paramètres de paie de l'année (validés par
-- l'expert-comptable) et des variables du mois saisies par l'administration
-- (heures supplémentaires ou complémentaires, absences non rémunérées,
-- primes, avantages en nature, indemnités non soumises, acompte).
--   1. Lecture contrôlée des variables saisies.
--   2. Calcul complet (prive.calculer_bulletin) :
--        - salaire de base mensualisé, taux horaire exact (4 à 6 décimales,
--          jamais arrondi au centime), prorata d'une entrée ou d'une sortie
--          en cours de mois (jours ouvrés), absences, heures majorées, primes ;
--        - cotisations ligne par ligne (base × taux, arrondi au centime),
--          plafond de la Sécurité sociale du mois, tranches 1 et 2, CSG et
--          CRDS sur leur assiette ;
--        - allègements : réduction de cotisations salariales et déduction
--          patronale sur les heures supplémentaires, réduction générale
--          dégressive unique calculée sur les cumuls de l'année ;
--        - net à payer avant impôt, net social, net imposable (heures
--          supplémentaires exonérées dans la limite annuelle), prélèvement
--          à la source (taux personnalisé ou grille du taux neutre), net à
--          payer, coût total employeur ;
--        - cumuls de l'année, congés payés (acquis, pris, soldes N-1 et N) ;
--        - contrôles : chaque ligne et chaque total sont revérifiés ; un
--          contrôle « bloquant » empêche la validation.
--   La préparation, l'aperçu, le brouillon, la validation et la remise d'un
--   bulletin sont dans la migration suivante (16c).
-- Rien n'est écrit ici : le calcul lit les tables et renvoie le bulletin.
-- =============================================================================


-- #############################################################################
-- 1. OUTILS
-- #############################################################################

-- 1a. Nombre saisi (0 si absent), contrôlé : jamais de message technique
create or replace function prive.variable_nombre(p_variables jsonb, p_cle text, p_libelle text, p_max numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_valeur jsonb := p_variables -> p_cle;
  v_nombre numeric;
begin
  if v_valeur is null or jsonb_typeof(v_valeur) = 'null' then
    return 0;
  end if;
  if jsonb_typeof(v_valeur) <> 'number' then
    raise exception '% : nombre attendu.', p_libelle;
  end if;
  v_nombre := round((v_valeur #>> '{}')::numeric, 2);
  if v_nombre < 0 or v_nombre > p_max then
    raise exception '% : entre 0 et %.', p_libelle, replace(p_max::text, '.', ',');
  end if;
  return v_nombre;
end;
$$;

-- 1b. Liste saisie [{ libelle, heures | montant }], nettoyée et contrôlée
create or replace function prive.variable_liste(p_variables jsonb, p_cle text, p_libelle text, p_champ text, p_max numeric)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_liste    jsonb := p_variables -> p_cle;
  v_element  jsonb;
  v_resultat jsonb := '[]'::jsonb;
  v_texte    text;
  v_nombre   numeric;
begin
  if v_liste is null or jsonb_typeof(v_liste) = 'null' then
    return v_resultat;
  end if;
  if jsonb_typeof(v_liste) <> 'array' then
    raise exception '% : liste attendue.', p_libelle;
  end if;
  if jsonb_array_length(v_liste) > 12 then
    raise exception '% : 12 lignes au plus.', p_libelle;
  end if;
  for v_element in select x from jsonb_array_elements(v_liste) as t(x) loop
    if jsonb_typeof(v_element) <> 'object' then
      raise exception '% : ligne invalide.', p_libelle;
    end if;
    v_texte := nullif(trim(coalesce(v_element ->> 'libelle', '')), '');
    if v_texte is null or char_length(v_texte) > 120 then
      raise exception '% : chaque ligne a un libellé (120 caractères au plus).', p_libelle;
    end if;
    if jsonb_typeof(v_element -> p_champ) is distinct from 'number' then
      raise exception '% (« % ») : nombre attendu.', p_libelle, v_texte;
    end if;
    v_nombre := round((v_element ->> p_champ)::numeric, 2);
    if v_nombre <= 0 or v_nombre > p_max then
      raise exception '% (« % ») : plus de 0 et au plus %.', p_libelle, v_texte, replace(p_max::text, '.', ',');
    end if;
    v_resultat := v_resultat || jsonb_build_array(jsonb_build_object('libelle', v_texte, p_champ, v_nombre));
  end loop;
  return v_resultat;
end;
$$;

-- 1b bis. « d'octobre 2026 », « de novembre 2026 » (élision devant une voyelle)
create or replace function prive.de_mois(p_jour date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when prive.mois_lisible(p_jour) ~ '^[aeiouyàâéèêîôû]' then 'd''' else 'de ' end || prive.mois_lisible(p_jour);
$$;

-- 1c. Contrôle d'un bulletin : bloquant (empêche la validation), attention, info
create or replace function prive.controle(p_niveau text, p_code text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_array(jsonb_build_object('niveau', p_niveau, 'code', p_code, 'message', p_message));
$$;

-- 1d. Valeur d'un cumul (0 s'il manque)
create or replace function prive.cumul(p_cumuls jsonb, p_cle text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select coalesce((p_cumuls ->> p_cle)::numeric, 0);
$$;

-- 1e. « 151,67 » : nombre à la française dans les messages
create or replace function prive.nombre_fr(p_nombre numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(coalesce(p_nombre, 0)::text, '.', ',');
$$;

-- #############################################################################
-- 2. CALCUL D'UN BULLETIN
-- #############################################################################
create or replace function prive.calculer_bulletin(p_salarie uuid, p_periode date, p_variables jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  s               public.salaries;
  so              public.societe;
  c               public.constantes_paie;
  rp              public.reprises_paie;
  bp              public.bulletins;
  l               public.parametres_paie;
  v_annee         integer := extract(year from p_periode)::integer;
  v_fin           date := (p_periode + interval '1 month')::date - 1;
  v_prec          date := (p_periode - interval '1 month')::date;
  v_mois          text := prive.mois_lisible(p_periode);
  v_nom           text;
  v_convention    text;
  v_manquants     text[];
  v_suivant       date;
  -- Présence dans le mois
  v_du            date;
  v_au            date;
  v_complet       boolean;
  v_jours_mois    integer;
  v_jours_pres    integer;
  v_ouvres_mois   integer;
  v_ouvres_pres   integer;
  v_ratio         numeric := 1;
  -- Salaire de base
  v_heures        numeric;
  v_heures_ref    numeric;
  v_base_mensuel  numeric;
  v_taux          numeric;
  v_base_mois     numeric;
  v_heures_base   numeric;
  v_smic          numeric;
  v_smic_du       date;
  -- Variables du mois
  v_hs25          numeric;
  v_hs50          numeric;
  v_hc10          numeric;
  v_hc25          numeric;
  v_absences      jsonb;
  v_primes        jsonb;
  v_avantages     jsonb;
  v_non_soumis    jsonb;
  v_acompte       numeric;
  v_paiement      date;
  -- Lignes
  v_rem           jsonb := '[]'::jsonb;
  v_cot           jsonb := '[]'::jsonb;
  v_all           jsonb := '[]'::jsonb;
  v_apres         jsonb := '[]'::jsonb;
  v_ctrl          jsonb := '[]'::jsonb;
  e               jsonb;
  v_taux_maj      numeric;
  v_montant       numeric;
  v_brut          numeric := 0;
  v_abs_heures    numeric := 0;
  v_hs_heures     numeric := 0;
  v_hs_sup        numeric := 0;
  v_hs_montant    numeric := 0;
  v_avantages_tot numeric := 0;
  v_non_soumis_tot numeric := 0;
  v_heures_payees numeric;
  -- Cotisations
  v_plafond       numeric;
  v_t1            numeric;
  v_t2            numeric;
  v_assiette      numeric;
  v_sal           numeric;
  v_pat           numeric;
  v_psc_pat       numeric := 0;
  v_sante_pat     numeric := 0;
  v_prev_pat      numeric := 0;
  v_prev_sal      numeric := 0;
  v_taux_retraite numeric := 0;
  v_taux_sal_hs   numeric := 0;
  v_taux_csg_ded  numeric := 0;
  v_base_csg      numeric;
  v_sante_active  boolean := false;
  v_at_nul        boolean := false;
  -- Allègements
  v_red_taux      numeric := 0;
  v_red_sal       numeric := 0;
  v_ded_pat       numeric := 0;
  v_smic_mois     numeric := 0;
  v_smic_cumul    numeric := 0;
  v_remu_cumul    numeric := 0;
  v_coef          numeric := 0;
  v_rgdu_cumul    numeric := 0;
  v_rgdu_mois     numeric := 0;
  v_rgdu_imputable numeric := 0;
  v_rgdu_applique numeric := 0;
  -- Totaux et nets
  v_total_sal     numeric := 0;
  v_total_pat     numeric := 0;
  v_sal_deduct    numeric := 0;
  v_allegements   numeric := 0;
  v_net_avant     numeric;
  v_net_social    numeric;
  v_hs_net        numeric := 0;
  v_hs_exo        numeric := 0;
  v_csg_hs        numeric := 0;
  v_net_imposable numeric;
  v_taux_pas      numeric;
  v_pas_type      text;
  v_grille_du     date;
  v_pas           numeric := 0;
  v_net_payer     numeric;
  v_cout          numeric;
  -- Mois précédent : cumuls de l'année et congés
  v_source        text;
  v_prec_cumuls   jsonb := '{}'::jsonb;
  v_prec_conges   jsonb;
  -- Congés payés
  v_ref           date;
  v_n1            numeric := 0;
  v_n             numeric := 0;
  v_n_acquis      numeric := 0;
  v_n_pris        numeric := 0;
  v_n1_pris       numeric := 0;
  v_j_ss          integer := 0;
  v_j_mal         integer := 0;
  v_acquis        numeric := 0;
  v_pris          numeric := 0;
  v_pris_n1       numeric := 0;
  -- Vérification
  v_ecarts        integer := 0;
begin
  -- ===========================================================================
  -- 1. Salarié, entreprise, paramètres de l'année
  -- ===========================================================================
  select * into s from public.salaries sa where sa.id = p_salarie;
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  v_nom := s.prenom || ' ' || s.nom;
  if p_periode is null or extract(day from p_periode) <> 1 then
    raise exception 'Période invalide : un bulletin couvre un mois.';
  end if;
  select * into so from public.societe so1 where so1.id = 1;
  select * into c from public.constantes_paie cp where cp.annee = v_annee;
  if not found then
    raise exception 'Paramètres de paie % absents : créez-les dans l''onglet « Paramètres de paie ».', v_annee;
  end if;
  v_convention := coalesce(nullif(trim(s.convention_collective), ''), nullif(trim(so.convention_collective), ''));

  -- ===========================================================================
  -- 2. Présence dans le mois : entrée ou sortie en cours de mois
  -- ===========================================================================
  v_du := greatest(p_periode, s.date_entree);
  v_au := least(v_fin, coalesce(s.date_sortie, v_fin));
  if v_du > v_au then
    raise exception '%', v_nom || ' n''est pas sous contrat en ' || v_mois || ' (entrée le ' || to_char(s.date_entree, 'DD/MM/YYYY')
                         || coalesce(', sortie le ' || to_char(s.date_sortie, 'DD/MM/YYYY'), '') || ').';
  end if;
  v_complet := v_du = p_periode and v_au = v_fin;
  v_jours_mois := v_fin - p_periode + 1;
  v_jours_pres := v_au - v_du + 1;
  v_ouvres_mois := prive.jours_ouvres(p_periode, v_fin);
  v_ouvres_pres := prive.jours_ouvres(v_du, v_au);
  if not v_complet then
    v_ratio := v_ouvres_pres::numeric / v_ouvres_mois;
  end if;

  -- ===========================================================================
  -- 3. Mois précédent : d'où viennent les cumuls de l'année et les congés
  --    (bulletin validé du mois précédent, ou reprise d'une paie faite
  --    ailleurs, ou entrée dans le mois)
  -- ===========================================================================
  select * into rp from public.reprises_paie r where r.salarie_id = s.id;
  if rp.salarie_id is not null and p_periode <= rp.mois then
    raise exception '%', 'Jusqu''en ' || prive.mois_lisible(rp.mois) || ' compris, la paie de ' || v_nom
                         || ' a été faite ailleurs (reprise des cumuls) : ce bulletin ne s''établit pas ici.';
  end if;
  select * into bp from public.bulletins b where b.salarie_id = s.id and b.periode = v_prec;
  if bp.id is not null and bp.statut <> 'brouillon' then
    v_source := 'bulletin';
    v_prec_conges := bp.calcul -> 'conges';
    if extract(month from p_periode) <> 1 then
      v_prec_cumuls := coalesce(bp.calcul -> 'cumuls', '{}'::jsonb);
    end if;
  elsif rp.salarie_id is not null and rp.mois = v_prec then
    v_source := 'reprise';
    v_prec_conges := jsonb_build_object(
      'reference', make_date(extract(year from rp.mois)::integer - case when extract(month from rp.mois) >= 6 then 0 else 1 end, 6, 1),
      'n1_solde', rp.cp_n1, 'n_solde', rp.cp_n, 'n_acquis', rp.cp_n, 'n_pris', 0, 'n1_pris', 0);
    if extract(month from p_periode) <> 1 then
      v_prec_cumuls := rp.cumuls;
    end if;
  elsif s.date_entree >= p_periode then
    v_source := 'entree';
  else
    v_source := 'manquant';
    v_ctrl := v_ctrl || prive.controle('bloquant', 'precedent', case
      when bp.id is not null then 'Le bulletin ' || prive.de_mois(v_prec) || ' est encore en brouillon : validez les mois dans l''ordre.'
      else 'Aucun bulletin validé en ' || prive.mois_lisible(v_prec) || ' : établissez d''abord ce bulletin, ou saisissez la reprise de la paie '
           || 'faite ailleurs (fiche du salarié). Sans cela, les cumuls de l''année, la réduction générale et les congés seraient faux.' end);
  end if;
  select b.periode into v_suivant from public.bulletins b
   where b.salarie_id = s.id and b.periode > p_periode and b.statut <> 'brouillon' order by b.periode limit 1;
  if v_suivant is not null then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'ordre', 'Le bulletin ' || prive.de_mois(v_suivant)
      || ' est déjà validé : un mois antérieur ne s''établit plus, l''oubli se régularise sur le prochain bulletin.');
  end if;

  -- ===========================================================================
  -- 4. Salaire de base mensualisé ; taux horaire exact, jamais arrondi au
  --    centime : 4 décimales, ou 5 ou 6 s'il le faut pour que heures × taux
  --    redonne le salaire de base au centime près
  -- ===========================================================================
  v_heures := s.heures_mensuelles;
  v_heures_ref := case when v_heures = 151.67 then 1820.0 / 12 else v_heures end;     -- 35 h × 52 semaines / 12 mois
  v_base_mensuel := coalesce(s.salaire_base_mensuel, round(s.taux_horaire * v_heures, 2));
  if v_base_mensuel is null then
    raise exception 'Indiquez le salaire de base mensuel (ou le taux horaire) sur la fiche de %.', v_nom;
  end if;
  v_taux := round(v_base_mensuel / v_heures, 4);
  if round(v_heures * v_taux, 2) <> v_base_mensuel then
    v_taux := round(v_base_mensuel / v_heures, 5);
  end if;
  if round(v_heures * v_taux, 2) <> v_base_mensuel then
    v_taux := round(v_base_mensuel / v_heures, 6);
  end if;
  v_base_mois := case when v_complet then v_base_mensuel else round(v_base_mensuel * v_ratio, 2) end;
  v_heures_base := case when v_complet then v_heures else round(v_heures * v_ratio, 2) end;
  select m.horaire, m.valable_du into v_smic, v_smic_du
    from public.smic m where m.valable_du <= v_fin order by m.valable_du desc limit 1;
  if v_smic is null then
    v_smic := c.smic_horaire;
    v_smic_du := make_date(v_annee, 1, 1);
  end if;

  -- ===========================================================================
  -- 5. Variables du mois
  -- ===========================================================================
  v_hs25 := prive.variable_nombre(p_variables, 'heures_sup_25', 'Heures supplémentaires majorées à 25 %', 100);
  v_hs50 := prive.variable_nombre(p_variables, 'heures_sup_50', 'Heures supplémentaires majorées à 50 %', 100);
  v_hc10 := prive.variable_nombre(p_variables, 'heures_comp_10', 'Heures complémentaires majorées à 10 %', 100);
  v_hc25 := prive.variable_nombre(p_variables, 'heures_comp_25', 'Heures complémentaires majorées à 25 %', 100);
  if s.temps = 'partiel' and v_hs25 + v_hs50 > 0 then
    raise exception 'Un salarié à temps partiel fait des heures complémentaires, pas des heures supplémentaires.';
  end if;
  if s.temps = 'plein' and v_hc10 + v_hc25 > 0 then
    raise exception 'Les heures complémentaires concernent un temps partiel : saisissez des heures supplémentaires.';
  end if;
  v_absences := prive.variable_liste(p_variables, 'absences', 'Absences non rémunérées', 'heures', 200);
  v_primes := prive.variable_liste(p_variables, 'primes', 'Primes et indemnités soumises', 'montant', 100000);
  v_avantages := prive.variable_liste(p_variables, 'avantages', 'Avantages en nature', 'montant', 10000);
  v_non_soumis := prive.variable_liste(p_variables, 'non_soumis', 'Indemnités non soumises', 'montant', 10000);
  v_acompte := prive.variable_nombre(p_variables, 'acompte', 'Acompte', 100000);
  v_paiement := v_fin;
  if jsonb_typeof(p_variables -> 'date_paiement') = 'string' then
    begin
      v_paiement := (p_variables ->> 'date_paiement')::date;
    exception when others then
      raise exception 'Date de paiement invalide.';
    end;
    if v_paiement < p_periode or v_paiement > v_fin + 15 then
      raise exception 'Date de paiement : entre le % et le %.', to_char(p_periode, 'DD/MM/YYYY'), to_char(v_fin + 15, 'DD/MM/YYYY');
    end if;
  end if;

  -- ===========================================================================
  -- 6. Rémunération brute
  -- ===========================================================================
  v_rem := v_rem || jsonb_build_array(jsonb_build_object('code', 'salaire_base', 'libelle', 'Salaire de base',
    'base', v_heures, 'taux', v_taux, 'montant', v_base_mensuel));
  if not v_complet then
    v_rem := v_rem || jsonb_build_array(jsonb_build_object('code', 'entree_sortie',
      'libelle', case when v_du > p_periode and v_au < v_fin then 'Entrée le ' || to_char(v_du, 'DD/MM/YYYY') || ', sortie le ' || to_char(v_au, 'DD/MM/YYYY')
                      when v_du > p_periode then 'Entrée en cours de mois, le ' || to_char(v_du, 'DD/MM/YYYY')
                      else 'Sortie en cours de mois, le ' || to_char(v_au, 'DD/MM/YYYY') end,
      'detail', v_ouvres_pres || ' jour(s) ouvré(s) payé(s) sur ' || v_ouvres_mois,
      'base', null, 'taux', null, 'montant', v_base_mois - v_base_mensuel));
  end if;
  for e in select x from jsonb_array_elements(v_absences) as t(x) loop
    v_abs_heures := v_abs_heures + (e ->> 'heures')::numeric;
    v_rem := v_rem || jsonb_build_array(jsonb_build_object('code', 'absence', 'libelle', e ->> 'libelle',
      'base', (e ->> 'heures')::numeric, 'taux', v_taux, 'montant', -round((e ->> 'heures')::numeric * v_taux, 2)));
  end loop;
  if v_abs_heures > v_heures_base then
    raise exception 'Les absences (% h) dépassent les heures payées du mois (% h).', prive.nombre_fr(v_abs_heures), prive.nombre_fr(v_heures_base);
  end if;
  for e in select x from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('code', 'heures_sup_25', 'libelle', 'Heures supplémentaires majorées à 25 %', 'heures', v_hs25, 'majoration', 1.25, 'sup', true),
      jsonb_build_object('code', 'heures_sup_50', 'libelle', 'Heures supplémentaires majorées à 50 %', 'heures', v_hs50, 'majoration', 1.50, 'sup', true),
      jsonb_build_object('code', 'heures_comp_10', 'libelle', 'Heures complémentaires majorées à 10 %', 'heures', v_hc10, 'majoration', 1.10, 'sup', false),
      jsonb_build_object('code', 'heures_comp_25', 'libelle', 'Heures complémentaires majorées à 25 %', 'heures', v_hc25, 'majoration', 1.25, 'sup', false)))
      as t(x) loop
    continue when (e ->> 'heures')::numeric = 0;
    v_taux_maj := round(v_taux * (e ->> 'majoration')::numeric, 6);
    v_montant := round((e ->> 'heures')::numeric * v_taux_maj, 2);
    v_hs_heures := v_hs_heures + (e ->> 'heures')::numeric;
    if (e ->> 'sup')::boolean then
      v_hs_sup := v_hs_sup + (e ->> 'heures')::numeric;
    end if;
    v_hs_montant := v_hs_montant + v_montant;
    v_rem := v_rem || jsonb_build_array(jsonb_build_object('code', e ->> 'code', 'libelle', e ->> 'libelle',
      'base', (e ->> 'heures')::numeric, 'taux', v_taux_maj, 'montant', v_montant));
  end loop;
  for e in select x from jsonb_array_elements(v_primes) as t(x) loop
    v_rem := v_rem || jsonb_build_array(jsonb_build_object('code', 'prime', 'libelle', e ->> 'libelle',
      'base', null, 'taux', null, 'montant', (e ->> 'montant')::numeric));
  end loop;
  for e in select x from jsonb_array_elements(v_avantages) as t(x) loop
    v_avantages_tot := v_avantages_tot + (e ->> 'montant')::numeric;
    v_rem := v_rem || jsonb_build_array(jsonb_build_object('code', 'avantage_nature', 'libelle', 'Avantage en nature : ' || (e ->> 'libelle'),
      'base', null, 'taux', null, 'montant', (e ->> 'montant')::numeric));
  end loop;
  select coalesce(sum((x ->> 'montant')::numeric), 0) into v_brut from jsonb_array_elements(v_rem) as t(x);
  if v_brut < 0 then
    raise exception 'Le salaire brut est négatif : vérifiez les absences.';
  end if;
  v_heures_payees := v_heures_base - v_abs_heures + v_hs_heures;

  -- ===========================================================================
  -- 7. Plafond de la Sécurité sociale du mois : réduit pour un temps partiel
  --    (durée du contrat / durée légale) et pour une entrée ou une sortie en
  --    cours de mois (jours calendaires de présence / jours du mois)
  -- ===========================================================================
  v_plafond := c.plafond_mensuel_ss;
  if s.temps = 'partiel' then
    v_plafond := round(v_plafond * v_heures / 151.67, 2);
  end if;
  if not v_complet then
    v_plafond := round(v_plafond * v_jours_pres / v_jours_mois, 2);
  end if;
  v_t1 := least(v_brut, v_plafond);
  v_t2 := greatest(least(v_brut, 8 * v_plafond) - v_plafond, 0);

  -- ===========================================================================
  -- 8. Cotisations ligne par ligne (CSG et CRDS ensuite, sur leur assiette)
  -- ===========================================================================
  for l in select * from public.parametres_paie p
            where p.annee = v_annee and p.actif and p.assiette <> 'csg_crds' order by p.ordre, p.code loop
    continue when (l.condition = 'cadre' and not s.cadre) or (l.condition = 'non_cadre' and s.cadre)
               or (l.condition = 'au_dela_plafond' and v_brut <= v_plafond);
    continue when l.assiette = 'tranche_2' and v_t2 = 0;
    v_assiette := case l.assiette when 'brut' then v_brut when 'tranche_1' then v_t1 when 'tranche_2' then v_t2 end;
    if l.plafond_pmss is not null and l.assiette = 'brut' then
      v_assiette := least(v_assiette, round(l.plafond_pmss * v_plafond, 2));
    end if;
    if l.assiette = 'forfait' then
      v_sal := l.montant_salarial;
      v_pat := l.montant_patronal;
    else
      v_sal := round(v_assiette * l.taux_salarial / 100, 2);
      v_pat := round(v_assiette * l.taux_patronal / 100, 2);
    end if;
    if l.section = 'accidents_travail' and l.taux_patronal = 0 then
      v_at_nul := true;
    end if;
    -- Part patronale sur laquelle s'impute la réduction générale (accidents
    -- du travail : dans la limite fixée, 0,49 % du salaire en 2026)
    if l.rgdu then
      v_rgdu_imputable := v_rgdu_imputable + case when l.section = 'accidents_travail' and c.rgdu_taux_at is not null
                                                  then least(v_pat, round(v_assiette * c.rgdu_taux_at / 100, 2)) else v_pat end;
    end if;
    if l.protection is not null then
      v_psc_pat := v_psc_pat + v_pat;
    end if;
    if l.protection = 'sante' then
      v_sante_pat := v_sante_pat + v_pat;
      v_sante_active := true;
    elsif l.protection = 'prevoyance' then
      v_prev_pat := v_prev_pat + v_pat;
      v_prev_sal := v_prev_sal + v_sal;
    end if;
    -- Taux qui s'appliquent aussi aux heures supplémentaires (le haut du salaire)
    if (l.assiette = 'brut' and (l.plafond_pmss is null or v_brut <= l.plafond_pmss * v_plafond))
       or (l.assiette = 'tranche_1' and v_brut <= v_plafond) or (l.assiette = 'tranche_2' and v_brut > v_plafond) then
      v_taux_sal_hs := v_taux_sal_hs + l.taux_salarial;
      if l.section = 'retraite' then
        v_taux_retraite := v_taux_retraite + l.taux_salarial;
      end if;
    end if;
    v_cot := v_cot || jsonb_build_array(jsonb_build_object('section', l.section, 'code', l.code, 'libelle', l.libelle,
      'base', v_assiette,
      'taux_salarial', case when l.assiette = 'forfait' or l.taux_salarial = 0 then null else l.taux_salarial end, 'montant_salarial', v_sal,
      'taux_patronal', case when l.assiette = 'forfait' or l.taux_patronal = 0 then null else l.taux_patronal end, 'montant_patronal', v_pat,
      'deductible', l.deductible, 'protection', l.protection));
  end loop;

  -- CSG et CRDS : 98,25 % du brut jusqu'à 4 plafonds, le surplus en totalité,
  -- plus la part patronale de la santé et de la prévoyance
  v_base_csg := round(least(v_brut, 4 * v_plafond) * (1 - c.abattement_csg / 100) + greatest(v_brut - 4 * v_plafond, 0) + v_psc_pat, 2);
  for l in select * from public.parametres_paie p
            where p.annee = v_annee and p.actif and p.assiette = 'csg_crds' order by p.ordre, p.code loop
    continue when (l.condition = 'cadre' and not s.cadre) or (l.condition = 'non_cadre' and s.cadre)
               or (l.condition = 'au_dela_plafond' and v_brut <= v_plafond);
    v_sal := round(v_base_csg * l.taux_salarial / 100, 2);
    v_pat := round(v_base_csg * l.taux_patronal / 100, 2);
    if l.deductible then
      v_taux_csg_ded := v_taux_csg_ded + l.taux_salarial;
    end if;
    v_cot := v_cot || jsonb_build_array(jsonb_build_object('section', l.section, 'code', l.code, 'libelle', l.libelle,
      'base', v_base_csg,
      'taux_salarial', case when l.taux_salarial = 0 then null else l.taux_salarial end, 'montant_salarial', v_sal,
      'taux_patronal', case when l.taux_patronal = 0 then null else l.taux_patronal end, 'montant_patronal', v_pat,
      'deductible', l.deductible, 'protection', null));
  end loop;

  -- ===========================================================================
  -- 9. Allègements
  -- ===========================================================================
  -- 9a. Heures supplémentaires et complémentaires : réduction des cotisations
  --     salariales de retraite (11,31 % au plus), déduction forfaitaire
  --     patronale par heure supplémentaire
  if v_hs_montant > 0 then
    v_red_taux := least(c.reduction_salariale_hs, v_taux_retraite);
    v_red_sal := round(v_hs_montant * v_red_taux / 100, 2);
    if v_red_sal > 0 then
      v_all := v_all || jsonb_build_array(jsonb_build_object('section', 'allegements', 'code', 'reduction_salariale_hs',
        'libelle', 'Réduction de cotisations salariales sur heures ' || case when s.temps = 'partiel' then 'complémentaires' else 'supplémentaires' end,
        'base', v_hs_montant, 'taux_salarial', -v_red_taux, 'montant_salarial', -v_red_sal, 'taux_patronal', null, 'montant_patronal', 0));
    end if;
  end if;
  if v_hs_sup > 0 and c.deduction_patronale_hs > 0 then
    v_ded_pat := round(v_hs_sup * c.deduction_patronale_hs, 2);
    v_all := v_all || jsonb_build_array(jsonb_build_object('section', 'allegements', 'code', 'deduction_patronale_hs',
      'libelle', 'Déduction forfaitaire patronale sur heures supplémentaires', 'unite', 'euro_heure',
      'base', v_hs_sup, 'taux_salarial', null, 'montant_salarial', 0, 'taux_patronal', -c.deduction_patronale_hs, 'montant_patronal', -v_ded_pat));
  end if;

  -- 9b. Réduction générale dégressive unique : coefficient calculé sur les
  --     cumuls de l'année (rémunération brute et SMIC des heures payées),
  --     réduction de l'année moins celle des mois précédents (régularisation
  --     progressive)
  if c.smic_horaire_rgdu is null then
    v_ctrl := v_ctrl || prive.controle('attention', 'rgdu', 'Réduction générale non paramétrée pour ' || v_annee || ' : aucune réduction calculée.');
  else
    v_smic_mois := round(c.smic_horaire_rgdu * greatest(v_heures_ref * v_ratio - v_abs_heures + v_hs_heures, 0), 2);
    v_smic_cumul := prive.cumul(v_prec_cumuls, 'smic_rgdu') + v_smic_mois;
    v_remu_cumul := prive.cumul(v_prec_cumuls, 'brut') + v_brut;
    if v_remu_cumul > 0 and v_remu_cumul < 3 * v_smic_cumul then
      v_coef := least(round(c.rgdu_tmin + c.rgdu_tdelta * power(0.5 * (3 * v_smic_cumul / v_remu_cumul - 1), c.rgdu_p), 4),
                      c.rgdu_tmin + c.rgdu_tdelta);
    end if;
    v_rgdu_cumul := round(v_coef * v_remu_cumul, 2);
    v_rgdu_mois := v_rgdu_cumul - prive.cumul(v_prec_cumuls, 'rgdu');
    -- Jamais plus que les cotisations du mois sur lesquelles elle s'impute :
    -- le reste se reprend les mois suivants (cumul de l'appliqué)
    if v_rgdu_mois > v_rgdu_imputable then
      v_ctrl := v_ctrl || prive.controle('attention', 'rgdu_plafond', 'Réduction générale limitée aux cotisations du mois ('
        || prive.euros(v_rgdu_imputable) || ') : ' || prive.euros(v_rgdu_mois - v_rgdu_imputable)
        || ' seront repris sur les mois suivants. Vérifiez les cumuls repris si ce n''est pas attendu.');
      v_rgdu_mois := v_rgdu_imputable;
    end if;
    v_rgdu_applique := prive.cumul(v_prec_cumuls, 'rgdu') + v_rgdu_mois;
    if v_rgdu_mois <> 0 then
      v_all := v_all || jsonb_build_array(jsonb_build_object('section', 'allegements', 'code', 'reduction_generale',
        'libelle', 'Réduction générale des cotisations patronales',
        'detail', 'Coefficient ' || replace(to_char(v_coef, 'FM0.0000'), '.', ',') || ' sur les rémunérations de l''année',
        'base', v_brut, 'taux_salarial', null, 'montant_salarial', 0, 'taux_patronal', null, 'montant_patronal', -v_rgdu_mois));
    end if;
  end if;

  -- ===========================================================================
  -- 10. Totaux, net avant impôt, net social
  -- ===========================================================================
  select coalesce(sum((x ->> 'montant_salarial')::numeric), 0), coalesce(sum((x ->> 'montant_patronal')::numeric), 0)
    into v_total_sal, v_total_pat
    from jsonb_array_elements(v_cot || v_all) as t(x);
  select coalesce(sum((x ->> 'montant_salarial')::numeric), 0) into v_sal_deduct
    from jsonb_array_elements(v_cot || v_all) as t(x) where coalesce((x ->> 'deductible')::boolean, true);
  select -coalesce(sum((x ->> 'montant_patronal')::numeric), 0) into v_allegements
    from jsonb_array_elements(v_all) as t(x);
  v_net_avant := v_brut - v_total_sal;
  -- Net social : brut − cotisations salariales obligatoires (CSG et CRDS
  -- comprises) + part patronale de la prévoyance ; la part salariale de la
  -- prévoyance n'en est pas retranchée
  v_net_social := v_brut - v_total_sal + v_prev_sal + v_prev_pat;

  -- ===========================================================================
  -- 11. Net imposable : heures supplémentaires et complémentaires exonérées
  --     d'impôt (leur montant net de cotisations) dans la limite annuelle ;
  --     la CSG déductible qui s'y rapporte ne l'est alors plus
  -- ===========================================================================
  if v_hs_montant > 0 then
    v_hs_net := v_hs_montant - greatest(round(v_hs_montant * v_taux_sal_hs / 100, 2) - v_red_sal, 0);
    v_hs_exo := least(v_hs_net, greatest(c.plafond_exoneration_hs - prive.cumul(v_prec_cumuls, 'hs_exonerees'), 0));
    if v_hs_exo > 0 then
      v_csg_hs := round(v_hs_montant * (1 - c.abattement_csg / 100) * v_taux_csg_ded / 100 * v_hs_exo / v_hs_net, 2);
    end if;
    if v_hs_exo < v_hs_net then
      v_ctrl := v_ctrl || prive.controle('info', 'heures_sup_plafond', 'Plafond annuel d''exonération d''impôt des heures supplémentaires atteint ('
        || prive.euros(c.plafond_exoneration_hs) || ') : ' || prive.euros(v_hs_net - v_hs_exo) || ' restent imposables.');
    end if;
  end if;
  v_net_imposable := v_brut - v_sal_deduct + v_csg_hs + v_sante_pat - v_hs_exo;

  -- ===========================================================================
  -- 12. Prélèvement à la source : taux personnalisé de la fiche, sinon grille
  --     du taux neutre en vigueur
  -- ===========================================================================
  if s.taux_pas is not null then
    v_taux_pas := s.taux_pas;
    v_pas_type := 'personnalise';
  else
    v_pas_type := 'neutre';
    select g.valable_du into v_grille_du from public.grille_taux_neutre g
     where g.valable_du <= v_fin order by g.valable_du desc limit 1;
    if v_grille_du is null then
      v_taux_pas := 0;
      v_ctrl := v_ctrl || prive.controle('bloquant', 'grille_pas', 'Aucune grille de taux neutre du prélèvement à la source en vigueur : complétez les paramètres de paie.');
    else
      select g.taux into v_taux_pas from public.grille_taux_neutre g
       where g.valable_du = v_grille_du and g.de <= greatest(v_net_imposable, 0) order by g.de desc limit 1;
      v_taux_pas := coalesce(v_taux_pas, 0);
      v_ctrl := v_ctrl || prive.controle('info', 'pas_neutre', 'Taux neutre appliqué (taux non personnalisé) : reportez sur la fiche le taux '
        || 'transmis par l''administration fiscale dès qu''il est connu.');
    end if;
  end if;
  if v_net_imposable > 0 then
    v_pas := round(v_net_imposable * v_taux_pas / 100, 2);
  end if;

  -- ===========================================================================
  -- 13. Après le net : avantages en nature (déjà dans le brut), indemnités
  --     non soumises, acompte ; net à payer ; coût total employeur
  -- ===========================================================================
  for e in select x from jsonb_array_elements(v_avantages) as t(x) loop
    v_apres := v_apres || jsonb_build_array(jsonb_build_object('code', 'avantage_nature',
      'libelle', 'Avantage en nature : ' || (e ->> 'libelle'), 'montant', -(e ->> 'montant')::numeric));
  end loop;
  for e in select x from jsonb_array_elements(v_non_soumis) as t(x) loop
    v_non_soumis_tot := v_non_soumis_tot + (e ->> 'montant')::numeric;
    v_apres := v_apres || jsonb_build_array(jsonb_build_object('code', 'non_soumis', 'libelle', e ->> 'libelle', 'montant', (e ->> 'montant')::numeric));
  end loop;
  if v_acompte > 0 then
    v_apres := v_apres || jsonb_build_array(jsonb_build_object('code', 'acompte', 'libelle', 'Acompte versé', 'montant', -v_acompte));
  end if;
  v_net_payer := v_net_avant - v_pas - v_avantages_tot + v_non_soumis_tot - v_acompte;
  v_cout := v_brut + v_total_pat;

  -- ===========================================================================
  -- 14. Congés payés : période de référence du 1er juin au 31 mai ;
  --     2,5 jours ouvrables par mois (2 jours par mois d'arrêt maladie),
  --     au prorata des jours du mois ; les congés pris se décomptent d'abord
  --     du solde N-1
  -- ===========================================================================
  v_ref := make_date(v_annee - case when extract(month from p_periode) >= 6 then 0 else 1 end, 6, 1);
  if v_prec_conges is not null then
    v_n1 := prive.cumul(v_prec_conges, 'n1_solde');
    v_n := prive.cumul(v_prec_conges, 'n_solde');
    v_n_acquis := prive.cumul(v_prec_conges, 'n_acquis');
    v_n_pris := prive.cumul(v_prec_conges, 'n_pris');
    v_n1_pris := prive.cumul(v_prec_conges, 'n1_pris');
    if (v_prec_conges ->> 'reference')::date < v_ref then
      if v_n1 > 0 then
        v_ctrl := v_ctrl || prive.controle('info', 'report_conges', prive.nombre_fr(v_n1)
          || ' jour(s) de congés de l''avant-dernière période n''ont pas été pris : ils restent au solde N-1 (report). Vérifiez-le avec l''expert-comptable.');
      end if;
      v_n1 := v_n1 + v_n;
      v_n := 0;
      v_n_acquis := 0;
      v_n_pris := 0;
      v_n1_pris := 0;
    end if;
  end if;
  select coalesce(sum(greatest(least(a.fin, v_au) - greatest(a.debut, v_du) + 1, 0)) filter (where a.type = 'sans_solde'), 0),
         coalesce(sum(greatest(least(a.fin, v_au) - greatest(a.debut, v_du) + 1, 0)) filter (where a.type = 'maladie'), 0)
    into v_j_ss, v_j_mal
    from public.absences a
   where a.salarie_id = s.id and a.statut = 'validee' and a.debut <= v_au and a.fin >= v_du;
  v_acquis := round((2.5 * greatest(v_jours_pres - v_j_ss - v_j_mal, 0) + 2.0 * least(v_j_mal, v_jours_pres)) / v_jours_mois, 2);
  select coalesce(sum(round(a.jours * prive.jours_ouvrables(greatest(a.debut, p_periode), least(a.fin, v_fin))
                            / nullif(prive.jours_ouvrables(a.debut, a.fin), 0), 2)), 0)
    into v_pris
    from public.absences a
   where a.salarie_id = s.id and a.statut = 'validee' and a.type = 'conges_payes' and a.debut <= v_fin and a.fin >= p_periode;
  v_pris_n1 := least(v_pris, greatest(v_n1, 0));
  v_n1 := v_n1 - v_pris_n1;
  v_n := v_n + v_acquis - (v_pris - v_pris_n1);
  v_n_acquis := v_n_acquis + v_acquis;
  v_n_pris := v_n_pris + (v_pris - v_pris_n1);
  v_n1_pris := v_n1_pris + v_pris_n1;

  -- ===========================================================================
  -- 15. Contrôles
  -- ===========================================================================
  if not c.valide_par_comptable then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'parametres', 'Paramètres de paie ' || v_annee
      || ' pas encore validés par l''expert-comptable : le bulletin se prépare, il ne se valide pas.');
  end if;
  if s.type_contrat <> 'apprentissage' and v_taux < v_smic then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'smic', 'Taux horaire (' || prive.nombre_fr(v_taux) || ' €) inférieur au SMIC ('
      || prive.nombre_fr(v_smic) || ' € depuis le ' || to_char(v_smic_du, 'DD/MM/YYYY') || ') : corrigez le salaire sur la fiche.');
  end if;
  if v_at_nul then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'at_mp', 'Taux accidents du travail à 0 : saisissez dans les paramètres de paie le taux '
      || 'notifié à l''entreprise (compte AT/MP sur net-entreprises.fr).');
  end if;
  v_manquants := array_remove(array[
    case when nullif(trim(so.siret), '') is null then 'SIRET' end,
    case when nullif(trim(so.code_ape), '') is null then 'code APE' end,
    case when nullif(trim(so.numero_urssaf), '') is null then 'n° URSSAF' end,
    case when nullif(trim(so.adresse), '') is null or nullif(trim(so.code_postal), '') is null or nullif(trim(so.ville), '') is null
         then 'adresse du siège' end], null);
  if cardinality(v_manquants) > 0 then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'employeur', 'Identité de l''employeur incomplète (Paramètres, Entreprise) : '
      || array_to_string(v_manquants, ', ') || '.');
  end if;
  if v_convention is null then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'convention', 'Convention collective non renseignée : indiquez-la, ou « Aucune convention '
      || 'collective applicable », dans Paramètres, Entreprise.');
  end if;
  if s.numero_securite_sociale is null then
    v_ctrl := v_ctrl || prive.controle('attention', 'nss', 'N° de Sécurité sociale absent de la fiche (indispensable à la déclaration sociale).');
  end if;
  if not v_sante_active then
    v_ctrl := v_ctrl || prive.controle('attention', 'sante', 'Complémentaire santé non paramétrée : la mutuelle d''entreprise est obligatoire '
      || '(sauf dispense du salarié). Activez sa ligne dans les paramètres de paie.');
  end if;
  if s.taux_horaire is not null and s.salaire_base_mensuel is not null and s.taux_horaire <> v_taux then
    v_ctrl := v_ctrl || prive.controle('attention', 'taux_horaire', 'La fiche indique un taux horaire de ' || prive.nombre_fr(s.taux_horaire)
      || ' € ; le salaire de base (' || prive.euros(s.salaire_base_mensuel) || ' pour ' || prive.nombre_fr(v_heures) || ' h) donne '
      || prive.nombre_fr(v_taux) || ' € : le bulletin retient ce taux exact.');
  end if;
  if v_net_payer < 0 then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'net_negatif', 'Net à payer négatif : vérifiez l''acompte et les absences.');
  end if;
  if v_n1 < 0 or v_n < 0 then
    v_ctrl := v_ctrl || prive.controle('attention', 'conges', 'Solde de congés payés négatif : congés pris par anticipation.');
  end if;
  if s.date_sortie between p_periode and v_fin then
    v_ctrl := v_ctrl || prive.controle('info', 'sortie', 'Sortie le ' || to_char(s.date_sortie, 'DD/MM/YYYY') || ' : solde de congés de '
      || prive.nombre_fr(v_n1 + v_n) || ' jour(s) à payer (indemnité compensatrice, en prime), puis certificat de travail, attestation '
      || 'France Travail et solde de tout compte.');
  end if;

  -- Revérification de chaque ligne (base × taux) et de chaque total
  for e in select x from jsonb_array_elements(v_rem) as t(x) loop
    if e ->> 'code' = 'salaire_base' then
      if abs(round((e ->> 'base')::numeric * (e ->> 'taux')::numeric, 2) - (e ->> 'montant')::numeric) > 0.01 then
        v_ecarts := v_ecarts + 1;
      end if;
    elsif (e ->> 'base') is not null and (e ->> 'taux') is not null
          and round((e ->> 'base')::numeric * (e ->> 'taux')::numeric, 2) <> abs((e ->> 'montant')::numeric) then
      v_ecarts := v_ecarts + 1;
    end if;
  end loop;
  for e in select x from jsonb_array_elements(v_cot || v_all) as t(x) loop
    if e ->> 'unite' = 'euro_heure' then
      if round((e ->> 'base')::numeric * (e ->> 'taux_patronal')::numeric, 2) <> (e ->> 'montant_patronal')::numeric then
        v_ecarts := v_ecarts + 1;
      end if;
    else
      if (e ->> 'taux_salarial') is not null
         and round((e ->> 'base')::numeric * (e ->> 'taux_salarial')::numeric / 100, 2) <> (e ->> 'montant_salarial')::numeric then
        v_ecarts := v_ecarts + 1;
      end if;
      if (e ->> 'taux_patronal') is not null
         and round((e ->> 'base')::numeric * (e ->> 'taux_patronal')::numeric / 100, 2) <> (e ->> 'montant_patronal')::numeric then
        v_ecarts := v_ecarts + 1;
      end if;
    end if;
  end loop;
  if v_net_payer <> v_net_avant - v_pas + coalesce((select sum((x ->> 'montant')::numeric) from jsonb_array_elements(v_apres) as t(x)), 0)
     or v_net_avant + v_total_sal <> v_brut or v_cout - v_total_pat <> v_brut then
    v_ecarts := v_ecarts + 1;
  end if;
  if v_ecarts > 0 then
    v_ctrl := v_ctrl || prive.controle('bloquant', 'verification', 'Écart de calcul détecté (' || v_ecarts
      || ' ligne(s)) : bulletin bloqué. Signalez-le avant toute validation.');
  end if;

  -- ===========================================================================
  -- 16. Résultat : tout ce qu'il faut pour imprimer le bulletin tel quel
  -- ===========================================================================
  return jsonb_build_object(
    'version', 1,
    'periode', p_periode, 'du', v_du, 'au', v_au, 'date_paiement', v_paiement,
    'salarie', jsonb_build_object('id', s.id, 'matricule', s.matricule, 'civilite', s.civilite, 'prenom', s.prenom, 'nom', s.nom,
      'adresse', s.adresse, 'code_postal', s.code_postal, 'ville', s.ville, 'numero_securite_sociale', s.numero_securite_sociale,
      'emploi', s.emploi, 'qualification', s.qualification, 'niveau', s.niveau, 'coefficient', s.coefficient, 'cadre', s.cadre,
      'type_contrat', s.type_contrat, 'temps', s.temps, 'heures_mensuelles', s.heures_mensuelles, 'date_entree', s.date_entree,
      'date_sortie', s.date_sortie, 'convention_collective', v_convention),
    'societe', jsonb_build_object('raison_sociale', so.raison_sociale, 'forme_juridique', so.forme_juridique, 'capital', so.capital,
      'adresse', so.adresse, 'code_postal', so.code_postal, 'ville', so.ville, 'siret', so.siret, 'code_ape', so.code_ape,
      'numero_urssaf', so.numero_urssaf, 'rcs', so.rcs, 'caisse_retraite', so.caisse_retraite, 'organisme_sante', so.organisme_sante,
      'organisme_prevoyance', so.organisme_prevoyance),
    'constantes', jsonb_build_object('annee', v_annee, 'plafond_mensuel', c.plafond_mensuel_ss, 'plafond_applique', v_plafond,
      'smic_horaire', v_smic, 'smic_depuis', v_smic_du, 'smic_rgdu', c.smic_horaire_rgdu, 'valide', c.valide_par_comptable,
      'valide_le', c.valide_le),
    'variables', jsonb_build_object('heures_sup_25', v_hs25, 'heures_sup_50', v_hs50, 'heures_comp_10', v_hc10, 'heures_comp_25', v_hc25,
      'absences', v_absences, 'primes', v_primes, 'avantages', v_avantages, 'non_soumis', v_non_soumis, 'acompte', v_acompte,
      'date_paiement', v_paiement),
    'heures', jsonb_build_object('contrat', v_heures, 'payees', v_heures_payees, 'absences', v_abs_heures,
      'sup_25', v_hs25, 'sup_50', v_hs50, 'comp_10', v_hc10, 'comp_25', v_hc25),
    'salaire_base', v_base_mensuel, 'taux_horaire', v_taux,
    'remuneration', v_rem, 'brut', v_brut,
    'cotisations', v_cot, 'allegements', v_all,
    'totaux', jsonb_build_object('cotisations_salariales', v_total_sal, 'cotisations_patronales', v_total_pat, 'allegements', v_allegements),
    'net_avant_impot', v_net_avant, 'net_social', v_net_social, 'net_imposable', v_net_imposable,
    'pas', jsonb_build_object('base', v_net_imposable, 'taux', v_taux_pas, 'type', v_pas_type, 'montant', v_pas),
    'apres_net', v_apres, 'net_a_payer', v_net_payer, 'cout_employeur', v_cout,
    'rgdu', jsonb_build_object('coefficient', v_coef, 'smic_mois', v_smic_mois, 'smic_cumul', v_smic_cumul,
      'remuneration_cumul', v_remu_cumul, 'reduction_cumul', v_rgdu_cumul, 'reduction_mois', v_rgdu_mois,
      'imputable', v_rgdu_imputable),
    'heures_sup', jsonb_build_object('montant', v_hs_montant, 'reduction_salariale', v_red_sal, 'net', v_hs_net,
      'exoneration_impot', v_hs_exo, 'csg_non_deductible', v_csg_hs, 'deduction_patronale', v_ded_pat),
    'cumuls', jsonb_build_object(
      'brut', prive.cumul(v_prec_cumuls, 'brut') + v_brut,
      'net_imposable', prive.cumul(v_prec_cumuls, 'net_imposable') + v_net_imposable,
      'net_social', prive.cumul(v_prec_cumuls, 'net_social') + v_net_social,
      'cotisations_salariales', prive.cumul(v_prec_cumuls, 'cotisations_salariales') + v_total_sal,
      'cotisations_patronales', prive.cumul(v_prec_cumuls, 'cotisations_patronales') + v_total_pat,
      'allegements', prive.cumul(v_prec_cumuls, 'allegements') + v_allegements,
      'pas', prive.cumul(v_prec_cumuls, 'pas') + v_pas,
      'net_a_payer', prive.cumul(v_prec_cumuls, 'net_a_payer') + v_net_payer,
      'cout_employeur', prive.cumul(v_prec_cumuls, 'cout_employeur') + v_cout,
      'heures', prive.cumul(v_prec_cumuls, 'heures') + v_heures_payees,
      'heures_sup', prive.cumul(v_prec_cumuls, 'heures_sup') + v_hs_heures,
      'hs_exonerees', prive.cumul(v_prec_cumuls, 'hs_exonerees') + v_hs_exo,
      'rgdu', case when c.smic_horaire_rgdu is null then prive.cumul(v_prec_cumuls, 'rgdu') else v_rgdu_applique end,
      'smic_rgdu', prive.cumul(v_prec_cumuls, 'smic_rgdu') + v_smic_mois),
    'conges', jsonb_build_object('reference', v_ref, 'reference_fin', (v_ref + interval '1 year')::date - 1,
      'acquis_mois', v_acquis, 'pris_mois', v_pris, 'n1_solde', v_n1, 'n1_pris', v_n1_pris,
      'n_acquis', v_n_acquis, 'n_pris', v_n_pris, 'n_solde', v_n),
    'precedent', v_source,
    'controles', v_ctrl);
end;
$$;
comment on function prive.calculer_bulletin(uuid, date, jsonb) is
  'Calcule un bulletin de paie complet (sans rien écrire) : lignes, totaux, nets, cumuls, congés et contrôles.';


-- #############################################################################
-- 3. DROITS D'EXÉCUTION
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout (outils et calcul : appelés par les fonctions de
-- l'administration seulement).
revoke all on function
  prive.variable_nombre(jsonb, text, text, numeric),
  prive.variable_liste(jsonb, text, text, text, numeric),
  prive.de_mois(date),
  prive.controle(text, text, text),
  prive.cumul(jsonb, text),
  prive.nombre_fr(numeric),
  prive.calculer_bulletin(uuid, date, jsonb)
  from public, anon, authenticated;
