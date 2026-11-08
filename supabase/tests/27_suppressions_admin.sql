-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Suppressions par l'administration (migrations 28 et 29), joué après
-- 26_donnees_personnelles.sql :
--   - droits : chaque fonction est réservée à l'administration confirmée par
--     la double authentification (client, administrateur sans code, visiteur
--     refusés) ;
--   - comptes : cliente sans historique et candidate refusée (Zoé) effacée en
--     entier ; client avec une course (Bruno) vidé et « supprimé » ;
--     chauffeur jamais parti en course (Yann) effacé ; chauffeur avec une
--     course (Victor) vidé, dossier « supprimé », courses gardées sans ses
--     coordonnées ; compte au rôle chauffeur sans fiche (Hervé, migration
--     29) ; refus : soi-même, administrateur, chauffeur depuis les clients,
--     course à venir, course confiée, déjà supprimé ;
--   - candidature (le dossier d'un candidat part avec), document ;
--   - course (seulement terminée ou annulée, sans pièce comptable), paiement
--     (jamais encaissé, sans facture) ;
--   - véhicule (les courses gardent sa description), code promo utilisé,
--     notification groupée envoyée (retirée chez les destinataires),
--     parrainage, demande d'aide (pièce jointe, objet trouvé détaché),
--     message, salarié (refusé avec un bulletin validé), compte
--     professionnel (refusé avec des courses), lieu, catégorie, tarif,
--     forfait ;
--   - notes internes : tout administrateur peut les retirer ;
--   - file d'effacement des fichiers : chaque fichier des lignes effacées y
--     est, la session de l'administration la lit et la vide ; un fichier
--     encore cité n'est jamais proposé ;
--   - journal : chaque suppression inscrite, sans coordonnées ni numéros de
--     pièces des lignes effacées.
-- Tout se joue dans une transaction annulée à la fin : la base revient à son
-- état de départ.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set client3    c0000000-0000-4000-8000-000000000003
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set zoe        e0000000-0000-4000-8000-000000000021
\set victor     e0000000-0000-4000-8000-000000000022
\set yann       e0000000-0000-4000-8000-000000000023
\set bruno      e0000000-0000-4000-8000-000000000024
\set admin2     e0000000-0000-4000-8000-000000000025
\set lina       e0000000-0000-4000-8000-000000000026
\set herve      e0000000-0000-4000-8000-000000000027

call test.systeme();
select count(*) as profils_depart, (select count(*) from auth.users) as comptes_depart,
       (select count(*) from public.courses) as courses_depart, (select count(*) from prive.journal) as journal_depart
from public.profils \gset

begin;

-- #############################################################################
-- 0. LES COMPTES D'ESSAI
-- #############################################################################
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data) values
  (:'zoe',    'zoe.martin@exemple.test',   '{"prenom":"Zoé","nom":"Martin"}'),
  (:'victor', 'victor.leroy@exemple.test', '{"prenom":"Victor","nom":"Leroy"}'),
  (:'yann',   'yann.morel@exemple.test',   '{"prenom":"Yann","nom":"Morel"}'),
  (:'bruno',  'bruno.faure@exemple.test',  '{"prenom":"Bruno","nom":"Faure"}'),
  (:'admin2', 'admin2@exemple.test',       '{"prenom":"Agnès","nom":"Viala"}'),
  (:'lina',   'lina.haddad@exemple.test',  '{"prenom":"Lina","nom":"Haddad"}'),
  (:'herve',  'herve.blanc@exemple.test',  '{"prenom":"Hervé","nom":"Blanc"}');
insert into auth.identities (provider_id, user_id, identity_data, provider) values
  (:'zoe', :'zoe', '{"email":"zoe.martin@exemple.test"}', 'email'),
  (:'bruno', :'bruno', '{"email":"bruno.faure@exemple.test"}', 'email'),
  (:'yann', :'yann', '{"email":"yann.morel@exemple.test"}', 'email');
insert into auth.sessions (id, user_id, user_agent) values
  ('f0000000-0000-4000-8000-000000000024', :'bruno', 'Android'),
  ('f0000000-0000-4000-8000-000000000021', :'zoe', 'iPhone');
reset role;

call test.systeme();
update public.profils set telephone = '+33611110021' where id = :'zoe';
update public.profils set telephone = '+33611110022' where id = :'victor';
update public.profils set telephone = '+33611110023' where id = :'yann';
update public.profils set telephone = '+33611110024' where id = :'bruno';
update public.profils set telephone = '+33611110026' where id = :'lina';
update public.profils set role = 'admin' where id = :'admin2';
update public.profils set role = 'chauffeur' where id = :'herve';    -- rôle changé directement, sans fiche
select cat.id as berline from public.categories cat where cat.code = 'berline_hybride' \gset
select v.id as vehicule_paul from public.vehicules v where v.immatriculation = 'GA-123-BC' \gset

-- Zoé : candidate refusée (une pièce déposée), lieu, proche, appareil,
-- notification, note interne, filleule de Claire
call test.connexion(:'zoe');
select public.deposer_candidature('Paris', 'Un an de VTC', true, null, 'VTC-0021', null, 'PERMIS-0021', null) \gset rien_
insert into public.documents (chauffeur_id, type, fichier_chemin, numero)
values (:'zoe', 'permis', :'zoe' || '/permis-1.jpg', 'PERMIS-0021');
insert into storage.objects (bucket_id, name, owner) values ('documents', :'zoe' || '/permis-1.jpg', :'zoe');
insert into public.lieux (client_id, type, adresse, latitude, longitude) values (:'zoe', 'domicile', '4 rue Haute, 95270 Chaumontel', 49.12, 2.43);
insert into public.proches (client_id, nom, telephone, relation) values (:'zoe', 'Papa Martin', '+33677000021', 'Père');
insert into public.appareils (profil_id, endpoint, cle_p256dh, cle_auth, agent) values (:'zoe', 'https://push.exemple.test/zoe', 'cle', 'auth', 'Safari');
call test.systeme();
update public.chauffeurs set statut = 'refuse' where id = :'zoe';
update public.candidatures set statut = 'refusee', motif_refus = 'Carte VTC expirée', traitee_le = now() where profil_id = :'zoe';
select prive.notifier(:'zoe', 'info', 'Bienvenue', 'Bienvenue chez LOC RÉACTION.') \gset rien_
insert into public.notes_internes (profil_id, texte) values (:'zoe', 'A appelé pour sa candidature.');
insert into public.parrainages (parrain_id, filleul_id) values (:'client1', :'zoe');

-- Victor : chauffeur validé, une pièce, un véhicule (avec ses papiers et un
-- entretien), en ligne, une course terminée et notée
call test.connexion(:'victor');
select public.deposer_candidature('Paris', 'Cinq ans de VTC', true, null, 'VTC-0022', current_date + 300, 'PERMIS-0022', current_date + 800) \gset rien_
insert into public.documents (chauffeur_id, type, fichier_chemin, numero, expire_le)
values (:'victor', 'carte_vtc', :'victor' || '/carte_vtc-1.pdf', 'VTC-0022', current_date + 300);
insert into storage.objects (bucket_id, name, owner) values ('documents', :'victor' || '/carte_vtc-1.pdf', :'victor');
call test.connexion(:'admin', 'aal2');
insert into public.vehicules (categorie_id, immatriculation, marque, modele, couleur)
values (:'berline', 'GV-222-VV', 'Toyota', 'Corolla', 'Noir') returning id as vehicule_victor \gset
insert into public.documents (vehicule_id, type, fichier_chemin, expire_le)
values (:'vehicule_victor', 'assurance', 'vehicules/' || :'vehicule_victor' || '/assurance.pdf', current_date + 200);
insert into storage.objects (bucket_id, name) values ('documents', 'vehicules/' || :'vehicule_victor' || '/assurance.pdf');
insert into public.entretiens (vehicule_id, jour, type, montant) values (:'vehicule_victor', current_date - 10, 'vidange', 89);
select public.valider_candidature(:'victor', :'vehicule_victor', false) \gset rien_
call test.systeme();
insert into public.positions (chauffeur_id, en_ligne, latitude, longitude) values (:'victor', false, 48.86, 2.35)
on conflict (chauffeur_id) do nothing;
call test.connexion(:'client1');
select c.id as course_victor, c.numero as numero_victor from public.commander_course(
  'berline_hybride', '10 rue de Rivoli, 75004 Paris', 48.8556, 2.3600, 'Gare du Nord, 75010 Paris', 48.8809, 2.3553) c \gset
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'course_victor', :'victor') \gset rien_
select public.avancer_course(:'course_victor', 'arrivee') \gset rien_
select public.avancer_course(:'course_victor', 'a_bord') \gset rien_
select public.avancer_course(:'course_victor', 'terminee') \gset rien_
call test.connexion(:'client1');
select public.noter_course(:'course_victor', 5, 'Parfait') \gset rien_

-- Yann : chauffeur validé sans véhicule, une pièce, jamais parti en course
call test.connexion(:'yann');
select public.deposer_candidature('Lyon', 'Débutant', false, null, null, null, 'PERMIS-0023', current_date + 900) \gset rien_
insert into public.documents (chauffeur_id, type, fichier_chemin, numero)
values (:'yann', 'piece_identite', :'yann' || '/piece_identite-1.jpg', 'ID-0023');
insert into storage.objects (bucket_id, name, owner) values ('documents', :'yann' || '/piece_identite-1.jpg', :'yann');
call test.connexion(:'admin', 'aal2');
select public.valider_candidature(:'yann', null, false) \gset rien_
call test.systeme();
insert into public.positions (chauffeur_id, en_ligne, latitude, longitude) values (:'yann', false, 45.76, 4.83)
on conflict (chauffeur_id) do nothing;

-- Bruno : une course terminée (conduite par Paul), une réservation à venir,
-- un solde de 3 €
call test.connexion(:'bruno');
select c.id as course_bruno, c.numero as numero_bruno from public.commander_course(
  'berline_hybride', '4 rue Haute, 95270 Chaumontel', 49.12, 2.43, 'Gare de Luzarches, 95270 Luzarches', 49.11, 2.42,
  p_depart_precision => 'Devant la boulangerie') c \gset
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'course_bruno', :'chauffeur1') \gset rien_
select public.avancer_course(:'course_bruno', 'arrivee') \gset rien_
select public.avancer_course(:'course_bruno', 'a_bord') \gset rien_
select public.avancer_course(:'course_bruno', 'terminee') \gset rien_
call test.connexion(:'bruno');
select c.id as reservation_bruno, c.numero as numero_reservation from public.commander_course(
  'berline_hybride', '4 rue Haute, 95270 Chaumontel', 49.12, 2.43, 'Aéroport Paris-Charles de Gaulle', 49.0097, 2.5479,
  p_type => 'planifiee', p_quand => now() + interval '3 days') c \gset
call test.systeme();
select prive.ecrire_solde(:'bruno', 3, 'Geste commercial', null) \gset rien_

call test.systeme();
select coalesce(max(id), 0) as journal_avant from prive.journal \gset


-- #############################################################################
-- 1. DROITS : ADMINISTRATION CONFIRMÉE SEULEMENT
-- #############################################################################
create table test.fonctions_suppression (appel text);
grant select on test.fonctions_suppression to anon, authenticated;
insert into test.fonctions_suppression values
  ('select public.admin_supprimer_client(gen_random_uuid())'), ('select public.admin_supprimer_chauffeur(gen_random_uuid())'),
  ('select public.admin_supprimer_candidature(gen_random_uuid())'), ('select public.admin_supprimer_document(gen_random_uuid())'),
  ('select public.admin_supprimer_course(gen_random_uuid())'), ('select public.admin_supprimer_paiement(gen_random_uuid())'),
  ('select public.admin_supprimer_vehicule(gen_random_uuid())'), ('select public.admin_supprimer_code_promo(gen_random_uuid())'),
  ('select public.admin_supprimer_campagne(gen_random_uuid())'), ('select public.admin_supprimer_parrainage(gen_random_uuid())'),
  ('select public.admin_supprimer_demande(gen_random_uuid())'), ('select public.admin_supprimer_message(gen_random_uuid())'),
  ('select public.admin_supprimer_salarie(gen_random_uuid())'), ('select public.admin_supprimer_compte_pro(gen_random_uuid())'),
  ('select public.admin_supprimer_zone(gen_random_uuid())'), ('select public.admin_supprimer_categorie(gen_random_uuid())'),
  ('select public.admin_supprimer_tarif(gen_random_uuid())'), ('select public.admin_supprimer_forfait(gen_random_uuid())'),
  ('select * from public.admin_fichiers_a_effacer()'), ('select public.admin_fichiers_effaces()');

call test.connexion(:'client1');
select test.doit_echouer(appel, 'Réservé à l''administration') from test.fonctions_suppression;
call test.connexion(:'chauffeur1');
select test.doit_echouer(appel, 'Réservé à l''administration') from test.fonctions_suppression;
call test.connexion(:'admin');                                      -- sans le code de l'application
select test.doit_echouer(appel, 'Réservé à l''administration') from test.fonctions_suppression;
call test.visiteur();
select test.doit_echouer(appel, 'permission denied') from test.fonctions_suppression;
call test.connexion(:'admin', 'aal2');
select test.verifier(true, 'droits : 20 fonctions refusées au client, au chauffeur, à l''administrateur sans code et au visiteur');


-- #############################################################################
-- 2. COMPTES CLIENTS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_client(%L)', :'admin'), 'propre compte');
select test.doit_echouer(format('select public.admin_supprimer_client(%L)', :'admin2'), 'retirez d''abord son rôle');
select test.doit_echouer(format('select public.admin_supprimer_client(%L)', :'chauffeur1'), 'module Chauffeurs');
select test.doit_echouer(format('select public.admin_supprimer_client(%L)', :'victor'), 'module Chauffeurs');
select test.doit_echouer('select public.admin_supprimer_client(gen_random_uuid())', 'Compte introuvable');

-- Zoé : rien à garder → effacée en entier, candidature et pièce comprises
select public.admin_supprimer_client(:'zoe') as resultat \gset
select test.verifier((:'resultat'::jsonb ->> 'mode') = 'efface', 'Zoé : mode « effacé »');
call test.systeme();
select test.verifier(not exists (select 1 from auth.users where id = :'zoe')
                     and not exists (select 1 from auth.identities where user_id = :'zoe')
                     and not exists (select 1 from auth.sessions where user_id = :'zoe')
                     and not exists (select 1 from public.profils where id = :'zoe')
                     and not exists (select 1 from public.soldes where profil_id = :'zoe'),
                     'Zoé : connexion, identité, sessions, profil et solde effacés');
select test.verifier(not exists (select 1 from public.chauffeurs where id = :'zoe')
                     and not exists (select 1 from public.candidatures where profil_id = :'zoe')
                     and not exists (select 1 from public.documents where chauffeur_id = :'zoe')
                     and not exists (select 1 from public.lieux where client_id = :'zoe')
                     and not exists (select 1 from public.proches where client_id = :'zoe')
                     and not exists (select 1 from public.appareils where profil_id = :'zoe')
                     and not exists (select 1 from public.notifications where destinataire_id = :'zoe')
                     and not exists (select 1 from public.notes_internes where profil_id = :'zoe')
                     and not exists (select 1 from public.parrainages where filleul_id = :'zoe'),
                     'Zoé : dossier chauffeur, candidature, pièce, lieu, proche, appareil, notification, note, parrainage effacés');
select test.verifier(exists (select 1 from prive.fichiers_a_effacer where dossier = 'documents' and chemin = :'zoe' || '/permis-1.jpg'),
                     'Zoé : le fichier de son permis est en file d''effacement');
select test.verifier(not exists (select 1 from prive.journal j
                                  where (coalesce(j.avant::text, '') || coalesce(j.apres::text, '')) ~ '(Zoé|zoe\.martin|PERMIS-0021|VTC-0021|Carte VTC expirée|33611110021)'),
                     'Zoé : le journal ne garde ni son nom, ni ses coordonnées, ni ses numéros de pièces');

-- Bruno : réservation à venir → refus ; annulée, il garde une course terminée
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_client(%L)', :'bruno'), :'numero_reservation' || ' de ce compte est en cours ou à venir');
call test.connexion(:'bruno');
select public.annuler_course(:'reservation_bruno', 'Plus besoin') \gset rien_
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_client(:'bruno') as resultat \gset
select test.verifier((:'resultat'::jsonb ->> 'mode') = 'archive' and (:'resultat'::jsonb ->> 'courses_gardees')::integer = 2
                     and (:'resultat'::jsonb ->> 'solde_abandonne')::numeric = 3,
                     'Bruno : fiche vidée (2 courses gardées, solde de 3 € abandonné)');
call test.systeme();
select test.verifier((select prenom = '' and nom = '' and email is null and telephone is null and statut = 'supprime'
                      from public.profils where id = :'bruno'),
                     'Bruno : profil sans nom ni coordonnées, statut « supprimé »');
select test.verifier((select email is null and encrypted_password is null and banned_until > now() + interval '900 years' and deleted_at is not null
                      from auth.users where id = :'bruno')
                     and not exists (select 1 from auth.sessions where user_id = :'bruno')
                     and not exists (select 1 from auth.identities where user_id = :'bruno'),
                     'Bruno : connexion fermée (adresse effacée, accès bloqué, sessions et identité effacées)');
select test.verifier((select client_prenom is null and client_telephone is null and depart_precision is null and statut = 'terminee'
                      from public.courses where id = :'course_bruno')
                     and exists (select 1 from public.factures where course_id = :'course_bruno'),
                     'Bruno : sa course terminée et sa facture restent, sans ses coordonnées');
select test.verifier((select montant from public.soldes where profil_id = :'bruno') = 0, 'Bruno : solde à zéro');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_client(%L)', :'bruno'), 'déjà supprimé');


-- #############################################################################
-- 3. CHAUFFEURS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_chauffeur(%L)', :'client2'), 'Chauffeur introuvable');

-- Yann : jamais parti en course → effacé en entier
select public.admin_supprimer_chauffeur(:'yann') as resultat \gset
select test.verifier((:'resultat'::jsonb ->> 'mode') = 'efface', 'Yann : mode « effacé »');
call test.systeme();
select test.verifier(not exists (select 1 from auth.users where id = :'yann')
                     and not exists (select 1 from public.profils where id = :'yann')
                     and not exists (select 1 from public.chauffeurs where id = :'yann')
                     and not exists (select 1 from public.documents where chauffeur_id = :'yann')
                     and not exists (select 1 from public.positions where chauffeur_id = :'yann')
                     and not exists (select 1 from public.candidatures where profil_id = :'yann'),
                     'Yann : compte, dossier, pièce, position et candidature effacés');
select test.verifier(exists (select 1 from prive.fichiers_a_effacer where dossier = 'documents' and chemin = :'yann' || '/piece_identite-1.jpg'),
                     'Yann : le fichier de sa pièce d''identité est en file d''effacement');

-- Hervé : rôle « chauffeur » sans fiche chauffeur (migration 29) → effacé
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_chauffeur(:'herve') as resultat \gset
call test.systeme();
select test.verifier((:'resultat'::jsonb ->> 'mode') = 'efface' and not exists (select 1 from auth.users where id = :'herve'),
                     'Hervé : compte au rôle chauffeur sans fiche, supprimé depuis le module Chauffeurs');

-- Victor : une course terminée → dossier vidé et « supprimé »
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_chauffeur(:'victor') as resultat \gset
select test.verifier((:'resultat'::jsonb ->> 'mode') = 'archive' and (:'resultat'::jsonb ->> 'courses_gardees')::integer = 1,
                     'Victor : fiche vidée, 1 course gardée');
call test.systeme();
select test.verifier((select statut = 'supprime' and vehicule_id is null and carte_vtc_numero is null and permis_numero is null
                             and carte_vtc_expiration is null and permis_expiration is null and note_moyenne is null and nb_notes = 0
                      from public.chauffeurs where id = :'victor'),
                     'Victor : dossier « supprimé », sans véhicule, sans numéros de carte ni de permis, sans note');
select test.verifier((select prenom = '' and nom = '' and email is null and telephone is null and statut = 'supprime'
                      from public.profils where id = :'victor')
                     and (select email is null and banned_until > now() from auth.users where id = :'victor'),
                     'Victor : profil vidé, connexion fermée');
select test.verifier(not exists (select 1 from public.documents where chauffeur_id = :'victor')
                     and not exists (select 1 from public.positions where chauffeur_id = :'victor')
                     and not exists (select 1 from public.candidatures where profil_id = :'victor')
                     and not exists (select 1 from public.evaluations where cible_id = :'victor'),
                     'Victor : pièce, position, candidature et notes reçues effacées');
select test.verifier((select chauffeur_id = :'victor' and chauffeur_prenom is null and chauffeur_telephone is null
                             and chauffeur_photo is null and statut = 'terminee'
                      from public.courses where id = :'course_victor'),
                     'Victor : sa course reste, à son nom de fiche, sans son prénom ni son téléphone');
select test.verifier(not exists (select 1 from prive.journal j
                                  where j.table_cible in ('chauffeurs', 'documents', 'candidatures', 'profils', 'courses')
                                    and (coalesce(j.avant::text, '') || coalesce(j.apres::text, '')) ~ '(VTC-0022|PERMIS-0022|Victor|victor\.leroy|33611110022)'),
                     'Victor : le journal ne garde ni ses numéros de carte et de permis, ni son nom, ni ses coordonnées');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_chauffeur(%L)', :'victor'), 'déjà supprimé');


-- #############################################################################
-- 4. CANDIDATURE, DOCUMENT
-- #############################################################################
-- Lina : candidate en attente, une pièce ; sa candidature part avec son dossier
call test.connexion(:'lina');
select public.deposer_candidature('Marseille', 'Trois ans', true, 'Disponible le soir', 'VTC-0026', current_date + 100, null, null) \gset rien_
insert into public.documents (chauffeur_id, type, fichier_chemin, numero)
values (:'lina', 'carte_vtc', :'lina' || '/carte_vtc-1.jpg', 'VTC-0026');
insert into storage.objects (bucket_id, name, owner) values ('documents', :'lina' || '/carte_vtc-1.jpg', :'lina');
call test.connexion(:'admin', 'aal2');
select ca.id as candidature_lina from public.candidatures ca where ca.profil_id = :'lina' \gset
select public.admin_supprimer_candidature(:'candidature_lina') as resultat \gset
call test.systeme();
select test.verifier((:'resultat'::jsonb ->> 'dossier_retire')::boolean
                     and not exists (select 1 from public.candidatures where profil_id = :'lina')
                     and not exists (select 1 from public.chauffeurs where id = :'lina')
                     and not exists (select 1 from public.documents where chauffeur_id = :'lina')
                     and exists (select 1 from public.profils where id = :'lina' and statut = 'actif' and role = 'client')
                     and exists (select 1 from prive.fichiers_a_effacer where chemin = :'lina' || '/carte_vtc-1.jpg'),
                     'candidature de Lina : effacée avec son dossier et sa pièce (fichier en file) ; son compte client reste');
-- Chauffeur validé : seule la trace de sa candidature part
select ca.id as candidature_paul from public.candidatures ca where ca.profil_id = :'chauffeur1' \gset
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_candidature(:'candidature_paul') as resultat \gset
select test.verifier(not (:'resultat'::jsonb ->> 'dossier_retire')::boolean
                     and (select statut from public.chauffeurs where id = :'chauffeur1') = 'valide',
                     'candidature d''un chauffeur validé : effacée, le chauffeur reste');
select test.doit_echouer(format('select public.admin_supprimer_candidature(%L)', :'candidature_paul'), 'Candidature introuvable');

-- Document : papier du véhicule de Paul
select d.id as assurance_paul, d.fichier_chemin as chemin_assurance_paul from public.documents d
 where d.vehicule_id = :'vehicule_paul' and d.type = 'assurance' limit 1 \gset
call test.systeme();
insert into storage.objects (bucket_id, name) values ('documents', :'chemin_assurance_paul') on conflict do nothing;
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_document(:'assurance_paul') \gset rien_
call test.systeme();
select test.verifier(not exists (select 1 from public.documents where id = :'assurance_paul')
                     and exists (select 1 from prive.fichiers_a_effacer where chemin = :'chemin_assurance_paul'),
                     'document : effacé, son fichier en file');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_document(%L)', :'assurance_paul'), 'Document introuvable');


-- #############################################################################
-- 5. COURSES, PAIEMENTS
-- #############################################################################
-- Course de Hugo confiée à Paul, en cours : ni la course, ni Paul, ni son
-- véhicule ne se suppriment
call test.connexion(:'client2');
select c.id as course_hugo, c.numero as numero_hugo from public.commander_course(
  'berline_hybride', '1 place de la Concorde, 75008 Paris', 48.8656, 2.3212, 'Gare de Lyon, 75012 Paris', 48.8443, 2.3744) c \gset
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'course_hugo', :'chauffeur1') \gset rien_
select public.avancer_course(:'course_hugo', 'arrivee') \gset rien_
select test.doit_echouer(format('select public.admin_supprimer_course(%L)', :'course_hugo'), 'n''est pas terminée');
select test.doit_echouer(format('select public.admin_supprimer_chauffeur(%L)', :'chauffeur1'), :'numero_hugo' || ' est confiée à ce chauffeur');
select test.doit_echouer(format('select public.admin_supprimer_vehicule(%L)', :'vehicule_paul'), 'fait la course ' || :'numero_hugo' || ' en ce moment');
call test.systeme();
insert into public.messages (course_id, auteur_id, contenu) values (:'course_hugo', :'client2', 'Je suis devant.') returning id as message_hugo \gset
call test.connexion(:'admin', 'aal2');
select test.verifier((public.admin_fiche_course(:'course_hugo') -> 'conversation' -> 0 ->> 'id') = :'message_hugo',
                     'fiche de la course : chaque message de la conversation porte son identifiant (migration 29)');
select public.admin_supprimer_message(:'message_hugo') \gset rien_
select test.verifier(not exists (select 1 from public.messages where id = :'message_hugo'), 'message de la conversation : effacé');
select test.doit_echouer(format('select public.admin_supprimer_message(%L)', :'message_hugo'), 'Message introuvable');
select public.avancer_course(:'course_hugo', 'a_bord') \gset rien_
select public.avancer_course(:'course_hugo', 'terminee') \gset rien_
select f.numero as facture_hugo from public.factures f where f.course_id = :'course_hugo' and f.nature = 'course' \gset
select test.doit_echouer(format('select public.admin_supprimer_course(%L)', :'course_hugo'), 'La facture ' || :'facture_hugo' || ' a été émise');

-- Pourboire en espèces jamais encaissé : il se supprime ; le paiement de la
-- course (facturée) non ; un paiement encaissé non plus
call test.connexion(:'client2');
select public.ajouter_pourboire(:'course_hugo', 2) \gset rien_
call test.systeme();
select pa.id as pourboire_hugo from public.paiements pa where pa.course_id = :'course_hugo' and pa.nature = 'pourboire' \gset
select pa.id as paiement_hugo from public.paiements pa where pa.course_id = :'course_hugo' and pa.nature = 'course' \gset
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_paiement(:'pourboire_hugo') \gset rien_
select test.verifier(not exists (select 1 from public.paiements where id = :'pourboire_hugo'), 'pourboire jamais encaissé : effacé');
select test.doit_echouer(format('select public.admin_supprimer_paiement(%L)', :'paiement_hugo'), 'La facture ' || :'facture_hugo' || ' a été émise pour ce montant');
call test.systeme();
update public.paiements set statut = 'encaisse', encaisse_le = now() where id = :'paiement_hugo';
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_paiement(%L)', :'paiement_hugo'), 'Un paiement encaissé est une écriture comptable');

-- Course annulée sans frais : effacée ; la demande d'aide qui la citait reste,
-- détachée ; les notifications qui y menaient partent
call test.connexion(:'client2');
select c.id as course_annulee, c.numero as numero_annulee from public.commander_course(
  'berline_hybride', '1 place de la Concorde, 75008 Paris', 48.8656, 2.3212, 'Gare de Lyon, 75012 Paris', 48.8443, 2.3744) c \gset
select public.annuler_course(:'course_annulee', 'Erreur de commande') \gset rien_
select (public.ouvrir_demande('course', 'Commande en double', 'J''ai commandé deux fois.', :'course_annulee')).id as demande_course \gset
call test.systeme();
select prive.notifier(:'client2', 'course', 'Course annulée', 'Votre course est annulée.', '/client/course/?id=' || :'course_annulee') \gset rien_
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_course(:'course_annulee') as resultat \gset
call test.systeme();
select test.verifier((:'resultat'::jsonb ->> 'numero') = :'numero_annulee'
                     and not exists (select 1 from public.courses where id = :'course_annulee')
                     and not exists (select 1 from public.evenements_course where course_id = :'course_annulee')
                     and not exists (select 1 from public.notifications where lien like '%' || :'course_annulee' || '%')
                     and (select course_id is null from public.demandes where id = :'demande_course'),
                     'course annulée sans frais : effacée, historique et notifications compris ; la demande d''aide reste, détachée');
select test.verifier(not exists (select 1 from prive.journal j where j.table_cible = 'courses' and j.ligne_id = :'course_annulee'
                                   and (coalesce(j.avant ?| array['depart_adresse', 'arrivee_adresse', 'client_prenom', 'client_telephone'], false)
                                        or coalesce(j.apres ?| array['depart_adresse', 'arrivee_adresse', 'client_prenom', 'client_telephone'], false))),
                     'course effacée : le journal ne garde ni les adresses ni le client');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_course(%L)', :'course_annulee'), 'Course introuvable');


-- #############################################################################
-- 6. FLOTTE, MARKETING
-- #############################################################################
-- Véhicule de Victor : ses papiers et son entretien partent ; la course de
-- Victor garde sa description
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_vehicule(:'vehicule_victor') \gset rien_
call test.systeme();
select test.verifier(not exists (select 1 from public.vehicules where id = :'vehicule_victor')
                     and not exists (select 1 from public.documents where vehicule_id = :'vehicule_victor')
                     and not exists (select 1 from public.entretiens where vehicule_id = :'vehicule_victor')
                     and (select vehicule_id is null and vehicule_immatriculation = 'GV-222-VV' from public.courses where id = :'course_victor')
                     and exists (select 1 from prive.fichiers_a_effacer where chemin = 'vehicules/' || :'vehicule_victor' || '/assurance.pdf'),
                     'véhicule : effacé avec ses papiers (fichier en file) et son entretien ; la course garde son immatriculation');

-- Code promo déjà utilisé : la course garde sa remise
call test.systeme();
insert into public.codes_promo (code, type, valeur) values ('ADIEU5', 'montant', 5) returning id as code_adieu \gset
update public.courses set code_promo_id = :'code_adieu' where id = :'course_hugo';
insert into public.utilisations_promo (code_promo_id, client_id, course_id, remise) values (:'code_adieu', :'client2', :'course_hugo', 5);
select remise as remise_hugo from public.courses where id = :'course_hugo' \gset
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_code_promo(:'code_adieu') as resultat \gset
call test.systeme();
select test.verifier((:'resultat'::jsonb ->> 'utilisations')::integer = 1
                     and not exists (select 1 from public.codes_promo where id = :'code_adieu')
                     and not exists (select 1 from public.utilisations_promo where code_promo_id = :'code_adieu')
                     and (select code_promo_id is null and remise = :remise_hugo from public.courses where id = :'course_hugo'),
                     'code promo utilisé : effacé avec ses utilisations ; la course garde sa remise');

-- Notification groupée envoyée : retirée aussi chez ses destinataires
insert into public.campagnes (titre, message, cible, canal, envoyee_le, nb_destinataires)
values ('Fermeture exceptionnelle', 'Le service ferme le 25 décembre.', 'clients', 'application', now(), 2) returning id as campagne \gset
insert into public.notifications (destinataire_id, type, titre, message, campagne_id) values
  (:'client1', 'info', 'Fermeture exceptionnelle', 'Le service ferme le 25 décembre.', :'campagne'),
  (:'client2', 'info', 'Fermeture exceptionnelle', 'Le service ferme le 25 décembre.', :'campagne');
select test.doit_echouer(format('update public.campagnes set titre = %L where id = %L', 'Autre', :'campagne'), 'déjà envoyée');
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_campagne(:'campagne') as resultat \gset
call test.systeme();
select test.verifier((:'resultat'::jsonb ->> 'notifications_retirees')::integer = 2
                     and not exists (select 1 from public.campagnes where id = :'campagne')
                     and not exists (select 1 from public.notifications where campagne_id = :'campagne'),
                     'notification groupée envoyée : effacée, retirée chez ses 2 destinataires (elle reste non modifiable)');

-- Parrainage
insert into public.parrainages (parrain_id, filleul_id) values (:'client2', :'client3') returning id as parrainage \gset
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_parrainage(:'parrainage') \gset rien_
select test.verifier(not exists (select 1 from public.parrainages where id = :'parrainage'), 'parrainage : effacé');


-- #############################################################################
-- 7. SUPPORT : DEMANDE AVEC PIÈCE JOINTE ET OBJET TROUVÉ
-- #############################################################################
call test.connexion(:'client1');
select (public.ouvrir_demande('objet_perdu', 'Sac oublié', 'Un sac noir sur la banquette.', null)).id as demande \gset
call test.systeme();
insert into public.messages (demande_id, auteur_id, contenu, piece_jointe_chemin)
values (:'demande', :'client1', 'Photo du sac', :'demande' || '/sac.jpg');
insert into storage.objects (bucket_id, name, owner) values ('support', :'demande' || '/sac.jpg', :'client1');
select prive.notifier(:'client1', 'info', 'Réponse du support', 'Nous cherchons votre sac.', '/client/aide/?demande=' || :'demande') \gset rien_
call test.connexion(:'admin', 'aal2');
select public.admin_enregistrer_objet(null, null, 'Sac noir', 'Bureau de Chaumontel', current_date, :'demande') ->> 'id' as objet \gset
select public.admin_supprimer_demande(:'demande') \gset rien_
call test.systeme();
select test.verifier(not exists (select 1 from public.demandes where id = :'demande')
                     and not exists (select 1 from public.messages where demande_id = :'demande')
                     and not exists (select 1 from public.notifications where lien like '%' || :'demande' || '%')
                     and (select demande_id is null from public.objets_trouves where id = :'objet')
                     and exists (select 1 from prive.fichiers_a_effacer where dossier = 'support' and chemin = :'demande' || '/sac.jpg'),
                     'demande d''aide : effacée avec ses messages et sa notification, pièce jointe en file ; l''objet trouvé reste, détaché');
select test.verifier(not exists (select 1 from prive.journal j where j.table_cible = 'demandes' and j.ligne_id = :'demande'
                                   and (coalesce(j.avant ? 'sujet', false) or coalesce(j.apres ? 'sujet', false))),
                     'demande effacée : le journal ne garde pas son sujet');


-- #############################################################################
-- 8. RH : SALARIÉ
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select (public.admin_enregistrer_salarie(null, jsonb_build_object(
  'civilite', 'Monsieur', 'prenom', 'Théo', 'nom', 'Essai', 'date_naissance', '1990-02-02', 'lieu_naissance', 'Nantes',
  'nationalite', 'Française', 'numero_securite_sociale', '190024412345635', 'adresse', '2 rue du Test', 'code_postal', '95270',
  'ville', 'Chaumontel', 'type_contrat', 'CDI', 'temps', 'plein', 'date_entree', '2026-11-02', 'salaire_base_mensuel', 1900,
  'iban', 'FR7630006000011234567890189'))) ->> 'id' as theo \gset
call test.systeme();
insert into public.contrats (salarie_id, type, date_debut, pdf_chemin) values (:'theo', 'CDI', '2026-11-02', :'theo' || '/contrat-brouillon.pdf');
insert into storage.objects (bucket_id, name) values ('paie', :'theo' || '/contrat-brouillon.pdf');
-- Un second salarié avec un bulletin validé : refusé
call test.connexion(:'admin', 'aal2');
select (public.admin_enregistrer_salarie(null, jsonb_build_object(
  'civilite', 'Madame', 'prenom', 'Ana', 'nom', 'Payée', 'type_contrat', 'CDI', 'temps', 'plein', 'date_entree', '2026-09-01',
  'salaire_base_mensuel', 1900))) ->> 'id' as ana \gset
call test.systeme();
insert into public.bulletins (salarie_id, periode, statut) values (:'ana', '2026-10-01', 'valide');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_salarie(%L)', :'ana'), 'bulletins de paie validés');
select public.admin_supprimer_salarie(:'theo') \gset rien_
call test.systeme();
select test.verifier(not exists (select 1 from public.salaries where id = :'theo')
                     and not exists (select 1 from public.contrats where salarie_id = :'theo')
                     and exists (select 1 from prive.fichiers_a_effacer where dossier = 'paie' and chemin = :'theo' || '/contrat-brouillon.pdf'),
                     'salarié sans bulletin validé : effacé avec son contrat brouillon (fichier en file)');
select test.verifier(not exists (select 1 from prive.journal j where j.table_cible = 'salaries' and j.ligne_id = :'theo'
                                   and (coalesce(j.avant::text, '') || coalesce(j.apres::text, '')) ~ '(190024412345635|FR7630006000011234567890189|Théo|rue du Test)'),
                     'salarié effacé : le journal ne garde ni son n° de Sécurité sociale, ni son IBAN, ni son nom, ni son adresse');


-- #############################################################################
-- 9. COMPTE PROFESSIONNEL
-- #############################################################################
call test.systeme();
insert into public.comptes_pro (raison_sociale, email_facturation) values ('Société Passée', 'compta@passee.test') returning id as pro_passe \gset
update public.courses set compte_pro_id = :'pro_passe' where id = :'course_victor';
insert into public.comptes_pro (raison_sociale, email_facturation, contact_nom) values ('Société Éphémère', 'contact@ephemere.test', 'Jean Test')
returning id as pro_neuf \gset
insert into public.comptes_pro_membres (compte_pro_id, profil_id, role) values (:'pro_neuf', :'client2', 'membre');
insert into public.notes_internes (compte_pro_id, texte) values (:'pro_neuf', 'Contrat à signer.');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_compte_pro(%L)', :'pro_passe'), 'Ce compte a 1 course');
select public.admin_supprimer_compte_pro(:'pro_neuf') \gset rien_
call test.systeme();
select test.verifier(not exists (select 1 from public.comptes_pro where id = :'pro_neuf')
                     and not exists (select 1 from public.comptes_pro_membres where compte_pro_id = :'pro_neuf')
                     and not exists (select 1 from public.notes_internes where compte_pro_id = :'pro_neuf'),
                     'compte professionnel sans course : effacé avec ses membres et ses notes');


-- #############################################################################
-- 10. TARIFS : LIEUX, FORFAITS, CATÉGORIE, TARIFS
-- #############################################################################
call test.systeme();
insert into public.zones (code, nom, type, latitude, longitude, rayon_km) values
  ('essai_a', 'Lieu A', 'autre', 48.80, 2.30, 1), ('essai_b', 'Lieu B', 'autre', 48.81, 2.31, 1),
  ('essai_c', 'Lieu C', 'autre', 48.82, 2.32, 1), ('essai_d', 'Lieu D', 'autre', 48.83, 2.33, 1);
select id as zone_a from public.zones where code = 'essai_a' \gset
select id as zone_b from public.zones where code = 'essai_b' \gset
select id as zone_c from public.zones where code = 'essai_c' \gset
select id as zone_d from public.zones where code = 'essai_d' \gset
insert into public.forfaits (categorie_id, zone_a_id, zone_b_id, prix) values (:'berline', :'zone_a', :'zone_b', 60) returning id as forfait_utilise \gset
insert into public.forfaits (categorie_id, zone_a_id, zone_b_id, prix) values (:'berline', :'zone_b', :'zone_c', 45) returning id as forfait_libre \gset
update public.courses set forfait_id = :'forfait_utilise' where id = :'course_hugo';
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_zone(%L)', :'zone_a'), 'payées au forfait depuis ou vers « Lieu A »');
select test.doit_echouer(format('select public.admin_supprimer_forfait(%L)', :'forfait_utilise'), 'a servi à 1 course');
select public.admin_supprimer_zone(:'zone_c') as resultat \gset
call test.systeme();
select test.verifier((:'resultat'::jsonb ->> 'forfaits_retires')::integer = 1
                     and not exists (select 1 from public.zones where id = :'zone_c')
                     and not exists (select 1 from public.forfaits where id = :'forfait_libre'),
                     'lieu sans course au forfait : effacé avec son forfait jamais utilisé');
insert into public.forfaits (categorie_id, zone_a_id, zone_b_id, prix) values (:'berline', :'zone_a', :'zone_d', 30)
returning id as forfait_seul \gset
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_forfait(:'forfait_seul') \gset rien_
select test.verifier(not exists (select 1 from public.forfaits where id = :'forfait_seul'), 'forfait jamais utilisé : effacé');

-- Catégorie : commandée → refus ; nouvelle catégorie avec un véhicule →
-- refus ; dernière active → refus ; sinon effacée avec ses tarifs et forfaits
call test.systeme();
insert into public.categories (code, nom_fr, nom_en, places, bagages, ordre, active)
values ('essai_van', 'Van d''essai', 'Test van', 7, 6, 9, true) returning id as van \gset
insert into public.tarifs (categorie_id, valide_du, prise_en_charge, prix_km, prix_minute, minimum, prix_attente_minute, frais_annulation, supplement_chauffeuse)
values (:'van', prive.heure_paris()::date, 5, 2, 0.5, 15, 0.5, 10, 0) returning id as tarif_van \gset
insert into public.tarifs (categorie_id, valide_du, prise_en_charge, prix_km, prix_minute, minimum, prix_attente_minute, frais_annulation, supplement_chauffeuse)
values (:'van', prive.heure_paris()::date + 30, 6, 2, 0.5, 15, 0.5, 10, 0) returning id as tarif_van_futur \gset
insert into public.forfaits (categorie_id, zone_a_id, zone_b_id, prix) values (:'van', :'zone_a', :'zone_b', 90);
insert into public.vehicules (categorie_id, immatriculation, marque, modele) values (:'van', 'VN-777-AN', 'Renault', 'Trafic')
returning id as vehicule_van \gset
select t.id as tarif_berline from public.tarifs t where t.categorie_id = :'berline' order by t.valide_du limit 1 \gset
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_categorie(%L)', :'berline'), 'Des courses ont été commandées en « Berline');
select test.doit_echouer(format('select public.admin_supprimer_tarif(%L)', :'tarif_berline'), 'a servi à calculer');
select test.doit_echouer(format('select public.admin_supprimer_tarif(%L)', :'tarif_van'), 'C''est le tarif en vigueur');
select public.admin_supprimer_tarif(:'tarif_van_futur') \gset rien_
select test.verifier(not exists (select 1 from public.tarifs where id = :'tarif_van_futur'), 'tarif à venir : effacé');
select test.doit_echouer(format('select public.admin_supprimer_categorie(%L)', :'van'), 'Des véhicules sont classés en « Van d''essai »');
select public.admin_supprimer_vehicule(:'vehicule_van') \gset rien_
call test.systeme();
update public.categories set active = false where id = :'berline';
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_categorie(%L)', :'van'), 'dernière catégorie active');
call test.systeme();
update public.categories set active = true where id = :'berline';
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_categorie(:'van') \gset rien_
call test.systeme();
select test.verifier(not exists (select 1 from public.categories where id = :'van')
                     and not exists (select 1 from public.tarifs where categorie_id = :'van')
                     and not exists (select 1 from public.forfaits where categorie_id = :'van'),
                     'catégorie jamais commandée : effacée avec ses tarifs et ses forfaits');


-- #############################################################################
-- 11. NOTES INTERNES : TOUT ADMINISTRATEUR LES RETIRE
-- #############################################################################
call test.connexion(:'admin', 'aal2');
insert into public.notes_internes (profil_id, texte) values (:'client2', 'Client fidèle.') returning id as note \gset
call test.connexion(:'admin2', 'aal2');
delete from public.notes_internes where id = :'note';
call test.systeme();
select test.verifier(not exists (select 1 from public.notes_internes where id = :'note'),
                     'note interne : retirée par un autre administrateur que son auteur');


-- #############################################################################
-- 12. FILE D'EFFACEMENT DES FICHIERS
-- #############################################################################
-- Un fichier encore cité par une ligne n'est jamais proposé
call test.systeme();
select d.fichier_chemin as chemin_cite from public.documents d where d.fichier_chemin is not null and d.chauffeur_id = :'chauffeur1' limit 1 \gset
insert into storage.objects (bucket_id, name) values ('documents', :'chemin_cite') on conflict do nothing;
select prive.fichier_a_effacer('documents', :'chemin_cite', 'essai') \gset rien_

call test.connexion(:'admin', 'aal2');
create temp table a_effacer on commit drop as select * from public.admin_fichiers_a_effacer();
select test.verifier((select count(*) from a_effacer
                       where (dossier, chemin) in (('documents', :'zoe' || '/permis-1.jpg'), ('documents', :'yann' || '/piece_identite-1.jpg'),
                                                   ('documents', :'victor' || '/carte_vtc-1.pdf'), ('documents', :'lina' || '/carte_vtc-1.jpg'),
                                                   ('documents', 'vehicules/' || :'vehicule_victor' || '/assurance.pdf'),
                                                   ('documents', :'chemin_assurance_paul'),
                                                   ('support', :'demande' || '/sac.jpg'), ('paie', :'theo' || '/contrat-brouillon.pdf'))) = 8,
                     'file : les 8 fichiers des lignes effacées sont proposés à la session de l''administration');
select test.verifier(not exists (select 1 from a_effacer where chemin = :'chemin_cite'),
                     'file : un fichier encore cité par une ligne n''est jamais proposé');

-- L'API de stockage efface les fichiers ; la file oublie ce qui n'existe plus
-- et ce qui est cité de nouveau
call test.systeme();
delete from storage.objects o using a_effacer a where o.bucket_id = a.dossier and o.name = a.chemin;
call test.connexion(:'admin', 'aal2');
select public.admin_fichiers_effaces() as oublies \gset
call test.systeme();
select test.verifier(:oublies >= 9
                     and not exists (select 1 from prive.fichiers_a_effacer f join a_effacer a on a.dossier = f.dossier and a.chemin = f.chemin)
                     and not exists (select 1 from prive.fichiers_a_effacer where chemin = :'chemin_cite')
                     and exists (select 1 from storage.objects where bucket_id = 'documents' and name = :'chemin_cite'),
                     'file : vidée des fichiers effacés et du fichier cité (qui reste dans le stockage)');
call test.connexion(:'admin', 'aal2');
select test.verifier(not exists (select 1 from public.admin_fichiers_a_effacer() f where f.chemin in (select chemin from a_effacer)),
                     'file : plus rien à proposer');


-- #############################################################################
-- 13. JOURNAL : CHAQUE SUPPRESSION INSCRITE
-- #############################################################################
call test.systeme();
select test.verifier((select count(*) from prive.journal j where j.id > :journal_avant and j.acteur_id = :'admin' and j.acteur_role = 'admin'
                       and j.action in ('suppression_compte', 'suppression_candidature', 'suppression_document', 'suppression_course',
                                        'suppression_paiement', 'suppression_vehicule', 'suppression_code_promo', 'suppression_campagne',
                                        'suppression_parrainage', 'suppression_demande', 'suppression_message', 'suppression_salarie',
                                        'suppression_compte_pro', 'suppression_zone', 'suppression_forfait', 'suppression_tarif',
                                        'suppression_categorie')) = 23,
                     'journal : les 23 suppressions sont inscrites au nom de l''administrateur');
select test.verifier((select count(*) from prive.journal j where j.id > :journal_avant and j.action = 'suppression_compte'
                       and j.apres ->> 'par' = 'administration'
                       and j.apres ->> 'mode' = case j.ligne_id when :'zoe' then 'efface' when :'yann' then 'efface'
                                                when :'herve' then 'efface' else 'archive' end) = 5,
                     'journal : 5 comptes supprimés (Zoé, Yann et Hervé effacés, Bruno et Victor vidés)');

rollback;

-- La base est revenue à son état de départ
call test.systeme();
select test.verifier((select count(*) from public.profils) = :profils_depart and (select count(*) from auth.users) = :comptes_depart
                     and (select count(*) from public.courses) = :courses_depart and (select count(*) from prive.journal) = :journal_depart,
                     'transaction annulée : la base est revenue à son état de départ');
\o
\echo '✔ Suppressions par l''administration : tout est conforme.'
