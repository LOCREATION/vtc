-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Messagerie de la course (migration 21), jouée après 19_espace_chauffeur.sql
-- sur les mêmes comptes fictifs : le client et le chauffeur d'une course
-- s'écrivent pendant la course et 24 heures après sa fin ; ensuite la
-- conversation se lit mais ne s'écrit plus ; course annulée, message vide,
-- autre client : refusés ; l'administration écrit toujours.
-- Tout ce qui est créé ici est retiré à la fin.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set chauffeur1 d0000000-0000-4000-8000-000000000001

call test.systeme();
-- Course terminée de Claire avec Paul (scénarios), et une course annulée de Claire
select id as course1, terminee_le as fin1 from public.courses
 where client_id = :'client1' and chauffeur_id = :'chauffeur1' and statut = 'terminee' order by cree_le limit 1 \gset
select id as annulee from public.courses where client_id = :'client1' and statut = 'annulee' order by cree_le limit 1 \gset
select count(*) as messages_avant from public.messages \gset
-- Depuis la migration 22, chaque message notifie l'autre personne (et
-- reprend une notification « Message de … » non lue des scénarios) : l'état
-- des notifications est photographié ici et rétabli à l'identique à la fin
create temp table instantane_notifications as select * from public.notifications;


-- #############################################################################
-- 1. PENDANT LES 24 HEURES QUI SUIVENT LA FIN DE LA COURSE
-- #############################################################################
update public.courses set terminee_le = now() - interval '2 hours' where id = :'course1';
call test.connexion(:'client1');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'J''ai oublié mon écharpe sur la banquette.');
call test.connexion(:'chauffeur1');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'Je l''ai trouvée, je vous la rapporte.');
call test.systeme();
select test.verifier((select count(*) from public.messages where course_id = :'course1') >= 2,
                     'course terminée depuis 2 heures : le client et le chauffeur s''écrivent encore');

call test.connexion(:'client1');
select test.doit_echouer(format('insert into public.messages (course_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'course1', '    '), 'row-level security');
call test.connexion(:'client2');
select test.doit_echouer(format('insert into public.messages (course_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'course1', 'Intrus'), 'row-level security');


-- #############################################################################
-- 2. APRÈS 24 HEURES : LA CONVERSATION SE LIT, MAIS NE S'ÉCRIT PLUS
-- #############################################################################
call test.systeme();
update public.courses set terminee_le = now() - interval '25 hours' where id = :'course1';
call test.connexion(:'client1');
select test.doit_echouer(format('insert into public.messages (course_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'course1', 'Encore une question'), 'row-level security');
select test.verifier((select count(*) from public.messages where course_id = :'course1') >= 2,
                     'plus de 24 heures après : la conversation reste lisible');
update public.messages set lu_le = now() where course_id = :'course1' and auteur_id <> auth.uid() and lu_le is null;
call test.systeme();
select test.verifier((select lu_le is not null from public.messages where course_id = :'course1' and auteur_id = :'chauffeur1'
                      order by cree_le desc limit 1), 'plus de 24 heures après : le message reçu peut encore être marqué lu');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('insert into public.messages (course_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'course1', 'Bonjour'), 'row-level security');

-- Course annulée : pas de conversation
call test.connexion(:'client1');
select test.doit_echouer(format('insert into public.messages (course_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'annulee', 'Bonjour'), 'row-level security');

-- L'administration écrit toujours
call test.connexion(:'admin', 'aal2');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'LOC RÉACTION : l''écharpe est à l''agence.');
call test.systeme();
select test.verifier((select count(*) from public.messages where course_id = :'course1' and auteur_id = :'admin') = 1,
                     'administration : écrit dans la conversation à tout moment');


-- #############################################################################
-- 3. RETOUR À L'ÉTAT DE DÉPART
-- #############################################################################
delete from public.messages where course_id = :'course1' and cree_le > now() - interval '1 hour'
  and contenu in ('J''ai oublié mon écharpe sur la banquette.', 'Je l''ai trouvée, je vous la rapporte.',
                  'LOC RÉACTION : l''écharpe est à l''agence.');
delete from public.notifications n where not exists (select 1 from instantane_notifications i where i.id = n.id);
update public.notifications n set titre = i.titre, message = i.message, lien = i.lien, lu_le = i.lu_le, cree_le = i.cree_le
  from instantane_notifications i where i.id = n.id;
update public.courses set terminee_le = :'fin1' where id = :'course1';
select test.verifier((select count(*) from public.messages) = :messages_avant
                     and not exists (select * from public.notifications except select * from instantane_notifications)
                     and not exists (select * from instantane_notifications except select * from public.notifications),
                     'messagerie : retour à l''état de départ (messages et notifications)');

\o
\echo '✔ Messagerie de la course : tout est conforme.'
