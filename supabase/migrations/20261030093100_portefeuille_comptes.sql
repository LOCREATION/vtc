-- =============================================================================
-- LOC RÉACTION S.A.S — Version 2 — migration 32 (portefeuille, partie 3 sur 3)
-- Compte supprimé et données personnelles : les recharges du portefeuille
-- -----------------------------------------------------------------------------
-- Suite des migrations 30 et 31 (20261030092900_portefeuille_recharges.sql
-- décrit l'ensemble) : une recharge payée est une pièce comptable, gardée à la
-- suppression du compte ; le client ne supprime pas son compte tant qu'une
-- somme reste à régler ou qu'une recharge attend la réponse de Mollie ;
-- l'export de ses données contient ses recharges.
-- Fonctions existantes redéfinies (create or replace) : leurs droits ne
-- changent pas.
-- =============================================================================


-- #############################################################################
-- 1. COMPTE SUPPRIMÉ ET DONNÉES PERSONNELLES : recharges gardées et exportées
-- #############################################################################

-- 1a. Suppression par l'administration : une recharge est une pièce
--      comptable (le compte est archivé, sans ses coordonnées)
-- (reprise de 20261030092700_suppressions_admin.sql, modifiée)
create or replace function prive.supprimer_compte(p_profil uuid, p_par text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil    public.profils;
  v_numero    text;
  v_garder    boolean;
  v_mode      text := 'efface';
  v_courses   integer := 0;
  v_solde     numeric := 0;
  v_salarie   boolean;
  v_dossier   boolean;
  v_ids       text[];
  v_candidatures text[];
  v_cles_profil      constant text[] := array['prenom', 'nom', 'email', 'telephone', 'photo_chemin'];
  v_cles_client      constant text[] := array['client_prenom', 'client_telephone', 'depart_precision',
                                              'beneficiaire_nom', 'beneficiaire_telephone'];
  v_cles_chauffeur   constant text[] := array['chauffeur_prenom', 'chauffeur_telephone', 'chauffeur_photo'];
  v_cles_fiche       constant text[] := array['carte_vtc_numero', 'permis_numero', 'filtre_destination_lat', 'filtre_destination_lng'];
  v_cles_document    constant text[] := array['numero', 'commentaire', 'fichier_chemin'];
  v_cles_candidature constant text[] := array['ville', 'experience', 'message', 'motif_refus'];
begin
  select * into v_profil from public.profils p where p.id = p_profil for update;
  if v_profil.id is null or v_profil.statut = 'supprime' then
    raise exception 'Compte introuvable.';
  end if;

  -- 1. Course en cours ou à venir : à annuler ou à retirer d'abord
  select c.numero into v_numero from public.courses c
   where c.client_id = p_profil and c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')
   order by c.cree_le limit 1;
  if v_numero is not null then
    raise exception 'La course % de ce compte est en cours ou à venir : annulez-la d''abord (module Courses).', v_numero;
  end if;
  select c.numero into v_numero from public.courses c
   where c.chauffeur_id = p_profil and c.statut in ('planifiee', 'acceptee', 'arrivee', 'en_cours')
   order by c.cree_le limit 1;
  if v_numero is not null then
    raise exception 'La course % est confiée à ce chauffeur : retirez-la-lui d''abord (module Courses).', v_numero;
  end if;

  -- 2. Pièces que la loi impose de garder
  v_salarie := exists (select 1 from public.salaries s where s.profil_id = p_profil);
  v_garder := exists (select 1 from public.courses c where c.client_id = p_profil or c.chauffeur_id = p_profil)
           or exists (select 1 from public.paiements pa
                       where pa.client_id = p_profil or pa.especes_chauffeur_id = p_profil or pa.encaisse_par = p_profil)
           or exists (select 1 from public.factures f where f.client_id = p_profil)
           or exists (select 1 from public.avoirs a where a.client_id = p_profil)
           or exists (select 1 from public.demandes d where d.auteur_id = p_profil)
           or exists (select 1 from public.remises_especes r where r.chauffeur_id = p_profil)
           or exists (select 1 from public.releves_plateformes r where r.chauffeur_id = p_profil)
           or exists (select 1 from public.recharges rc where rc.client_id = p_profil)
           or v_salarie;
  select count(*) into v_courses from public.courses c where c.client_id = p_profil or c.chauffeur_id = p_profil;
  v_solde := coalesce((select s.montant from public.soldes s where s.profil_id = p_profil), 0);

  -- Lignes dont le journal perd les coordonnées et numéros (avant effacement)
  v_ids := array(select d.id::text from public.documents d where d.chauffeur_id = p_profil);
  v_candidatures := array(select ca.id::text from public.candidatures ca where ca.profil_id = p_profil);

  -- 3. Effacé dans tous les cas. L'adhésion aux comptes pro part en premier :
  --    son retrait écrit une notification, effacée juste après.
  delete from public.comptes_pro_membres where profil_id = p_profil;
  delete from public.lieux where client_id = p_profil;
  delete from public.proches where client_id = p_profil;
  delete from public.appareils where profil_id = p_profil;
  delete from public.notes_internes where profil_id = p_profil;
  delete from public.evaluations e where e.cible_id = p_profil;
  delete from public.messages m using public.courses c
   where m.course_id = c.id and (c.client_id = p_profil or c.chauffeur_id = p_profil);
  delete from public.notifications where destinataire_id = p_profil;
  delete from public.propositions where chauffeur_id = p_profil;
  delete from public.positions where chauffeur_id = p_profil;
  delete from public.documents where chauffeur_id = p_profil;          -- fichiers mis en file
  delete from public.candidatures where profil_id = p_profil;
  delete from public.parrainages where parrain_id = p_profil or filleul_id = p_profil;
  update public.objets_trouves set declare_par = null where declare_par = p_profil;
  perform prive.journal_sans('documents', v_ids, v_cles_document);
  perform prive.journal_sans('candidatures', v_candidatures, v_cles_candidature);

  -- 4. Rien à garder : le compte entier part (profil, dossier chauffeur,
  --    solde et écritures en cascade). Encore cité ailleurs (ancien
  --    administrateur, par exemple) : fiche vidée, comme ci-dessous.
  if not v_garder then
    begin
      delete from auth.users where id = p_profil;
    exception when foreign_key_violation then
      v_mode := 'archive';
    end;
  else
    v_mode := 'archive';
  end if;

  if v_mode = 'archive' then
    -- Courses : coordonnées effacées, trajets et montants gardés
    update public.courses c
       set client_prenom = null, client_telephone = null, depart_precision = null,
           beneficiaire_nom = case when c.pour_proche then 'Proche' end, beneficiaire_telephone = null
     where c.client_id = p_profil;
    update public.courses c
       set chauffeur_prenom = null, chauffeur_telephone = null, chauffeur_photo = null
     where c.chauffeur_id = p_profil;

    -- Dossier chauffeur : jamais validé et sans course, il part ; sinon vidé
    -- et « supprimé » (il tient l'historique de ses courses)
    v_dossier := exists (select 1 from public.chauffeurs ch where ch.id = p_profil);
    if v_dossier then
      if exists (select 1 from public.chauffeurs ch where ch.id = p_profil and ch.statut in ('candidat', 'refuse'))
         and not exists (select 1 from public.courses c where c.chauffeur_id = p_profil)
         and not exists (select 1 from public.paiements pa where pa.especes_chauffeur_id = p_profil)
         and not exists (select 1 from public.remises_especes r where r.chauffeur_id = p_profil)
         and not exists (select 1 from public.releves_plateformes r where r.chauffeur_id = p_profil) then
        delete from public.chauffeurs where id = p_profil;
      else
        update public.chauffeurs
           set statut = 'supprime', vehicule_id = null,
               carte_vtc_numero = null, carte_vtc_expiration = null,
               permis_numero = null, permis_expiration = null,
               filtre_destination_actif = false, filtre_destination_lat = null, filtre_destination_lng = null,
               note_moyenne = null, nb_notes = 0
         where id = p_profil;
      end if;
    end if;

    -- Solde restant : abandonné, avec son écriture
    if v_solde > 0 then
      perform prive.ecrire_solde(p_profil, -v_solde, 'Compte supprimé : solde abandonné', null);
    end if;

    -- Profil vidé, puis « supprimé » (le journal des statuts ne garde ainsi
    -- aucune coordonnée)
    update public.profils
       set prenom = '', nom = '', email = null, telephone = null, photo_chemin = null,
           notif_email = false, notif_whatsapp = false, notif_push = false,
           code_parrainage = prive.nouveau_code_parrainage()
     where id = p_profil;
    update public.profils set statut = 'supprime' where id = p_profil;

    -- Connexion : sessions fermées partout, identifiants effacés, accès
    -- bloqué (une date lointaine : le service de connexion ne lit pas
    -- « infinity »)
    delete from auth.sessions where user_id = p_profil;
    delete from auth.refresh_tokens where user_id = p_profil::text;
    delete from auth.one_time_tokens where user_id = p_profil;
    delete from auth.mfa_factors where user_id = p_profil;
    delete from auth.identities where user_id = p_profil;
    update auth.users
       set email = null, phone = null, encrypted_password = null,
           email_change = '', email_change_token_new = '', email_change_token_current = '',
           phone_change = '', phone_change_token = '', confirmation_token = '', recovery_token = '',
           reauthentication_token = '', raw_user_meta_data = '{}'::jsonb,
           banned_until = '2999-12-31 00:00:00+00', deleted_at = now()
     where id = p_profil;

    -- Journal : coordonnées des courses effacées aussi
    perform prive.journal_sans('courses',
      array(select c.id::text from public.courses c where c.client_id = p_profil), v_cles_client);
    perform prive.journal_sans('courses',
      array(select c.id::text from public.courses c where c.chauffeur_id = p_profil), v_cles_chauffeur);
  end if;

  -- 5. Journal : coordonnées du profil et numéros du dossier chauffeur
  perform prive.journal_sans('profils', array[p_profil::text], v_cles_profil);
  perform prive.journal_sans('chauffeurs', array[p_profil::text], v_cles_fiche);

  -- 6. Trace de la suppression, sans coordonnées
  perform prive.journaliser_action('suppression_compte', 'profils', p_profil::text,
    jsonb_build_object('par', p_par, 'mode', v_mode, 'role', v_profil.role,
                       'courses_gardees', case when v_mode = 'archive' then v_courses else 0 end,
                       'solde_abandonne', case when v_mode = 'archive' then v_solde else 0 end,
                       'dossier_paie_garde', v_salarie));
  return jsonb_build_object('mode', v_mode, 'courses_gardees', case when v_mode = 'archive' then v_courses else 0 end,
                            'solde_abandonne', case when v_mode = 'archive' then v_solde else 0 end,
                            'dossier_paie_garde', v_salarie);
end;
$$;
-- 1b. Suppression par le client : pas tant qu'une somme reste à régler par
--      le portefeuille ou par virement, ni pendant une recharge en cours
-- (reprise de 20261030092600_donnees_personnelles.sql, modifiée)
create or replace function public.supprimer_mon_compte(p_confirmation text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_moi      uuid := auth.uid();
  v_profil   public.profils;
  v_solde    numeric := 0;
  v_courses  integer := 0;
begin
  select * into v_profil from public.profils p where p.id = v_moi for update;
  if v_profil.id is null or v_profil.statut = 'supprime' then
    raise exception 'Compte introuvable.';
  end if;
  if v_profil.role <> 'client' then
    raise exception 'La suppression en ligne est réservée aux comptes clients : écrivez à LOC RÉACTION pour fermer ce compte.';
  end if;
  if upper(trim(coalesce(p_confirmation, ''))) not in ('SUPPRIMER', 'DELETE') then
    raise exception 'Pour confirmer, écrivez SUPPRIMER.';
  end if;
  if exists (select 1 from public.courses c
             where c.client_id = v_moi and c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')) then
    raise exception 'Une course est en cours ou à venir : annulez-la, ou attendez qu''elle soit terminée, avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.paiements pa where pa.client_id = v_moi and pa.statut = 'echoue') then
    raise exception 'Un paiement est signalé non réglé : écrivez à LOC RÉACTION avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.paiements pa
             where pa.client_id = v_moi and pa.statut = 'a_encaisser' and pa.mode in ('solde', 'virement')) then
    raise exception 'Une somme reste à régler (portefeuille ou virement) : réglez-la avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.recharges r
             where r.client_id = v_moi and r.statut = 'ouverte' and r.cree_le > now() - interval '24 hours') then
    raise exception 'Une recharge de votre portefeuille attend la réponse de Mollie : attendez son résultat avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.chauffeurs ch where ch.id = v_moi)
     or exists (select 1 from public.candidatures ca where ca.profil_id = v_moi) then
    raise exception 'Un dossier chauffeur est ouvert à votre nom : écrivez à LOC RÉACTION, qui le fermera avec votre compte et vos documents.';
  end if;

  v_solde := coalesce((select s.montant from public.soldes s where s.profil_id = v_moi), 0);
  select count(*) into v_courses from public.courses c where c.client_id = v_moi;

  -- 1. Données effacées. L'adhésion aux comptes professionnels part en
  --    premier : son retrait écrit une notification, effacée juste après.
  delete from public.comptes_pro_membres where profil_id = v_moi;
  delete from public.lieux where client_id = v_moi;
  delete from public.proches where client_id = v_moi;
  delete from public.appareils where profil_id = v_moi;
  delete from public.notes_internes where profil_id = v_moi;
  delete from public.evaluations e where e.cible_id = v_moi;
  delete from public.messages m using public.courses c where m.course_id = c.id and c.client_id = v_moi;
  delete from public.notifications where destinataire_id = v_moi;

  -- 2. Courses : les coordonnées s'effacent, le trajet et les montants restent
  update public.courses c
     set client_prenom = null, client_telephone = null, depart_precision = null,
         beneficiaire_nom = case when c.pour_proche then 'Proche' end, beneficiaire_telephone = null
   where c.client_id = v_moi;

  -- 3. Solde restant : abandonné, avec son écriture
  if v_solde > 0 then
    perform prive.ecrire_solde(v_moi, -v_solde, 'Compte supprimé : solde abandonné', null);
  end if;

  -- 4. Profil anonymisé, puis marqué « supprimé » : le journal des statuts ne
  --    garde ainsi aucune coordonnée
  update public.profils
     set prenom = '', nom = '', email = null, telephone = null, photo_chemin = null,
         notif_email = false, notif_whatsapp = false, notif_push = false,
         code_parrainage = prive.nouveau_code_parrainage()
   where id = v_moi;
  update public.profils set statut = 'supprime' where id = v_moi;

  -- 5. Journal des modifications : les coordonnées déjà inscrites s'effacent
  --    (corrections de l'administration sur le profil et sur les courses)
  update prive.journal j
     set avant = j.avant - array['prenom', 'nom', 'email', 'telephone'],
         apres = j.apres - array['prenom', 'nom', 'email', 'telephone']
   where j.table_cible = 'profils' and j.ligne_id = v_moi::text;
  update prive.journal j
     set avant = j.avant - array['client_prenom', 'client_telephone', 'depart_precision', 'beneficiaire_nom', 'beneficiaire_telephone'],
         apres = j.apres - array['client_prenom', 'client_telephone', 'depart_precision', 'beneficiaire_nom', 'beneficiaire_telephone']
   where j.table_cible = 'courses'
     and j.ligne_id in (select c.id::text from public.courses c where c.client_id = v_moi);

  -- 6. Connexion : sessions fermées partout, identifiants effacés, accès
  --    bloqué. Une date lointaine plutôt que « infinity », que le service de
  --    connexion ne sait pas lire.
  delete from auth.sessions where user_id = v_moi;
  delete from auth.refresh_tokens where user_id = v_moi::text;
  delete from auth.one_time_tokens where user_id = v_moi;
  delete from auth.mfa_factors where user_id = v_moi;
  delete from auth.identities where user_id = v_moi;
  update auth.users
     set email = null, phone = null, encrypted_password = null,
         email_change = '', email_change_token_new = '', email_change_token_current = '',
         phone_change = '', phone_change_token = '', confirmation_token = '', recovery_token = '',
         reauthentication_token = '', raw_user_meta_data = '{}'::jsonb,
         banned_until = '2999-12-31 00:00:00+00', deleted_at = now()
   where id = v_moi;

  -- 7. Trace de la suppression, sans coordonnées
  perform prive.journaliser_action('suppression_compte', 'profils', v_moi::text,
    jsonb_build_object('par', 'client', 'courses_gardees', v_courses, 'solde_abandonne', v_solde));
  return jsonb_build_object('supprime', true, 'courses_gardees', v_courses, 'solde_abandonne', v_solde);
end;
$$;
-- 1c. Export des données : les recharges du portefeuille en plus
-- (reprise de 20261030092600_donnees_personnelles.sql, modifiée)
create or replace function public.mes_donnees()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_moi    uuid := auth.uid();
  v_profil public.profils;
begin
  select * into v_profil from public.profils p where p.id = v_moi;
  if v_profil.id is null or v_profil.statut = 'supprime' then
    raise exception 'Compte introuvable.';
  end if;
  if v_profil.role <> 'client' then
    raise exception 'Le téléchargement en ligne est réservé aux comptes clients : écrivez à LOC RÉACTION pour recevoir vos données.';
  end if;

  return jsonb_build_object(
    'a_propos', jsonb_build_object(
      'document', 'Données personnelles d''un compte client LOC RÉACTION',
      'genere_le', now(),
      'responsable_du_traitement', (select jsonb_strip_nulls(jsonb_build_object(
                                      'raison_sociale', s.raison_sociale,
                                      'adresse', nullif(concat_ws(' ', s.adresse, s.code_postal, s.ville), ''),
                                      'email', s.email, 'telephone', s.telephone))
                                    from public.societe s where s.id = 1),
      'contenu', 'Profil, connexion, lieux, proches, courses (arrêts compris), paiements, remboursements, factures, avoirs, '
                 || 'notes données et reçues, conversations des courses, demandes au support, notifications, solde, écritures et recharges du portefeuille, '
                 || 'parrainages, codes promo utilisés, comptes professionnels, appareils, notes de LOC RÉACTION.'),

    'profil', jsonb_build_object(
      'prenom', v_profil.prenom, 'nom', v_profil.nom, 'email', v_profil.email, 'telephone', v_profil.telephone,
      'langue', v_profil.langue, 'code_parrainage', v_profil.code_parrainage, 'statut', v_profil.statut,
      'notifications', jsonb_build_object('email', v_profil.notif_email, 'whatsapp', v_profil.notif_whatsapp,
                                          'application', v_profil.notif_push),
      'cree_le', v_profil.cree_le, 'maj_le', v_profil.maj_le),

    'connexion', (select jsonb_build_object('email', u.email, 'telephone', u.phone, 'email_confirme_le', u.email_confirmed_at,
                                            'derniere_connexion', u.last_sign_in_at, 'cree_le', u.created_at)
                  from auth.users u where u.id = v_moi),

    'lieux', coalesce((select jsonb_agg(jsonb_build_object(
               'type', l.type, 'libelle', l.libelle, 'adresse', l.adresse, 'latitude', l.latitude, 'longitude', l.longitude,
               'precision', l.precision, 'cree_le', l.cree_le) order by l.cree_le)
             from public.lieux l where l.client_id = v_moi), '[]'::jsonb),

    'proches', coalesce((select jsonb_agg(jsonb_build_object(
                 'nom', pr.nom, 'telephone', pr.telephone, 'relation', pr.relation, 'cree_le', pr.cree_le) order by pr.cree_le)
               from public.proches pr where pr.client_id = v_moi), '[]'::jsonb),

    'courses', coalesce((select jsonb_agg(jsonb_build_object(
                 'numero', c.numero, 'type', c.type, 'statut', c.statut, 'categorie', cat.nom_fr,
                 'chauffeuse_demandee', c.option_chauffeuse,
                 'pour_un_proche', c.pour_proche, 'proche_nom', c.beneficiaire_nom, 'proche_telephone', c.beneficiaire_telephone,
                 'depart', c.depart_adresse, 'depart_precision', c.depart_precision, 'arrivee', c.arrivee_adresse,
                 'arrets', coalesce((select jsonb_agg(a.adresse order by a.ordre) from public.course_arrets a where a.course_id = c.id),
                                    '[]'::jsonb),
                 'prise_en_charge_le', c.prise_en_charge_le, 'numero_vol', c.numero_vol, 'terminal', c.terminal,
                 'mise_a_disposition_heures', c.duree_mad_heures, 'distance_km', c.distance_km, 'duree_min', c.duree_min,
                 'prix_total', c.prix_total, 'remise', c.remise, 'attente_min', c.attente_min, 'frais_attente', c.frais_attente,
                 'frais_annulation', c.frais_annulation, 'pourboire', c.pourboire, 'mode_paiement', c.mode_paiement,
                 'compte_professionnel', cp.raison_sociale,
                 'chauffeur_prenom', c.chauffeur_prenom,
                 'vehicule', nullif(concat_ws(' ', c.vehicule_libelle, c.vehicule_couleur), ''),
                 'immatriculation', c.vehicule_immatriculation,
                 'commandee_le', c.cree_le, 'acceptee_le', c.acceptee_le, 'terminee_le', c.terminee_le,
                 'annulee_le', c.annulee_le, 'annulee_par', c.annulee_par, 'motif_annulation', c.motif_annulation)
               order by c.cree_le)
               from public.courses c
               left join public.categories cat on cat.id = c.categorie_id
               left join public.comptes_pro cp on cp.id = c.compte_pro_id
               where c.client_id = v_moi), '[]'::jsonb),

    'paiements', coalesce((select jsonb_agg(jsonb_build_object(
                   'course', c.numero, 'nature', pa.nature, 'mode', pa.mode, 'montant', pa.montant, 'statut', pa.statut,
                   'encaisse_le', pa.encaisse_le, 'cree_le', pa.cree_le) order by pa.cree_le)
                 from public.paiements pa join public.courses c on c.id = pa.course_id
                 where pa.client_id = v_moi), '[]'::jsonb),

    'remboursements', coalesce((select jsonb_agg(jsonb_build_object(
                        'course', c.numero, 'montant', r.montant, 'mode', r.mode, 'motif', r.motif, 'cree_le', r.cree_le)
                      order by r.cree_le)
                      from public.remboursements r
                      join public.paiements pa on pa.id = r.paiement_id
                      join public.courses c on c.id = pa.course_id
                      where pa.client_id = v_moi), '[]'::jsonb),

    'factures', coalesce((select jsonb_agg(jsonb_build_object(
                  'numero', f.numero, 'nature', f.nature, 'course', c.numero, 'date_emission', f.date_emission,
                  'destinataire_nom', f.destinataire_nom, 'destinataire_adresse', f.destinataire_adresse,
                  'montant_ht', f.montant_ht, 'taux_tva', f.taux_tva, 'montant_tva', f.montant_tva, 'montant_ttc', f.montant_ttc,
                  'pourboire', f.pourboire, 'statut', f.statut) order by f.numero)
                from public.factures f join public.courses c on c.id = f.course_id
                where f.client_id = v_moi), '[]'::jsonb),

    'avoirs', coalesce((select jsonb_agg(jsonb_build_object(
                'numero', av.numero, 'facture', f.numero, 'date_emission', av.date_emission, 'motif', av.motif,
                'montant_ht', av.montant_ht, 'montant_tva', av.montant_tva, 'montant_ttc', av.montant_ttc) order by av.numero)
              from public.avoirs av join public.factures f on f.id = av.facture_id
              where av.client_id = v_moi), '[]'::jsonb),

    'notes_donnees', coalesce((select jsonb_agg(jsonb_build_object(
                       'course', c.numero, 'note', e.note, 'commentaire', e.commentaire, 'cree_le', e.cree_le) order by e.cree_le)
                     from public.evaluations e join public.courses c on c.id = e.course_id
                     where e.auteur_id = v_moi), '[]'::jsonb),

    'notes_recues', coalesce((select jsonb_agg(jsonb_build_object(
                      'course', c.numero, 'note', e.note, 'cree_le', e.cree_le) order by e.cree_le)
                    from public.evaluations e join public.courses c on c.id = e.course_id
                    where e.cible_id = v_moi), '[]'::jsonb),

    'conversations_courses', coalesce((select jsonb_agg(jsonb_build_object(
                               'course', c.numero, 'de', case when m.auteur_id = v_moi then 'vous' else 'chauffeur' end,
                               'message', m.contenu, 'cree_le', m.cree_le) order by m.cree_le)
                             from public.messages m join public.courses c on c.id = m.course_id
                             where c.client_id = v_moi), '[]'::jsonb),

    'demandes_support', coalesce((select jsonb_agg(jsonb_build_object(
                          'numero', d.numero, 'type', d.type, 'sujet', d.sujet, 'statut', d.statut,
                          'course', (select c.numero from public.courses c where c.id = d.course_id),
                          'cree_le', d.cree_le, 'cloturee_le', d.cloturee_le,
                          'messages', coalesce((select jsonb_agg(jsonb_build_object(
                                        'de', case when m.auteur_id = v_moi then 'vous' else 'LOC RÉACTION' end,
                                        'message', m.contenu,
                                        'piece_jointe', substring(m.piece_jointe_chemin from '[^/]+$'),
                                        'cree_le', m.cree_le) order by m.cree_le)
                                      from public.messages m where m.demande_id = d.id), '[]'::jsonb))
                        order by d.cree_le)
                        from public.demandes d where d.auteur_id = v_moi), '[]'::jsonb),

    'notifications', coalesce((select jsonb_agg(jsonb_build_object(
                       'titre', n.titre, 'message', n.message, 'lue_le', n.lu_le, 'cree_le', n.cree_le) order by n.cree_le)
                     from public.notifications n where n.destinataire_id = v_moi), '[]'::jsonb),

    'solde', jsonb_build_object(
      'montant', coalesce((select so.montant from public.soldes so where so.profil_id = v_moi), 0),
      'ecritures', coalesce((select jsonb_agg(jsonb_build_object(
                     'montant', es.montant, 'motif', es.motif,
                     'course', (select c.numero from public.courses c where c.id = es.course_id),
                     'cree_le', es.cree_le) order by es.cree_le)
                   from public.ecritures_solde es where es.profil_id = v_moi), '[]'::jsonb),
      'recharges', coalesce((select jsonb_agg(jsonb_build_object(
                     'numero', r.numero, 'montant', r.montant, 'statut', r.statut, 'moyen', r.methode,
                     'cree_le', r.cree_le, 'payee_le', r.payee_le) order by r.cree_le)
                   from public.recharges r where r.client_id = v_moi), '[]'::jsonb)),

    'parrainages', coalesce((select jsonb_agg(jsonb_build_object(
                     'vous_etes', case when pa.parrain_id = v_moi then 'parrain' else 'filleul' end,
                     'statut', pa.statut,
                     'recompense', case when pa.parrain_id = v_moi then pa.recompense_parrain else pa.recompense_filleul end,
                     'cree_le', pa.cree_le, 'valide_le', pa.valide_le) order by pa.cree_le)
                   from public.parrainages pa where v_moi in (pa.parrain_id, pa.filleul_id)), '[]'::jsonb),

    'codes_promo_utilises', coalesce((select jsonb_agg(jsonb_build_object(
                              'code', cpr.code, 'remise', u.remise,
                              'course', (select c.numero from public.courses c where c.id = u.course_id),
                              'cree_le', u.cree_le) order by u.cree_le)
                            from public.utilisations_promo u join public.codes_promo cpr on cpr.id = u.code_promo_id
                            where u.client_id = v_moi), '[]'::jsonb),

    'comptes_professionnels', coalesce((select jsonb_agg(jsonb_build_object(
                                'raison_sociale', cp.raison_sociale, 'role', m.role, 'depuis', m.cree_le) order by m.cree_le)
                              from public.comptes_pro_membres m join public.comptes_pro cp on cp.id = m.compte_pro_id
                              where m.profil_id = v_moi), '[]'::jsonb),

    'appareils', coalesce((select jsonb_agg(jsonb_build_object(
                   'appareil', ap.agent, 'ajoute_le', ap.cree_le, 'vu_le', ap.vu_le) order by ap.cree_le)
                 from public.appareils ap where ap.profil_id = v_moi), '[]'::jsonb),

    'notes_de_loc_reaction', coalesce((select jsonb_agg(jsonb_build_object(
                               'note', ni.texte, 'cree_le', ni.cree_le) order by ni.cree_le)
                             from public.notes_internes ni where ni.profil_id = v_moi), '[]'::jsonb)
  );
end;
$$;
