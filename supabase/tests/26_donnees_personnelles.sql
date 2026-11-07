-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Données personnelles du client (migration 27), joué après
-- 25_pourboire_client.sql. Une cliente d'essai, Romane, est créée avec tout
-- ce qu'un compte peut avoir (lieu, proche, appareil, notification, note
-- interne, compte professionnel, course pour un proche avec arrêt,
-- conversation, notes dans les deux sens, demande au support, solde,
-- session de connexion, correction de l'administration au journal) :
--   - mes_donnees : tout y est, rien des autres personnes ; réservé au client
--     connecté (chauffeur refusé, visiteur sans droit) ;
--   - supprimer_mon_compte : contrôles (mot de confirmation, course à venir,
--     paiement non réglé, dossier chauffeur, compte chauffeur), puis
--     suppression : effacé, gardé sans coordonnées, solde abandonné, journal
--     nettoyé, connexion fermée ; ensuite le compte ne sert plus à rien, la
--     même adresse peut ouvrir un nouveau compte ;
--   - administration : compte supprimé ni bloqué ni réactivé, à part dans la
--     liste des clients.
-- Tout se joue dans une transaction annulée à la fin : la base revient à son
-- état de départ.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set romane     e0000000-0000-4000-8000-000000000011

call test.systeme();
select count(*) as profils_avant, (select count(*) from public.courses) as courses_avant,
       (select count(*) from auth.users) as comptes_avant, (select count(*) from prive.journal) as journal_avant
from public.profils \gset
select cp.id as compte from public.comptes_pro cp where cp.statut = 'actif' order by cp.cree_le limit 1 \gset

begin;

-- #############################################################################
-- 0. ROMANE ET TOUT CE QU'UN COMPTE PEUT AVOIR
-- #############################################################################
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
values (:'romane', 'romane.petit@exemple.test', '{"prenom":"Romane","nom":"Petit"}', now() - interval '1 hour');
insert into auth.identities (provider_id, user_id, identity_data, provider)
values (:'romane', :'romane', '{"email":"romane.petit@exemple.test"}', 'email');
insert into auth.sessions (id, user_id, user_agent) values ('f0000000-0000-4000-8000-000000000011', :'romane', 'Android');
insert into auth.refresh_tokens (token, user_id, session_id) values ('jeton-romane', :'romane', 'f0000000-0000-4000-8000-000000000011');
reset role;

call test.systeme();
update public.profils set telephone = '+33655443322' where id = :'romane';
insert into public.lieux (client_id, type, adresse, latitude, longitude, precision)
values (:'romane', 'domicile', '8 rue des Lilas, 95270 Chaumontel', 49.1250, 2.4300, 'Code 4521, 2e étage');
insert into public.proches (client_id, nom, telephone, relation) values (:'romane', 'Mamie Petit', '+33677889900', 'Grand-mère');
insert into public.appareils (profil_id, endpoint, cle_p256dh, cle_auth, agent)
values (:'romane', 'https://push.exemple.test/romane', 'cle', 'auth', 'Chrome Android');
insert into public.notes_internes (profil_id, texte) values (:'romane', 'Préfère être appelée avant l''arrivée.');
insert into public.comptes_pro_membres (compte_pro_id, profil_id, role) values (:'compte', :'romane', 'membre');
select prive.ecrire_solde(:'romane', 7.50, 'Geste commercial', null);

-- Course pour sa grand-mère, avec un arrêt et une précision, terminée par Paul
call test.connexion(:'romane');
select c.id as course, c.numero as numero_course from public.commander_course(
  'berline_hybride', '8 rue des Lilas, 95270 Chaumontel', 49.1250, 2.4300, 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
  p_arrets => '[{"adresse":"Place de la Mairie, 95270 Luzarches","lat":49.1140,"lng":2.4220}]'::jsonb,
  p_depart_precision => 'Portail vert', p_pour_proche => true,
  p_beneficiaire_nom => 'Mamie Petit', p_beneficiaire_telephone => '+33677889900') c \gset
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'course', :'chauffeur1') \gset rien_
select public.avancer_course(:'course', 'arrivee') \gset rien_
select public.avancer_course(:'course', 'a_bord') \gset rien_
-- Correction de l'administration sur la course (inscrite au journal)
update public.courses set depart_precision = 'Portail vert, côté rue' where id = :'course';
select public.avancer_course(:'course', 'terminee') \gset rien_
call test.connexion(:'romane');
insert into public.messages (course_id, auteur_id, contenu) values (:'course', :'romane', 'Ma grand-mère vous attend devant le portail.');
select public.noter_course(:'course', 5, 'Très attentionné avec ma grand-mère') \gset rien_
call test.connexion(:'chauffeur1');
insert into public.messages (course_id, auteur_id, contenu) values (:'course', :'chauffeur1', 'Bien noté, merci Romane.');
select public.noter_course(:'course', 4) \gset rien_
call test.connexion(:'romane');
select (public.ouvrir_demande('objet_perdu', 'Écharpe oubliée', 'Une écharpe bleue, sur la banquette arrière.', :'course')).id as demande \gset
-- Correction de l'administration sur le profil (inscrite au journal)
call test.connexion(:'admin', 'aal2');
update public.profils set nom = 'Petit-Durand' where id = :'romane';


-- #############################################################################
-- 1. TÉLÉCHARGER MES DONNÉES
-- #############################################################################
call test.connexion(:'romane');
select public.mes_donnees() as donnees \gset
select test.verifier((:'donnees'::jsonb -> 'profil' ->> 'prenom') = 'Romane'
                     and (:'donnees'::jsonb -> 'profil' ->> 'nom') = 'Petit-Durand'
                     and (:'donnees'::jsonb -> 'profil' ->> 'telephone') = '+33655443322'
                     and (:'donnees'::jsonb -> 'connexion' ->> 'email') = 'romane.petit@exemple.test'
                     and (:'donnees'::jsonb -> 'a_propos' -> 'responsable_du_traitement' ->> 'raison_sociale') = 'LOC RÉACTION S.A.S',
                     'mes données : profil, connexion, responsable du traitement (LOC RÉACTION S.A.S)');
select test.verifier(jsonb_array_length(:'donnees'::jsonb -> 'lieux') = 1 and jsonb_array_length(:'donnees'::jsonb -> 'proches') = 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'appareils') = 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'comptes_professionnels') = 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'notes_de_loc_reaction') = 1
                     and (:'donnees'::jsonb -> 'solde' ->> 'montant')::numeric = 7.50,
                     'mes données : lieu, proche, appareil, compte professionnel, note de LOC RÉACTION, solde de 7,50 €');
select test.verifier(jsonb_array_length(:'donnees'::jsonb -> 'courses') = 1
                     and (:'donnees'::jsonb -> 'courses' -> 0 ->> 'numero') = :'numero_course'
                     and (:'donnees'::jsonb -> 'courses' -> 0 -> 'arrets' ->> 0) = 'Place de la Mairie, 95270 Luzarches'
                     and (:'donnees'::jsonb -> 'courses' -> 0 ->> 'proche_nom') = 'Mamie Petit'
                     and jsonb_array_length(:'donnees'::jsonb -> 'paiements') >= 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'factures') >= 1,
                     'mes données : la course (arrêt, proche), ses paiements et sa facture');
select test.verifier(jsonb_array_length(:'donnees'::jsonb -> 'conversations_courses') = 2
                     and (:'donnees'::jsonb -> 'conversations_courses' -> 0 ->> 'de') = 'vous'
                     and (:'donnees'::jsonb -> 'conversations_courses' -> 1 ->> 'de') = 'chauffeur'
                     and jsonb_array_length(:'donnees'::jsonb -> 'notes_donnees') = 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'notes_recues') = 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'demandes_support') = 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'demandes_support' -> 0 -> 'messages') = 1
                     and jsonb_array_length(:'donnees'::jsonb -> 'notifications') >= 1,
                     'mes données : conversation de la course, notes données et reçues, demande au support, notifications');
select test.verifier(position('Claire' in :'donnees') = 0 and position('Bernard' in :'donnees') = 0,
                     'mes données : rien des autres personnes (ni autre client, ni nom de famille du chauffeur)');
call test.connexion(:'chauffeur1');
select test.doit_echouer('select public.mes_donnees()', 'réservé aux comptes clients');
call test.visiteur();
select test.doit_echouer('select public.mes_donnees()', 'permission denied');
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'permission denied');


-- #############################################################################
-- 2. SUPPRIMER MON COMPTE : CONTRÔLES
-- #############################################################################
call test.connexion(:'romane');
select test.doit_echouer($$select public.supprimer_mon_compte('oui')$$, 'écrivez SUPPRIMER');
select test.doit_echouer($$select public.supprimer_mon_compte(null)$$, 'écrivez SUPPRIMER');
-- Réservation à venir
select c.id as reservation from public.commander_course(
  'berline_hybride', '8 rue des Lilas, 95270 Chaumontel', 49.1250, 2.4300, 'Aéroport Paris-Charles de Gaulle', 49.0097, 2.5479,
  p_type => 'planifiee', p_quand => now() + interval '2 days') c \gset
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'Une course est en cours ou à venir');
select public.annuler_course(:'reservation', 'Changement de programme') \gset rien_
-- Paiement signalé non réglé
call test.systeme();
update public.paiements set statut = 'echoue' where course_id = :'course' and nature = 'course';
call test.connexion(:'romane');
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'paiement est signalé non réglé');
call test.systeme();
update public.paiements set statut = 'a_encaisser' where course_id = :'course' and nature = 'course';
-- Dossier chauffeur ouvert
insert into public.candidatures (profil_id, ville, message) values (:'romane', 'Chaumontel', 'Je souhaite conduire.');
call test.connexion(:'romane');
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'dossier chauffeur est ouvert');
call test.systeme();
delete from public.candidatures where profil_id = :'romane';
-- Compte chauffeur
call test.connexion(:'chauffeur1');
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'réservée aux comptes clients');
call test.systeme();
select test.verifier((select statut from public.profils where id = :'romane') = 'actif'
                     and (select count(*) from public.lieux where client_id = :'romane') = 1,
                     'suppression refusée : rien n''a changé');


-- #############################################################################
-- 3. SUPPRIMER MON COMPTE
-- #############################################################################
select count(*) as courses_romane from public.courses where client_id = :'romane' \gset
select count(*) as factures_romane, min(destinataire_nom) as destinataire_facture from public.factures where client_id = :'romane' \gset
select count(*) as paiements_romane from public.paiements where client_id = :'romane' \gset
select prix_total as prix_course from public.courses where id = :'course' \gset
select code_parrainage as ancien_code from public.profils where id = :'romane' \gset
call test.connexion(:'romane');
select public.supprimer_mon_compte('  supprimer ') as resultat \gset
select test.verifier((:'resultat'::jsonb ->> 'supprime')::boolean
                     and (:'resultat'::jsonb ->> 'solde_abandonne')::numeric = 7.50
                     and (:'resultat'::jsonb ->> 'courses_gardees')::integer = :courses_romane,
                     'suppression acceptée (« supprimer » en minuscules) : solde abandonné, courses gardées');

call test.systeme();
select test.verifier((select prenom = '' and nom = '' and email is null and telephone is null and statut = 'supprime'
                             and not notif_email and not notif_whatsapp and not notif_push and code_parrainage <> :'ancien_code'
                      from public.profils where id = :'romane'),
                     'profil : identité et coordonnées effacées, notifications coupées, nouveau code, statut « supprimé »');
select test.verifier((select count(*) from public.lieux where client_id = :'romane') = 0
                     and (select count(*) from public.proches where client_id = :'romane') = 0
                     and (select count(*) from public.appareils where profil_id = :'romane') = 0
                     and (select count(*) from public.notifications where destinataire_id = :'romane') = 0
                     and (select count(*) from public.notes_internes where profil_id = :'romane') = 0
                     and (select count(*) from public.comptes_pro_membres where profil_id = :'romane') = 0,
                     'effacés : lieux, proches, appareils, notifications, notes internes, compte professionnel');
select test.verifier((select count(*) from public.messages where course_id = :'course') = 0
                     and (select count(*) from public.evaluations where cible_id = :'romane') = 0
                     and (select count(*) from public.evaluations where auteur_id = :'romane') = 1
                     and (select count(*) from public.demandes where auteur_id = :'romane') = 1
                     and (select count(*) from public.messages where demande_id = :'demande') = 1,
                     'effacées : conversation de la course, note du chauffeur sur elle ; gardées : sa note au chauffeur, sa demande au support');
select test.verifier((select client_prenom is null and client_telephone is null and depart_precision is null
                             and pour_proche and beneficiaire_nom = 'Proche' and beneficiaire_telephone is null
                             and prix_total = :prix_course and statut = 'terminee'
                      from public.courses where id = :'course')
                     and (select count(*) from public.courses where client_id = :'romane') = :courses_romane
                     and (select count(*) from public.course_arrets where course_id = :'course') = 1,
                     'course gardée (trajet, arrêt, prix) sans coordonnées : prénom, téléphone, précision, téléphone du proche (« Proche »)');
select test.verifier((select count(*) from public.factures where client_id = :'romane') = :factures_romane
                     and (select min(destinataire_nom) from public.factures where client_id = :'romane') = :'destinataire_facture'
                     and (select count(*) from public.paiements where client_id = :'romane') = :paiements_romane,
                     'factures (inchangées) et paiements gardés : obligation comptable');
select test.verifier((select montant from public.soldes where profil_id = :'romane') = 0
                     and exists (select 1 from public.ecritures_solde where profil_id = :'romane' and montant = -7.50
                                 and motif = 'Compte supprimé : solde abandonné'),
                     'solde de 7,50 € abandonné, avec son écriture « Compte supprimé : solde abandonné »');
select test.verifier(exists (select 1 from prive.journal where action = 'suppression_compte' and ligne_id = :'romane'
                                and acteur_id = :'romane' and (apres ->> 'solde_abandonne')::numeric = 7.50)
                     and exists (select 1 from prive.journal where table_cible = 'profils' and ligne_id = :'romane'
                                   and avant ->> 'statut' = 'actif' and apres ->> 'statut' = 'supprime')
                     and not exists (select 1 from prive.journal where ligne_id in (:'romane', :'course')
                                       and (coalesce(avant::text, '') || coalesce(apres::text, '')) ~ 'Romane|Petit|Portail|33655443322|33677889900'),
                     'journal : suppression et changement de statut inscrits, plus aucune coordonnée (profil, course)');
select test.verifier((select email is null and phone is null and encrypted_password is null and raw_user_meta_data = '{}'::jsonb
                             and banned_until > now() + interval '100 years' and deleted_at is not null
                      from auth.users where id = :'romane')
                     and (select count(*) from auth.sessions where user_id = :'romane') = 0
                     and (select count(*) from auth.refresh_tokens where user_id = :'romane') = 0
                     and (select count(*) from auth.identities where user_id = :'romane') = 0,
                     'connexion : adresse effacée, accès bloqué, sessions et identité retirées (tous les appareils)');

-- Le compte ne sert plus à rien ; la même adresse peut ouvrir un nouveau compte
call test.connexion(:'romane');
select test.doit_echouer('select public.mes_donnees()', 'Compte introuvable');
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'Compte introuvable');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.85, 2.35, 'B', 48.86, 2.36)$$, 'compte est suspendu');
call test.systeme();
set role supabase_auth_admin;
insert into auth.users (email, raw_user_meta_data) values ('romane.petit@exemple.test', '{"prenom":"Romane"}');
reset role;
select test.verifier((select count(*) from public.profils where email = 'romane.petit@exemple.test' and statut = 'actif' and id <> :'romane') = 1,
                     'même adresse : un nouveau compte s''ouvre, sans lien avec l''ancien');


-- #############################################################################
-- 4. ADMINISTRATION
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_statut_client(%L, %L, %L)', :'romane', 'bloque', 'Essai'), 'supprimé à la demande du client');
select test.doit_echouer(format('select public.admin_statut_client(%L, %L)', :'romane', 'actif'), 'supprimé à la demande du client');
select public.admin_lister_clients(p_limite => 5000) as tous \gset
select public.admin_lister_clients(p_statut => 'supprime', p_limite => 5000) as supprimes \gset
select test.verifier(not exists (select 1 from jsonb_array_elements(:'tous'::jsonb -> 'lignes') l where l ->> 'id' = :'romane')
                     and exists (select 1 from jsonb_array_elements(:'supprimes'::jsonb -> 'lignes') l
                                 where l ->> 'id' = :'romane' and l ->> 'statut' = 'supprime')
                     and (:'tous'::jsonb -> 'resume' ->> 'supprimes')::integer >= 1
                     and (:'tous'::jsonb -> 'resume' ->> 'clients')::integer
                         = (select count(*) from public.profils where role = 'client' and statut <> 'supprime'),
                     'liste des clients : compte supprimé absent de « Tous » et des chiffres, présent sous « Supprimés »');
select test.doit_echouer($$select public.admin_lister_clients(p_statut => 'efface')$$, 'Statut inconnu');


-- #############################################################################
-- 5. RETOUR À L'ÉTAT DE DÉPART
-- #############################################################################
rollback;
call test.systeme();
select test.verifier((select count(*) from public.profils) = :profils_avant
                     and (select count(*) from public.courses) = :courses_avant
                     and (select count(*) from auth.users) = :comptes_avant
                     and (select count(*) from prive.journal) = :journal_avant,
                     'données personnelles : retour à l''état de départ (comptes, courses, journal)');

\o
\echo '✔ Données personnelles du client : tout est conforme.'
