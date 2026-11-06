-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Notification des messages de course (migration 22), jouée après
-- 20_messagerie.sql sur les mêmes comptes fictifs : un message prévient
-- l'autre personne de la course (« Message de Claire », lien de la course),
-- une seule notification non lue par conversation, LOC RÉACTION prévient les
-- deux, l'auteur n'est jamais notifié, un message de demande au support ne
-- crée pas de notification de course.
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
-- Course terminée de Claire avec Paul (scénarios), conversation rouverte :
-- terminée depuis une heure
select id as course1, terminee_le as fin1 from public.courses
 where client_id = :'client1' and chauffeur_id = :'chauffeur1' and statut = 'terminee' order by cree_le limit 1 \gset
select '/chauffeur/course/?id=' || :'course1' as lien_chauffeur, '/client/course/?id=' || :'course1' as lien_client \gset
select id as demande1 from public.demandes order by cree_le limit 1 \gset
select count(*) as messages_avant from public.messages \gset
-- État des notifications photographié, rétabli à l'identique à la fin (les
-- messages des scénarios ont pu laisser une notification non lue, reprise ici)
create temp table instantane_notifications as select * from public.notifications;
select now() as debut_essai \gset
update public.courses set terminee_le = now() - interval '1 hour' where id = :'course1';


-- #############################################################################
-- 1. LE CLIENT ÉCRIT : LE CHAUFFEUR EST PRÉVENU
-- #############################################################################
call test.connexion(:'client1');
insert into public.messages (course_id, auteur_id, contenu)
  values (:'course1', auth.uid(), e'Bonjour,\n  j''ai oublié mon parapluie.');
call test.systeme();
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'chauffeur1' and cree_le >= :'debut_essai' and lu_le is null
                         and type = 'course' and titre = 'Message de Claire' and lien = :'lien_chauffeur'
                         and message = 'Bonjour, j''ai oublié mon parapluie.') = 1,
                     'message du client : le chauffeur reçoit « Message de Claire », lien de la course, texte sur une ligne');
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'client1' and cree_le >= :'debut_essai') = 0,
                     'message du client : son auteur ne reçoit rien');

-- Deuxième message avant lecture : la même notification, au dernier texte
call test.connexion(:'client1');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'Il est noir, sur la banquette arrière.');
call test.systeme();
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'chauffeur1' and cree_le >= :'debut_essai' and lien = :'lien_chauffeur') = 1
                     and (select message from public.notifications
                           where destinataire_id = :'chauffeur1' and lien = :'lien_chauffeur' and lu_le is null
                             and titre like 'Message de %') = 'Il est noir, sur la banquette arrière.',
                     'deuxième message non lu : une seule notification, avec le dernier message');

-- Notification lue (par le chauffeur lui-même), puis nouveau message : nouvelle notification
call test.connexion(:'chauffeur1');
update public.notifications set lu_le = now()
 where destinataire_id = auth.uid() and lien = :'lien_chauffeur' and lu_le is null and titre like 'Message de %';
call test.connexion(:'client1');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'Merci beaucoup !');
call test.systeme();
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'chauffeur1' and cree_le >= :'debut_essai' and lien = :'lien_chauffeur') = 2
                     and (select count(*) from public.notifications
                           where destinataire_id = :'chauffeur1' and lien = :'lien_chauffeur' and lu_le is null
                             and titre like 'Message de %') = 1,
                     'notification lue puis nouveau message : une nouvelle notification');


-- #############################################################################
-- 2. LE CHAUFFEUR ÉCRIT : LE CLIENT EST PRÉVENU
-- #############################################################################
call test.connexion(:'chauffeur1');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'Je l''ai trouvé, je vous le rapporte ce soir.');
call test.systeme();
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'client1' and cree_le >= :'debut_essai' and lu_le is null
                         and type = 'course' and titre = 'Message de Paul' and lien = :'lien_client'
                         and message = 'Je l''ai trouvé, je vous le rapporte ce soir.') = 1,
                     'message du chauffeur : le client reçoit « Message de Paul », lien du suivi de la course');


-- #############################################################################
-- 3. LOC RÉACTION ÉCRIT : LES DEUX SONT PRÉVENUS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'Le parapluie est aussi signalé à l''agence.');
call test.systeme();
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'client1' and cree_le >= :'debut_essai' and lien = :'lien_client') = 1
                     and (select titre from public.notifications
                           where destinataire_id = :'client1' and lien = :'lien_client' and lu_le is null
                             and titre like 'Message de %') = 'Message de LOC RÉACTION',
                     'message de LOC RÉACTION : la notification non lue du client est reprise, au nom de LOC RÉACTION');
select test.verifier((select titre || ' · ' || message from public.notifications
                       where destinataire_id = :'chauffeur1' and lien = :'lien_chauffeur' and lu_le is null
                         and titre like 'Message de %')
                     = 'Message de LOC RÉACTION · Le parapluie est aussi signalé à l''agence.',
                     'message de LOC RÉACTION : le chauffeur est prévenu aussi');
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'admin' and cree_le >= :'debut_essai' and titre like 'Message de %') = 0,
                     'message de LOC RÉACTION : l''administration ne se notifie pas elle-même');

-- Message d'une demande au support : aucune notification de course
call test.connexion(:'admin', 'aal2');
insert into public.messages (demande_id, auteur_id, contenu) values (:'demande1', auth.uid(), 'Essai de fil du support.');
call test.systeme();
-- (toujours les trois notifications de la conversation : deux pour le chauffeur, une pour le client)
select test.verifier((select count(*) from public.notifications where cree_le >= :'debut_essai') = 3,
                     'message d''une demande au support : aucune notification de course');


-- #############################################################################
-- 4. RETOUR À L'ÉTAT DE DÉPART
-- #############################################################################
delete from public.messages where cree_le >= :'debut_essai'
  and (course_id = :'course1' or (demande_id = :'demande1' and contenu = 'Essai de fil du support.'));
delete from public.notifications n where not exists (select 1 from instantane_notifications i where i.id = n.id);
update public.notifications n set titre = i.titre, message = i.message, lien = i.lien, lu_le = i.lu_le, cree_le = i.cree_le
  from instantane_notifications i where i.id = n.id;
update public.courses set terminee_le = :'fin1' where id = :'course1';
select test.verifier((select count(*) from public.messages) = :messages_avant
                     and not exists (select * from public.notifications except select * from instantane_notifications)
                     and not exists (select * from instantane_notifications except select * from public.notifications),
                     'notification des messages : retour à l''état de départ (messages et notifications)');

\o
\echo '✔ Notification des messages de course : tout est conforme.'
