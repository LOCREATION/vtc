-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 28 : SUPPRESSIONS PAR L'ADMINISTRATION
-- -----------------------------------------------------------------------------
-- Demande de l'administrateur : « un bouton Supprimer à tous les niveaux,
-- qui agit dans la base, sans avoir à ouvrir la base de données ».
--
-- Principe, le même partout :
--   - « Supprimer » efface vraiment la ligne et tout ce qui en dépend ;
--   - une seule limite, imposée par la loi : les pièces comptables (factures,
--     avoirs, paiements encaissés, remboursements : 10 ans, Code de commerce
--     art. L123-22) et la paie (bulletins validés, contrats signés : 5 ans,
--     Code du travail art. L3243-4) ne s'effacent pas. Une personne liée à de
--     telles pièces est alors vidée de toutes ses coordonnées, sa connexion est
--     fermée, et il ne reste d'elle qu'une fiche « supprimée » sans nom, qui
--     tient les pièces (même règle que la suppression d'un compte client par
--     lui-même, migration 27). Le message dit toujours pourquoi et que faire.
--
--   1. File d'effacement des fichiers. Supabase interdit d'effacer un fichier
--      du stockage depuis la base (le fichier resterait sur ses disques) :
--      chaque ligne effacée qui portait un fichier (pièce de chauffeur, pièce
--      jointe du support, feuille de route, bulletin ou contrat brouillon,
--      relevé de plateforme, photo) le met en file ; la session de
--      l'administrateur, seule autorisée sur tous les dossiers, l'efface par
--      l'API de stockage juste après la suppression, et à chaque ouverture de
--      l'administration pour ce qui resterait. Un fichier de nouveau cité par
--      une ligne n'est jamais effacé.
--   2. Journal : chaque suppression y est inscrite (qui, quoi, quand), sans
--      les coordonnées ni les numéros de pièces de la personne ; celles déjà
--      inscrites pour la ligne effacée s'effacent aussi.
--   3. Comptes : clients et chauffeurs (avec dossier, documents, position,
--      candidature) ; effacés en entier s'ils n'ont aucune pièce à garder.
--   4. Le reste : candidature, document, course, paiement, véhicule, code
--      promo, notification groupée (retirée aussi chez les destinataires),
--      parrainage, demande d'aide, message, salarié, compte professionnel,
--      lieu (zone), catégorie, tarif, forfait.
-- Les suppressions simples déjà en place (entretien, absence, relevé, objet
-- trouvé, message du site, jour férié…) restent des suppressions directes ;
-- les notes internes s'effacent désormais par tout administrateur.
-- Nouveau statut « supprime » pour les chauffeurs (fiche vidée qui tient
-- l'historique de ses courses : un chauffeur reste obligatoire sur une course
-- acceptée ou terminée).
-- =============================================================================


-- #############################################################################
-- 1. FILE D'EFFACEMENT DES FICHIERS
-- #############################################################################
create table prive.fichiers_a_effacer (
  dossier     text not null,                 -- dossier (bucket) du stockage
  chemin      text not null,                 -- chemin du fichier dans ce dossier
  origine     text not null,                 -- table d'où vient la demande
  demande_le  timestamptz not null default now(),
  primary key (dossier, chemin)
);
comment on table prive.fichiers_a_effacer is
  'Fichiers du stockage à effacer par l''API (lignes supprimées) : traités par la session de l''administration.';
revoke all on table prive.fichiers_a_effacer from public, anon, authenticated;

-- Met un fichier en file (sans doublon)
create or replace function prive.fichier_a_effacer(p_dossier text, p_chemin text, p_origine text)
returns void
language sql security definer set search_path = ''
as $$
  insert into prive.fichiers_a_effacer (dossier, chemin, origine)
  select p_dossier, p_chemin, p_origine
   where nullif(trim(coalesce(p_chemin, '')), '') is not null
  on conflict (dossier, chemin) do nothing
$$;

-- Vrai si une ligne de la base cite encore ce fichier : il ne s'efface pas
create or replace function prive.fichier_utilise(p_dossier text, p_chemin text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_dossier
    when 'documents' then exists (select 1 from public.documents d where d.fichier_chemin = p_chemin)
    when 'courses' then exists (select 1 from public.courses c where c.feuille_de_route_chemin = p_chemin)
    when 'support' then exists (select 1 from public.messages m where m.piece_jointe_chemin = p_chemin)
    when 'paie' then exists (select 1 from public.bulletins b where b.pdf_chemin = p_chemin)
                  or exists (select 1 from public.contrats k where k.pdf_chemin = p_chemin)
    when 'administration' then exists (select 1 from public.releves_plateformes r where r.fichier_chemin = p_chemin)
    when 'photos' then exists (select 1 from public.profils p where p.photo_chemin = p_chemin)
                    or exists (select 1 from public.courses c where c.chauffeur_photo = p_chemin)
    when 'factures' then exists (select 1 from public.factures f where f.pdf_chemin = p_chemin)
    else true                                  -- dossier inconnu : on n'y touche pas
  end
$$;

-- Déclencheur : une ligne effacée (ou dont le fichier change) met l'ancien
-- fichier en file. Arguments : dossier, colonne du chemin.
create or replace function prive.fichier_ligne_retiree()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_colonne text := tg_argv[1];
  v_ancien  text := to_jsonb(old) ->> v_colonne;
begin
  if v_ancien is not null
     and (tg_op = 'DELETE' or (to_jsonb(new) ->> v_colonne) is distinct from v_ancien) then
    perform prive.fichier_a_effacer(tg_argv[0], v_ancien, tg_table_name);
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function prive.fichier_a_effacer(text, text, text) from public, anon, authenticated;
revoke all on function prive.fichier_utilise(text, text) from public, anon, authenticated;
revoke all on function prive.fichier_ligne_retiree() from public, anon, authenticated;

create trigger fichier_retire after delete or update of fichier_chemin on public.documents
  for each row execute function prive.fichier_ligne_retiree('documents', 'fichier_chemin');
create trigger fichier_retire after delete or update of feuille_de_route_chemin on public.courses
  for each row execute function prive.fichier_ligne_retiree('courses', 'feuille_de_route_chemin');
-- Seules les demandes d'aide ont des pièces jointes (dossier « support »)
create trigger fichier_retire after delete or update of piece_jointe_chemin on public.messages
  for each row execute function prive.fichier_ligne_retiree('support', 'piece_jointe_chemin');
create trigger fichier_retire after delete or update of pdf_chemin on public.bulletins
  for each row execute function prive.fichier_ligne_retiree('paie', 'pdf_chemin');
create trigger fichier_retire after delete or update of pdf_chemin on public.contrats
  for each row execute function prive.fichier_ligne_retiree('paie', 'pdf_chemin');
create trigger fichier_retire after delete or update of fichier_chemin on public.releves_plateformes
  for each row execute function prive.fichier_ligne_retiree('administration', 'fichier_chemin');
create trigger fichier_retire after delete or update of photo_chemin on public.profils
  for each row execute function prive.fichier_ligne_retiree('photos', 'photo_chemin');

-- Lecture pour la session de l'administration : fichiers encore présents et
-- cités par aucune ligne (par lots de 200)
create or replace function public.admin_fichiers_a_effacer()
returns table (dossier text, chemin text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  return query
  select f.dossier, f.chemin
    from prive.fichiers_a_effacer f
   where exists (select 1 from storage.objects o where o.bucket_id = f.dossier and o.name = f.chemin)
     and not prive.fichier_utilise(f.dossier, f.chemin)
   order by f.demande_le, f.chemin
   limit 200;
end;
$$;

-- Après l'effacement par l'API : la file oublie les fichiers qui n'existent
-- plus, et ceux qu'une ligne cite de nouveau (jamais effacés)
create or replace function public.admin_fichiers_effaces()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_nombre integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  delete from prive.fichiers_a_effacer f
   where not exists (select 1 from storage.objects o where o.bucket_id = f.dossier and o.name = f.chemin)
      or prive.fichier_utilise(f.dossier, f.chemin);
  get diagnostics v_nombre = row_count;
  return v_nombre;
end;
$$;

-- Fichiers déjà orphelins à la mise en place (pièces des comptes d'essai
-- effacés le 8 novembre 2026) : en file, s'ils datent de plus d'une heure
-- (jamais un dépôt en cours)
insert into prive.fichiers_a_effacer (dossier, chemin, origine)
select o.bucket_id, o.name, 'documents'
  from storage.objects o
 where o.bucket_id = 'documents'
   and o.created_at < now() - interval '1 hour'
   and not prive.fichier_utilise(o.bucket_id, o.name)
on conflict (dossier, chemin) do nothing;


-- #############################################################################
-- 2. OUTILS COMMUNS
-- #############################################################################
-- Retire des clés (coordonnées, numéros de pièces) des lignes du journal
-- d'une table, pour les lignes données
create or replace function prive.journal_sans(p_table text, p_lignes text[], p_cles text[])
returns void
language sql security definer set search_path = ''
as $$
  update prive.journal j
     set avant = j.avant - p_cles,
         apres = j.apres - p_cles
   where j.table_cible = p_table
     and j.ligne_id = any(p_lignes)
     and (coalesce(j.avant ?| p_cles, false) or coalesce(j.apres ?| p_cles, false))
$$;

-- Notifications dont le lien mène à une ligne effacée : elles partent aussi
create or replace function prive.retirer_notifications_liees(p_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.notifications n where n.lien like '%' || p_id::text || '%'
$$;

-- Note moyenne d'un chauffeur, recalculée après le retrait de notes
create or replace function prive.recalculer_note_chauffeur(p_chauffeur uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.chauffeurs c
     set note_moyenne = s.moyenne, nb_notes = s.nombre
    from (select round(avg(e.note)::numeric, 2) as moyenne, count(*)::integer as nombre
            from public.evaluations e
           where e.cible_id = p_chauffeur and e.sens = 'client_vers_chauffeur') s
   where c.id = p_chauffeur
$$;

revoke all on function prive.journal_sans(text, text[], text[]) from public, anon, authenticated;
revoke all on function prive.retirer_notifications_liees(uuid) from public, anon, authenticated;
revoke all on function prive.recalculer_note_chauffeur(uuid) from public, anon, authenticated;

-- Coordonnées et numéros de pièces, par table, effacés du journal
-- (listes reprises dans les fonctions ci-dessous)
--   profils       : prenom, nom, email, telephone, photo_chemin
--   courses       : client_prenom, client_telephone, depart_precision,
--                   beneficiaire_nom, beneficiaire_telephone, chauffeur_prenom,
--                   chauffeur_telephone, chauffeur_photo (+ trajets pour une
--                   course effacée)
--   chauffeurs    : carte_vtc_numero, permis_numero, filtre_destination_lat/lng
--   documents     : numero, commentaire, fichier_chemin
--   candidatures  : ville, experience, message, motif_refus
--   salaries      : identité, naissance, sécurité sociale, adresse, banque


-- #############################################################################
-- 3. COMPTES : CLIENTS ET CHAUFFEURS
-- #############################################################################
-- Statut « supprime » des chauffeurs : fiche vidée qui tient l'historique
alter table public.chauffeurs drop constraint chauffeurs_statut_check;
alter table public.chauffeurs add constraint chauffeurs_statut_check
  check (statut in ('candidat', 'valide', 'suspendu', 'refuse', 'supprime'));

-- Moteur commun. Contrôles : aucune course en cours ou à venir (comme client
-- ou comme chauffeur). Puis :
--   - effacé dans tous les cas : adhésions aux comptes pro, lieux, proches,
--     appareils, notes internes, notes reçues, conversations de ses courses,
--     notifications, propositions, position, documents (fichiers en file),
--     candidature, parrainages ;
--   - rien à garder : le compte entier part (connexion, profil, solde…) ;
--   - pièces à garder (courses, paiements, factures, avoirs, demandes d'aide,
--     paie, espèces, relevés) : profil vidé et « supprimé », connexion fermée,
--     coordonnées effacées des courses, dossier chauffeur vidé et
--     « supprimé », solde abandonné.
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

revoke all on function prive.supprimer_compte(uuid, text) from public, anon, authenticated;

-- Client (et candidat chauffeur jamais validé : son dossier part avec lui)
create or replace function public.admin_supprimer_client(p_profil uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
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
  if v_profil.id = auth.uid() then
    raise exception 'Vous ne pouvez pas supprimer votre propre compte.';
  end if;
  if v_profil.statut = 'supprime' then
    raise exception 'Ce compte est déjà supprimé.';
  end if;
  if v_profil.role = 'admin' then
    raise exception 'Ce compte est administrateur : retirez d''abord son rôle (Paramètres, Administrateurs).';
  end if;
  if v_profil.role = 'chauffeur'
     or exists (select 1 from public.chauffeurs ch where ch.id = p_profil and ch.statut in ('valide', 'suspendu', 'supprime')) then
    raise exception 'Ce compte est celui d''un chauffeur : supprimez-le depuis le module Chauffeurs.';
  end if;
  return prive.supprimer_compte(p_profil, 'administration');
end;
$$;

-- Chauffeur (compte, dossier, documents, position, candidature)
create or replace function public.admin_supprimer_chauffeur(p_chauffeur uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil public.profils;
  v_statut text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select ch.statut into v_statut from public.chauffeurs ch where ch.id = p_chauffeur;
  select * into v_profil from public.profils p where p.id = p_chauffeur;
  if v_statut is null or v_profil.id is null then
    raise exception 'Chauffeur introuvable.';
  end if;
  if v_statut = 'supprime' or v_profil.statut = 'supprime' then
    raise exception 'Ce chauffeur est déjà supprimé.';
  end if;
  if v_profil.id = auth.uid() then
    raise exception 'Vous ne pouvez pas supprimer votre propre compte.';
  end if;
  if v_profil.role = 'admin' then
    raise exception 'Ce compte est administrateur : retirez d''abord son rôle (Paramètres, Administrateurs).';
  end if;
  return prive.supprimer_compte(p_chauffeur, 'administration');
end;
$$;


-- #############################################################################
-- 4. DOSSIER CHAUFFEUR : CANDIDATURE, DOCUMENT
-- #############################################################################
-- Candidature : effacée ; le dossier d'un candidat jamais validé part avec
-- elle (documents compris) ; son compte client reste.
create or replace function public.admin_supprimer_candidature(p_candidature uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_candidature public.candidatures;
  v_statut      text;
  v_dossier     boolean := false;
  v_documents   text[];
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_candidature from public.candidatures ca where ca.id = p_candidature for update;
  if v_candidature.id is null then
    raise exception 'Candidature introuvable.';
  end if;
  select ch.statut into v_statut from public.chauffeurs ch where ch.id = v_candidature.profil_id for update;

  delete from public.candidatures where id = p_candidature;
  if v_statut in ('candidat', 'refuse')
     and not exists (select 1 from public.courses c where c.chauffeur_id = v_candidature.profil_id) then
    v_documents := array(select d.id::text from public.documents d where d.chauffeur_id = v_candidature.profil_id);
    delete from public.chauffeurs where id = v_candidature.profil_id;   -- documents (fichiers en file), position
    v_dossier := true;
    perform prive.journal_sans('documents', v_documents, array['numero', 'commentaire', 'fichier_chemin']);
    perform prive.journal_sans('chauffeurs', array[v_candidature.profil_id::text],
      array['carte_vtc_numero', 'permis_numero', 'filtre_destination_lat', 'filtre_destination_lng']);
  end if;
  perform prive.journal_sans('candidatures', array[p_candidature::text], array['ville', 'experience', 'message', 'motif_refus']);
  perform prive.journaliser_action('suppression_candidature', 'candidatures', p_candidature::text,
    jsonb_build_object('statut', v_candidature.statut, 'dossier_retire', v_dossier));
  return jsonb_build_object('mode', 'efface', 'dossier_retire', v_dossier);
end;
$$;

-- Document d'un chauffeur ou d'un véhicule (le fichier part aussi)
create or replace function public.admin_supprimer_document(p_document uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_document public.documents;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_document from public.documents d where d.id = p_document for update;
  if v_document.id is null then
    raise exception 'Document introuvable.';
  end if;
  delete from public.documents where id = p_document;                  -- fichier mis en file
  perform prive.journal_sans('documents', array[p_document::text], array['numero', 'commentaire', 'fichier_chemin']);
  perform prive.journaliser_action('suppression_document', 'documents', p_document::text,
    jsonb_build_object('type', v_document.type, 'statut', v_document.statut));
  return jsonb_build_object('mode', 'efface');
end;
$$;


-- #############################################################################
-- 5. COURSES ET PAIEMENTS
-- #############################################################################
-- Course : seulement terminée ou annulée, et sans pièce comptable (facture,
-- avoir, paiement encaissé, mouvement de solde). Partent avec elle : arrêts,
-- historique, conversation, propositions, notes (moyenne du chauffeur
-- recalculée), paiements jamais encaissés, notifications qui y mènent ; la
-- feuille de route est mise en file ; une demande d'aide ou un objet trouvé
-- qui la citaient restent, détachés.
create or replace function public.admin_supprimer_course(p_course uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course  public.courses;
  v_piece   text;
  v_montant numeric;
  v_noter   boolean;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut not in ('terminee', 'annulee') then
    raise exception 'La course % n''est pas terminée : annulez-la d''abord (le client et le chauffeur sont prévenus), puis supprimez-la.', v_course.numero;
  end if;
  select f.numero into v_piece from public.factures f where f.course_id = p_course order by f.numero limit 1;
  if v_piece is not null then
    raise exception 'La facture % a été émise pour cette course : la loi impose de la conserver 10 ans, avec sa course. Pour l''annuler, établissez un avoir (module Finances).', v_piece;
  end if;
  select a.numero into v_piece from public.avoirs a where a.course_id = p_course order by a.numero limit 1;
  if v_piece is not null then
    raise exception 'L''avoir % a été établi pour cette course : la loi impose de le conserver 10 ans, avec sa course.', v_piece;
  end if;
  select pa.montant into v_montant from public.paiements pa
   where pa.course_id = p_course and pa.statut in ('encaisse', 'rembourse') limit 1;
  if v_montant is not null then
    raise exception 'Un paiement de % a été encaissé pour cette course : c''est une écriture comptable, conservée 10 ans avec sa course.', prive.euros(v_montant);
  end if;
  if exists (select 1 from public.ecritures_solde e where e.course_id = p_course) then
    raise exception 'Le solde d''un client a bougé avec cette course : l''écriture reste dans la comptabilité, avec sa course.';
  end if;

  v_noter := exists (select 1 from public.evaluations e where e.course_id = p_course and e.sens = 'client_vers_chauffeur');
  delete from public.paiements where course_id = p_course;            -- jamais encaissés (contrôlé ci-dessus)
  update public.demandes set course_id = null where course_id = p_course;
  update public.objets_trouves set course_id = null where course_id = p_course;
  perform prive.retirer_notifications_liees(p_course);
  delete from public.courses where id = p_course;                      -- arrêts, historique, conversation, notes…
  if v_noter and v_course.chauffeur_id is not null then
    perform prive.recalculer_note_chauffeur(v_course.chauffeur_id);
  end if;

  -- Journal : la course effacée n'y garde ni coordonnées ni trajet
  perform prive.journal_sans('courses', array[p_course::text],
    array['client_prenom', 'client_telephone', 'depart_precision', 'beneficiaire_nom', 'beneficiaire_telephone',
          'chauffeur_prenom', 'chauffeur_telephone', 'chauffeur_photo', 'depart_adresse', 'depart_lat', 'depart_lng',
          'arrivee_adresse', 'arrivee_lat', 'arrivee_lng', 'numero_vol', 'terminal', 'motif_annulation',
          'vehicule_immatriculation']);
  perform prive.journaliser_action('suppression_course', 'courses', p_course::text,
    jsonb_build_object('numero', v_course.numero, 'statut', v_course.statut));
  return jsonb_build_object('mode', 'efface', 'numero', v_course.numero);
end;
$$;

-- Paiement : seulement s'il n'a jamais été encaissé et qu'aucune facture,
-- aucun avoir ni remboursement ne le couvre
create or replace function public.admin_supprimer_paiement(p_paiement uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement public.paiements;
  v_facture  text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_paiement from public.paiements pa where pa.id = p_paiement for update;
  if v_paiement.id is null then
    raise exception 'Paiement introuvable.';
  end if;
  if v_paiement.statut in ('encaisse', 'rembourse') then
    raise exception 'Un paiement encaissé est une écriture comptable : la loi impose de le conserver 10 ans. Pour rendre l''argent, faites un remboursement.';
  end if;
  if exists (select 1 from public.remboursements r where r.paiement_id = p_paiement)
     or exists (select 1 from public.avoirs a where a.paiement_id = p_paiement) then
    raise exception 'Un remboursement ou un avoir porte sur ce paiement : il reste dans la comptabilité.';
  end if;
  select f.numero into v_facture from public.factures f
   where f.course_id = v_paiement.course_id and f.nature = v_paiement.nature and f.statut = 'emise'
   limit 1;
  if v_facture is not null then
    raise exception 'La facture % a été émise pour ce montant : elle se conserve 10 ans. Pour ne plus le réclamer, établissez un avoir (module Finances).', v_facture;
  end if;
  delete from public.paiements where id = p_paiement;
  perform prive.journaliser_action('suppression_paiement', 'paiements', p_paiement::text,
    jsonb_build_object('nature', v_paiement.nature, 'mode', v_paiement.mode, 'montant', v_paiement.montant,
                       'statut', v_paiement.statut));
  return jsonb_build_object('mode', 'efface');
end;
$$;


-- #############################################################################
-- 6. FLOTTE, MARKETING
-- #############################################################################
-- Véhicule : les courses gardent sa description (marque, couleur,
-- immatriculation copiées à la course) ; ses papiers (fichiers en file) et
-- ses entretiens partent avec lui. Refusé s'il roule en ce moment.
create or replace function public.admin_supprimer_vehicule(p_vehicule uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_vehicule public.vehicules;
  v_numero   text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_vehicule from public.vehicules v where v.id = p_vehicule for update;
  if v_vehicule.id is null then
    raise exception 'Véhicule introuvable.';
  end if;
  select c.numero into v_numero from public.courses c
   where c.vehicule_id = p_vehicule and c.statut in ('acceptee', 'arrivee', 'en_cours') limit 1;
  if v_numero is not null then
    raise exception 'Ce véhicule fait la course % en ce moment : attendez qu''elle soit terminée.', v_numero;
  end if;
  update public.courses set vehicule_id = null where vehicule_id = p_vehicule;
  update public.chauffeurs set vehicule_id = null where vehicule_id = p_vehicule;
  delete from public.vehicules where id = p_vehicule;                  -- papiers et entretiens en cascade
  perform prive.journaliser_action('suppression_vehicule', 'vehicules', p_vehicule::text,
    jsonb_build_object('immatriculation', v_vehicule.immatriculation, 'marque', v_vehicule.marque, 'modele', v_vehicule.modele));
  return jsonb_build_object('mode', 'efface');
end;
$$;

-- Code promo, même déjà utilisé : les courses gardent la remise accordée
create or replace function public.admin_supprimer_code_promo(p_code uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_code        public.codes_promo;
  v_utilisations integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_code from public.codes_promo cp where cp.id = p_code for update;
  if v_code.id is null then
    raise exception 'Code introuvable.';
  end if;
  delete from public.utilisations_promo where code_promo_id = p_code;
  get diagnostics v_utilisations = row_count;
  update public.courses set code_promo_id = null where code_promo_id = p_code;
  delete from public.codes_promo where id = p_code;
  perform prive.journaliser_action('suppression_code_promo', 'codes_promo', p_code::text,
    jsonb_build_object('code', v_code.code, 'utilisations', v_utilisations));
  return jsonb_build_object('mode', 'efface', 'utilisations', v_utilisations);
end;
$$;

-- Notification groupée : envoyée, elle disparaît aussi des notifications de
-- ses destinataires (clé étrangère en cascade, ci-dessous)
alter table public.notifications drop constraint notifications_campagne_id_fkey;
alter table public.notifications add constraint notifications_campagne_id_fkey
  foreign key (campagne_id) references public.campagnes (id) on delete cascade;

-- Une campagne envoyée ne se modifie plus, mais se supprime
create or replace function prive.proteger_campagne()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if old.envoyee_le is not null then
    raise exception 'Cette notification groupée est déjà envoyée : elle ne se modifie plus.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.admin_supprimer_campagne(p_campagne uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_campagne public.campagnes;
  v_retirees integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_campagne from public.campagnes c where c.id = p_campagne for update;
  if v_campagne.id is null then
    raise exception 'Notification groupée introuvable.';
  end if;
  select count(*) into v_retirees from public.notifications n where n.campagne_id = p_campagne;
  delete from public.campagnes where id = p_campagne;                  -- notifications envoyées en cascade
  perform prive.journaliser_action('suppression_campagne', 'campagnes', p_campagne::text,
    jsonb_build_object('titre', v_campagne.titre, 'envoyee', v_campagne.envoyee_le is not null, 'notifications_retirees', v_retirees));
  return jsonb_build_object('mode', 'efface', 'notifications_retirees', v_retirees);
end;
$$;

-- Parrainage : le lien part ; une récompense déjà versée reste sur le solde
create or replace function public.admin_supprimer_parrainage(p_parrainage uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_parrainage public.parrainages;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_parrainage from public.parrainages pr where pr.id = p_parrainage for update;
  if v_parrainage.id is null then
    raise exception 'Parrainage introuvable.';
  end if;
  delete from public.parrainages where id = p_parrainage;
  perform prive.journaliser_action('suppression_parrainage', 'parrainages', p_parrainage::text,
    jsonb_build_object('statut', v_parrainage.statut));
  return jsonb_build_object('mode', 'efface', 'recompenses_versees', v_parrainage.statut = 'valide');
end;
$$;


-- #############################################################################
-- 7. SUPPORT : DEMANDE, MESSAGE
-- #############################################################################
-- Demande d'aide : ses messages et pièces jointes (fichiers en file) partent ;
-- un objet trouvé qui la citait reste, détaché
create or replace function public.admin_supprimer_demande(p_demande uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_demande public.demandes;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_demande from public.demandes d where d.id = p_demande for update;
  if v_demande.id is null then
    raise exception 'Demande introuvable.';
  end if;
  perform prive.retirer_notifications_liees(p_demande);
  delete from public.demandes where id = p_demande;                    -- messages en cascade
  perform prive.journal_sans('demandes', array[p_demande::text], array['sujet']);
  perform prive.journaliser_action('suppression_demande', 'demandes', p_demande::text,
    jsonb_build_object('numero', v_demande.numero, 'type', v_demande.type, 'statut', v_demande.statut));
  return jsonb_build_object('mode', 'efface', 'numero', v_demande.numero);
end;
$$;

-- Un message d'une demande d'aide ou d'une conversation de course
create or replace function public.admin_supprimer_message(p_message uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_message public.messages;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_message from public.messages m where m.id = p_message for update;
  if v_message.id is null then
    raise exception 'Message introuvable.';
  end if;
  delete from public.messages where id = p_message;                    -- pièce jointe mise en file
  perform prive.journaliser_action('suppression_message', 'messages', p_message::text,
    jsonb_build_object('demande_id', v_message.demande_id, 'course_id', v_message.course_id,
                       'piece_jointe', v_message.piece_jointe_chemin is not null));
  return jsonb_build_object('mode', 'efface');
end;
$$;


-- #############################################################################
-- 8. RH : SALARIÉ
-- #############################################################################
-- Salarié : refusé dès qu'un bulletin est validé ou un contrat signé (5 ans
-- de conservation) ; sinon effacé avec ses brouillons, absences, temps et
-- reprises (fichiers en file)
create or replace function public.admin_supprimer_salarie(p_salarie uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_salarie public.salaries;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_salarie from public.salaries s where s.id = p_salarie for update;
  if v_salarie.id is null then
    raise exception 'Salarié introuvable.';
  end if;
  if exists (select 1 from public.bulletins b where b.salarie_id = p_salarie and b.statut <> 'brouillon') then
    raise exception 'Des bulletins de paie validés existent pour ce salarié : la loi impose de les conserver 5 ans. Indiquez plutôt sa date de sortie.';
  end if;
  if exists (select 1 from public.contrats k where k.salarie_id = p_salarie and k.statut in ('signe', 'termine')) then
    raise exception 'Un contrat signé existe pour ce salarié : il reste dans son dossier 5 ans après son départ. Indiquez plutôt sa date de sortie.';
  end if;
  delete from public.bulletins where salarie_id = p_salarie;           -- brouillons et leurs lignes
  delete from public.salaries where id = p_salarie;                    -- contrats non signés, absences, temps, reprises
  perform prive.journal_sans('salaries', array[p_salarie::text],
    array['civilite', 'prenom', 'nom', 'date_naissance', 'lieu_naissance', 'nationalite', 'numero_securite_sociale',
          'adresse', 'code_postal', 'ville', 'iban', 'bic', 'profil_id']);
  perform prive.journaliser_action('suppression_salarie', 'salaries', p_salarie::text,
    jsonb_build_object('matricule', v_salarie.matricule));
  return jsonb_build_object('mode', 'efface');
end;
$$;


-- #############################################################################
-- 9. CLIENTS : COMPTE PROFESSIONNEL
-- #############################################################################
-- Compte professionnel sans course : effacé (membres et notes en cascade).
-- Avec des courses : ses factures, au nom de l'entreprise, se conservent
-- 10 ans ; il se suspend.
create or replace function public.admin_supprimer_compte_pro(p_compte uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_compte  public.comptes_pro;
  v_courses integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_compte from public.comptes_pro cp where cp.id = p_compte for update;
  if v_compte.id is null then
    raise exception 'Compte professionnel introuvable.';
  end if;
  select count(*) into v_courses from public.courses c where c.compte_pro_id = p_compte;
  if v_courses > 0
     or exists (select 1 from public.factures f where f.compte_pro_id = p_compte)
     or exists (select 1 from public.avoirs a where a.compte_pro_id = p_compte) then
    raise exception '% : la loi impose de conserver 10 ans ses factures, au nom de l''entreprise. Suspendez plutôt le compte : ses membres ne pourront plus commander sur facture mensuelle.',
      case when v_courses = 1 then 'Ce compte a 1 course' else 'Ce compte a ' || v_courses || ' courses' end;
  end if;
  delete from public.comptes_pro where id = p_compte;
  perform prive.journaliser_action('suppression_compte_pro', 'comptes_pro', p_compte::text,
    jsonb_build_object('raison_sociale', v_compte.raison_sociale));
  return jsonb_build_object('mode', 'efface');
end;
$$;


-- #############################################################################
-- 10. TARIFS : LIEU (ZONE), CATÉGORIE, TARIF, FORFAIT
-- #############################################################################
-- Un tarif ou un forfait qui a servi à calculer une course reste : il
-- justifie le prix facturé.

-- Lieu : ses forfaits jamais utilisés partent avec lui
create or replace function public.admin_supprimer_zone(p_zone uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_zone     public.zones;
  v_forfaits integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_zone from public.zones z where z.id = p_zone for update;
  if v_zone.id is null then
    raise exception 'Lieu introuvable.';
  end if;
  if exists (select 1 from public.forfaits f join public.courses c on c.forfait_id = f.id
              where f.zone_a_id = p_zone or f.zone_b_id = p_zone) then
    raise exception 'Des courses ont été payées au forfait depuis ou vers « % » : ces forfaits justifient leurs prix. Désactivez plutôt ce lieu.', v_zone.nom;
  end if;
  delete from public.forfaits where zone_a_id = p_zone or zone_b_id = p_zone;
  get diagnostics v_forfaits = row_count;
  delete from public.zones where id = p_zone;
  perform prive.journaliser_action('suppression_zone', 'zones', p_zone::text,
    jsonb_build_object('nom', v_zone.nom, 'forfaits_retires', v_forfaits));
  return jsonb_build_object('mode', 'efface', 'forfaits_retires', v_forfaits);
end;
$$;

-- Catégorie : jamais commandée ni portée par un véhicule, et pas la dernière
-- active ; ses tarifs et forfaits partent avec elle
create or replace function public.admin_supprimer_categorie(p_categorie uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_categorie public.categories;
  v_nombre    integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_categorie from public.categories c where c.id = p_categorie for update;
  if v_categorie.id is null then
    raise exception 'Catégorie introuvable.';
  end if;
  select count(*) into v_nombre from public.courses c where c.categorie_id = p_categorie;
  if v_nombre > 0 then
    raise exception 'Des courses ont été commandées en « % » (%) : la catégorie reste pour leur historique. Désactivez-la plutôt.',
      v_categorie.nom_fr, v_nombre;
  end if;
  select count(*) into v_nombre from public.vehicules v where v.categorie_id = p_categorie;
  if v_nombre > 0 then
    raise exception 'Des véhicules sont classés en « % » (%) : changez d''abord leur catégorie (module Flotte).', v_categorie.nom_fr, v_nombre;
  end if;
  if v_categorie.active and not exists (select 1 from public.categories c where c.active and c.id <> p_categorie) then
    raise exception 'C''est la dernière catégorie active : sans elle, plus aucune course ne peut être commandée.';
  end if;
  delete from public.forfaits where categorie_id = p_categorie;
  delete from public.tarifs where categorie_id = p_categorie;
  delete from public.categories where id = p_categorie;
  perform prive.journaliser_action('suppression_categorie', 'categories', p_categorie::text,
    jsonb_build_object('code', v_categorie.code, 'nom', v_categorie.nom_fr));
  return jsonb_build_object('mode', 'efface');
end;
$$;

-- Tarif : ni en vigueur, ni utilisé par une course
create or replace function public.admin_supprimer_tarif(p_tarif uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_tarif  public.tarifs;
  v_jour   date := prive.heure_paris()::date;
  v_nombre integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_tarif from public.tarifs t where t.id = p_tarif for update;
  if v_tarif.id is null then
    raise exception 'Tarif introuvable.';
  end if;
  select count(*) into v_nombre from public.courses c where c.tarif_id = p_tarif;
  if v_nombre > 0 then
    raise exception 'Ce tarif a servi à calculer % : il reste pour justifier leurs prix.',
      case when v_nombre = 1 then '1 course' else v_nombre || ' courses' end;
  end if;
  if v_tarif.valide_du <= v_jour and (v_tarif.valide_au is null or v_tarif.valide_au >= v_jour) then
    raise exception 'C''est le tarif en vigueur : enregistrez d''abord le suivant.';
  end if;
  delete from public.tarifs where id = p_tarif;
  perform prive.journaliser_action('suppression_tarif', 'tarifs', p_tarif::text,
    jsonb_build_object('valide_du', v_tarif.valide_du, 'valide_au', v_tarif.valide_au));
  return jsonb_build_object('mode', 'efface');
end;
$$;

-- Forfait : jamais utilisé par une course
create or replace function public.admin_supprimer_forfait(p_forfait uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_forfait public.forfaits;
  v_nombre  integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_forfait from public.forfaits f where f.id = p_forfait for update;
  if v_forfait.id is null then
    raise exception 'Forfait introuvable.';
  end if;
  select count(*) into v_nombre from public.courses c where c.forfait_id = p_forfait;
  if v_nombre > 0 then
    raise exception 'Ce forfait a servi à % : il reste pour justifier leurs prix. Désactivez-le plutôt.',
      case when v_nombre = 1 then '1 course' else v_nombre || ' courses' end;
  end if;
  delete from public.forfaits where id = p_forfait;
  perform prive.journaliser_action('suppression_forfait', 'forfaits', p_forfait::text,
    jsonb_build_object('prix', v_forfait.prix));
  return jsonb_build_object('mode', 'efface');
end;
$$;


-- #############################################################################
-- 11. NOTES INTERNES : TOUT ADMINISTRATEUR PEUT LES RETIRER
-- #############################################################################
drop policy notes_internes_suppression on public.notes_internes;
create policy notes_internes_suppression on public.notes_internes for delete to authenticated
  using ((select public.est_admin()));


-- #############################################################################
-- 12. DROITS
-- #############################################################################
revoke all on function public.admin_fichiers_a_effacer() from public, anon;
revoke all on function public.admin_fichiers_effaces() from public, anon;
revoke all on function public.admin_supprimer_client(uuid) from public, anon;
revoke all on function public.admin_supprimer_chauffeur(uuid) from public, anon;
revoke all on function public.admin_supprimer_candidature(uuid) from public, anon;
revoke all on function public.admin_supprimer_document(uuid) from public, anon;
revoke all on function public.admin_supprimer_course(uuid) from public, anon;
revoke all on function public.admin_supprimer_paiement(uuid) from public, anon;
revoke all on function public.admin_supprimer_vehicule(uuid) from public, anon;
revoke all on function public.admin_supprimer_code_promo(uuid) from public, anon;
revoke all on function public.admin_supprimer_campagne(uuid) from public, anon;
revoke all on function public.admin_supprimer_parrainage(uuid) from public, anon;
revoke all on function public.admin_supprimer_demande(uuid) from public, anon;
revoke all on function public.admin_supprimer_message(uuid) from public, anon;
revoke all on function public.admin_supprimer_salarie(uuid) from public, anon;
revoke all on function public.admin_supprimer_compte_pro(uuid) from public, anon;
revoke all on function public.admin_supprimer_zone(uuid) from public, anon;
revoke all on function public.admin_supprimer_categorie(uuid) from public, anon;
revoke all on function public.admin_supprimer_tarif(uuid) from public, anon;
revoke all on function public.admin_supprimer_forfait(uuid) from public, anon;

grant execute on function
  public.admin_fichiers_a_effacer(), public.admin_fichiers_effaces(),
  public.admin_supprimer_client(uuid), public.admin_supprimer_chauffeur(uuid),
  public.admin_supprimer_candidature(uuid), public.admin_supprimer_document(uuid),
  public.admin_supprimer_course(uuid), public.admin_supprimer_paiement(uuid),
  public.admin_supprimer_vehicule(uuid), public.admin_supprimer_code_promo(uuid),
  public.admin_supprimer_campagne(uuid), public.admin_supprimer_parrainage(uuid),
  public.admin_supprimer_demande(uuid), public.admin_supprimer_message(uuid),
  public.admin_supprimer_salarie(uuid), public.admin_supprimer_compte_pro(uuid),
  public.admin_supprimer_zone(uuid), public.admin_supprimer_categorie(uuid),
  public.admin_supprimer_tarif(uuid), public.admin_supprimer_forfait(uuid)
  to authenticated;
