-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 27 : DONNÉES PERSONNELLES (ESPACE CLIENT)
-- -----------------------------------------------------------------------------
-- Droits du client sur ses données (RGPD), depuis l'onglet Compte :
--   1. mes_donnees : toutes ses données en un seul fichier (JSON), lisible et
--      réutilisable (droit d'accès et droit à la portabilité) ; les données
--      des autres personnes (nom des filleuls, identité des chauffeurs au-delà
--      du prénom affiché à la course) n'y figurent pas.
--   2. supprimer_mon_compte : suppression du compte par le client lui-même,
--      après avoir écrit SUPPRIMER (DELETE en anglais).
--        - Refusée tant qu'une course est en cours ou à venir, qu'un paiement
--          est signalé non réglé, ou qu'un dossier chauffeur est ouvert à son
--          nom (LOC RÉACTION le ferme, avec ses documents).
--        - Effacé : identité et coordonnées du profil, lieux, proches,
--          appareils, notifications, conversations de ses courses, notes des
--          chauffeurs sur lui, notes internes de l'administration, adhésion
--          aux comptes professionnels ; sur ses courses : prénom et téléphone
--          transmis au chauffeur, précision du point de prise en charge,
--          téléphone du proche (son nom devient « Proche ») ; ces mêmes
--          coordonnées dans le journal des modifications.
--        - Gardé, sans coordonnées (obligation comptable de 10 ans, Code de
--          commerce art. L123-22) : courses (trajets, montants, dates),
--          paiements, remboursements, factures et avoirs (une facture émise
--          ne change plus), solde et écritures, parrainages, codes promo
--          utilisés ; ses notes données aux chauffeurs ; ses demandes au
--          support (litiges éventuels).
--        - Solde restant : abandonné, avec son écriture « Compte supprimé ».
--        - Connexion : sessions fermées sur tous les appareils, adresse et
--          téléphone de connexion effacés, accès bloqué (auth.users) ; la
--          même adresse peut ouvrir plus tard un nouveau compte.
--        - Profil marqué « supprimé » (nouveau statut) ; journal : action
--          « suppression_compte », sans coordonnées.
--   3. Administration : un compte supprimé ne se bloque ni ne se réactive
--      (admin_statut_client) ; la liste des clients le met à part : filtre
--      « Supprimés », absent de « Tous » et des chiffres (admin_lister_clients).
-- Contrainte « courses_proche » assouplie : le téléphone du proche peut être
-- effacé (compte supprimé) ; commander_course l'exige toujours à la commande.
-- =============================================================================


-- #############################################################################
-- 1. STATUT « SUPPRIMÉ », TÉLÉPHONE DU PROCHE EFFAÇABLE
-- #############################################################################
alter table public.profils drop constraint profils_statut_check;
alter table public.profils add constraint profils_statut_check check (statut in ('actif', 'bloque', 'supprime'));

alter table public.courses drop constraint courses_proche;
alter table public.courses add constraint courses_proche check (not pour_proche or beneficiaire_nom is not null);


-- #############################################################################
-- 2. TÉLÉCHARGER MES DONNÉES
-- #############################################################################
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
                 || 'notes données et reçues, conversations des courses, demandes au support, notifications, solde et écritures, '
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
                   from public.ecritures_solde es where es.profil_id = v_moi), '[]'::jsonb)),

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

comment on function public.mes_donnees() is
  'Données personnelles du client connecté, en un seul document (droit d''accès et à la portabilité).';


-- #############################################################################
-- 3. SUPPRIMER MON COMPTE
-- #############################################################################
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

comment on function public.supprimer_mon_compte(text) is
  'Suppression du compte client par lui-même : coordonnées effacées, comptabilité gardée sans coordonnées, connexion fermée.';

revoke all on function public.mes_donnees() from public, anon;
revoke all on function public.supprimer_mon_compte(text) from public, anon;
grant execute on function public.mes_donnees(), public.supprimer_mon_compte(text) to authenticated;


-- #############################################################################
-- 4. ADMINISTRATION : COMPTE SUPPRIMÉ À PART
-- #############################################################################
-- 4a. Bloquer ou débloquer : jamais un compte supprimé (reprend la version de
--     la migration 12, avec ce seul contrôle en plus).
create or replace function public.admin_statut_client(
  p_profil uuid, p_statut text, p_motif text default null, p_annuler_reservations boolean default false
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil   public.profils;
  v_motif    text := nullif(left(trim(coalesce(p_motif, '')), 500), '');
  v_course   record;
  v_annulees integer := 0;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut is null or p_statut not in ('actif', 'bloque') then
    raise exception 'Statut inconnu.';
  end if;
  select * into v_profil from public.profils p where p.id = p_profil for update;
  if v_profil.id is null then
    raise exception 'Compte introuvable.';
  end if;
  if v_profil.id = auth.uid() then
    raise exception 'Vous ne pouvez pas bloquer votre propre compte.';
  end if;
  if v_profil.role = 'admin' then
    raise exception 'Ce compte est administrateur : retirez d''abord son rôle (Paramètres, Administrateurs).';
  end if;
  if v_profil.role = 'chauffeur' then
    raise exception 'Ce compte est celui d''un chauffeur : suspendez-le depuis le module Chauffeurs.';
  end if;
  if v_profil.statut = 'supprime' then
    raise exception 'Ce compte a été supprimé à la demande du client : il ne se bloque ni ne se réactive.';
  end if;
  if v_profil.statut = p_statut then
    raise exception '%', case when p_statut = 'bloque' then 'Ce compte est déjà bloqué.' else 'Ce compte est déjà actif.' end;
  end if;
  if p_statut = 'bloque' and v_motif is null then
    raise exception 'Indiquez le motif du blocage : il est conservé dans le journal.';
  end if;

  update public.profils set statut = p_statut where id = v_profil.id;

  -- Réservations pas encore prises en charge : annulées sans frais
  if p_statut = 'bloque' and coalesce(p_annuler_reservations, false) then
    for v_course in
      select c.id from public.courses c
      where c.client_id = v_profil.id and c.statut in ('planifiee', 'recherche', 'a_attribuer')
      order by c.prise_en_charge_le
    loop
      perform public.annuler_course(v_course.id, 'Compte suspendu');
      v_annulees := v_annulees + 1;
    end loop;
  end if;

  perform prive.journaliser_action(case when p_statut = 'bloque' then 'blocage_compte' else 'deblocage_compte' end,
    'profils', v_profil.id::text, jsonb_build_object('motif', v_motif, 'reservations_annulees', v_annulees));
  perform prive.notifier(v_profil.id, 'alerte',
    case when p_statut = 'bloque' then 'Compte suspendu' else 'Compte réactivé' end,
    case when p_statut = 'bloque'
         then 'Votre compte LOC RÉACTION est suspendu : vous ne pouvez plus commander de course. Contactez-nous pour en savoir plus.'
         else 'Votre compte LOC RÉACTION est de nouveau actif : vous pouvez commander vos courses.' end);
  return jsonb_build_object('statut', p_statut, 'reservations_annulees', v_annulees);
end;
$$;

-- 4b. Liste des clients : « Tous » = actifs et bloqués ; « Supprimés » à part ;
--     chiffres du résumé sans les comptes supprimés, comptés à part (reprend
--     la version de la migration 12).
create or replace function public.admin_lister_clients(
  p_texte     text    default null,
  p_statut    text    default null,          -- 'actif', 'bloque', 'supprime' ou null (actifs et bloqués)
  p_tri       text    default 'recents',     -- recents, nom, depense, courses, derniere
  p_limite    integer default 50,
  p_decalage  integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_texte    text := nullif(trim(coalesce(p_texte, '')), '');
  v_motif    text;
  v_chiffres text;
  v_tri      text := case when p_tri in ('recents', 'nom', 'depense', 'courses', 'derniere') then p_tri else 'recents' end;
  v_total    integer;
  v_lignes   jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut is not null and p_statut not in ('actif', 'bloque', 'supprime') then
    raise exception 'Statut inconnu.';
  end if;
  if v_texte is not null then
    -- « % » et « _ » saisis sont cherchés tels quels
    v_motif := '%' || replace(replace(replace(v_texte, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- Téléphone saisi comme on le dit : « 06 12 34 56 78 » retrouve +33612345678
    v_chiffres := regexp_replace(v_texte, '[^0-9]', '', 'g');
    if v_chiffres ~ '^0[1-9][0-9]{8}$' then
      v_chiffres := substr(v_chiffres, 2);
    end if;
    if char_length(v_chiffres) < 6 then
      v_chiffres := null;
    end if;
  end if;

  with clients as (
    select p.*
    from public.profils p
    where p.role = 'client'
      and ((p_statut is null and p.statut <> 'supprime') or p.statut = p_statut)
      and (v_motif is null
           or concat_ws(' ', p.prenom, p.nom, p.email, p.telephone, p.code_parrainage) ilike v_motif
           or (v_chiffres is not null and p.telephone like '%' || v_chiffres || '%'))
  ),
  stats as (
    select c.client_id,
           count(*) filter (where c.statut = 'terminee')::integer as courses_terminees,
           count(*) filter (where c.statut = 'annulee' and c.annulee_par = 'client')::integer as annulations,
           count(*) filter (where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours'))::integer as a_venir,
           coalesce(sum(c.prix_total + c.frais_attente) filter (where c.statut = 'terminee'), 0)
             + coalesce(sum(c.frais_annulation) filter (where c.statut = 'annulee'), 0) as depense,
           max(c.terminee_le) filter (where c.statut = 'terminee') as derniere_course_le
    from public.courses c
    where c.client_id in (select id from clients)
    group by c.client_id
  ),
  notes as (
    select e.cible_id, round(avg(e.note)::numeric, 2) as note_moyenne, count(*)::integer as nb_notes
    from public.evaluations e
    where e.sens = 'chauffeur_vers_client' and e.cible_id in (select id from clients)
    group by e.cible_id
  ),
  lignes as (
    select cl.id, cl.prenom, cl.nom, cl.email, cl.telephone, cl.statut, cl.langue, cl.cree_le, cl.maj_le,
           coalesce(s.courses_terminees, 0) as courses_terminees, coalesce(s.annulations, 0) as annulations,
           coalesce(s.a_venir, 0) as a_venir, coalesce(s.depense, 0) as depense, s.derniere_course_le,
           n.note_moyenne, coalesce(n.nb_notes, 0) as nb_notes, coalesce(so.montant, 0) as solde,
           (select coalesce(jsonb_agg(cp.raison_sociale order by cp.raison_sociale), '[]'::jsonb)
              from public.comptes_pro_membres m join public.comptes_pro cp on cp.id = m.compte_pro_id
             where m.profil_id = cl.id) as entreprises,
           exists (select 1 from public.chauffeurs ch where ch.id = cl.id and ch.statut = 'candidat') as candidat
    from clients cl
    left join stats s on s.client_id = cl.id
    left join notes n on n.cible_id = cl.id
    left join public.soldes so on so.profil_id = cl.id
  ),
  classees as (
    select l.*, row_number() over (order by
             case when v_tri = 'nom' then lower(nullif(trim(l.prenom || ' ' || l.nom), '')) end asc nulls last,
             case when v_tri = 'depense' then l.depense end desc nulls last,
             case when v_tri = 'courses' then l.courses_terminees end desc nulls last,
             case when v_tri = 'derniere' then l.derniere_course_le end desc nulls last,
             l.cree_le desc, l.id) as rang
    from lignes l
  ),
  page as (
    select * from classees
    order by rang
    limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)
  )
  select (select count(*) from lignes),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'prenom', g.prenom, 'nom', g.nom, 'email', g.email, 'telephone', g.telephone,
           'statut', g.statut, 'langue', g.langue, 'cree_le', g.cree_le, 'maj_le', g.maj_le,
           'courses_terminees', g.courses_terminees, 'annulations', g.annulations, 'a_venir', g.a_venir,
           'depense', g.depense, 'derniere_course_le', g.derniere_course_le,
           'note_moyenne', g.note_moyenne, 'nb_notes', g.nb_notes, 'solde', g.solde,
           'entreprises', g.entreprises, 'candidat', g.candidat
         ) order by g.rang), '[]'::jsonb)
    into v_total, v_lignes
  from page g;

  return jsonb_build_object(
    'total', v_total,
    'lignes', v_lignes,
    'resume', (select jsonb_build_object(
                 'clients', count(*) filter (where p.statut <> 'supprime'),
                 'bloques', count(*) filter (where p.statut = 'bloque'),
                 'supprimes', count(*) filter (where p.statut = 'supprime'),
                 'nouveaux_30_jours', count(*) filter (where p.statut <> 'supprime' and p.cree_le > now() - interval '30 days'),
                 'actifs_30_jours', count(*) filter (where p.statut <> 'supprime' and exists (
                    select 1 from public.courses c
                    where c.client_id = p.id and c.statut = 'terminee' and c.terminee_le > now() - interval '30 days')),
                 'avec_entreprise', count(*) filter (where exists (
                    select 1 from public.comptes_pro_membres m where m.profil_id = p.id)))
               from public.profils p where p.role = 'client')
  );
end;
$$;
