-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 16d : RH ET PAIE (4/5) — salariés, reprise de paie, contrats
-- -----------------------------------------------------------------------------
--   1. Outils : lecture contrôlée d'une fiche, clé du n° de Sécurité sociale,
--      mois dont le bulletin est validé (plus rien ne s'y modifie).
--   2. Salariés : liste, dossier complet, création et modification de la fiche
--      (matricule automatique, n° de Sécurité sociale contrôlé, salaire au
--      moins égal au SMIC, compte de l'application rattaché).
--   3. Reprise d'une paie faite ailleurs : cumuls de l'année et soldes de
--      congés au dernier mois payé hors de l'application.
--   4. Contrats de travail : établis depuis la fiche du salarié et l'identité
--      de l'entreprise, sans aucun champ « à compléter » (sinon la liste
--      précise de ce qui manque), contrôle de la période d'essai et du CDD ;
--      remis pour signature, classés une fois signés (PDF), terminés.
-- Aucune instruction de suppression : un contrat non signé se supprime depuis
-- la page (règle d'accès de l'administration, contrat signé protégé).
-- =============================================================================


-- #############################################################################
-- 1. OUTILS
-- #############################################################################

-- 1a. Texte d'une fiche : espaces retirés, vide → null
create or replace function prive.texte_json(p_donnees jsonb, p_cle text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(trim(p_donnees ->> p_cle), '');
$$;

-- 1b. Nombre d'une fiche (null si vide), message clair sinon
create or replace function prive.nombre_json(p_donnees jsonb, p_cle text, p_libelle text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_donnees -> p_cle is null or jsonb_typeof(p_donnees -> p_cle) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_donnees -> p_cle) <> 'number' then
    raise exception '% : nombre attendu.', p_libelle;
  end if;
  return (p_donnees ->> p_cle)::numeric;
end;
$$;

-- 1c. Date d'une fiche (null si vide), message clair sinon
create or replace function prive.date_json(p_donnees jsonb, p_cle text, p_libelle text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(trim(coalesce(p_donnees ->> p_cle, '')), '') is null then
    return null;
  end if;
  begin
    return (p_donnees ->> p_cle)::date;
  exception when others then
    raise exception '% : date invalide.', p_libelle;
  end;
end;
$$;

-- 1d. N° de Sécurité sociale : 13 chiffres, ou 15 avec la clé (97 moins le
--     reste de la division des 13 chiffres par 97)
create or replace function prive.nss_valide(p_numero text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_numero ~ '^[12][0-9]{12}$'
         or (p_numero ~ '^[12][0-9]{14}$' and 97 - (substr(p_numero, 1, 13)::numeric % 97) = substr(p_numero, 14, 2)::numeric);
$$;

-- 1e. Premier mois validé (bulletin validé ou remis) d'une période : rien ne
--     s'y modifie plus (absences, heures)
create or replace function prive.mois_valide(p_salarie uuid, p_debut date, p_fin date)
returns date
language sql
stable
set search_path = ''
as $$
  select min(b.periode) from public.bulletins b
   where b.salarie_id = p_salarie and b.statut <> 'brouillon'
     and b.periode between date_trunc('month', p_debut)::date and date_trunc('month', p_fin)::date;
$$;

-- 1f. SMIC horaire en vigueur à une date
create or replace function prive.smic_au(p_jour date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select m.horaire from public.smic m where m.valable_du <= p_jour order by m.valable_du desc limit 1),
    (select c.smic_horaire from public.constantes_paie c where c.annee = extract(year from p_jour)::integer));
$$;

-- 1g. Ce qui manque pour établir un contrat sans champ « à compléter »
create or replace function prive.manquants_contrat(p_salarie uuid)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  s          public.salaries;
  so         public.societe;
  v_societe  text[];
  v_salarie  text[];
  v_resultat text[] := '{}'::text[];
begin
  select * into s from public.salaries x where x.id = p_salarie;
  select * into so from public.societe x where x.id = 1;
  v_societe := array_remove(array[
    case when nullif(trim(so.forme_juridique), '') is null or so.capital is null then 'forme juridique et capital' end,
    case when nullif(trim(so.adresse), '') is null or nullif(trim(so.code_postal), '') is null or nullif(trim(so.ville), '') is null
         then 'adresse du siège' end,
    case when nullif(trim(so.siret), '') is null then 'SIRET' end,
    case when nullif(trim(so.rcs), '') is null then 'RCS' end,
    case when nullif(trim(so.representant_nom), '') is null or nullif(trim(so.representant_qualite), '') is null
         then 'représentant légal et sa qualité' end,
    case when nullif(trim(coalesce(s.convention_collective, so.convention_collective)), '') is null then 'convention collective' end,
    case when nullif(trim(so.caisse_retraite), '') is null then 'caisse de retraite complémentaire' end,
    case when nullif(trim(so.organisme_sante), '') is null then 'organisme de complémentaire santé' end,
    case when nullif(trim(so.service_sante_travail), '') is null then 'service de santé au travail' end], null);
  v_salarie := array_remove(array[
    case when s.civilite is null then 'civilité' end,
    case when s.date_naissance is null or nullif(trim(s.lieu_naissance), '') is null then 'date et lieu de naissance' end,
    case when nullif(trim(s.nationalite), '') is null then 'nationalité' end,
    case when s.numero_securite_sociale is null then 'n° de Sécurité sociale' end,
    case when nullif(trim(s.adresse), '') is null or nullif(trim(s.code_postal), '') is null or nullif(trim(s.ville), '') is null
         then 'adresse' end,
    case when nullif(trim(s.qualification), '') is null then 'qualification (classification)' end,
    case when nullif(trim(s.lieu_travail), '') is null then 'lieu de travail' end,
    case when s.salaire_base_mensuel is null and s.taux_horaire is null then 'salaire' end,
    case when s.temps = 'partiel' and nullif(trim(s.repartition_horaire), '') is null then 'répartition des horaires (temps partiel)' end], null);
  if cardinality(v_societe) > 0 then
    v_resultat := v_resultat || (array_to_string(v_societe, ', ') || ' (Paramètres, Entreprise)');
  end if;
  if cardinality(v_salarie) > 0 then
    v_resultat := v_resultat || (array_to_string(v_salarie, ', ') || ' (fiche du salarié)');
  end if;
  return v_resultat;
end;
$$;


-- #############################################################################
-- 2. SALARIÉS
-- #############################################################################

-- 2a. Liste : statut (en poste, à venir, sorti), dernier contrat, congés au
--     dernier bulletin validé, comptes de l'application encore libres
create or replace function public.admin_lister_salaries()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_aujourdhui date := (now() at time zone 'Europe/Paris')::date;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  return jsonb_build_object(
    'lignes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'matricule', s.matricule, 'nom', s.prenom || ' ' || s.nom, 'prenom', s.prenom, 'nom_famille', s.nom,
        'emploi', s.emploi, 'type_contrat', s.type_contrat, 'temps', s.temps, 'heures_mensuelles', s.heures_mensuelles,
        'cadre', s.cadre, 'date_entree', s.date_entree, 'date_sortie', s.date_sortie,
        'statut', case when s.date_entree > v_aujourdhui then 'a_venir'
                       when s.date_sortie is not null and s.date_sortie < v_aujourdhui then 'sorti' else 'en_poste' end,
        'salaire_base_mensuel', coalesce(s.salaire_base_mensuel, round(s.taux_horaire * s.heures_mensuelles, 2)),
        'compte', (select jsonb_build_object('id', p.id, 'nom', nullif(trim(p.prenom || ' ' || p.nom), ''), 'role', p.role)
                     from public.profils p where p.id = s.profil_id),
        'contrat', (select jsonb_build_object('id', k.id, 'type', k.type, 'statut', k.statut, 'date_debut', k.date_debut)
                      from public.contrats k where k.salarie_id = s.id order by k.date_debut desc, k.cree_le desc limit 1),
        'dernier_bulletin', (select jsonb_build_object('periode', b.periode, 'statut', b.statut)
                               from public.bulletins b where b.salarie_id = s.id order by b.periode desc limit 1),
        'conges', (select jsonb_build_object('n1_solde', b.conges -> 'n1_solde', 'n_solde', b.conges -> 'n_solde', 'au', b.periode)
                     from public.bulletins b where b.salarie_id = s.id and b.statut <> 'brouillon' order by b.periode desc limit 1),
        'manquants_contrat', cardinality(prive.manquants_contrat(s.id)),
        'demandes', (select count(*) from public.absences a where a.salarie_id = s.id and a.statut = 'demandee'))
        order by (s.date_sortie is not null and s.date_sortie < v_aujourdhui), s.nom, s.prenom), '[]'::jsonb)
      from public.salaries s),
    'comptes', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom'),
                                                         'role', p.role) order by p.nom, p.prenom), '[]'::jsonb)
                  from public.profils p
                 where p.role in ('chauffeur', 'admin') and p.statut = 'actif'
                   and not exists (select 1 from public.salaries s where s.profil_id = p.id)),
    'smic', jsonb_build_object('horaire', prive.smic_au(v_aujourdhui),
                               'mensuel', round(prive.smic_au(v_aujourdhui) * 1820 / 12, 2)));
end;
$$;

-- 2b. Dossier d'un salarié : fiche, compte rattaché, contrats, bulletins,
--     absences, reprise, ce qui manque pour établir un contrat
create or replace function public.admin_dossier_salarie(p_salarie uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.salaries;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into s from public.salaries x where x.id = p_salarie;
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  return jsonb_build_object(
    'salarie', to_jsonb(s),
    'compte', (select jsonb_build_object('id', p.id, 'nom', nullif(trim(p.prenom || ' ' || p.nom), ''), 'role', p.role,
                                         'email', p.email, 'telephone', p.telephone)
                 from public.profils p where p.id = s.profil_id),
    'contrats', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'type', k.type, 'statut', k.statut, 'date_debut', k.date_debut,
                                   'date_fin', k.date_fin, 'essai_fin', k.essai_fin, 'pdf_chemin', k.pdf_chemin, 'signe_le', k.signe_le,
                                   'cree_le', k.cree_le, 'externe', coalesce((k.champs ->> 'externe')::boolean, false),
                                   'motif', k.champs ->> 'motif_libelle', 'objet', k.champs ->> 'detail')
                                 order by k.date_debut desc, k.cree_le desc), '[]'::jsonb)
                   from public.contrats k where k.salarie_id = s.id),
    'bulletins', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'periode', b.periode, 'statut', b.statut, 'brut', b.brut,
                                    'net_a_payer', b.net_a_payer, 'cout_employeur', b.cout_employeur, 'pdf_chemin', b.pdf_chemin)
                                  order by b.periode desc), '[]'::jsonb)
                    from public.bulletins b where b.salarie_id = s.id),
    'absences', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'type', a.type, 'debut', a.debut, 'fin', a.fin, 'jours', a.jours,
                                   'statut', a.statut, 'commentaire', a.commentaire) order by a.debut desc), '[]'::jsonb)
                   from (select * from public.absences a1 where a1.salarie_id = s.id order by a1.debut desc limit 30) as a),
    'reprise', (select to_jsonb(r) from public.reprises_paie r where r.salarie_id = s.id),
    'conges', (select b.conges || jsonb_build_object('au', b.periode)
                 from public.bulletins b where b.salarie_id = s.id and b.statut <> 'brouillon' order by b.periode desc limit 1),
    'manquants_contrat', to_jsonb(prive.manquants_contrat(s.id)),
    'comptes', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom'),
                                                         'role', p.role) order by p.nom, p.prenom), '[]'::jsonb)
                  from public.profils p
                 where p.role in ('chauffeur', 'admin') and p.statut = 'actif'
                   and not exists (select 1 from public.salaries x where x.profil_id = p.id and x.id <> s.id)),
    'societe', (select jsonb_build_object('convention_collective', so.convention_collective) from public.societe so where so.id = 1));
end;
$$;

-- 2c. Création ou modification de la fiche
create or replace function public.admin_enregistrer_salarie(p_salarie uuid, p_fiche jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f            jsonb := coalesce(p_fiche, '{}'::jsonb);
  s            public.salaries;
  v_aujourdhui date := (now() at time zone 'Europe/Paris')::date;
  v_prenom     text := prive.texte_json(f, 'prenom');
  v_nom        text := prive.texte_json(f, 'nom');
  v_civilite   text := prive.texte_json(f, 'civilite');
  v_type       text := prive.texte_json(f, 'type_contrat');
  v_temps      text := coalesce(prive.texte_json(f, 'temps'), 'plein');
  v_heures     numeric := prive.nombre_json(f, 'heures_mensuelles', 'Heures par mois');
  v_base       numeric := prive.nombre_json(f, 'salaire_base_mensuel', 'Salaire de base');
  v_taux       numeric := prive.nombre_json(f, 'taux_horaire', 'Taux horaire');
  v_taux_pas   numeric := prive.nombre_json(f, 'taux_pas', 'Taux de prélèvement à la source');
  v_entree     date := prive.date_json(f, 'date_entree', 'Date d''entrée');
  v_sortie     date := prive.date_json(f, 'date_sortie', 'Date de sortie');
  v_naissance  date := prive.date_json(f, 'date_naissance', 'Date de naissance');
  v_nss        text := nullif(regexp_replace(coalesce(f ->> 'numero_securite_sociale', ''), '[\s.\-]', '', 'g'), '');
  v_iban       text := nullif(upper(regexp_replace(coalesce(f ->> 'iban', ''), '\s', '', 'g')), '');
  v_bic        text := nullif(upper(regexp_replace(coalesce(f ->> 'bic', ''), '\s', '', 'g')), '');
  v_profil     uuid;
  v_matricule  text := upper(prive.texte_json(f, 'matricule'));
  v_smic       numeric;
  v_taux_eff   numeric;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_salarie is not null then
    select * into s from public.salaries x where x.id = p_salarie for update;
    if not found then
      raise exception 'Salarié introuvable.';
    end if;
  end if;
  if v_prenom is null or v_nom is null then
    raise exception 'Indiquez le prénom et le nom du salarié.';
  end if;
  if v_civilite is not null and v_civilite not in ('Madame', 'Monsieur') then
    raise exception 'Civilité : Madame ou Monsieur.';
  end if;
  if v_type is null or v_type not in ('CDI', 'CDD', 'apprentissage') then
    raise exception 'Type de contrat : CDI, CDD ou apprentissage.';
  end if;
  if v_temps not in ('plein', 'partiel') then
    raise exception 'Durée du travail : temps plein ou temps partiel.';
  end if;
  if v_temps = 'plein' then
    v_heures := 151.67;
  elsif v_heures is null or v_heures <= 0 or v_heures >= 151.67 then
    raise exception 'Temps partiel : indiquez les heures par mois (moins de 151,67 h ; 24 h par semaine font 104 h).';
  end if;
  if v_entree is null then
    raise exception 'Indiquez la date d''entrée.';
  end if;
  if v_sortie is not null and v_sortie < v_entree then
    raise exception 'La date de sortie est avant la date d''entrée.';
  end if;
  if v_sortie is not null and prive.texte_json(f, 'motif_sortie') is null then
    raise exception 'Indiquez le motif de la sortie (fin de CDD, démission, rupture conventionnelle, licenciement…).';
  end if;
  if v_naissance is not null and (v_naissance > v_aujourdhui - interval '14 years' or v_naissance < date '1930-01-01') then
    raise exception 'Date de naissance improbable : vérifiez la saisie.';
  end if;
  if v_nss is not null and not prive.nss_valide(v_nss) then
    raise exception 'N° de Sécurité sociale invalide : 13 chiffres et la clé à 2 chiffres. La clé ne correspond pas aux 13 premiers chiffres : vérifiez la saisie.';
  end if;
  if v_base is null and v_taux is null then
    raise exception 'Indiquez le salaire de base mensuel (ou le taux horaire).';
  end if;
  if (v_base is not null and (v_base <= 0 or v_base > 100000)) or (v_taux is not null and (v_taux <= 0 or v_taux > 1000)) then
    raise exception 'Salaire invalide.';
  end if;
  if v_taux_pas is not null and (v_taux_pas < 0 or v_taux_pas > 60) then
    raise exception 'Taux de prélèvement à la source : entre 0 et 60 %%.';
  end if;
  -- Salaire au moins égal au SMIC en vigueur (à l'entrée, si elle est à venir) ;
  -- l'apprenti est payé en pourcentage du SMIC selon son âge
  v_taux_eff := coalesce(round(v_base / v_heures, 4), v_taux);
  v_smic := prive.smic_au(greatest(v_entree, v_aujourdhui));
  if v_type <> 'apprentissage' and v_smic is not null and v_taux_eff < v_smic and (v_sortie is null or v_sortie >= v_aujourdhui) then
    raise exception 'Salaire inférieur au SMIC (% € de l''heure, soit % pour % h) : corrigez le salaire.',
      prive.nombre_fr(v_smic), prive.euros(round(v_smic * v_heures, 2)), prive.nombre_fr(v_heures);
  end if;
  -- Compte de l'application (facultatif) : un compte par salarié
  if prive.texte_json(f, 'profil_id') is not null then
    begin
      v_profil := (f ->> 'profil_id')::uuid;
    exception when others then
      raise exception 'Compte de l''application introuvable.';
    end;
    if not exists (select 1 from public.profils p where p.id = v_profil) then
      raise exception 'Compte de l''application introuvable.';
    end if;
    if exists (select 1 from public.salaries x where x.profil_id = v_profil and x.id is distinct from p_salarie) then
      raise exception 'Ce compte est déjà rattaché à un autre salarié.';
    end if;
  end if;
  if v_matricule is not null and v_matricule !~ '^[A-Z0-9\-]{1,20}$' then
    raise exception 'Matricule : lettres, chiffres et tirets, 20 caractères au plus.';
  end if;
  if v_matricule is not null and exists (select 1 from public.salaries x where x.matricule = v_matricule and x.id is distinct from p_salarie) then
    raise exception 'Ce matricule est déjà attribué.';
  end if;

  begin
    if p_salarie is null then
      perform pg_advisory_xact_lock(hashtext('matricule_salarie'));
      if v_matricule is null then
        select 'S' || lpad((coalesce(max((substring(x.matricule from '^S([0-9]+)$'))::integer), 0) + 1)::text, 4, '0')
          into v_matricule from public.salaries x;
      end if;
      insert into public.salaries (matricule, profil_id, civilite, prenom, nom, date_naissance, lieu_naissance, nationalite,
        numero_securite_sociale, adresse, code_postal, ville, emploi, qualification, niveau, coefficient, convention_collective, cadre,
        type_contrat, temps, heures_mensuelles, repartition_horaire, lieu_travail, date_entree, date_sortie, motif_sortie,
        salaire_base_mensuel, taux_horaire, taux_pas, iban, bic, actif)
      values (v_matricule, v_profil, v_civilite, v_prenom, v_nom, v_naissance, prive.texte_json(f, 'lieu_naissance'),
        prive.texte_json(f, 'nationalite'), v_nss, prive.texte_json(f, 'adresse'), prive.texte_json(f, 'code_postal'),
        prive.texte_json(f, 'ville'), coalesce(prive.texte_json(f, 'emploi'), 'Conducteur de VTC'), prive.texte_json(f, 'qualification'),
        prive.texte_json(f, 'niveau'), prive.texte_json(f, 'coefficient'), prive.texte_json(f, 'convention_collective'),
        coalesce((f ->> 'cadre')::boolean, false), v_type, v_temps, v_heures,
        case when v_temps = 'partiel' then prive.texte_json(f, 'repartition_horaire') end, prive.texte_json(f, 'lieu_travail'),
        v_entree, v_sortie, case when v_sortie is not null then prive.texte_json(f, 'motif_sortie') end,
        v_base, case when v_base is null then v_taux end, v_taux_pas, v_iban, v_bic, v_sortie is null or v_sortie >= v_aujourdhui)
      returning * into s;
    else
      update public.salaries set
        matricule = coalesce(v_matricule, matricule), profil_id = v_profil, civilite = v_civilite, prenom = v_prenom, nom = v_nom,
        date_naissance = v_naissance, lieu_naissance = prive.texte_json(f, 'lieu_naissance'), nationalite = prive.texte_json(f, 'nationalite'),
        numero_securite_sociale = v_nss, adresse = prive.texte_json(f, 'adresse'), code_postal = prive.texte_json(f, 'code_postal'),
        ville = prive.texte_json(f, 'ville'), emploi = coalesce(prive.texte_json(f, 'emploi'), 'Conducteur de VTC'),
        qualification = prive.texte_json(f, 'qualification'), niveau = prive.texte_json(f, 'niveau'),
        coefficient = prive.texte_json(f, 'coefficient'), convention_collective = prive.texte_json(f, 'convention_collective'),
        cadre = coalesce((f ->> 'cadre')::boolean, false), type_contrat = v_type, temps = v_temps, heures_mensuelles = v_heures,
        repartition_horaire = case when v_temps = 'partiel' then prive.texte_json(f, 'repartition_horaire') end,
        lieu_travail = prive.texte_json(f, 'lieu_travail'), date_entree = v_entree, date_sortie = v_sortie,
        motif_sortie = case when v_sortie is not null then prive.texte_json(f, 'motif_sortie') end,
        salaire_base_mensuel = v_base, taux_horaire = case when v_base is null then v_taux end, taux_pas = v_taux_pas,
        iban = v_iban, bic = v_bic, actif = v_sortie is null or v_sortie >= v_aujourdhui
      where id = s.id
      returning * into s;
    end if;
  exception
    when check_violation then
      if sqlerrm ~ 'salaries_iban' then
        raise exception 'IBAN invalide : 2 lettres du pays, 2 chiffres de clé, puis le numéro du compte.';
      elsif sqlerrm ~ 'salaries_bic' then
        raise exception 'BIC invalide : 8 ou 11 caractères.';
      elsif sqlerrm ~ 'salaries_textes' then
        raise exception 'Un champ de la fiche est trop long : raccourcissez-le.';
      end if;
      raise;
  end;
  return jsonb_build_object('id', s.id, 'matricule', s.matricule);
end;
$$;


-- #############################################################################
-- 3. REPRISE D'UNE PAIE FAITE AILLEURS
-- #############################################################################
-- Cumuls de l'année au dernier mois payé ailleurs (lus sur son dernier
-- bulletin) : brut, net imposable, net social, cotisations, allègements,
-- impôt prélevé, net payé, coût employeur, heures payées, heures
-- supplémentaires, heures supplémentaires exonérées, réduction générale
-- appliquée ; soldes de congés N-1 et N à la fin de ce mois.
create or replace function public.admin_enregistrer_reprise(
  p_salarie uuid, p_mois date, p_cumuls jsonb, p_cp_n1 numeric, p_cp_n numeric, p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s          public.salaries;
  c          public.constantes_paie;
  v_mois     date := date_trunc('month', p_mois)::date;
  v_cles     constant text[] := array['brut', 'net_imposable', 'net_social', 'cotisations_salariales', 'cotisations_patronales',
                                      'allegements', 'pas', 'net_a_payer', 'cout_employeur', 'heures', 'heures_sup',
                                      'hs_exonerees', 'rgdu', 'smic_rgdu'];
  v_cumuls   jsonb := '{}'::jsonb;
  v_cle      text;
  v_valeur   jsonb;
  v_premier  date;
  r          public.reprises_paie;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into s from public.salaries x where x.id = p_salarie;
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  if v_mois is null then
    raise exception 'Indiquez le dernier mois payé hors de l''application.';
  end if;
  if v_mois < (date_trunc('month', s.date_entree) - interval '1 month')::date then
    raise exception 'Le mois repris est avant l''entrée du salarié (%).', to_char(s.date_entree, 'DD/MM/YYYY');
  end if;
  select min(b.periode) into v_premier from public.bulletins b where b.salarie_id = s.id;
  if v_premier is not null and v_mois >= v_premier then
    raise exception 'Un bulletin existe déjà pour % : la reprise s''arrête au mois précédent.', prive.mois_lisible(v_premier);
  end if;
  if p_cumuls is null or jsonb_typeof(p_cumuls) <> 'object' then
    raise exception 'Cumuls invalides.';
  end if;
  for v_cle, v_valeur in select * from jsonb_each(p_cumuls) loop
    continue when jsonb_typeof(v_valeur) = 'null';
    if not (v_cle = any (v_cles)) then
      raise exception 'Cumul inconnu : %.', v_cle;
    end if;
    if jsonb_typeof(v_valeur) <> 'number' or (v_valeur #>> '{}')::numeric < 0 or (v_valeur #>> '{}')::numeric > 10000000 then
      raise exception 'Cumul « % » : montant positif attendu.', v_cle;
    end if;
    v_cumuls := v_cumuls || jsonb_build_object(v_cle, round((v_valeur #>> '{}')::numeric, 2));
  end loop;
  if prive.cumul(v_cumuls, 'brut') > 0 and prive.cumul(v_cumuls, 'heures') = 0 and not v_cumuls ? 'smic_rgdu' then
    raise exception 'Indiquez les heures payées de l''année : elles servent au calcul de la réduction générale.';
  end if;
  -- SMIC des heures payées (réduction générale), s'il n'est pas indiqué
  select * into c from public.constantes_paie x where x.annee = extract(year from v_mois)::integer;
  if not v_cumuls ? 'smic_rgdu' and c.smic_horaire_rgdu is not null then
    v_cumuls := v_cumuls || jsonb_build_object('smic_rgdu', round(c.smic_horaire_rgdu * prive.cumul(v_cumuls, 'heures'), 2));
  end if;
  if p_cp_n1 is null or p_cp_n is null or p_cp_n1 < -60 or p_cp_n1 > 120 or p_cp_n < -60 or p_cp_n > 120 then
    raise exception 'Soldes de congés invalides (en jours ouvrables).';
  end if;
  insert into public.reprises_paie (salarie_id, mois, cumuls, cp_n1, cp_n, note)
  values (s.id, v_mois, v_cumuls, round(p_cp_n1, 2), round(p_cp_n, 2), nullif(left(trim(coalesce(p_note, '')), 500), ''))
  on conflict (salarie_id) do update set mois = excluded.mois, cumuls = excluded.cumuls, cp_n1 = excluded.cp_n1,
    cp_n = excluded.cp_n, note = excluded.note
  returning * into r;
  return to_jsonb(r);
end;
$$;


-- #############################################################################
-- 4. CONTRATS DE TRAVAIL
-- #############################################################################

-- 4a. Établir un contrat (CDI, CDD) ou un avenant depuis la fiche du salarié
--     et l'identité de l'entreprise ; tout est recopié dans le contrat (il se
--     réimprime à l'identique, même si la fiche change ensuite)
--     p_motif (CDD) : accroissement, remplacement, saisonnier ;
--     p_detail : personne remplacée (CDD de remplacement) ou objet de l'avenant
create or replace function public.admin_generer_contrat(
  p_salarie uuid, p_type text, p_date_debut date, p_date_fin date default null, p_essai_fin date default null,
  p_motif text default null, p_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s            public.salaries;
  so           public.societe;
  k            public.contrats;
  v_manquants  text[];
  v_detail     text := nullif(trim(coalesce(p_detail, '')), '');
  v_motif_lib  text;
  v_essai_max  date;
  v_mois_essai integer;
  v_jours      integer;
  v_base       numeric;
  v_taux       numeric;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into s from public.salaries x where x.id = p_salarie;
  if not found then
    raise exception 'Salarié introuvable.';
  end if;
  select * into so from public.societe x where x.id = 1;
  if p_type = 'apprentissage' then
    raise exception 'Le contrat d''apprentissage s''établit sur le formulaire Cerfa officiel : classez-le une fois signé avec « Classer un contrat signé ».';
  end if;
  if p_type is null or p_type not in ('CDI', 'CDD', 'avenant') then
    raise exception 'Type de contrat : CDI, CDD ou avenant.';
  end if;
  if p_date_debut is null then
    raise exception 'Indiquez la date de début (ou d''effet de l''avenant).';
  end if;
  v_manquants := prive.manquants_contrat(s.id);
  if cardinality(v_manquants) > 0 then
    raise exception 'Pour établir le contrat sans aucun champ à compléter, renseignez : %.', array_to_string(v_manquants, ' ; ');
  end if;

  if p_type = 'CDI' then
    if p_date_fin is not null then
      raise exception 'Un CDI n''a pas de date de fin.';
    end if;
    -- Période d'essai : 2 mois (employés), 3 mois (agents de maîtrise et
    -- techniciens), 4 mois (cadres) au plus
    v_mois_essai := case when s.cadre then 4 when s.qualification ~* '(maîtrise|maitrise|technicien)' then 3 else 2 end;
    v_essai_max := (p_date_debut + make_interval(months => v_mois_essai))::date - 1;
    if p_essai_fin is not null and (p_essai_fin < p_date_debut or p_essai_fin > v_essai_max) then
      raise exception 'Période d''essai : % mois au plus pour ce poste, soit jusqu''au % compris.', v_mois_essai, to_char(v_essai_max, 'DD/MM/YYYY');
    end if;
  elsif p_type = 'CDD' then
    if p_date_fin is null or p_date_fin < p_date_debut then
      raise exception 'Un CDD a une date de fin (terme précis), après la date de début.';
    end if;
    if p_date_fin > (p_date_debut + interval '18 months')::date - 1 then
      raise exception 'Un CDD dure 18 mois au plus, renouvellements compris.';
    end if;
    v_motif_lib := case p_motif
      when 'accroissement' then 'Accroissement temporaire de l''activité de l''entreprise'
      when 'remplacement' then 'Remplacement d''un salarié absent : ' || coalesce(v_detail, '')
      when 'saisonnier' then 'Emploi à caractère saisonnier' end;
    if v_motif_lib is null then
      raise exception 'Motif du CDD : accroissement temporaire d''activité, remplacement d''un salarié absent ou emploi saisonnier.';
    end if;
    if p_motif = 'remplacement' and (v_detail is null or char_length(v_detail) < 5) then
      raise exception 'CDD de remplacement : indiquez le nom et la qualification du salarié remplacé.';
    end if;
    -- Période d'essai : 1 jour par semaine de contrat, 2 semaines au plus
    -- (contrat de 6 mois au plus) ou 1 mois au plus (au-delà)
    v_jours := (p_date_fin - p_date_debut + 1) / 7;
    v_essai_max := case when p_date_fin <= (p_date_debut + interval '6 months')::date - 1 then p_date_debut + least(v_jours, 14) - 1
                        else least(p_date_debut + v_jours - 1, (p_date_debut + interval '1 month')::date - 1) end;
    if p_essai_fin is not null and (v_jours < 1 or p_essai_fin < p_date_debut or p_essai_fin > v_essai_max) then
      raise exception 'Période d''essai d''un CDD : 1 jour par semaine de contrat, soit jusqu''au % compris au plus.',
        case when v_jours < 1 then '(contrat trop court)' else to_char(v_essai_max, 'DD/MM/YYYY') end;
    end if;
  else
    if v_detail is null or char_length(v_detail) < 10 then
      raise exception 'Avenant : décrivez ce qui change (10 caractères au moins).';
    end if;
    if p_essai_fin is not null then
      raise exception 'Un avenant n''a pas de période d''essai.';
    end if;
  end if;
  if v_detail is not null and char_length(v_detail) > 2000 then
    raise exception 'Texte trop long (2 000 caractères au plus).';
  end if;

  v_base := coalesce(s.salaire_base_mensuel, round(s.taux_horaire * s.heures_mensuelles, 2));
  v_taux := round(v_base / s.heures_mensuelles, 4);
  if round(s.heures_mensuelles * v_taux, 2) <> v_base then
    v_taux := round(v_base / s.heures_mensuelles, 5);
  end if;
  if round(s.heures_mensuelles * v_taux, 2) <> v_base then
    v_taux := round(v_base / s.heures_mensuelles, 6);
  end if;
  insert into public.contrats (salarie_id, type, date_debut, date_fin, essai_fin, statut, champs)
  values (s.id, p_type, p_date_debut, p_date_fin, p_essai_fin, 'brouillon', jsonb_build_object(
    'version', 1,
    'type', p_type, 'date_debut', p_date_debut, 'date_fin', p_date_fin, 'essai_fin', p_essai_fin,
    'motif', p_motif, 'motif_libelle', v_motif_lib, 'detail', v_detail,
    'convention_collective', coalesce(nullif(trim(s.convention_collective), ''), so.convention_collective),
    'societe', jsonb_build_object('raison_sociale', so.raison_sociale, 'forme_juridique', so.forme_juridique, 'capital', so.capital,
      'adresse', so.adresse, 'code_postal', so.code_postal, 'ville', so.ville, 'siret', so.siret, 'rcs', so.rcs, 'code_ape', so.code_ape,
      'numero_urssaf', so.numero_urssaf, 'representant_nom', so.representant_nom, 'representant_qualite', so.representant_qualite,
      'caisse_retraite', so.caisse_retraite, 'organisme_sante', so.organisme_sante, 'organisme_prevoyance', so.organisme_prevoyance,
      'service_sante_travail', so.service_sante_travail),
    'salarie', jsonb_build_object('civilite', s.civilite, 'prenom', s.prenom, 'nom', s.nom, 'date_naissance', s.date_naissance,
      'lieu_naissance', s.lieu_naissance, 'nationalite', s.nationalite, 'numero_securite_sociale', s.numero_securite_sociale,
      'adresse', s.adresse, 'code_postal', s.code_postal, 'ville', s.ville, 'emploi', s.emploi, 'qualification', s.qualification,
      'niveau', s.niveau, 'coefficient', s.coefficient, 'cadre', s.cadre, 'temps', s.temps, 'heures_mensuelles', s.heures_mensuelles,
      'heures_hebdo', round(case when s.heures_mensuelles = 151.67 then 35 else s.heures_mensuelles * 12 / 52 end, 2),
      'repartition_horaire', s.repartition_horaire, 'lieu_travail', s.lieu_travail, 'salaire_base_mensuel', v_base,
      'taux_horaire', v_taux, 'date_entree', s.date_entree, 'matricule', s.matricule),
    'etabli_le', now(),
    'etabli_par', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = auth.uid())))
  returning * into k;
  return jsonb_build_object('id', k.id, 'statut', k.statut, 'champs', k.champs);
end;
$$;

-- 4b. Remis pour signature (ou rendu au brouillon), terminé à la sortie
create or replace function public.admin_statut_contrat(p_contrat uuid, p_statut text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k public.contrats;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into k from public.contrats x where x.id = p_contrat for update;
  if not found then
    raise exception 'Contrat introuvable.';
  end if;
  if not ((k.statut = 'brouillon' and p_statut = 'envoye') or (k.statut = 'envoye' and p_statut = 'brouillon')
          or (k.statut = 'signe' and p_statut = 'termine')) then
    raise exception 'Changement impossible : un contrat est remis pour signature, puis classé une fois signé, puis terminé.';
  end if;
  update public.contrats set statut = p_statut where id = k.id;
end;
$$;

-- 4c. Classer un contrat signé (PDF dans le dossier privé « paie », sous
--     {salarié}/contrats/) : le contrat établi ici, ou un contrat signé
--     ailleurs (Cerfa d'apprentissage, contrat antérieur à l'application).
--     Renvoie le chemin de l'ancien fichier remplacé, à retirer du dossier.
create or replace function public.admin_classer_contrat(
  p_contrat uuid, p_chemin text, p_salarie uuid default null, p_type text default null,
  p_date_debut date default null, p_date_fin date default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k       public.contrats;
  v_ancien text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_contrat is null then
    if not exists (select 1 from public.salaries x where x.id = p_salarie) then
      raise exception 'Salarié introuvable.';
    end if;
    if p_type is null or p_type not in ('CDI', 'CDD', 'apprentissage', 'avenant') then
      raise exception 'Type de contrat : CDI, CDD, apprentissage ou avenant.';
    end if;
    if p_date_debut is null or (p_date_fin is not null and p_date_fin < p_date_debut) then
      raise exception 'Indiquez la date de début (et la date de fin, après le début).';
    end if;
  else
    select * into k from public.contrats x where x.id = p_contrat for update;
    if not found then
      raise exception 'Contrat introuvable.';
    end if;
    if k.statut = 'termine' then
      raise exception 'Ce contrat est terminé.';
    end if;
  end if;
  if p_chemin is null or p_chemin not like coalesce(k.salarie_id, p_salarie)::text || '/contrats/%' or p_chemin like '%..%' then
    raise exception 'Chemin du fichier invalide.';
  end if;
  if p_contrat is null then
    insert into public.contrats (salarie_id, type, date_debut, date_fin, statut, signe_le, pdf_chemin, champs)
    values (p_salarie, p_type, p_date_debut, p_date_fin, 'signe', now(), p_chemin, jsonb_build_object('externe', true));
    return null;
  end if;
  v_ancien := k.pdf_chemin;
  update public.contrats set statut = 'signe', signe_le = coalesce(signe_le, now()), pdf_chemin = p_chemin where id = k.id;
  return case when v_ancien is distinct from p_chemin then v_ancien end;
end;
$$;

-- 4d. Document : le contrat tel qu'établi (identités recopiées à l'établissement)
create or replace function public.admin_document_contrat(p_contrat uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k public.contrats;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into k from public.contrats x where x.id = p_contrat;
  if not found then
    raise exception 'Contrat introuvable.';
  end if;
  return to_jsonb(k);
end;
$$;


-- #############################################################################
-- 5. DROITS D'EXÉCUTION
-- #############################################################################
revoke all on function
  prive.texte_json(jsonb, text), prive.nombre_json(jsonb, text, text), prive.date_json(jsonb, text, text),
  prive.nss_valide(text), prive.mois_valide(uuid, date, date), prive.smic_au(date), prive.manquants_contrat(uuid)
  from public, anon, authenticated;

revoke all on function
  public.admin_lister_salaries(),
  public.admin_dossier_salarie(uuid),
  public.admin_enregistrer_salarie(uuid, jsonb),
  public.admin_enregistrer_reprise(uuid, date, jsonb, numeric, numeric, text),
  public.admin_generer_contrat(uuid, text, date, date, date, text, text),
  public.admin_statut_contrat(uuid, text),
  public.admin_classer_contrat(uuid, text, uuid, text, date, date),
  public.admin_document_contrat(uuid)
  from public, anon;

grant execute on function
  public.admin_lister_salaries(),
  public.admin_dossier_salarie(uuid),
  public.admin_enregistrer_salarie(uuid, jsonb),
  public.admin_enregistrer_reprise(uuid, date, jsonb, numeric, numeric, text),
  public.admin_generer_contrat(uuid, text, date, date, date, text, text),
  public.admin_statut_contrat(uuid, text),
  public.admin_classer_contrat(uuid, text, uuid, text, date, date),
  public.admin_document_contrat(uuid)
  to authenticated;
