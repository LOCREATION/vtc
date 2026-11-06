-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Mes demandes au support, espace client (migration 24), jouée après
-- 22_mes_demandes.sql sur les mêmes comptes fictifs : un client ouvre une
-- demande sur sa course (pas sur celle d'un autre), la retrouve dans
-- mes_demandes() avec les réponses non lues, reçoit les notifications du
-- support avec le lien de son espace (« /client/demandes/?id=… »), répond
-- (LOC RÉACTION prévenue) ; une pièce jointe déposée mais inutilisée peut
-- être retirée par son auteur, pas une pièce jointe d'un message.
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
select id as course_client1, numero as numero_course_client1 from public.courses
 where client_id = :'client1' and statut = 'terminee' order by cree_le limit 1 \gset
select id as course_client2 from public.courses
 where client_id = :'client2' order by cree_le limit 1 \gset
select count(*) as demandes_avant from public.demandes \gset
select count(*) as messages_avant from public.messages \gset
select count(*) as fichiers_avant from storage.objects where bucket_id = 'support' \gset
create temp table instantane_notifications as select * from public.notifications;
select now() as debut_essai \gset


-- #############################################################################
-- 1. LE CLIENT OUVRE UNE DEMANDE SUR SA COURSE
-- #############################################################################
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ouvrir_demande(%L, %L, %L, %L)', 'objet_perdu', 'Sac oublié',
                                'J''ai oublié mon sac.', :'course_client2'), 'Course introuvable.');
select id as demande1, numero as numero_demande1
  from public.ouvrir_demande('objet_perdu', 'Sac oublié dans le véhicule',
                             'J''ai oublié un sac de sport bleu sur la banquette arrière.', :'course_client1') \gset
select '/client/demandes/?id=' || :'demande1' as lien_demande1 \gset
select test.verifier((select (x->>'course_numero') = :'numero_course_client1' and (x->>'non_lus')::int = 0
                             and (x->>'statut') = 'ouverte' and (x->>'type') = 'objet_perdu'
                      from jsonb_array_elements(public.mes_demandes()) x where (x->>'id') = :'demande1')
                     and (select (public.mes_demandes())->0->>'id') = :'demande1',
                     'mes_demandes (client) : la demande en tête, sa course, aucune réponse non lue');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'admin' and cree_le >= :'debut_essai'
                        and titre = 'Nouvelle demande au support' and lien = '/admin/support/?demande=' || :'demande1') >= 1,
                     'demande d''un client : l''administration prévenue, lien direct vers la demande');

call test.connexion(:'client2');
select test.verifier(not exists (select 1 from jsonb_array_elements(public.mes_demandes()) x where (x->>'id') = :'demande1')
                     and not exists (select 1 from public.demandes where id = :'demande1'),
                     'un autre client ne voit pas la demande');
call test.connexion(:'chauffeur1');
select test.verifier(not exists (select 1 from jsonb_array_elements(public.mes_demandes()) x where (x->>'id') = :'demande1'),
                     'mes_demandes : le chauffeur de la course ne voit pas la demande du client');


-- #############################################################################
-- 2. RÉPONSE DU SUPPORT : NOTIFICATION AVEC LE LIEN DE L'ESPACE CLIENT
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_repondre_demande(:'demande1', 'Votre chauffeur l''a retrouvé : nous vous appelons pour la remise.');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'client1' and cree_le >= :'debut_essai'
                        and titre = 'Réponse du support' and lien = :'lien_demande1') = 1,
                     'réponse du support : notification du client avec le lien de son espace');

call test.connexion(:'client1');
select test.verifier((select (x->>'non_lus')::int = 1 and (x->>'statut') = 'en_cours'
                      from jsonb_array_elements(public.mes_demandes()) x where (x->>'id') = :'demande1'),
                     'mes_demandes (client) : une réponse non lue, demande en cours');
-- Fil ouvert : réponses marquées lues, et la notification de la demande aussi
update public.messages set lu_le = now() where demande_id = :'demande1' and auteur_id <> auth.uid() and lu_le is null;
update public.notifications set lu_le = now() where destinataire_id = auth.uid() and lien = :'lien_demande1' and lu_le is null;
select test.verifier((select (x->>'non_lus')::int = 0 from jsonb_array_elements(public.mes_demandes()) x where (x->>'id') = :'demande1')
                     and not exists (select 1 from public.notifications where lien = :'lien_demande1' and lu_le is null),
                     'fil ouvert par le client : réponse et notification marquées lues');


-- #############################################################################
-- 3. LE CLIENT RÉPOND, AVEC UNE PHOTO
-- #############################################################################
call test.connexion(:'client1');
insert into storage.objects (bucket_id, name, owner, owner_id)
  values ('support', :'demande1' || '/photo-sac.jpg', auth.uid(), auth.uid()::text);
insert into public.messages (demande_id, auteur_id, contenu, piece_jointe_chemin)
  values (:'demande1', auth.uid(), 'Voici une photo du sac.', :'demande1' || '/photo-sac.jpg');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'admin' and cree_le >= :'debut_essai'
                        and titre = 'Nouveau message sur une demande' and lien = '/admin/support/?demande=' || :'demande1'
                        and message = :'numero_demande1' || ' · Sac oublié dans le véhicule : Voici une photo du sac.') = 1,
                     'message du client : l''administrateur de la demande est prévenu (lien direct)');


-- #############################################################################
-- 4. PIÈCE JOINTE INUTILISÉE : RETIRÉE PAR SON AUTEUR SEULEMENT
-- #############################################################################
-- Dépôt dont le message n'a pas abouti
call test.connexion(:'client1');
insert into storage.objects (bucket_id, name, owner, owner_id)
  values ('support', :'demande1' || '/sans-message.jpg', auth.uid(), auth.uid()::text);

-- Un autre client, le chauffeur : rien à retirer
call test.connexion(:'client2');
delete from storage.objects where bucket_id = 'support' and name = :'demande1' || '/sans-message.jpg';
call test.connexion(:'chauffeur1');
delete from storage.objects where bucket_id = 'support' and name = :'demande1' || '/sans-message.jpg';
call test.systeme();
select test.verifier(exists (select 1 from storage.objects where bucket_id = 'support' and name = :'demande1' || '/sans-message.jpg'),
                     'pièce jointe inutilisée : ni un autre client ni le chauffeur ne peuvent la retirer');

-- La pièce jointe d'un message reste
call test.connexion(:'client1');
delete from storage.objects where bucket_id = 'support' and name = :'demande1' || '/photo-sac.jpg';
call test.systeme();
select test.verifier(exists (select 1 from storage.objects where bucket_id = 'support' and name = :'demande1' || '/photo-sac.jpg'),
                     'pièce jointe d''un message : son auteur ne peut pas la retirer');

-- Le fichier déposé par LOC RÉACTION reste aussi
call test.connexion(:'admin', 'aal2');
insert into storage.objects (bucket_id, name, owner, owner_id)
  values ('support', :'demande1' || '/document-equipe.pdf', auth.uid(), auth.uid()::text);
call test.connexion(:'client1');
delete from storage.objects where bucket_id = 'support' and name = :'demande1' || '/document-equipe.pdf';
call test.systeme();
select test.verifier(exists (select 1 from storage.objects where bucket_id = 'support' and name = :'demande1' || '/document-equipe.pdf'),
                     'fichier déposé par LOC RÉACTION : le client ne peut pas le retirer');

-- Son propre fichier inutilisé : retiré
call test.connexion(:'client1');
delete from storage.objects where bucket_id = 'support' and name = :'demande1' || '/sans-message.jpg';
call test.systeme();
select test.verifier(not exists (select 1 from storage.objects where bucket_id = 'support' and name = :'demande1' || '/sans-message.jpg'),
                     'pièce jointe inutilisée : son auteur la retire');


-- #############################################################################
-- 5. DEMANDE RÉSOLUE, FERMÉE, ENREGISTRÉE PAR LOC RÉACTION : LIEN DU CLIENT
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_statut_demande(:'demande1', 'resolue');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'client1' and cree_le >= :'debut_essai'
                        and titre = 'Demande résolue' and lien = :'lien_demande1') = 1,
                     'demande résolue : notification du client avec le lien de son espace');
call test.connexion(:'client1');
select test.doit_echouer(format('insert into public.messages (demande_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'demande1', 'Encore une question'), 'row-level security');
select test.doit_echouer(format('insert into storage.objects (bucket_id, name, owner, owner_id) values (%L, %L, auth.uid(), auth.uid()::text)',
                                'support', :'demande1' || '/apres.jpg'), 'row-level security');

call test.connexion(:'admin', 'aal2');
select (public.admin_creer_demande(:'client1', 'paiement', 'Double paiement', 'Appel de la cliente : paiement débité deux fois.'))->>'id'
  as demande2 \gset
select public.admin_statut_demande(:'demande2', 'fermee', 'Un seul paiement a été encaissé : le second a été annulé par la banque.');
call test.systeme();
select test.verifier((select count(*) from public.notifications where destinataire_id = :'client1' and cree_le >= :'debut_essai'
                        and titre = 'Demande enregistrée' and lien = '/client/demandes/?id=' || :'demande2') = 1
                     and (select count(*) from public.notifications where destinataire_id = :'client1' and cree_le >= :'debut_essai'
                        and titre = 'Demande fermée' and lien = '/client/demandes/?id=' || :'demande2') = 1,
                     'demande enregistrée puis fermée par LOC RÉACTION : notifications du client avec le lien');


-- #############################################################################
-- 6. RETOUR À L'ÉTAT DE DÉPART
-- #############################################################################
delete from storage.objects where bucket_id = 'support' and name like :'demande1' || '/%';
delete from public.demandes where id in (:'demande1', :'demande2');
delete from public.notifications n where not exists (select 1 from instantane_notifications i where i.id = n.id);
update public.notifications n set titre = i.titre, message = i.message, lien = i.lien, lu_le = i.lu_le, cree_le = i.cree_le
  from instantane_notifications i where i.id = n.id;
select test.verifier((select count(*) from public.demandes) = :demandes_avant
                     and (select count(*) from public.messages) = :messages_avant
                     and (select count(*) from storage.objects where bucket_id = 'support') = :fichiers_avant
                     and not exists (select * from public.notifications except select * from instantane_notifications)
                     and not exists (select * from instantane_notifications except select * from public.notifications),
                     'demandes des clients : retour à l''état de départ (demandes, messages, fichiers, notifications)');

\o
\echo '✔ Mes demandes au support (espace client) : tout est conforme.'
