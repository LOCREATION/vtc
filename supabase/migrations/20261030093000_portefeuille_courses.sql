-- =============================================================================
-- LOC RÉACTION S.A.S — Version 2 — migration 31 (portefeuille, partie 2 sur 3)
-- Portefeuille et virement dans les courses et les finances
-- -----------------------------------------------------------------------------
-- Suite de la migration 30 (20261030092900_portefeuille_recharges.sql, qui
-- décrit l'ensemble) : la commande, la fin de course, l'annulation et le
-- pourboire prennent le portefeuille et le virement ; l'encaissement, le
-- remboursement et les synthèses des finances aussi.
-- Fonctions existantes redéfinies (create or replace) : leurs droits ne
-- changent pas.
-- =============================================================================


-- #############################################################################
-- 1. COMMANDE, FIN DE COURSE, ANNULATION, POURBOIRE : portefeuille et virement
-- #############################################################################

-- 1a. Commande : portefeuille (le disponible couvre le prix) et virement
--     (coordonnées bancaires de l'entreprise saisies)
-- (reprise de 20261030090200_fonctions.sql, modifiée)
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

  -- Paiement : espèces, carte dans le véhicule, portefeuille, virement, ou
  -- facture mensuelle (comptes professionnels)
  if p_mode_paiement is null or p_mode_paiement not in ('especes', 'carte', 'solde', 'virement', 'facture_mensuelle') then
    raise exception 'Mode de paiement inconnu.';
  end if;
  if p_mode_paiement = 'virement' and not exists (
       select 1 from public.societe s where s.id = 1 and s.iban is not null and s.bic is not null) then
    raise exception 'Le paiement par virement n''est pas encore proposé : choisissez un autre moyen de paiement.';
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

  -- Portefeuille : le prix doit tenir dans le disponible (solde, moins les
  -- courses à venir déjà payées avec lui et le reste dû). Le solde est
  -- verrouillé le temps du contrôle : deux commandes simultanées ne peuvent
  -- pas compter deux fois le même argent.
  if p_mode_paiement = 'solde' then
    insert into public.soldes (profil_id) values (v_client.id) on conflict (profil_id) do nothing;
    perform 1 from public.soldes s where s.profil_id = v_client.id for update;
    if prive.portefeuille_disponible(v_client.id) < (v_prix ->> 'prix_total')::numeric then
      raise exception 'Solde insuffisant : la course coûte %, votre portefeuille en a % de disponibles. Rechargez-le ou choisissez un autre moyen de paiement.',
        prive.euros((v_prix ->> 'prix_total')::numeric), prive.euros(prive.portefeuille_disponible(v_client.id));
    end if;
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
-- 1b. Fin de course : portefeuille prélevé (reste dû si le solde ne suffit
--     plus), message de fin selon le paiement
-- (reprise de 20261030090200_fonctions.sql, modifiée)
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

  -- Paiement de la course : à encaisser (espèces, carte dans le véhicule,
  -- virement, facture mensuelle) ou prélevé tout de suite sur le portefeuille
  if v_course.prix_total + v_course.frais_attente > 0 then
    if v_course.mode_paiement = 'solde' then
      perform prive.payer_par_portefeuille(v_course, 'course', v_course.prix_total + v_course.frais_attente);
    else
      insert into public.paiements (course_id, client_id, nature, mode, montant)
      values (v_course.id, v_course.client_id, 'course', v_course.mode_paiement,
              v_course.prix_total + v_course.frais_attente);
    end if;
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
    || case v_course.mode_paiement
         when 'solde' then ', payé avec votre portefeuille (solde : '
           || prive.euros(coalesce((select s.montant from public.soldes s where s.profil_id = v_course.client_id), 0)) || ')'
         when 'virement' then ', à régler par virement : coordonnées bancaires sur la page de la course'
         else '' end
    || '. Notez votre chauffeur et retrouvez votre facture.', '/client/course/?id=' || v_course.id);
  return v_course;
end;
$$;
-- 1c. Annulation par le client avec frais : prélevés sur le portefeuille
--     quand la course devait être payée avec lui
-- (reprise de 20261030090200_fonctions.sql, modifiée)
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
      if v_course.mode_paiement = 'solde' then
        perform prive.payer_par_portefeuille(v_course, 'frais_annulation', v_frais);
      else
        insert into public.paiements (course_id, client_id, nature, mode, montant)
        values (v_course.id, v_course.client_id, 'frais_annulation', v_course.mode_paiement, v_frais);
      end if;
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
-- 1d. Pourboire : par le portefeuille (dans le disponible) ou par virement,
--     dans les 24 heures
-- (reprise de 20261030092500_pourboire_client.sql, modifiée)
create or replace function public.ajouter_pourboire(p_course uuid, p_montant numeric)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course     public.courses;
  v_montant    numeric := round(p_montant, 2);
  -- Espèces ou carte au terminal : le pourboire se règle en personne
  v_sur_place  boolean;
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

  -- Délai : 30 minutes en personne, 24 heures sur facture mensuelle. Une
  -- course terminée sans heure de fin (reprise d'une ancienne base) est
  -- traitée comme ancienne.
  v_sur_place := v_course.mode_paiement in ('especes', 'carte');
  if v_sur_place and coalesce(v_course.terminee_le, '-infinity'::timestamptz) < now() - interval '30 minutes' then
    raise exception 'Un pourboire en espèces ou par carte se donne à votre chauffeur dans les 30 minutes qui suivent la course.';
  end if;
  if not v_sur_place and coalesce(v_course.terminee_le, '-infinity'::timestamptz) < now() - interval '24 hours' then
    raise exception 'Le pourboire se donne dans les 24 heures qui suivent la course.';
  end if;

  if p_montant is null or p_montant < 0.5 or p_montant > 100 then
    raise exception 'Le pourboire va de 0,50 € à 100 €.';
  end if;

  -- Portefeuille : le pourboire doit tenir dans le disponible
  if v_course.mode_paiement = 'solde' then
    insert into public.soldes (profil_id) values (v_course.client_id) on conflict (profil_id) do nothing;
    perform 1 from public.soldes s where s.profil_id = v_course.client_id for update;
    if prive.portefeuille_disponible(v_course.client_id) < v_montant then
      raise exception 'Solde insuffisant pour ce pourboire : votre portefeuille a % de disponibles. Rechargez-le d''abord.',
        prive.euros(prive.portefeuille_disponible(v_course.client_id));
    end if;
  end if;

  update public.courses set pourboire = v_montant where id = p_course returning * into v_course;
  if v_course.mode_paiement = 'solde' then
    perform prive.payer_par_portefeuille(v_course, 'pourboire', v_montant);
  else
    insert into public.paiements (course_id, client_id, nature, mode, montant)
    values (p_course, v_course.client_id, 'pourboire', v_course.mode_paiement, v_montant);
  end if;
  -- La facture déjà émise ne change pas : le pourboire (hors TVA, reversé au
  -- chauffeur) figure sur son propre reçu, établi à partir de ce paiement.
  perform prive.evenement(p_course, 'pourboire', jsonb_build_object('montant', v_montant));

  -- Chauffeur prévenu : ce qu'il doit faire dépend du mode de paiement
  if v_course.mode_paiement = 'especes' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire en espèces',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ' : le client vous le remet en espèces. Confirmez-le dans la course une fois reçu.',
      '/chauffeur/course/?id=' || v_course.id::text);
  elsif v_course.mode_paiement = 'carte' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire par carte',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ' : à encaisser sur votre terminal. Confirmez-le dans la course une fois encaissé.',
      '/chauffeur/course/?id=' || v_course.id::text);
  elsif v_course.mode_paiement = 'solde' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire reçu',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ', payé avec le portefeuille du client. Merci !', '/chauffeur/revenus/');
  elsif v_course.mode_paiement = 'virement' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire reçu',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ', réglé par virement avec la course. Merci !', '/chauffeur/revenus/');
  else
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire reçu',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ', sur la facture mensuelle de l''entreprise. Merci !', '/chauffeur/revenus/');
  end if;
  return v_course;
end;
$$;
comment on function public.ajouter_pourboire(uuid, numeric) is
  'Pourboire du client sur sa course terminée : une fois, de 0,50 € à 100 €, réglé comme la course '
  '(espèces ou carte dans le véhicule dans les 30 minutes ; portefeuille, virement ou facture mensuelle dans les 24 heures).';


-- #############################################################################
-- 2. ENCAISSEMENT ET REMBOURSEMENT
-- #############################################################################

-- 2a. Encaissement : portefeuille et virement ne passent jamais par le
--     chauffeur ; l'administration enregistre le virement reçu, ou prélève
--     sur le portefeuille un reste dû (solde suffisant)
-- (reprise de 20261030091310_finances_fonctions_completees.sql, modifiée)
create or replace function public.confirmer_encaissement(p_paiement uuid, p_especes_au_bureau boolean default false)
returns public.paiements
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement public.paiements;
  v_course   public.courses;
  v_admin    boolean := public.est_admin();
  v_bureau   boolean := coalesce(p_especes_au_bureau, false);
begin
  select * into v_paiement from public.paiements p where p.id = p_paiement for update;
  if v_paiement.id is null then
    raise exception 'Paiement introuvable.';
  end if;
  select * into v_course from public.courses c where c.id = v_paiement.course_id;
  if v_course.chauffeur_id is distinct from auth.uid() and not v_admin then
    raise exception 'Paiement introuvable.';
  end if;
  if v_bureau and not v_admin then
    raise exception 'Seule l''administration enregistre des espèces reçues au bureau.';
  end if;
  if not (v_paiement.statut = 'a_encaisser' or (v_paiement.statut = 'echoue' and v_admin)) then
    raise exception 'Ce paiement a déjà été traité.';
  end if;
  if v_paiement.mode = 'facture_mensuelle' and not v_admin then
    raise exception 'Les paiements sur facture mensuelle sont encaissés par l''administration.';
  end if;
  if v_paiement.mode = 'solde' and not v_admin then
    raise exception 'Ce paiement passe par le portefeuille du client : rien à encaisser.';
  end if;
  if v_paiement.mode = 'virement' and not v_admin then
    raise exception 'Le client règle par virement : l''administration l''enregistre à réception.';
  end if;
  -- Reste dû au portefeuille : prélevé maintenant (refusé si le solde ne
  -- suffit pas)
  if v_paiement.mode = 'solde' then
    perform prive.ecrire_solde(v_paiement.client_id, -v_paiement.montant,
      prive.motif_portefeuille(v_paiement.nature, v_course.numero) || ' (reste dû)', v_course.id);
  end if;
  if v_bureau and v_paiement.mode <> 'especes' then
    raise exception 'Ce paiement n''est pas en espèces.';
  end if;

  update public.paiements
     set statut = 'encaisse', encaisse_par = auth.uid(), encaisse_le = now(),
         especes_chauffeur_id = case when v_paiement.mode = 'especes' and not v_bureau then v_course.chauffeur_id end,
         motif = case when v_paiement.statut = 'echoue' then null else motif end
   where id = p_paiement
  returning * into v_paiement;
  perform prive.evenement(v_course.id, 'paiement_encaisse',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_paiement.montant, 'mode', v_paiement.mode)
    || case when v_paiement.mode = 'especes' then jsonb_build_object('au_bureau', v_bureau) else '{}'::jsonb end);
  return v_paiement;
end;
$$;
-- 2b. Remboursement : un paiement fait par le portefeuille est recrédité au
--     portefeuille
-- (reprise de 20261030091310_finances_fonctions_completees.sql, modifiée)
create or replace function public.rembourser(p_paiement uuid, p_montant numeric, p_motif text, p_mode text default null)
returns public.remboursements
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement      public.paiements;
  v_deja          numeric;
  v_montant       numeric := round(p_montant, 2);
  v_mode          text;
  v_remboursement public.remboursements;
  v_facture       public.factures;
  v_avoir         public.avoirs;
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
  -- Par défaut : le moyen du paiement (carte → carte, espèces → espèces,
  -- facture mensuelle → virement)
  v_mode := coalesce(nullif(p_mode, ''), case v_paiement.mode when 'carte' then 'carte' when 'especes' then 'especes'
                                                              when 'solde' then 'solde' else 'virement' end);
  if v_mode not in ('virement', 'carte', 'especes', 'solde') then
    raise exception 'Mode de remboursement inconnu : virement, carte, espèces ou portefeuille.';
  end if;
  if v_mode = 'solde' and v_paiement.mode <> 'solde' then
    raise exception 'Le remboursement sur le portefeuille n''est possible que pour un paiement fait avec lui : choisissez le virement, la carte ou les espèces.';
  end if;
  if v_mode = 'carte' and v_paiement.mode <> 'carte' then
    raise exception 'Le remboursement sur la carte n''est possible que pour un paiement par carte : choisissez le virement ou les espèces.';
  end if;
  select coalesce(sum(r.montant), 0) into v_deja from public.remboursements r where r.paiement_id = p_paiement;
  if v_montant is null or v_montant <= 0 or v_deja + v_montant > v_paiement.montant then
    raise exception 'Montant invalide : il reste % à rembourser au maximum.', prive.euros(v_paiement.montant - v_deja);
  end if;

  insert into public.remboursements (paiement_id, montant, motif, mode, cree_par)
  values (p_paiement, v_montant, left(trim(p_motif), 500), v_mode, auth.uid())
  returning * into v_remboursement;
  if v_deja + v_montant = v_paiement.montant then
    update public.paiements set statut = 'rembourse' where id = p_paiement;
  end if;
  if v_mode = 'solde' then
    perform prive.ecrire_solde(v_paiement.client_id, v_montant,
      'Remboursement ' || (select c.numero from public.courses c where c.id = v_paiement.course_id), v_paiement.course_id);
  end if;

  select * into v_facture from public.factures f where f.course_id = v_paiement.course_id and f.nature = v_paiement.nature;
  if v_facture.id is not null then
    v_avoir := prive.emettre_avoir(v_facture.id, v_montant, 'remboursement', p_motif, p_paiement, v_remboursement.id);
  end if;

  perform prive.evenement(v_paiement.course_id, 'remboursement',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_montant, 'mode', v_mode, 'avoir', v_avoir.numero));
  perform prive.notifier(v_paiement.client_id, 'paiement', 'Remboursement',
    prive.euros(v_montant) || ' vous sont remboursés'
    || case v_mode when 'carte' then ' sur votre carte' when 'virement' then ' par virement'
                   when 'solde' then ' sur votre portefeuille' else ' en espèces' end
    || ' : ' || rtrim(left(trim(p_motif), 200), '.')
    || case when v_avoir.id is not null then ' (avoir ' || v_avoir.numero || ').' else '.' end,
    '/client/activite/');
  return v_remboursement;
end;
$$;

-- #############################################################################
-- 3. FINANCES : virement et portefeuille dans les synthèses et les listes
-- #############################################################################
-- (reprise de 20261030091320_finances_lectures_actions.sql, modifiée)
create or replace function public.admin_finances_synthese(p_debut date, p_fin date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_debut timestamptz;
  v_fin   timestamptz;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);
  v_debut := prive.debut_jour_paris(p_debut);
  v_fin   := prive.debut_jour_paris(p_fin + 1);

  return jsonb_build_object(
    'debut', p_debut, 'fin', p_fin,
    'encaisse', (select jsonb_build_object(
        'total', coalesce(sum(pa.montant), 0), 'nb', count(*),
        'especes', coalesce(sum(pa.montant) filter (where pa.mode = 'especes'), 0),
        'carte', coalesce(sum(pa.montant) filter (where pa.mode = 'carte'), 0),
        'facture_mensuelle', coalesce(sum(pa.montant) filter (where pa.mode = 'facture_mensuelle'), 0),
        'solde', coalesce(sum(pa.montant) filter (where pa.mode = 'solde'), 0),
        'virement', coalesce(sum(pa.montant) filter (where pa.mode = 'virement'), 0),
        'pourboires', coalesce(sum(pa.montant) filter (where pa.nature = 'pourboire'), 0))
      from public.paiements pa
      where pa.statut in ('encaisse', 'rembourse') and pa.encaisse_le >= v_debut and pa.encaisse_le < v_fin),
    'rembourse', (select jsonb_build_object(
        'total', coalesce(sum(r.montant), 0), 'nb', count(*),
        'virement', coalesce(sum(r.montant) filter (where r.mode = 'virement'), 0),
        'carte', coalesce(sum(r.montant) filter (where r.mode = 'carte'), 0),
        'especes', coalesce(sum(r.montant) filter (where r.mode = 'especes'), 0),
        'solde', coalesce(sum(r.montant) filter (where r.mode = 'solde'), 0))
      from public.remboursements r
      where r.cree_le >= v_debut and r.cree_le < v_fin),
    'a_encaisser', (select jsonb_build_object(
        'total', coalesce(sum(pa.montant), 0), 'nb', count(*),
        'sur_place', coalesce(sum(pa.montant) filter (where pa.mode in ('especes', 'carte')), 0),
        'nb_sur_place', count(*) filter (where pa.mode in ('especes', 'carte')),
        'plus_24h', count(*) filter (where pa.mode in ('especes', 'carte') and pa.cree_le < now() - interval '24 hours'),
        'releves', coalesce(sum(pa.montant) filter (where pa.mode = 'facture_mensuelle'), 0),
        'nb_releves', count(*) filter (where pa.mode = 'facture_mensuelle'),
        'virements', coalesce(sum(pa.montant) filter (where pa.mode = 'virement'), 0),
        'nb_virements', count(*) filter (where pa.mode = 'virement'),
        'portefeuille', coalesce(sum(pa.montant) filter (where pa.mode = 'solde'), 0),
        'nb_portefeuille', count(*) filter (where pa.mode = 'solde'))
      from public.paiements pa where pa.statut = 'a_encaisser'),
    'impayes', (select jsonb_build_object('total', coalesce(sum(pa.montant), 0), 'nb', count(*))
                from public.paiements pa where pa.statut = 'echoue'),
    'especes', (select jsonb_build_object(
        'a_remettre', coalesce(sum(e.a_remettre), 0),
        'chauffeurs', count(*) filter (where e.a_remettre > 0),
        'depuis_le', min(e.depuis_le))
      from prive.especes_chauffeurs() e),
    'factures', (select jsonb_build_object('nb', count(*), 'ht', coalesce(sum(f.montant_ht), 0),
                                           'tva', coalesce(sum(f.montant_tva), 0), 'ttc', coalesce(sum(f.montant_ttc), 0))
                 from public.factures f where f.date_emission between p_debut and p_fin),
    'avoirs', (select jsonb_build_object('nb', count(*), 'ht', coalesce(sum(a.montant_ht), 0),
                                         'tva', coalesce(sum(a.montant_tva), 0), 'ttc', coalesce(sum(a.montant_ttc), 0))
               from public.avoirs a where a.date_emission between p_debut and p_fin)
  );
end;
$$;
-- (reprise de 20261030091320_finances_lectures_actions.sql, modifiée)
create or replace function public.admin_lister_paiements(
  p_vue       text,
  p_debut     date    default null,
  p_fin       date    default null,
  p_texte     text    default null,
  p_mode      text    default null,
  p_nature    text    default null,
  p_limite    integer default 50,
  p_decalage  integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_motif    text := prive.motif_recherche(p_texte);
  v_chiffres text := prive.chiffres_telephone(p_texte);
  v_debut    timestamptz;
  v_fin      timestamptz;
  v_resultat jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_vue is null or p_vue not in ('a_encaisser', 'impayes', 'encaisses', 'annules') then
    raise exception 'Vue inconnue.';
  end if;
  if p_mode is not null and p_mode not in ('especes', 'carte', 'solde', 'virement', 'facture_mensuelle') then
    raise exception 'Mode de paiement inconnu.';
  end if;
  if p_nature is not null and p_nature not in ('course', 'pourboire', 'frais_annulation') then
    raise exception 'Nature de paiement inconnue.';
  end if;
  if p_vue = 'encaisses' then
    perform prive.controler_periode(p_debut, p_fin);
    v_debut := prive.debut_jour_paris(p_debut);
    v_fin   := prive.debut_jour_paris(p_fin + 1);
  end if;

  with choisis as (
    select pa.id, pa.mode, pa.montant, pa.cree_le, pa.encaisse_le
    from public.paiements pa
    join public.courses c on c.id = pa.course_id
    join public.profils cl on cl.id = c.client_id
    left join public.profils ch on ch.id = c.chauffeur_id
    left join public.comptes_pro cp on cp.id = c.compte_pro_id
    left join public.factures f on f.course_id = pa.course_id and f.nature = pa.nature
    where (case p_vue
             when 'a_encaisser' then pa.statut = 'a_encaisser'
             when 'impayes'     then pa.statut = 'echoue'
             when 'annules'     then pa.statut = 'annule'
             else pa.statut in ('encaisse', 'rembourse') and pa.encaisse_le >= v_debut and pa.encaisse_le < v_fin
           end)
      and (p_mode is null or pa.mode = p_mode)
      and (p_nature is null or pa.nature = p_nature)
      and (v_motif is null
           or concat_ws(' ', c.numero, cl.prenom, cl.nom, cl.email, cl.telephone, ch.prenom, ch.nom,
                        cp.raison_sociale, pa.reference_externe, f.numero) ilike v_motif
           or (v_chiffres is not null and cl.telephone like '%' || v_chiffres || '%'))
  ),
  classes as (
    select x.*, row_number() over (order by
             case when p_vue = 'encaisses' then x.encaisse_le end desc,
             case when p_vue = 'annules' then x.cree_le end desc,
             x.cree_le, x.id) as rang
    from choisis x
  ),
  page as (
    select * from classes
    order by rang
    limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from choisis),
    'totaux', (select jsonb_build_object('montant', coalesce(sum(x.montant), 0), 'rembourse', coalesce(sum(r.montant), 0))
               from choisis x
               cross join lateral (select coalesce(sum(rb.montant), 0) as montant
                                   from public.remboursements rb where rb.paiement_id = x.id) r),
    'par_mode', (select coalesce(jsonb_agg(jsonb_build_object('mode', m.mode, 'nb', m.nb, 'montant', m.montant)
                                           order by m.montant desc, m.mode), '[]'::jsonb)
                 from (select x.mode, count(*)::integer as nb, sum(x.montant) as montant from choisis x group by x.mode) m),
    'lignes', (select coalesce(jsonb_agg(prive.ligne_paiement(g.id) order by g.rang), '[]'::jsonb) from page g)
  ) into v_resultat;
  return v_resultat;
end;
$$;
-- (reprise de 20261030091320_finances_lectures_actions.sql, modifiée)
create or replace function public.admin_lister_remboursements(
  p_debut     date,
  p_fin       date,
  p_texte     text    default null,
  p_limite    integer default 50,
  p_decalage  integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_motif text := prive.motif_recherche(p_texte);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);

  return (
    with choisis as (
      select r.*, pa.nature as paiement_nature, pa.mode as paiement_mode, pa.montant as paiement_montant,
             pa.course_id, c.numero as course_numero, pa.client_id,
             coalesce(nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email, 'Client') as client_nom,
             (select cp.raison_sociale from public.comptes_pro cp where cp.id = c.compte_pro_id) as compte_pro,
             (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = r.cree_par) as cree_par_nom,
             a.id as avoir_id, a.numero as avoir_numero
      from public.remboursements r
      join public.paiements pa on pa.id = r.paiement_id
      join public.courses c on c.id = pa.course_id
      join public.profils cl on cl.id = pa.client_id
      left join public.avoirs a on a.remboursement_id = r.id
      where r.cree_le >= prive.debut_jour_paris(p_debut) and r.cree_le < prive.debut_jour_paris(p_fin + 1)
        and (v_motif is null
             or concat_ws(' ', c.numero, cl.prenom, cl.nom, cl.email, r.motif, a.numero) ilike v_motif)
    ),
    classes as (
      select x.*, row_number() over (order by x.cree_le desc, x.id) as rang from choisis x
    )
    select jsonb_build_object(
      'total', (select count(*) from choisis),
      'totaux', (select jsonb_build_object('montant', coalesce(sum(x.montant), 0),
                                           'virement', coalesce(sum(x.montant) filter (where x.mode = 'virement'), 0),
                                           'carte', coalesce(sum(x.montant) filter (where x.mode = 'carte'), 0),
                                           'especes', coalesce(sum(x.montant) filter (where x.mode = 'especes'), 0),
                                           'solde', coalesce(sum(x.montant) filter (where x.mode = 'solde'), 0))
                 from choisis x),
      'lignes', coalesce((select jsonb_agg(jsonb_build_object(
          'id', g.id, 'cree_le', g.cree_le, 'montant', g.montant, 'mode', g.mode, 'motif', g.motif,
          'cree_par_nom', g.cree_par_nom, 'paiement_id', g.paiement_id, 'paiement_nature', g.paiement_nature,
          'paiement_mode', g.paiement_mode, 'paiement_montant', g.paiement_montant,
          'course_id', g.course_id, 'course_numero', g.course_numero, 'client_id', g.client_id, 'client_nom', g.client_nom,
          'compte_pro', g.compte_pro, 'avoir_id', g.avoir_id, 'avoir_numero', g.avoir_numero) order by g.rang)
        from (select * from classes order by rang
              limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)) g),
        '[]'::jsonb)
    )
  );
end;
$$;
