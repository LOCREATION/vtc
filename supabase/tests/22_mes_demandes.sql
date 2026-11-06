-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Mes demandes au support (migration 23), jouée après
-- 21_notifications_messages.sql sur les mêmes comptes fictifs : un chauffeur
-- ouvre une demande sur sa course (contrôles lisibles), la retrouve dans
-- mes_demandes() avec les réponses non lues, reçoit les notifications du
-- support avec le lien de la demande, répond (LOC RÉACTION prévenue), joint
-- une photo dans le dossier de sa demande seulement ; une demande résolue ne
-- s'écrit plus ; pour un client, pas encore de lien.
-- Tout ce qui est créé ici est retiré à la fin.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set chauffeur1 d0000000-0000-4000-8000-000000000001

call test.systeme();
select id as course1, numero as numero1 from public.courses
 where chauffeur_id = :'chauffeur1' and statut = 'terminee' order by cree_le limit 1 \gset
select count(*) as demandes_avant from public.demandes \gset
select count(*) as messages_avant from public.messages \gset
create temp table instantane_notifications as select * from public.notifications;
select now() as debut_essai \gset


-- #############################################################################
-- 1. LE CHAUFFEUR OUVRE UNE DEMANDE SUR SA COURSE
-- #############################################################################
call test.connexion(:'chauffeur1');
select test.doit_echouer($$select public.ouvrir_demande('inconnu', 'Client absent', 'Le client n''est pas venu.')$$,
                         'Type de demande inconnu.');
select test.doit_echouer($$select public.ouvrir_demande('course', 'ab', 'Le client n''est pas venu.')$$,
                         'Sujet : de 3 à 200 caractères.');
select test.doit_echouer(format('select public.ouvrir_demande(%L, %L, %L)', 'autre', 'Message trop long', repeat('a', 2001)),
                         'Message trop long : 2 000 caractères au plus.');
select id as demande1, numero as numero_demande1
  from public.ouvrir_demande('course', 'Client absent au rendez-vous', 'Le client n''est jamais venu au point de prise en charge.', :'course1') \gset
select '/chauffeur/demandes/?id=' || :'demande1' as lien_demande1 \gset

call test.systeme();
select test.verifier((select count(*) from public.notifications where cree_le >= :'debut_essai'
                        and titre = 'Nouvelle demande au support' and lien = '/admin/support/?demande=' || :'demande1') >= 1,
                     'nouvelle demande : l''administration prévenue, lien direct vers la demande');

call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from jsonb_array_elements(public.mes_demandes()) e
                       where e->>'id' = :'demande1' and e->>'statut' = 'ouverte' and e->>'course_numero' = :'numero1'
                         and (e->>'non_lus')::int = 0 and e->>'type' = 'course') = 1,
                     'mes_demandes : la demande, sa course, aucune réponse non lue');
select test.verifier((select (public.mes_demandes()->0->>'id')) = :'demande1',
                     'mes_demandes : la plus récemment active en premier');
call test.connexion(:'client1');
select test.verifier(not exists (select 1 from jsonb_array_elements(public.mes_demandes()) e where e->>'id' = :'demande1'),
                     'mes_demandes : un client ne voit pas la demande d''un chauffeur');


-- #############################################################################
-- 2. RÉPONSE DE LOC RÉACTION : NOTIFICATION AVEC LE LIEN DE LA DEMANDE
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_repondre_demande(:'demande1', 'Nous appelons le client et revenons vers vous.');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'chauffeur1' and cree_le >= :'debut_essai'
                        and titre = 'Réponse du support' and lien = :'lien_demande1') = 1,
                     'réponse du support : notification du chauffeur avec le lien de la demande');
call test.connexion(:'chauffeur1');
select test.verifier((select (e->>'non_lus')::int from jsonb_array_elements(public.mes_demandes()) e where e->>'id' = :'demande1') = 1
                     and (select e->>'statut' from jsonb_array_elements(public.mes_demandes()) e where e->>'id' = :'demande1') = 'en_cours',
                     'mes_demandes : une réponse non lue, demande en cours');
update public.messages set lu_le = now() where demande_id = :'demande1' and auteur_id <> auth.uid() and lu_le is null;
select test.verifier((select (e->>'non_lus')::int from jsonb_array_elements(public.mes_demandes()) e where e->>'id' = :'demande1') = 0,
                     'réponse lue : plus de non lu');


-- #############################################################################
-- 3. LE CHAUFFEUR RÉPOND : LOC RÉACTION PRÉVENUE ; PIÈCE JOINTE
-- #############################################################################
call test.connexion(:'chauffeur1');
insert into public.messages (demande_id, auteur_id, contenu) values (:'demande1', auth.uid(), e'J''ai attendu 20 minutes\nsur place.');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'admin' and cree_le >= :'debut_essai'
                        and titre = 'Nouveau message sur une demande' and lien = '/admin/support/?demande=' || :'demande1'
                        and message = :'numero_demande1' || ' · Client absent au rendez-vous : J''ai attendu 20 minutes sur place.') = 1,
                     'message du chauffeur : l''administrateur de la demande est prévenu (lien direct)');

call test.connexion(:'chauffeur1');
select test.doit_echouer(format('insert into public.messages (demande_id, auteur_id, piece_jointe_chemin) values (%L, auth.uid(), %L)',
                                :'demande1', 'autre-dossier/photo.jpg'), 'Pièce jointe refusée');
select test.doit_echouer(format('insert into public.messages (demande_id, auteur_id, piece_jointe_chemin) values (%L, auth.uid(), %L)',
                                :'demande1', :'demande1' || '/../photo.jpg'), 'Pièce jointe refusée');
insert into public.messages (demande_id, auteur_id, contenu, piece_jointe_chemin)
  values (:'demande1', auth.uid(), 'Photo du point de rendez-vous.', :'demande1' || '/photo-rendez-vous.jpg');
call test.systeme();
select test.verifier(exists (select 1 from public.messages where demande_id = :'demande1'
                              and piece_jointe_chemin = :'demande1' || '/photo-rendez-vous.jpg'),
                     'pièce jointe dans le dossier de la demande : acceptée');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('insert into public.messages (course_id, auteur_id, contenu, piece_jointe_chemin) values (%L, auth.uid(), %L, %L)',
                                :'course1', 'Photo', :'course1' || '/photo.jpg'), 'Pièce jointe refusée');


-- #############################################################################
-- 4. DEMANDE RÉSOLUE : NOTIFICATION AVEC LIEN, PLUS DE MESSAGE DE L'AUTEUR
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_statut_demande(:'demande1', 'resolue');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'chauffeur1' and cree_le >= :'debut_essai'
                        and titre = 'Demande résolue' and lien = :'lien_demande1') = 1,
                     'demande résolue : notification du chauffeur avec le lien de la demande');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('insert into public.messages (demande_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'demande1', 'Encore une question'), 'row-level security');

-- Demande enregistrée par LOC RÉACTION pour le chauffeur : lien aussi
call test.connexion(:'admin', 'aal2');
select (public.admin_creer_demande(:'chauffeur1', 'paiement', 'Virement de la semaine', 'Appel du chauffeur : virement non reçu.'))->>'id'
  as demande2 \gset
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'chauffeur1' and cree_le >= :'debut_essai'
                        and titre = 'Demande enregistrée' and lien = '/chauffeur/demandes/?id=' || :'demande2') = 1,
                     'demande enregistrée par LOC RÉACTION : notification du chauffeur avec le lien');


-- #############################################################################
-- 5. CLIENT : PAS ENCORE DE LIEN (SON ESPACE VIENDRA)
-- #############################################################################
call test.connexion(:'client1');
select id as demande3 from public.ouvrir_demande('autre', 'Question sur une facture', 'Pouvez-vous me renvoyer la facture ?') \gset
call test.connexion(:'admin', 'aal2');
select public.admin_repondre_demande(:'demande3', 'Elle vous est renvoyée par e-mail.');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'client1' and cree_le >= :'debut_essai'
                        and titre = 'Réponse du support' and lien is null) = 1,
                     'réponse du support à un client : notification sans lien pour le moment');


-- #############################################################################
-- 6. RETOUR À L'ÉTAT DE DÉPART
-- #############################################################################
delete from public.demandes where id in (:'demande1', :'demande2', :'demande3');
delete from public.notifications n where not exists (select 1 from instantane_notifications i where i.id = n.id);
update public.notifications n set titre = i.titre, message = i.message, lien = i.lien, lu_le = i.lu_le, cree_le = i.cree_le
  from instantane_notifications i where i.id = n.id;
select test.verifier((select count(*) from public.demandes) = :demandes_avant
                     and (select count(*) from public.messages) = :messages_avant
                     and not exists (select * from public.notifications except select * from instantane_notifications)
                     and not exists (select * from instantane_notifications except select * from public.notifications),
                     'mes demandes : retour à l''état de départ (demandes, messages, notifications)');

\o
\echo '✔ Mes demandes au support : tout est conforme.'
