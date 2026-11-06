-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios de l'espace chauffeur, onglet Compte (migration 20), joués après
-- 18_marketing.sql sur les mêmes comptes fictifs :
--   demande d'absence de la salariée (jours comptés par la base, réponse de
--   l'administration impossible à écrire à l'avance, arrêt maladie refusé,
--   période hors du contrat, absence déjà enregistrée, mois dont le bulletin
--   est validé, demande pour un autre salarié, retrait) ; dépôt d'un document
--   par la chauffeuse (pièces du véhicule refusées, fichier hors de son
--   dossier, commentaire de vérification vide, retrait) ; droits.
-- Tout ce qui est créé ici est retiré à la fin : les parcours navigateur
-- partent du même état qu'avant ce fichier.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set chauffeuse d0000000-0000-4000-8000-000000000002

call test.systeme();
select id as nadia from public.salaries where matricule = 'S0002' \gset
select id as paul from public.salaries where matricule = 'S0001' \gset
-- Une semaine entière (lundi au samedi) dans environ quatre mois : après
-- toutes les absences des scénarios, dans un mois sans bulletin validé
select date_trunc('week', current_date + 120)::date as lundi, (date_trunc('week', current_date + 120)::date + 5) as samedi \gset
select count(*) as absences_avant from public.absences \gset
select count(*) as documents_avant from public.documents \gset
select now() as debut_essai \gset


-- #############################################################################
-- 1. DEMANDE D'ABSENCE DE LA SALARIÉE
-- #############################################################################
call test.connexion(:'chauffeuse');
-- Jours, décision et note envoyés par la page : ignorés, la base compte et la
-- réponse reste vide
insert into public.absences (salarie_id, type, debut, fin, jours, decision_note, decide_par, decide_le, commentaire)
values (:'nadia', 'conges_payes', :'lundi', :'samedi', 1, 'Accepté', :'admin', now(), '   Mariage de ma sœur   ')
returning id as demande \gset
call test.systeme();
select test.verifier((select a.jours = prive.jours_ouvrables(a.debut, a.fin) and a.statut = 'demandee' and a.decision_note is null
                             and a.decide_par is null and a.decide_le is null and a.commentaire = 'Mariage de ma sœur'
                      from public.absences a where a.id = :'demande'),
                     'demande de congés payés : jours ouvrables comptés par la base, réponse vide, commentaire nettoyé');

call test.connexion(:'chauffeuse');
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin) values (%L, %L, %L, %L)',
                                :'nadia', 'sans_solde', :'samedi', :'samedi'),
                         'déjà enregistrée du ' || to_char(:'lundi'::date, 'DD/MM/YYYY') || ' au ' || to_char(:'samedi'::date, 'DD/MM/YYYY'));
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin) values (%L, %L, %L, %L)',
                                :'nadia', 'maladie', :'lundi'::date + 14, :'lundi'::date + 15), 'avis d''arrêt');
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin) values (%L, %L, %L, %L)',
                                :'nadia', 'conges_payes', '2026-07-01', '2026-07-03'), 'sort de votre contrat (entrée le 06/07/2026)');
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin) values (%L, %L, %L, %L)',
                                :'nadia', 'autre', '2026-09-28', '2026-09-28'), 'Le bulletin de septembre 2026 est déjà validé');
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin) values (%L, %L, %L, %L)',
                                :'nadia', 'autre', :'lundi'::date + 21, :'lundi'::date + 20), 'le dernier après le premier');
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin) values (%L, %L, %L, %L)',
                                :'paul', 'conges_payes', :'lundi'::date + 21, :'lundi'::date + 22), 'row-level security');
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin, statut) values (%L, %L, %L, %L, %L)',
                                :'nadia', 'conges_payes', :'lundi'::date + 21, :'lundi'::date + 22, 'validee'), 'row-level security');
-- Retrait de la demande tant qu'elle attend une réponse
delete from public.absences where id = :'demande';
call test.systeme();
select test.verifier(not exists (select 1 from public.absences where id = :'demande'), 'demande retirée par la salariée');

-- Une demande déjà acceptée ne se retire plus
call test.connexion(:'chauffeuse');
insert into public.absences (salarie_id, type, debut, fin) values (:'nadia', 'sans_solde', :'lundi', :'lundi')
returning id as demande2 \gset
call test.connexion(:'admin', 'aal2');
select public.admin_decider_absence(:'demande2', 'validee');
call test.connexion(:'chauffeuse');
delete from public.absences where id = :'demande2';
call test.systeme();
select test.verifier((select a.statut = 'validee' and a.jours = 1 from public.absences a where a.id = :'demande2'),
                     'congé sans solde d''un jour accepté : la salariée ne peut plus le retirer');
select test.verifier(exists (select 1 from public.notifications n where n.destinataire_id = :'chauffeuse'
                                    and n.titre = 'Demande d''absence acceptée' and n.cree_le >= :'debut_essai'),
                     'demande acceptée : la salariée est prévenue');
delete from public.absences where id = :'demande2';
delete from public.notifications where destinataire_id = :'chauffeuse' and cree_le >= :'debut_essai';
select test.verifier((select count(*) from public.absences) = :absences_avant, 'absences : retour à l''état de départ');


-- #############################################################################
-- 2. DÉPÔT D'UN DOCUMENT PAR LA CHAUFFEUSE
-- #############################################################################
call test.connexion(:'chauffeuse');
select test.doit_echouer(format('insert into public.documents (chauffeur_id, type, fichier_chemin) values (%L, %L, %L)',
                                :'chauffeuse', 'assurance', :'chauffeuse' || '/assurance.pdf'), 'pièces du véhicule');
select test.doit_echouer(format('insert into public.documents (chauffeur_id, type, fichier_chemin) values (%L, %L, %L)',
                                :'chauffeuse', 'carte_vtc', :'chauffeur1' || '/carte_vtc.pdf'), 'Fichier invalide');
select test.doit_echouer(format('insert into public.documents (chauffeur_id, type, fichier_chemin) values (%L, %L, %L)',
                                :'chauffeuse', 'carte_vtc', :'chauffeuse' || '/../carte_vtc.pdf'), 'Fichier invalide');
select test.doit_echouer(format('insert into public.documents (chauffeur_id, type, fichier_chemin) values (%L, %L, %L)',
                                :'chauffeuse', 'carte_vtc', :'chauffeuse' || '/sous-dossier/carte_vtc.pdf'), 'Fichier invalide');
select test.doit_echouer(format('insert into public.documents (chauffeur_id, type, fichier_chemin, statut) values (%L, %L, %L, %L)',
                                :'chauffeuse', 'carte_vtc', :'chauffeuse' || '/carte_vtc.pdf', 'valide'), 'row-level security');
insert into public.documents (chauffeur_id, type, fichier_chemin, numero, expire_le, commentaire)
values (:'chauffeuse', 'carte_vtc', :'chauffeuse' || '/carte_vtc-1.pdf', '  VTC-0002  ', current_date + 400, 'Conforme')
returning id as piece \gset
call test.systeme();
select test.verifier((select d.statut = 'en_attente' and d.commentaire is null and d.numero = 'VTC-0002'
                      from public.documents d where d.id = :'piece'),
                     'carte VTC déposée : en vérification, numéro nettoyé, sans commentaire de vérification');
call test.connexion(:'chauffeuse');
delete from public.documents where id = :'piece';
call test.systeme();
select test.verifier((select count(*) from public.documents) = :documents_avant, 'document retiré avant vérification : retour à l''état de départ');


-- #############################################################################
-- 3. DROITS
-- #############################################################################
select test.verifier(not has_function_privilege('authenticated', 'prive.controler_demande_absence()', 'execute')
                     and not has_function_privilege('authenticated', 'prive.controler_depot_document()', 'execute')
                     and not has_function_privilege('anon', 'prive.controler_demande_absence()', 'execute'),
                     'contrôles de l''espace chauffeur : jamais appelables directement');
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables restent protégées ligne par ligne');

\o
\echo '✔ Espace chauffeur : tout est conforme.'
