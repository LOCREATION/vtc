-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 16a : RH ET PAIE (1/5) — structure et paramètres de paie 2026
-- -----------------------------------------------------------------------------
-- Module « RH et paie » de l'administration : salariés, contrats de travail,
-- bulletins de paie, congés et absences, temps de travail. Cinq migrations,
-- à appliquer dans l'ordre :
--   16a (ce fichier) : structure et paramètres de paie 2026 ;
--   16b : calcul d'un bulletin de paie ;
--   16c : vie des bulletins (préparation, brouillon, validation, remise) ;
--   16d : salariés, reprise d'une paie faite ailleurs, contrats de travail ;
--   16e : congés et absences, temps de travail, paramètres de paie.
-- Ce fichier :
--   1. Entreprise : convention collective et organismes de protection sociale
--      (repris sur les contrats et les bulletins).
--   2. Salariés (statut cadre, lieu de travail, horaires d'un temps partiel,
--      motif de sortie), reprise des cumuls et des congés d'une paie faite
--      ailleurs, contrats (un contrat signé ne se supprime pas), absences
--      (jours décomptés calculés), bulletins (variables saisies et calcul
--      complet ; un bulletin validé ne se modifie plus et ne se supprime pas,
--      ses lignes ne s'écrivent que par les fonctions de la base).
--   3. Paramètres de paie par année : SMIC et ses revalorisations, plafond de
--      la Sécurité sociale, réduction générale dégressive unique (RGDU),
--      heures supplémentaires, abattement de CSG ; lignes de cotisation
--      (forfaits, plafonds, conditions, protection complémentaire) ; grille du
--      taux neutre du prélèvement à la source. Une année validée par
--      l'expert-comptable ne se modifie plus sans retirer d'abord la
--      validation, et la validation passe par la fonction prévue (16e).
--   4. Valeurs 2026 (sources officielles), à faire valider par
--      l'expert-comptable avant le premier bulletin : le taux d'accidents du
--      travail (notifié à l'entreprise) et la complémentaire santé (contrat de
--      l'entreprise) restent à saisir.
--   5. Règles d'accès et droits.
-- Aucune instruction de suppression : rien n'est retiré de la base.
-- =============================================================================


-- #############################################################################
-- 1. ENTREPRISE
-- #############################################################################
alter table public.societe
  add column convention_collective  text,
  add column caisse_retraite        text,
  add column organisme_sante        text,
  add column organisme_prevoyance   text,
  add column service_sante_travail  text;

alter table public.societe
  add constraint societe_rh_longueurs check (
    char_length(convention_collective) <= 200 and char_length(caisse_retraite) <= 200
    and char_length(organisme_sante) <= 200 and char_length(organisme_prevoyance) <= 200
    and char_length(service_sante_travail) <= 200);

comment on column public.societe.convention_collective is
  'Convention collective appliquée (intitulé et IDCC), ou « Aucune convention collective applicable ».';
comment on column public.societe.caisse_retraite is 'Caisse de retraite complémentaire Agirc-Arrco des salariés.';
comment on column public.societe.organisme_sante is 'Organisme de la complémentaire santé obligatoire des salariés.';
comment on column public.societe.organisme_prevoyance is 'Organisme de prévoyance, s''il y en a un.';
comment on column public.societe.service_sante_travail is 'Service de prévention et de santé au travail.';


-- #############################################################################
-- 2. SALARIÉS, REPRISE, CONTRATS, ABSENCES, BULLETINS
-- #############################################################################

-- 2a. Jours ouvrables (lundi au samedi) et jours ouvrés (lundi au vendredi)
--     d'une période, jours fériés exclus : décompte des congés payés, prorata
--     d'une entrée ou d'une sortie en cours de mois, heures d'absence
create or replace function prive.jours_ouvrables(p_debut date, p_fin date)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from generate_series(p_debut, p_fin, interval '1 day') as d(jour)
  where extract(isodow from d.jour) < 7
    and not exists (select 1 from public.jours_feries f where f.jour = d.jour::date);
$$;

create or replace function prive.jours_ouvres(p_debut date, p_fin date)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from generate_series(p_debut, p_fin, interval '1 day') as d(jour)
  where extract(isodow from d.jour) < 6
    and not exists (select 1 from public.jours_feries f where f.jour = d.jour::date);
$$;

-- 2b. Salariés
alter table public.salaries
  add column cadre                boolean not null default false,
  add column lieu_travail         text,
  add column repartition_horaire  text,
  add column motif_sortie         text;

alter table public.salaries
  add constraint salaries_textes check (
    char_length(matricule) <= 20 and char_length(prenom) between 1 and 80 and char_length(nom) between 1 and 80
    and char_length(lieu_naissance) <= 120 and char_length(nationalite) <= 60 and char_length(adresse) <= 200
    and char_length(code_postal) <= 10 and char_length(ville) <= 80 and char_length(emploi) between 1 and 120
    and char_length(qualification) <= 120 and char_length(niveau) <= 40 and char_length(coefficient) <= 40
    and char_length(convention_collective) <= 200 and char_length(lieu_travail) <= 200
    and char_length(repartition_horaire) <= 500 and char_length(motif_sortie) <= 200),
  add constraint salaries_iban check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  add constraint salaries_bic check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  add constraint salaries_heures check ((temps = 'plein' and heures_mensuelles = 151.67) or (temps = 'partiel' and heures_mensuelles < 151.67));

comment on column public.salaries.cadre is 'Statut cadre : Apec, prévoyance des cadres.';
comment on column public.salaries.heures_mensuelles is
  'Temps plein : 151,67 h (35 h par semaine ; les heures au-delà se paient en heures supplémentaires) ; temps partiel : moins.';
comment on column public.salaries.convention_collective is 'Convention propre au salarié ; vide : celle de l''entreprise.';
comment on column public.salaries.repartition_horaire is 'Temps partiel : répartition de la durée du travail entre les jours de la semaine (mention obligatoire du contrat).';
comment on column public.salaries.taux_pas is 'Taux personnalisé du prélèvement à la source transmis par l''administration fiscale ; vide : taux neutre.';

-- 2c. Reprise d'une paie faite ailleurs : cumuls de l'année jusqu'au mois
--     indiqué (réduction générale progressive, cumuls du bulletin, plafond
--     d'exonération des heures supplémentaires) et soldes de congés payés à
--     la fin de ce mois. Une seule reprise par salarié.
create table public.reprises_paie (
  salarie_id  uuid primary key references public.salaries (id) on delete cascade,
  mois        date not null check (extract(day from mois) = 1),
  cumuls      jsonb not null default '{}'::jsonb check (jsonb_typeof(cumuls) = 'object'),
  cp_n1       numeric(6,2) not null default 0 check (cp_n1 between -60 and 120),
  cp_n        numeric(6,2) not null default 0 check (cp_n between -60 and 120),
  note        text check (char_length(note) <= 500),
  cree_le     timestamptz not null default now(),
  maj_le      timestamptz not null default now()
);
comment on table public.reprises_paie is
  'Cumuls de l''année et soldes de congés repris de la dernière paie faite ailleurs (le mois indiqué compris).';

-- 2d. Contrats : un contrat signé ne se supprime pas et son contenu ne change
--     plus (seuls son statut « terminé » et le fichier signé peuvent changer)
create or replace function prive.proteger_contrat()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.statut in ('signe', 'termine') then
      raise exception 'Un contrat signé ne se supprime pas : il reste dans le dossier du salarié.' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.statut in ('signe', 'termine') then
    if (to_jsonb(new) - array['statut', 'pdf_chemin', 'maj_le']) <> (to_jsonb(old) - array['statut', 'pdf_chemin', 'maj_le'])
       or new.statut not in ('signe', 'termine') or (old.statut = 'termine' and new.statut <> 'termine') then
      raise exception 'Un contrat signé ne se modifie plus : établissez un avenant.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger proteger_contrat
  before update or delete on public.contrats
  for each row execute function prive.proteger_contrat();

alter table public.contrats
  add constraint contrats_dates check (date_fin is null or date_fin >= date_debut),
  add constraint contrats_essai check (essai_fin is null or essai_fin >= date_debut),
  add constraint contrats_signature check ((statut in ('signe', 'termine')) = (signe_le is not null and pdf_chemin is not null));

-- 2e. Absences : jours décomptés calculés s'ils ne sont pas indiqués (congés
--     payés : jours ouvrables ; autres absences : jours calendaires) ; trace
--     de la décision
alter table public.absences
  add column decide_par     uuid references public.profils (id),
  add column decide_le      timestamptz,
  add column decision_note  text;
alter table public.absences
  add constraint absences_textes check (char_length(commentaire) <= 500 and char_length(decision_note) <= 300),
  add constraint absences_duree check (fin - debut <= 366);
create index absences_decide_par_fk_idx on public.absences (decide_par);

create or replace function prive.jours_absence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.jours is null then
    new.jours := case when new.type = 'conges_payes' then prive.jours_ouvrables(new.debut, new.fin)
                      else new.fin - new.debut + 1 end;
    if new.jours = 0 then
      raise exception 'Aucun jour ouvrable dans cette période : les congés payés se décomptent du lundi au samedi, hors jours fériés.';
    end if;
  end if;
  return new;
end;
$$;

create trigger jours_absence
  before insert or update of debut, fin, jours, type on public.absences
  for each row execute function prive.jours_absence();

-- 2f. Bulletins : ce qui a été saisi (variables) et le calcul complet (lignes,
--     cumuls, congés, contrôles, identités de l'employeur et du salarié au
--     moment du calcul : le bulletin s'imprime toujours tel qu'il a été validé)
alter table public.bulletins
  add column variables        jsonb not null default '{}'::jsonb,
  add column calcul           jsonb not null default '{}'::jsonb,
  add column salaire_base     numeric(10,2),
  add column taux_horaire     numeric(12,6),
  add column net_avant_impot  numeric(10,2) not null default 0;
create index bulletins_periode_idx on public.bulletins (periode);
comment on column public.bulletins.taux_horaire is
  'Taux horaire exact (4 à 6 décimales, assez pour que heures × taux redonne le salaire de base au centime).';

-- Taux des lignes : jusqu'à 6 décimales (taux horaire exact, majorations)
alter table public.bulletin_lignes
  alter column taux_salarial type numeric(12,6),
  alter column taux_patronal type numeric(12,6);

-- Un bulletin validé ne bouge plus : seuls son passage à « remis au salarié »
-- et son PDF peuvent encore changer. Un brouillon se recalcule et se supprime.
create or replace function prive.proteger_bulletin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.statut <> 'brouillon' then
      raise exception 'Un bulletin validé ne peut pas être supprimé : une erreur se corrige sur le bulletin du mois suivant.'
        using errcode = '42501';
    end if;
    return old;
  end if;
  if old.statut <> 'brouillon' then
    if (to_jsonb(new) - array['statut', 'pdf_chemin', 'maj_le']) <> (to_jsonb(old) - array['statut', 'pdf_chemin', 'maj_le'])
       or new.statut not in ('valide', 'envoye') or (old.statut = 'envoye' and new.statut = 'valide') then
      raise exception 'Un bulletin validé ne se modifie plus : une erreur se corrige sur le bulletin du mois suivant.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger proteger_bulletin
  before update or delete on public.bulletins
  for each row execute function prive.proteger_bulletin();

-- Les lignes d'un bulletin sont recopiées à sa validation, puis figées
create or replace function prive.proteger_ligne_bulletin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Les lignes d''un bulletin validé ne se modifient pas.' using errcode = '42501';
end;
$$;

create trigger proteger_ligne_bulletin
  before update or delete on public.bulletin_lignes
  for each row execute function prive.proteger_ligne_bulletin();

-- Bulletins et lignes : écrits par les fonctions de calcul et de validation
-- seulement (un brouillon se supprime encore depuis la page)
revoke insert, update on public.bulletins from authenticated;
revoke insert, update, delete on public.bulletin_lignes from authenticated;


-- #############################################################################
-- 3. PARAMÈTRES DE PAIE
-- #############################################################################

-- 3a. Constantes de l'année
alter table public.constantes_paie
  add column smic_horaire_rgdu       numeric(8,4),
  add column rgdu_tmin               numeric(6,4),
  add column rgdu_tdelta             numeric(6,4),
  add column rgdu_p                  numeric(5,3),
  add column rgdu_taux_at            numeric(5,3),
  add column abattement_csg          numeric(5,2) not null default 1.75,
  add column reduction_salariale_hs  numeric(5,2) not null default 0,
  add column deduction_patronale_hs  numeric(6,2) not null default 0,
  add column plafond_exoneration_hs  numeric(10,2) not null default 0,
  add column valide_le               timestamptz,
  add column valide_par              uuid references public.profils (id),
  add column validation_note         text;
create index constantes_paie_valide_par_fk_idx on public.constantes_paie (valide_par);

alter table public.constantes_paie
  add constraint constantes_paie_valeurs check (
    plafond_mensuel_ss > 0 and smic_horaire > 0
    and (smic_horaire_rgdu is null or smic_horaire_rgdu > 0)
    and (rgdu_tmin is null or rgdu_tmin between 0 and 1) and (rgdu_tdelta is null or rgdu_tdelta between 0 and 1)
    and (rgdu_p is null or rgdu_p > 0) and (rgdu_taux_at is null or rgdu_taux_at between 0 and 10)
    and abattement_csg between 0 and 10 and reduction_salariale_hs between 0 and 20
    and deduction_patronale_hs >= 0 and plafond_exoneration_hs >= 0),
  add constraint constantes_paie_rgdu check (
    (smic_horaire_rgdu is null and rgdu_tmin is null and rgdu_tdelta is null and rgdu_p is null and rgdu_taux_at is null)
    or (smic_horaire_rgdu is not null and rgdu_tmin is not null and rgdu_tdelta is not null and rgdu_p is not null
        and rgdu_taux_at is not null)),
  add constraint constantes_paie_validation check (valide_par_comptable = (valide_le is not null)),
  add constraint constantes_paie_note check (char_length(validation_note) <= 300);

comment on column public.constantes_paie.smic_horaire is 'SMIC horaire brut au 1er janvier (les revalorisations sont dans la table smic).';
comment on column public.constantes_paie.smic_horaire_rgdu is 'SMIC horaire retenu pour la réduction générale (gelé pour l''année si un décret le prévoit).';
comment on column public.constantes_paie.rgdu_taux_at is 'Part de la cotisation accidents du travail sur laquelle s''impute la réduction générale (% du salaire).';
comment on column public.constantes_paie.reduction_salariale_hs is 'Taux maximal de réduction des cotisations salariales sur les heures supplémentaires et complémentaires (%).';
comment on column public.constantes_paie.deduction_patronale_hs is 'Déduction forfaitaire de cotisations patronales par heure supplémentaire (€), selon l''effectif.';
comment on column public.constantes_paie.plafond_exoneration_hs is 'Plafond annuel d''exonération d''impôt sur le revenu des heures supplémentaires et complémentaires (€ nets).';

-- 3b. SMIC horaire et ses revalorisations en cours d'année
create table public.smic (
  valable_du  date primary key,
  horaire     numeric(8,4) not null check (horaire > 0),
  source      text check (char_length(source) <= 200),
  maj_le      timestamptz not null default now()
);
comment on table public.smic is 'SMIC horaire brut et date d''effet de chaque revalorisation.';

-- 3c. Lignes de cotisation : montants des forfaits (complémentaire santé…),
--     plafond de l'assiette en nombre de plafonds mensuels de la Sécurité
--     sociale (4 pour le chômage, 8 pour la CET), condition d'application,
--     protection complémentaire (la part patronale de la santé est
--     imposable ; celle de la prévoyance entre dans le montant net social),
--     cotisations sur lesquelles s'impute la réduction générale
alter table public.parametres_paie
  add column montant_salarial  numeric(8,2),
  add column montant_patronal  numeric(8,2),
  add column plafond_pmss      numeric(4,1),
  add column condition         text not null default 'toujours',
  add column protection        text,
  add column rgdu              boolean not null default false,
  add column actif             boolean not null default true;

alter table public.parametres_paie
  add constraint parametres_paie_condition check (condition in ('toujours', 'cadre', 'non_cadre', 'au_dela_plafond')),
  add constraint parametres_paie_protection check (protection in ('sante', 'prevoyance')),
  add constraint parametres_paie_plafond check (plafond_pmss is null or plafond_pmss > 0),
  add constraint parametres_paie_forfait check (
    (assiette = 'forfait' and montant_salarial is not null and montant_patronal is not null
     and montant_salarial >= 0 and montant_patronal >= 0)
    or (assiette <> 'forfait' and montant_salarial is null and montant_patronal is null)),
  add constraint parametres_paie_taux check (taux_salarial between 0 and 100 and taux_patronal between 0 and 100),
  add constraint parametres_paie_textes check (char_length(code) between 1 and 40 and code ~ '^[a-z0-9_]+$'
                                               and char_length(libelle) between 1 and 120),
  add constraint parametres_paie_section check (section <> 'allegements');

comment on column public.parametres_paie.plafond_pmss is 'Assiette limitée à ce nombre de plafonds mensuels (4 : chômage et AGS ; 8 : CET).';
comment on column public.parametres_paie.condition is 'toujours, cadre (Apec, prévoyance), non_cadre, au_dela_plafond (CET : salaire au-dessus du plafond).';
comment on column public.parametres_paie.rgdu is 'La réduction générale s''impute sur la part patronale de cette cotisation (accidents du travail : dans la limite fixée par les constantes).';
comment on column public.parametres_paie.protection is 'sante : complémentaire santé ; prevoyance : prévoyance (traitements propres à la CSG, au net imposable et au net social).';

-- 3d. Grille du taux neutre (taux par défaut) du prélèvement à la source,
--     métropole, base mensuelle : le taux s'applique à partir du montant « de »
create table public.grille_taux_neutre (
  valable_du  date not null,
  de          numeric(10,2) not null check (de >= 0),
  taux        numeric(4,2) not null check (taux between 0 and 60),
  primary key (valable_du, de)
);
comment on table public.grille_taux_neutre is
  'Taux neutre du prélèvement à la source (métropole, base mensuelle nette imposable), utilisé quand le taux personnalisé du salarié n''est pas connu.';

-- 3e. Une année validée par l'expert-comptable ne se modifie plus : retirer
--     d'abord la validation (inscrite au journal), puis corriger
create or replace function prive.proteger_parametres_paie()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_annee integer := case when tg_op = 'DELETE' then old.annee else new.annee end;
begin
  if exists (select 1 from public.constantes_paie c where c.annee = v_annee and c.valide_par_comptable)
     or (tg_op = 'UPDATE' and exists (select 1 from public.constantes_paie c where c.annee = old.annee and c.valide_par_comptable)) then
    raise exception 'Les paramètres de paie % sont validés par l''expert-comptable : retirez la validation avant de les modifier.', v_annee
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger proteger_parametres_paie
  before insert or update or delete on public.parametres_paie
  for each row execute function prive.proteger_parametres_paie();

-- Constantes : la validation (et son retrait) passe par les fonctions de
-- validation ; tant que l'année est validée, rien d'autre ne change.
-- (Fonction volontairement sans « security definer » : elle doit voir le
--  rôle réel de celui qui modifie.)
create or replace function prive.proteger_constantes_paie()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_validation constant text[] := array['valide_par_comptable', 'valide_le', 'valide_par', 'validation_note', 'maj_le'];
begin
  if tg_op = 'DELETE' then
    if old.valide_par_comptable then
      raise exception 'Les paramètres de paie % sont validés par l''expert-comptable : ils ne se suppriment pas.', old.annee
        using errcode = '42501';
    end if;
    return old;
  end if;
  if current_user = 'authenticated' then
    if (tg_op = 'INSERT' and new.valide_par_comptable)
       or (tg_op = 'UPDATE' and (to_jsonb(new) -> 'valide_par_comptable', to_jsonb(new) -> 'valide_le', to_jsonb(new) -> 'valide_par')
                                is distinct from (to_jsonb(old) -> 'valide_par_comptable', to_jsonb(old) -> 'valide_le', to_jsonb(old) -> 'valide_par')) then
      raise exception 'La validation par l''expert-comptable se fait avec le bouton « Valider les paramètres ».' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.valide_par_comptable
     and (to_jsonb(new) - v_validation) <> (to_jsonb(old) - v_validation) then
    raise exception 'Les paramètres de paie % sont validés par l''expert-comptable : retirez la validation avant de les modifier.', old.annee
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger proteger_constantes_paie
  before insert or update or delete on public.constantes_paie
  for each row execute function prive.proteger_constantes_paie();


-- #############################################################################
-- 4. VALEURS 2026
-- #############################################################################
-- Sources : décret n° 2025-1228 du 17 décembre 2025 (SMIC au 1er janvier) ;
-- revalorisation automatique du SMIC au 1er juin 2026 ; arrêté du
-- 22 décembre 2025 (plafond de la Sécurité sociale) ; réduction générale
-- dégressive unique : décret n° 2026-509 du 12 juin 2026 (SMIC de calcul
-- conservé à 12,02 € pour 2026 ; Tmin 0,0200 ; Tdelta 0,3781 pour les
-- employeurs redevables du FNAL à 0,10 % ; P 1,75) ; taux Urssaf et
-- Agirc-Arrco 2026 ; grille du taux neutre applicable à compter du
-- 1er mai 2026 (loi de finances pour 2026).
-- La réduction générale s'impute sur les cotisations patronales de maladie,
-- vieillesse, retraite complémentaire (tranche 1, 6,01 %), famille, chômage,
-- FNAL, contribution solidarité autonomie et accidents du travail (dans la
-- limite de 0,49 % du salaire).
-- Entreprise de moins de 11 salariés (formation professionnelle 0,55 %,
-- FNAL 0,10 % sur la tranche 1, pas de versement mobilité ni de forfait
-- social) et de moins de 20 salariés (déduction de 1,50 € par heure
-- supplémentaire). À faire valider par l'expert-comptable.
insert into public.constantes_paie (
  annee, plafond_mensuel_ss, smic_horaire, smic_horaire_rgdu, rgdu_tmin, rgdu_tdelta, rgdu_p, rgdu_taux_at,
  abattement_csg, reduction_salariale_hs, deduction_patronale_hs, plafond_exoneration_hs, valide_par_comptable
) values (
  2026, 4005.00, 12.0200, 12.0200, 0.0200, 0.3781, 1.750, 0.490,
  1.75, 11.31, 1.50, 7500.00, false
)
on conflict (annee) do nothing;

insert into public.smic (valable_du, horaire, source) values
  ('2026-01-01', 12.0200, 'Décret n° 2025-1228 du 17 décembre 2025'),
  ('2026-06-01', 12.3100, 'Revalorisation automatique au 1er juin 2026')
on conflict (valable_du) do nothing;

insert into public.parametres_paie
  (annee, code, libelle, section, assiette, taux_salarial, taux_patronal, deductible, ordre,
   montant_salarial, montant_patronal, plafond_pmss, condition, protection, rgdu, actif)
values
  (2026, 'maladie', 'Sécurité sociale - Maladie, maternité, invalidité, décès', 'sante', 'brut', 0, 13.00, true, 10, null, null, null, 'toujours', null, true, true),
  (2026, 'prevoyance_cadres', 'Complémentaire incapacité, invalidité, décès (prévoyance des cadres)', 'sante', 'tranche_1', 0, 1.50, true, 20, null, null, null, 'cadre', 'prevoyance', false, true),
  (2026, 'complementaire_sante', 'Complémentaire santé', 'sante', 'forfait', 0, 0, true, 30, 0, 0, null, 'toujours', 'sante', false, false),
  (2026, 'at_mp', 'Accidents du travail - maladies professionnelles', 'accidents_travail', 'brut', 0, 0, true, 40, null, null, null, 'toujours', null, true, true),
  (2026, 'vieillesse_plafonnee', 'Sécurité sociale plafonnée', 'retraite', 'tranche_1', 6.90, 8.55, true, 50, null, null, null, 'toujours', null, true, true),
  (2026, 'vieillesse_deplafonnee', 'Sécurité sociale déplafonnée', 'retraite', 'brut', 0.40, 2.11, true, 60, null, null, null, 'toujours', null, true, true),
  (2026, 'complementaire_t1', 'Complémentaire Tranche 1', 'retraite', 'tranche_1', 4.01, 6.01, true, 70, null, null, null, 'toujours', null, true, true),
  (2026, 'complementaire_t2', 'Complémentaire Tranche 2', 'retraite', 'tranche_2', 9.72, 14.57, true, 80, null, null, null, 'toujours', null, false, true),
  (2026, 'cet', 'Contribution d''équilibre technique', 'retraite', 'brut', 0.14, 0.21, true, 90, null, null, 8, 'au_dela_plafond', null, false, true),
  (2026, 'allocations_familiales', 'Famille - Sécurité sociale', 'famille', 'brut', 0, 5.25, true, 100, null, null, null, 'toujours', null, true, true),
  (2026, 'chomage', 'Assurance chômage', 'chomage', 'brut', 0, 4.00, true, 110, null, null, 4, 'toujours', null, true, true),
  (2026, 'ags', 'Assurance garantie des salaires (AGS)', 'chomage', 'brut', 0, 0.25, true, 120, null, null, 4, 'toujours', null, false, true),
  (2026, 'apec', 'Apec', 'chomage', 'brut', 0.024, 0.036, true, 130, null, null, 4, 'cadre', null, false, true),
  (2026, 'fnal', 'Fonds national d''aide au logement (FNAL)', 'autres', 'tranche_1', 0, 0.10, true, 140, null, null, null, 'toujours', null, true, true),
  (2026, 'csa', 'Contribution solidarité autonomie', 'autres', 'brut', 0, 0.30, true, 150, null, null, null, 'toujours', null, true, true),
  (2026, 'dialogue_social', 'Contribution au dialogue social', 'autres', 'brut', 0, 0.016, true, 160, null, null, null, 'toujours', null, false, true),
  (2026, 'formation_professionnelle', 'Contribution à la formation professionnelle', 'autres', 'brut', 0, 0.55, true, 170, null, null, null, 'toujours', null, false, true),
  (2026, 'taxe_apprentissage', 'Taxe d''apprentissage', 'autres', 'brut', 0, 0.59, true, 180, null, null, null, 'toujours', null, false, true),
  (2026, 'csg_deductible', 'CSG déductible de l''impôt sur le revenu', 'csg_crds', 'csg_crds', 6.80, 0, true, 190, null, null, null, 'toujours', null, false, true),
  (2026, 'csg_crds_non_deductible', 'CSG/CRDS non déductible de l''impôt sur le revenu', 'csg_crds', 'csg_crds', 2.90, 0, false, 200, null, null, null, 'toujours', null, false, true)
on conflict (annee, code) do nothing;

insert into public.grille_taux_neutre (valable_du, de, taux) values
  ('2026-05-01', 0, 0), ('2026-05-01', 1635, 0.5), ('2026-05-01', 1698, 1.3), ('2026-05-01', 1807, 2.1),
  ('2026-05-01', 1928, 2.9), ('2026-05-01', 2060, 3.5), ('2026-05-01', 2170, 4.1), ('2026-05-01', 2315, 5.3),
  ('2026-05-01', 2738, 7.5), ('2026-05-01', 3135, 9.9), ('2026-05-01', 3571, 11.9), ('2026-05-01', 4019, 13.8),
  ('2026-05-01', 4690, 15.8), ('2026-05-01', 5624, 17.9), ('2026-05-01', 7037, 20), ('2026-05-01', 8789, 24),
  ('2026-05-01', 12200, 28), ('2026-05-01', 16523, 33), ('2026-05-01', 25937, 38), ('2026-05-01', 55558, 43)
on conflict (valable_du, de) do nothing;


-- #############################################################################
-- 5. RÈGLES D'ACCÈS ET DROITS
-- #############################################################################
-- Nouvelles tables : administration seulement ; journal des modifications ;
-- date de dernière modification. La reprise s'écrit par sa fonction (16d).
alter table public.smic enable row level security;
alter table public.grille_taux_neutre enable row level security;
alter table public.reprises_paie enable row level security;
revoke all on public.smic, public.grille_taux_neutre, public.reprises_paie from public, anon, authenticated;
grant select, insert, update, delete on public.smic, public.grille_taux_neutre to authenticated;
grant select on public.reprises_paie to authenticated;
create policy smic_admin on public.smic for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy grille_taux_neutre_admin on public.grille_taux_neutre for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy reprises_paie_admin on public.reprises_paie for select to authenticated
  using ((select public.est_admin()));

create trigger journal
  after insert or update or delete on public.smic
  for each row execute function prive.journaliser();
create trigger journal
  after insert or update or delete on public.grille_taux_neutre
  for each row execute function prive.journaliser();
create trigger journal
  after insert or update or delete on public.reprises_paie
  for each row execute function prive.journaliser();
create trigger maj_horodatage
  before update on public.smic
  for each row execute function prive.maj_horodatage();
create trigger maj_horodatage
  before update on public.reprises_paie
  for each row execute function prive.maj_horodatage();

revoke all on function prive.jours_ouvrables(date, date), prive.jours_ouvres(date, date), prive.jours_absence(),
  prive.proteger_contrat(), prive.proteger_bulletin(), prive.proteger_ligne_bulletin(),
  prive.proteger_parametres_paie(), prive.proteger_constantes_paie()
  from public, anon, authenticated;
