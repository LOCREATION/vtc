-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 14b : FINANCES (2/3) — fonctions existantes complétées
-- -----------------------------------------------------------------------------
-- Suite de la migration 14a (structure et outils du module Finances) et de
-- son préalable (anciennes signatures de deux fonctions supprimées).
--   3. Fonctions existantes complétées : encaissement (espèces au bureau ou
--      chez le chauffeur, paiement impayé encaissé plus tard), remboursement
--      (mode, avoir automatique), fiches de course, de client, de compte pro,
--      relevé mensuel (avoirs déduits), tableau de bord (alertes Finances).
--   Droits d'exécution des deux fonctions dont la signature change.
-- Comme partout : chaque fonction vérifie elle-même l'appelant (double
-- authentification comprise), chemin de recherche vide, messages d'erreur en
-- français affichables tels quels.
-- =============================================================================


-- #############################################################################
-- 3. FONCTIONS EXISTANTES COMPLÉTÉES
-- #############################################################################

-- 3a. Encaissement confirmé (chauffeur ou administration).
--     - Espèces : le chauffeur de la course les garde jusqu'à leur remise au
--       bureau ; l'administration peut indiquer qu'elles ont été reçues
--       directement au bureau.
--     - Un paiement déclaré impayé peut être encaissé plus tard, par
--       l'administration (le client a fini par régler).
--     (Remplace la version à un seul paramètre, supprimée juste avant par la
--     migration 14b préalable : l'application du chauffeur l'appelle
--     toujours avec le seul paiement.)
create function public.confirmer_encaissement(p_paiement uuid, p_especes_au_bureau boolean default false)
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

-- 3b. Remboursement (administration) : partiel ou total, jamais au-delà du
--     payé ; mode (virement, carte, espèces) ; la facture de la course ou des
--     frais d'annulation est corrigée par un avoir (un pourboire n'a pas de
--     facture). Le client est prévenu, avec le numéro de l'avoir.
--     (Remplace la version sans mode, supprimée par la migration 14b
--     préalable.)
create function public.rembourser(p_paiement uuid, p_montant numeric, p_motif text, p_mode text default null)
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
  v_mode := coalesce(nullif(p_mode, ''), case v_paiement.mode when 'carte' then 'carte' when 'especes' then 'especes' else 'virement' end);
  if v_mode not in ('virement', 'carte', 'especes') then
    raise exception 'Mode de remboursement inconnu : virement, carte ou espèces.';
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

  select * into v_facture from public.factures f where f.course_id = v_paiement.course_id and f.nature = v_paiement.nature;
  if v_facture.id is not null then
    v_avoir := prive.emettre_avoir(v_facture.id, v_montant, 'remboursement', p_motif, p_paiement, v_remboursement.id);
  end if;

  perform prive.evenement(v_paiement.course_id, 'remboursement',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_montant, 'mode', v_mode, 'avoir', v_avoir.numero));
  perform prive.notifier(v_paiement.client_id, 'paiement', 'Remboursement',
    prive.euros(v_montant) || ' vous sont remboursés'
    || case v_mode when 'carte' then ' sur votre carte' when 'virement' then ' par virement' else ' en espèces' end
    || ' : ' || rtrim(left(trim(p_motif), 200), '.')
    || case when v_avoir.id is not null then ' (avoir ' || v_avoir.numero || ').' else '.' end,
    '/client/activite/');
  return v_remboursement;
end;
$$;

-- 3c. Fiche d'une course : paiements (motif, qui garde les espèces, montant
--     annulé), remboursements (mode, avoir) et avoirs en plus de la version
--     de la migration 10.
create or replace function public.admin_fiche_course(p_course uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_course public.courses;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;

  return jsonb_build_object(
    'course', to_jsonb(v_course),
    'categorie', (select cat.nom_fr from public.categories cat where cat.id = v_course.categorie_id),
    'client', (select jsonb_build_object('id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email,
                                         'telephone', p.telephone, 'statut', p.statut, 'langue', p.langue)
               from public.profils p where p.id = v_course.client_id),
    'chauffeur', (select jsonb_build_object('id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email,
                                            'telephone', p.telephone)
                  from public.profils p where p.id = v_course.chauffeur_id),
    'attribuee_par', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = v_course.attribuee_par),
    'tarif', (select to_jsonb(t) from public.tarifs t where t.id = v_course.tarif_id),
    'forfait', (select jsonb_build_object('prix', f.prix, 'zone_a', za.nom, 'zone_b', zb.nom)
                from public.forfaits f
                join public.zones za on za.id = f.zone_a_id
                join public.zones zb on zb.id = f.zone_b_id
                where f.id = v_course.forfait_id),
    'code_promo', (select cp.code from public.codes_promo cp where cp.id = v_course.code_promo_id),
    'compte_pro', (select cp.raison_sociale from public.comptes_pro cp where cp.id = v_course.compte_pro_id),
    'arrets', coalesce((select jsonb_agg(jsonb_build_object('ordre', a.ordre, 'adresse', a.adresse,
                                                           'latitude', a.latitude, 'longitude', a.longitude) order by a.ordre)
                        from public.course_arrets a where a.course_id = v_course.id), '[]'::jsonb),
    'evenements', coalesce((select jsonb_agg(jsonb_build_object('type', e.type, 'cree_le', e.cree_le, 'details', e.details,
                                                               'acteur_nom', nullif(trim(p.prenom || ' ' || p.nom), ''),
                                                               'acteur_role', p.role) order by e.cree_le, e.id)
                            from public.evenements_course e left join public.profils p on p.id = e.acteur_id
                            where e.course_id = v_course.id), '[]'::jsonb),
    'propositions', coalesce((select jsonb_agg(jsonb_build_object('chauffeur_nom', nullif(trim(p.prenom || ' ' || p.nom), ''),
                                                                 'statut', pr.statut, 'distance_km', pr.distance_km,
                                                                 'envoyee_le', pr.envoyee_le, 'expire_le', pr.expire_le,
                                                                 'repondue_le', pr.repondue_le) order by pr.envoyee_le)
                              from public.propositions pr join public.profils p on p.id = pr.chauffeur_id
                              where pr.course_id = v_course.id), '[]'::jsonb),
    'paiements', coalesce((select jsonb_agg(prive.ligne_paiement(pa.id) order by pa.cree_le)
                           from public.paiements pa where pa.course_id = v_course.id), '[]'::jsonb),
    'remboursements', coalesce((select jsonb_agg(jsonb_build_object('paiement_id', r.paiement_id, 'montant', r.montant,
                                                                   'motif', r.motif, 'mode', r.mode, 'cree_le', r.cree_le,
                                                                   'cree_par', nullif(trim(p.prenom || ' ' || p.nom), ''),
                                                                   'avoir_id', a.id, 'avoir_numero', a.numero)
                                                 order by r.cree_le)
                                from public.remboursements r
                                join public.paiements pa on pa.id = r.paiement_id
                                left join public.profils p on p.id = r.cree_par
                                left join public.avoirs a on a.remboursement_id = r.id
                                where pa.course_id = v_course.id), '[]'::jsonb),
    'factures', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'numero', f.numero, 'nature', f.nature,
                                                             'date_emission', f.date_emission, 'montant_ht', f.montant_ht,
                                                             'taux_tva', f.taux_tva, 'montant_tva', f.montant_tva,
                                                             'montant_ttc', f.montant_ttc, 'pourboire', f.pourboire,
                                                             'statut', f.statut, 'pdf_chemin', f.pdf_chemin) order by f.numero)
                          from public.factures f where f.course_id = v_course.id), '[]'::jsonb),
    'avoirs', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'numero', a.numero, 'date_emission', a.date_emission,
                                                           'origine', a.origine, 'motif', a.motif, 'facture_numero', f.numero,
                                                           'montant_ht', a.montant_ht, 'taux_tva', a.taux_tva,
                                                           'montant_tva', a.montant_tva, 'montant_ttc', a.montant_ttc) order by a.numero)
                        from public.avoirs a join public.factures f on f.id = a.facture_id
                        where a.course_id = v_course.id), '[]'::jsonb),
    'evaluations', coalesce((select jsonb_agg(jsonb_build_object('sens', e.sens, 'note', e.note,
                                                                'commentaire', e.commentaire, 'cree_le', e.cree_le) order by e.cree_le)
                             from public.evaluations e where e.course_id = v_course.id), '[]'::jsonb)
  );
end;
$$;

-- 3d. Fiche d'un client : ses avoirs, en plus de la version de la migration 12.
create or replace function public.admin_fiche_client(p_profil uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_profil public.profils;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_profil from public.profils p where p.id = p_profil;
  if v_profil.id is null then
    raise exception 'Compte introuvable.';
  end if;

  return jsonb_build_object(
    'profil', jsonb_build_object(
      'id', v_profil.id, 'role', v_profil.role, 'statut', v_profil.statut, 'prenom', v_profil.prenom, 'nom', v_profil.nom,
      'email', v_profil.email, 'telephone', v_profil.telephone, 'langue', v_profil.langue,
      'code_parrainage', v_profil.code_parrainage, 'notif_email', v_profil.notif_email,
      'notif_whatsapp', v_profil.notif_whatsapp, 'notif_push', v_profil.notif_push,
      'cree_le', v_profil.cree_le, 'maj_le', v_profil.maj_le),
    'connexion', (select jsonb_build_object('derniere_connexion', u.last_sign_in_at, 'email_confirme_le', u.email_confirmed_at,
                                            'telephone_connexion', u.phone)
                  from auth.users u where u.id = v_profil.id),
    'solde', coalesce((select s.montant from public.soldes s where s.profil_id = v_profil.id), 0),
    'chiffres', (select jsonb_build_object(
        'courses_total', count(*),
        'courses_terminees', count(*) filter (where c.statut = 'terminee'),
        'a_venir', count(*) filter (where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')),
        'annulations_client', count(*) filter (where c.statut = 'annulee' and c.annulee_par = 'client'),
        'annulations_autres', count(*) filter (where c.statut = 'annulee' and c.annulee_par is distinct from 'client'),
        'depense', coalesce(sum(c.prix_total + c.frais_attente) filter (where c.statut = 'terminee'), 0)
                   + coalesce(sum(c.frais_annulation) filter (where c.statut = 'annulee'), 0),
        'panier_moyen', round(avg(c.prix_total + c.frais_attente) filter (where c.statut = 'terminee'), 2),
        'pourboires', coalesce(sum(c.pourboire) filter (where c.statut = 'terminee'), 0),
        'distance_km', coalesce(sum(c.distance_km) filter (where c.statut = 'terminee'), 0),
        'premiere_course_le', min(c.terminee_le) filter (where c.statut = 'terminee'),
        'derniere_course_le', max(c.terminee_le) filter (where c.statut = 'terminee'),
        'a_encaisser', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                         where pa.client_id = v_profil.id and pa.statut = 'a_encaisser'),
        'note_recue', (select round(avg(e.note)::numeric, 2) from public.evaluations e
                        where e.cible_id = v_profil.id and e.sens = 'chauffeur_vers_client'),
        'nb_notes_recues', (select count(*) from public.evaluations e
                             where e.cible_id = v_profil.id and e.sens = 'chauffeur_vers_client'),
        'note_donnee', (select round(avg(e.note)::numeric, 2) from public.evaluations e
                         where e.auteur_id = v_profil.id and e.sens = 'client_vers_chauffeur'))
      from public.courses c where c.client_id = v_profil.id),
    'courses', coalesce((select jsonb_agg(x.ligne order by x.prise_en_charge_le desc, x.numero desc) from (
        select c.prise_en_charge_le, c.numero, jsonb_build_object(
          'id', c.id, 'numero', c.numero, 'statut', c.statut, 'type', c.type, 'prise_en_charge_le', c.prise_en_charge_le,
          'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
          'prix_total', c.prix_total, 'frais_attente', c.frais_attente, 'frais_annulation', c.frais_annulation,
          'pourboire', c.pourboire, 'mode_paiement', c.mode_paiement, 'annulee_par', c.annulee_par,
          'pour_proche', c.pour_proche, 'beneficiaire_nom', c.beneficiaire_nom,
          'chauffeur_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.chauffeur_id),
          'compte_pro', (select cp.raison_sociale from public.comptes_pro cp where cp.id = c.compte_pro_id)) as ligne
        from public.courses c where c.client_id = v_profil.id
        order by c.prise_en_charge_le desc, c.numero desc limit 100) x), '[]'::jsonb),
    'paiements_a_encaisser', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pa.id, 'course_id', pa.course_id, 'course_numero', c.numero, 'nature', pa.nature, 'mode', pa.mode,
        'montant', pa.montant, 'cree_le', pa.cree_le) order by pa.cree_le)
      from public.paiements pa join public.courses c on c.id = pa.course_id
      where pa.client_id = v_profil.id and pa.statut = 'a_encaisser'), '[]'::jsonb),
    'factures', coalesce((select jsonb_agg(x.ligne order by x.numero desc) from (
        select f.numero, jsonb_build_object(
          'id', f.id, 'numero', f.numero, 'nature', f.nature, 'date_emission', f.date_emission,
          'montant_ttc', f.montant_ttc, 'statut', f.statut, 'course_id', f.course_id, 'course_numero', c.numero,
          'destinataire_nom', f.destinataire_nom, 'compte_pro_id', f.compte_pro_id,
          'credite', (select coalesce(sum(a.montant_ttc), 0) from public.avoirs a where a.facture_id = f.id)) as ligne
        from public.factures f join public.courses c on c.id = f.course_id
        where f.client_id = v_profil.id
        order by f.numero desc limit 100) x), '[]'::jsonb),
    'avoirs', coalesce((select jsonb_agg(x.ligne order by x.numero desc) from (
        select a.numero, jsonb_build_object(
          'id', a.id, 'numero', a.numero, 'date_emission', a.date_emission, 'origine', a.origine, 'motif', a.motif,
          'montant_ttc', a.montant_ttc, 'facture_id', a.facture_id, 'facture_numero', f.numero,
          'course_id', a.course_id, 'course_numero', c.numero, 'destinataire_nom', a.destinataire_nom,
          'compte_pro_id', a.compte_pro_id) as ligne
        from public.avoirs a
        join public.factures f on f.id = a.facture_id
        join public.courses c on c.id = a.course_id
        where a.client_id = v_profil.id
        order by a.numero desc limit 100) x), '[]'::jsonb),
    'ecritures', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select e.cree_le, jsonb_build_object(
          'montant', e.montant, 'motif', e.motif, 'cree_le', e.cree_le, 'course_id', e.course_id,
          'course_numero', (select c.numero from public.courses c where c.id = e.course_id),
          'auteur', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = e.cree_par)) as ligne
        from public.ecritures_solde e where e.profil_id = v_profil.id
        order by e.cree_le desc limit 50) x), '[]'::jsonb),
    'notes_recues', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select e.cree_le, jsonb_build_object(
          'note', e.note, 'commentaire', e.commentaire, 'cree_le', e.cree_le, 'course_id', e.course_id,
          'course_numero', c.numero, 'auteur', nullif(trim(p.prenom || ' ' || p.nom), '')) as ligne
        from public.evaluations e
        join public.courses c on c.id = e.course_id
        left join public.profils p on p.id = e.auteur_id
        where e.cible_id = v_profil.id and e.sens = 'chauffeur_vers_client'
        order by e.cree_le desc limit 50) x), '[]'::jsonb),
    'notes_donnees', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select e.cree_le, jsonb_build_object(
          'note', e.note, 'commentaire', e.commentaire, 'cree_le', e.cree_le, 'course_id', e.course_id,
          'course_numero', c.numero, 'chauffeur', nullif(trim(p.prenom || ' ' || p.nom), '')) as ligne
        from public.evaluations e
        join public.courses c on c.id = e.course_id
        left join public.profils p on p.id = e.cible_id
        where e.auteur_id = v_profil.id and e.sens = 'client_vers_chauffeur'
        order by e.cree_le desc limit 50) x), '[]'::jsonb),
    'parrain', (select jsonb_build_object('id', pp.id, 'nom', coalesce(nullif(trim(pp.prenom || ' ' || pp.nom), ''), pp.email),
                                          'statut', pa.statut, 'valide_le', pa.valide_le, 'recompense', pa.recompense_filleul,
                                          'cree_le', pa.cree_le)
                from public.parrainages pa join public.profils pp on pp.id = pa.parrain_id
                where pa.filleul_id = v_profil.id),
    'filleuls', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pf.id, 'nom', coalesce(nullif(trim(pf.prenom || ' ' || pf.nom), ''), pf.email), 'statut', pa.statut,
        'valide_le', pa.valide_le, 'recompense', pa.recompense_parrain, 'cree_le', pa.cree_le) order by pa.cree_le desc)
      from public.parrainages pa join public.profils pf on pf.id = pa.filleul_id
      where pa.parrain_id = v_profil.id), '[]'::jsonb),
    'promos', coalesce((select jsonb_agg(jsonb_build_object(
        'code', cp.code, 'remise', u.remise, 'cree_le', u.cree_le, 'course_id', u.course_id, 'course_numero', c.numero)
        order by u.cree_le desc)
      from public.utilisations_promo u
      join public.codes_promo cp on cp.id = u.code_promo_id
      join public.courses c on c.id = u.course_id
      where u.client_id = v_profil.id), '[]'::jsonb),
    'lieux', coalesce((select jsonb_agg(jsonb_build_object('type', l.type, 'libelle', l.libelle, 'adresse', l.adresse,
                                                          'precision', l.precision)
                                        order by case l.type when 'domicile' then 0 when 'travail' then 1 else 2 end, l.cree_le)
                       from public.lieux l where l.client_id = v_profil.id), '[]'::jsonb),
    'proches', coalesce((select jsonb_agg(jsonb_build_object('nom', pr.nom, 'telephone', pr.telephone, 'relation', pr.relation)
                                          order by pr.nom)
                         from public.proches pr where pr.client_id = v_profil.id), '[]'::jsonb),
    'entreprises', coalesce((select jsonb_agg(jsonb_build_object('id', cp.id, 'raison_sociale', cp.raison_sociale,
                                                                'role', m.role, 'statut', cp.statut, 'ajoute_le', m.cree_le)
                                              order by cp.raison_sociale)
                             from public.comptes_pro_membres m join public.comptes_pro cp on cp.id = m.compte_pro_id
                             where m.profil_id = v_profil.id), '[]'::jsonb),
    'chauffeur', (select jsonb_build_object('statut', ch.statut) from public.chauffeurs ch where ch.id = v_profil.id),
    'demandes', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select d.cree_le, jsonb_build_object('id', d.id, 'numero', d.numero, 'type', d.type, 'sujet', d.sujet,
                                             'statut', d.statut, 'cree_le', d.cree_le, 'course_id', d.course_id) as ligne
        from public.demandes d where d.auteur_id = v_profil.id
        order by d.cree_le desc limit 20) x), '[]'::jsonb),
    'notes_internes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'texte', n.texte, 'cree_le', n.cree_le, 'auteur_id', n.auteur_id,
        'auteur', nullif(trim(p.prenom || ' ' || p.nom), '')) order by n.cree_le desc)
      from public.notes_internes n left join public.profils p on p.id = n.auteur_id
      where n.profil_id = v_profil.id), '[]'::jsonb)
  );
end;
$$;

-- 3e. Fiche d'un compte professionnel : total facturé net des avoirs.
create or replace function public.admin_fiche_compte_pro(p_compte uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_compte public.comptes_pro;
  v_debut  timestamptz := prive.debut_mois_paris();
  v_jour   date := prive.heure_paris()::date;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_compte from public.comptes_pro cp where cp.id = p_compte;
  if v_compte.id is null then
    raise exception 'Compte professionnel introuvable.';
  end if;

  return jsonb_build_object(
    'compte', to_jsonb(v_compte),
    'membres', coalesce((select jsonb_agg(jsonb_build_object(
        'profil_id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email, 'telephone', p.telephone,
        'statut', p.statut, 'role', m.role, 'ajoute_le', m.cree_le,
        'courses_mois', (select count(*) from public.courses c
                          where c.compte_pro_id = v_compte.id and c.client_id = p.id
                            and c.cree_le >= v_debut and c.statut <> 'annulee'))
        order by case m.role when 'gestionnaire' then 0 else 1 end, lower(p.prenom || ' ' || p.nom))
      from public.comptes_pro_membres m join public.profils p on p.id = m.profil_id
      where m.compte_pro_id = v_compte.id), '[]'::jsonb),
    'chiffres', jsonb_build_object(
      'courses_mois', (select count(*) from public.courses c
                        where c.compte_pro_id = v_compte.id and c.cree_le >= v_debut and c.statut <> 'annulee'),
      'engage_mois', prive.engage_mois_pro(v_compte.id),
      'courses_terminees', (select count(*) from public.courses c where c.compte_pro_id = v_compte.id and c.statut = 'terminee'),
      'total_facture', (select coalesce(sum(f.montant_ttc), 0) from public.factures f
                         where f.compte_pro_id = v_compte.id and f.statut = 'emise')
                       - (select coalesce(sum(a.montant_ttc), 0) from public.avoirs a where a.compte_pro_id = v_compte.id),
      'a_encaisser', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                       join public.courses c on c.id = pa.course_id
                       where c.compte_pro_id = v_compte.id and pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'),
      'en_retard', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                     join public.courses c on c.id = pa.course_id
                     where c.compte_pro_id = v_compte.id and pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'
                       and prive.echeance_releve(pa.cree_le, v_compte.delai_paiement_jours) < v_jour)),
    'courses', coalesce((select jsonb_agg(x.ligne order by x.prise_en_charge_le desc, x.numero desc) from (
        select c.prise_en_charge_le, c.numero, jsonb_build_object(
          'id', c.id, 'numero', c.numero, 'statut', c.statut, 'type', c.type, 'prise_en_charge_le', c.prise_en_charge_le,
          'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
          'prix_total', c.prix_total, 'frais_attente', c.frais_attente, 'frais_annulation', c.frais_annulation,
          'pourboire', c.pourboire, 'mode_paiement', c.mode_paiement,
          'client_id', c.client_id,
          'client_nom', (select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email) from public.profils p where p.id = c.client_id),
          'pour_proche', c.pour_proche, 'beneficiaire_nom', c.beneficiaire_nom) as ligne
        from public.courses c where c.compte_pro_id = v_compte.id
        order by c.prise_en_charge_le desc, c.numero desc limit 100) x), '[]'::jsonb),
    -- Mois qui ont un relevé (factures ou pourboires), plus le mois en cours
    'mois', (select coalesce(jsonb_agg(m.mois order by m.mois desc), '[]'::jsonb) from (
        select to_char(f.date_emission, 'YYYY-MM') as mois from public.factures f where f.compte_pro_id = v_compte.id
        union
        select to_char(prive.heure_paris(pa.cree_le), 'YYYY-MM') from public.paiements pa
          join public.courses c on c.id = pa.course_id
          where c.compte_pro_id = v_compte.id and pa.nature = 'pourboire'
        union
        select to_char(prive.heure_paris(), 'YYYY-MM')) m),
    'notes_internes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'texte', n.texte, 'cree_le', n.cree_le, 'auteur_id', n.auteur_id,
        'auteur', nullif(trim(p.prenom || ' ' || p.nom), '')) order by n.cree_le desc)
      from public.notes_internes n left join public.profils p on p.id = n.auteur_id
      where n.compte_pro_id = v_compte.id), '[]'::jsonb)
  );
end;
$$;

-- 3f. Relevé mensuel d'un compte professionnel, avoirs déduits.
--     Les avoirs figurent sous la facture qu'ils corrigent, dans le relevé
--     du mois de cette facture (avec leur propre date) : le relevé d'un mois
--     dit toujours ce qui reste dû sur ses factures. Pourboires : hors ceux
--     annulés, remboursements déduits.
create or replace function public.admin_releve_compte_pro(p_compte uuid, p_mois date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_compte  public.comptes_pro;
  v_jour    date := prive.heure_paris()::date;
  v_debut   date := date_trunc('month', coalesce(p_mois, prive.heure_paris()::date))::date;
  v_fin     date;
  v_date    date;
  v_lignes  jsonb;
  v_ht      numeric;
  v_tva     numeric;
  v_ttc     numeric;
  v_av_ht   numeric;
  v_av_tva  numeric;
  v_av_ttc  numeric;
  v_tips    jsonb;
  v_pourb   numeric;
  v_reste   numeric;
  v_nb      integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_compte from public.comptes_pro cp where cp.id = p_compte;
  if v_compte.id is null then
    raise exception 'Compte professionnel introuvable.';
  end if;
  if v_debut > v_jour then
    raise exception 'Ce mois n''a pas encore commencé.';
  end if;
  v_fin  := (v_debut + interval '1 month')::date - 1;
  v_date := least(v_fin, v_jour);

  -- Factures du mois, avec le paiement correspondant et leurs avoirs
  select coalesce(jsonb_agg(jsonb_build_object(
           'facture_id', f.id, 'numero', f.numero, 'nature', f.nature, 'date_emission', f.date_emission,
           'montant_ht', f.montant_ht, 'taux_tva', f.taux_tva, 'montant_tva', f.montant_tva, 'montant_ttc', f.montant_ttc,
           'course_id', c.id, 'course_numero', c.numero, 'prise_en_charge_le', c.prise_en_charge_le,
           'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
           'passager', coalesce(case when c.pour_proche then c.beneficiaire_nom end,
                                nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email),
           'commande_par', coalesce(nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email),
           'paiement_id', pa.id, 'paiement_mode', pa.mode, 'paiement_statut', pa.statut,
           'encaisse_le', pa.encaisse_le, 'reference', pa.reference_externe,
           'avoirs', coalesce((select jsonb_agg(jsonb_build_object(
                                 'avoir_id', a.id, 'numero', a.numero, 'date_emission', a.date_emission,
                                 'origine', a.origine, 'motif', a.motif, 'montant_ht', a.montant_ht,
                                 'montant_tva', a.montant_tva, 'montant_ttc', a.montant_ttc) order by a.numero)
                               from public.avoirs a where a.facture_id = f.id), '[]'::jsonb))
           order by f.date_emission, f.numero), '[]'::jsonb),
         coalesce(sum(f.montant_ht), 0), coalesce(sum(f.montant_tva), 0), coalesce(sum(f.montant_ttc), 0)
    into v_lignes, v_ht, v_tva, v_ttc
  from public.factures f
  join public.courses c on c.id = f.course_id
  join public.profils cl on cl.id = c.client_id
  left join public.paiements pa on pa.course_id = f.course_id and pa.nature = f.nature
  where f.compte_pro_id = v_compte.id and f.statut = 'emise' and f.date_emission between v_debut and v_fin;

  select coalesce(sum(a.montant_ht), 0), coalesce(sum(a.montant_tva), 0), coalesce(sum(a.montant_ttc), 0)
    into v_av_ht, v_av_tva, v_av_ttc
  from public.avoirs a join public.factures f on f.id = a.facture_id
  where f.compte_pro_id = v_compte.id and f.statut = 'emise' and f.date_emission between v_debut and v_fin;

  -- Pourboires du mois (hors TVA, reversés aux chauffeurs), hors annulés,
  -- remboursements déduits
  select coalesce(jsonb_agg(jsonb_build_object(
           'paiement_id', pa.id, 'montant', pa.montant, 'mode', pa.mode, 'statut', pa.statut, 'cree_le', pa.cree_le,
           'rembourse', r.montant, 'course_id', c.id, 'course_numero', c.numero) order by pa.cree_le), '[]'::jsonb),
         coalesce(sum(pa.montant - r.montant), 0)
    into v_tips, v_pourb
  from public.paiements pa
  join public.courses c on c.id = pa.course_id
  cross join lateral (select coalesce(sum(x.montant), 0) as montant from public.remboursements x where x.paiement_id = pa.id) r
  where pa.nature = 'pourboire' and pa.statut <> 'annule' and c.compte_pro_id = v_compte.id
    and pa.cree_le >= prive.debut_jour_paris(v_debut) and pa.cree_le < prive.debut_jour_paris(v_fin + 1);

  -- Reste à payer : paiements sur facture mensuelle pas encore encaissés
  select coalesce(sum(x.montant), 0), count(*) into v_reste, v_nb
  from prive.paiements_releve(v_compte.id, v_debut, v_fin) x
  where x.mode = 'facture_mensuelle' and x.statut = 'a_encaisser';

  return jsonb_build_object(
    'compte', to_jsonb(v_compte),
    'societe', (select to_jsonb(s) from public.societe s where s.id = 1),
    'mois', to_char(v_debut, 'YYYY-MM'),
    'mois_lisible', prive.mois_lisible(v_debut),
    'debut', v_debut,
    'fin', v_fin,
    'date_releve', v_date,
    'provisoire', v_fin >= v_jour,
    'echeance', v_date + v_compte.delai_paiement_jours,
    'lignes', v_lignes,
    'pourboires', v_tips,
    'tva_par_taux', coalesce((select jsonb_agg(jsonb_build_object('taux', t.taux_tva, 'montant_ht', t.ht, 'montant_tva', t.tva)
                                               order by t.taux_tva)
                              from (select f.taux_tva,
                                           sum(f.montant_ht) - coalesce(sum(av.ht), 0) as ht,
                                           sum(f.montant_tva) - coalesce(sum(av.tva), 0) as tva
                                    from public.factures f
                                    left join lateral (select sum(a.montant_ht) as ht, sum(a.montant_tva) as tva
                                                       from public.avoirs a where a.facture_id = f.id) av on true
                                    where f.compte_pro_id = v_compte.id and f.statut = 'emise'
                                      and f.date_emission between v_debut and v_fin
                                    group by f.taux_tva) t), '[]'::jsonb),
    'totaux', jsonb_build_object(
      'factures_ttc', v_ttc, 'avoirs_ttc', v_av_ttc,
      'montant_ht', v_ht - v_av_ht, 'montant_tva', v_tva - v_av_tva, 'montant_ttc', v_ttc - v_av_ttc,
      'pourboires', v_pourb,
      'total', v_ttc - v_av_ttc + v_pourb, 'reste_a_payer', v_reste, 'deja_regle', v_ttc - v_av_ttc + v_pourb - v_reste,
      'paiements_a_encaisser', v_nb)
  );
end;
$$;

-- 3g. Tableau de bord : les paiements à encaisser mènent au module Finances
--     (lien direct vers la bonne liste), et deux alertes s'ajoutent :
--     espèces gardées par un chauffeur depuis plus de 7 jours, paiements
--     impayés à relancer. Une alerte peut porter son propre « lien ».
create or replace function public.admin_tableau_de_bord()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_jour      date := prive.heure_paris()::date;
  v_mois      date;
  v_param     public.parametres;
  v_societe   public.societe;
  v_alertes   jsonb := '[]'::jsonb;
  v_n         integer;
  v_montant   numeric;
  r           record;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  v_mois := v_jour - (extract(day from v_jour)::integer - 1);        -- 1er jour du mois
  select * into v_param from public.parametres where id = 1;
  select * into v_societe from public.societe where id = 1;

  -- 1. Courses sans chauffeur : personne n'a accepté
  select count(*) into v_n from public.courses c where c.statut = 'a_attribuer';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'urgent', 'module', 'dispatch',
      'titre', case when v_n = 1 then '1 course à attribuer' else v_n || ' courses à attribuer' end,
      'detail', 'Aucun chauffeur n''a accepté : attribuez-la à la main depuis le dispatch.');
  end if;

  -- 2. Réservations des prochaines 24 heures encore sans chauffeur
  select count(*) into v_n from public.courses c
   where c.statut = 'planifiee' and c.chauffeur_id is null and c.prise_en_charge_le < now() + interval '24 hours';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'dispatch',
      'titre', case when v_n = 1 then '1 réservation sans chauffeur dans les 24 h'
                    else v_n || ' réservations sans chauffeur dans les 24 h' end,
      'detail', 'La recherche automatique démarre ' || v_param.recherche_planifiee_avant_min
                || ' min avant l''heure prévue ; vous pouvez attribuer dès maintenant.');
  end if;

  -- 3. Paiements sur place en attente d'encaissement depuis plus de 24 heures
  --    (ceux sur facture mensuelle attendent le relevé : voir 3 bis)
  select count(*) into v_n from public.paiements p
   where p.statut = 'a_encaisser' and p.mode <> 'facture_mensuelle' and p.cree_le < now() - interval '24 hours';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'finances', 'lien', 'finances/?vue=a_encaisser',
      'titre', case when v_n = 1 then '1 paiement à encaisser depuis plus de 24 h'
                    else v_n || ' paiements à encaisser depuis plus de 24 h' end,
      'detail', 'Vérifiez avec le chauffeur, puis confirmez l''encaissement ou déclarez le paiement impayé.');
  end if;

  -- 3 bis. Comptes professionnels en retard de paiement (relevé échu)
  select count(distinct c.compte_pro_id), coalesce(sum(p.montant), 0) into v_n, v_montant
    from public.paiements p
    join public.courses c on c.id = p.course_id
    join public.comptes_pro cp on cp.id = c.compte_pro_id
   where p.statut = 'a_encaisser' and p.mode = 'facture_mensuelle'
     and prive.echeance_releve(p.cree_le, cp.delai_paiement_jours) < v_jour;
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'clients',
      'titre', case when v_n = 1 then '1 compte professionnel en retard de paiement'
                    else v_n || ' comptes professionnels en retard de paiement' end,
      'detail', prive.euros(v_montant) || ' de relevés échus non réglés : relancez l''entreprise, puis encaissez le relevé dans sa fiche.');
  end if;

  -- 3 ter. Espèces gardées par un chauffeur depuis plus de 7 jours
  select count(*), coalesce(sum(e.a_remettre), 0) into v_n, v_montant
    from prive.especes_chauffeurs() e
   where e.a_remettre > 0 and e.depuis_le < now() - interval '7 days';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'finances', 'lien', 'finances/?vue=especes',
      'titre', case when v_n = 1 then '1 chauffeur garde des espèces depuis plus de 7 jours'
                    else v_n || ' chauffeurs gardent des espèces depuis plus de 7 jours' end,
      'detail', prive.euros(v_montant) || ' à remettre au bureau : enregistrez chaque remise quand l''argent vous est donné.');
  end if;

  -- 3 quater. Paiements déclarés impayés, à relancer
  select count(*), coalesce(sum(p.montant), 0) into v_n, v_montant from public.paiements p where p.statut = 'echoue';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'finances', 'lien', 'finances/?vue=impayes',
      'titre', case when v_n = 1 then '1 paiement impayé' else v_n || ' paiements impayés' end,
      'detail', prive.euros(v_montant) || ' à relancer : encaissez-les quand le client règle, ou annulez-les par un avoir.');
  end if;

  -- 4. Candidatures et documents à examiner
  select count(*) into v_n from public.candidatures c where c.statut in ('nouvelle', 'en_cours');
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'chauffeurs',
      'titre', case when v_n = 1 then '1 candidature à examiner' else v_n || ' candidatures à examiner' end,
      'detail', 'Vérifiez les pièces, puis validez ou refusez.');
  end if;
  select count(*) into v_n from public.documents d where d.statut = 'en_attente';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'chauffeurs',
      'titre', case when v_n = 1 then '1 document à vérifier' else v_n || ' documents à vérifier' end,
      'detail', 'Un document validé met à jour les dates d''expiration de la fiche.');
  end if;

  -- 5. Échéances : documents expirés ou expirant dans les 30 jours
  for r in
    select 'chauffeurs' as module, nullif(trim(p.prenom || ' ' || p.nom), '') as qui, 'Carte VTC' as quoi, c.carte_vtc_expiration as fin
      from public.chauffeurs c join public.profils p on p.id = c.id
     where c.statut = 'valide' and c.carte_vtc_expiration <= v_jour + 30
    union all
    select 'chauffeurs', nullif(trim(p.prenom || ' ' || p.nom), ''), 'Permis de conduire', c.permis_expiration
      from public.chauffeurs c join public.profils p on p.id = c.id
     where c.statut = 'valide' and c.permis_expiration <= v_jour + 30
    union all
    select 'flotte', v.immatriculation, 'Assurance', v.assurance_expiration
      from public.vehicules v where v.actif and v.assurance_expiration <= v_jour + 30
    union all
    select 'flotte', v.immatriculation, 'Contrôle technique', v.controle_technique_expiration
      from public.vehicules v where v.actif and v.controle_technique_expiration <= v_jour + 30
    union all
    select 'flotte', v.immatriculation, 'Vignette VTC', v.vignette_vtc_expiration
      from public.vehicules v where v.actif and v.vignette_vtc_expiration <= v_jour + 30
    order by 4
  loop
    v_alertes := v_alertes || jsonb_build_object(
      'niveau', case when r.fin < v_jour then 'urgent' else 'attention' end,
      'module', r.module,
      'titre', r.quoi || ' · ' || coalesce(r.qui, 'sans nom'),
      'detail', case when r.fin < v_jour then 'Expiré depuis le ' || to_char(r.fin, 'DD/MM/YYYY') || '.'
                     else 'Expire le ' || to_char(r.fin, 'DD/MM/YYYY') || '.' end);
  end loop;

  -- 6. Fiches incomplètes qui empêchent de travailler
  for r in
    select nullif(trim(p.prenom || ' ' || p.nom), '') as qui, c.vehicule_id, c.carte_vtc_expiration
      from public.chauffeurs c join public.profils p on p.id = c.id and p.statut = 'actif'
     where c.statut = 'valide' and (c.vehicule_id is null or c.carte_vtc_expiration is null)
     order by p.prenom, p.nom
  loop
    if r.vehicule_id is null then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'chauffeurs',
        'titre', 'Aucun véhicule affecté · ' || coalesce(r.qui, 'sans nom'),
        'detail', 'Sans véhicule, ce chauffeur ne peut ni passer en ligne ni recevoir de course.');
    end if;
    if r.carte_vtc_expiration is null then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'chauffeurs',
        'titre', 'Carte VTC non renseignée · ' || coalesce(r.qui, 'sans nom'),
        'detail', 'Sans carte VTC valide, ce chauffeur ne peut pas passer en ligne.');
    end if;
  end loop;
  for r in select v.immatriculation from public.vehicules v where v.actif and v.assurance_expiration is null order by 1 loop
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'flotte',
      'titre', 'Assurance non renseignée · ' || r.immatriculation,
      'detail', 'Aucun chauffeur ne peut passer en ligne avec ce véhicule.');
  end loop;

  -- 7. Identité de l'entreprise (reprise sur les feuilles de route, factures, bulletins)
  if v_societe.registre_vtc_numero is null then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'parametres',
      'titre', 'Numéro d''inscription au registre VTC manquant',
      'detail', 'Il doit figurer sur chaque feuille de route.');
  end if;
  if v_societe.siret is null or v_societe.code_ape is null or v_societe.tva_intracommunautaire is null
     or v_societe.numero_urssaf is null then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'parametres',
      'titre', 'Identité de l''entreprise à compléter',
      'detail', concat_ws(', ',
                  case when v_societe.siret is null then 'SIRET' end,
                  case when v_societe.code_ape is null then 'code APE' end,
                  case when v_societe.tva_intracommunautaire is null then 'TVA intracommunautaire' end,
                  case when v_societe.numero_urssaf is null then 'n° URSSAF' end)
                || ' : repris sur les factures et les bulletins de paie.');
  end if;
  -- Coordonnées bancaires : imprimées sur les relevés, dès qu'un compte pro existe
  if (v_societe.iban is null or v_societe.bic is null)
     and exists (select 1 from public.comptes_pro cp where cp.statut = 'actif') then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'parametres',
      'titre', 'IBAN et BIC de l''entreprise à saisir',
      'detail', 'Ils figurent sur les relevés mensuels des comptes professionnels, pour le règlement par virement.');
  end if;

  -- 8. Montants encore à fixer dans le tarif en vigueur
  for r in
    select cat.nom_fr, t.frais_annulation, t.prix_heure_mad
      from public.categories cat
      cross join lateral prive.tarif_en_vigueur(cat.id, v_jour) t
     where cat.active and t.id is not null
     order by cat.ordre, cat.nom_fr
  loop
    if r.frais_annulation = 0 then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'tarifs',
        'titre', 'Frais d''annulation à 0 € · ' || r.nom_fr,
        'detail', 'Fixez le montant prévu par vos conditions de vente (après acceptation du chauffeur).');
    end if;
    if r.prix_heure_mad is null then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'tarifs',
        'titre', 'Mise à disposition non tarifée · ' || r.nom_fr,
        'detail', 'Fixez le prix de l''heure pour la proposer aux clients.');
    end if;
  end loop;

  -- 9. Messages reçus : support, formulaire de contact, demandes de devis
  select count(*) into v_n from public.demandes d where d.statut in ('ouverte', 'en_cours');
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'support',
      'titre', case when v_n = 1 then '1 demande au support en attente' else v_n || ' demandes au support en attente' end,
      'detail', 'Clients ou chauffeurs attendent une réponse.');
  end if;
  select count(*) into v_n from public.messages_contact m where not m.traite;
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'support',
      'titre', case when v_n = 1 then '1 message du formulaire de contact' else v_n || ' messages du formulaire de contact' end,
      'detail', 'Envoyés depuis le site, à traiter.');
  end if;
  select count(*) into v_n from public.demandes_devis d where d.statut = 'nouvelle';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'support',
      'titre', case when v_n = 1 then '1 demande de devis' else v_n || ' demandes de devis' end,
      'detail', 'Longues distances, mise à disposition et autres services.');
  end if;

  return jsonb_build_object(
    'maintenant', now(),
    'jour',       (select to_jsonb(x) from prive.chiffres_periode(prive.debut_jour_paris(v_jour), prive.debut_jour_paris(v_jour + 1)) x),
    'sept_jours', (select to_jsonb(x) from prive.chiffres_periode(prive.debut_jour_paris(v_jour - 6), prive.debut_jour_paris(v_jour + 1)) x),
    'mois',       (select to_jsonb(x) from prive.chiffres_periode(prive.debut_jour_paris(v_mois), prive.debut_jour_paris(v_jour + 1)) x),
    'statuts',    (select coalesce(jsonb_object_agg(s.statut, s.n), '{}'::jsonb)
                   from (select c.statut, count(*)::integer as n from public.courses c
                         where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')
                         group by c.statut) s),
    'chauffeurs', jsonb_build_object(
                    'valides',  (select count(*) from public.chauffeurs c
                                 join public.profils p on p.id = c.id and p.statut = 'actif'
                                 where c.statut = 'valide'),
                    'en_ligne', (select count(*) from public.positions po
                                 join public.chauffeurs c on c.id = po.chauffeur_id and c.statut = 'valide'
                                 where po.en_ligne and po.maj_le > now() - interval '3 minutes'),
                    'occupes',  (select count(distinct x.chauffeur_id) from public.courses x
                                 where x.statut in ('acceptee', 'arrivee', 'en_cours'))),
    'serie',      (select jsonb_agg(jsonb_build_object('jour', s.jour, 'courses', x.courses_terminees,
                                                       'chiffre_affaires', x.chiffre_affaires) order by s.jour)
                   from (select v_jour - k as jour from generate_series(0, 13) as k) s
                   cross join lateral prive.chiffres_periode(prive.debut_jour_paris(s.jour), prive.debut_jour_paris(s.jour + 1)) x),
    'alertes',    v_alertes
  );
end;
$$;


-- #############################################################################
-- DROITS D'EXÉCUTION (fonctions recréées de la section 3)
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout, puis on n'accorde que l'utile. Les fonctions
-- remplacées par « create or replace » gardent leurs droits.
revoke all on function
  public.confirmer_encaissement(uuid, boolean),
  public.rembourser(uuid, numeric, text, text)
  from public, anon;

grant execute on function
  public.confirmer_encaissement(uuid, boolean),
  public.rembourser(uuid, numeric, text, text)
  to authenticated;
