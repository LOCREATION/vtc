-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Parrainage dans l'espace client (migration 25), joué après
-- 23_demandes_clients.sql sur les mêmes comptes fictifs :
--   - le parrainage validé par la première course de Léa (scénario 11) a
--     prévenu Claire (marraine) et Léa (filleule), avec le lien de leur solde ;
--   - un client inscrit sans le lien saisit le code de sa marraine (contrôles
--     lisibles : format, code inconnu, son propre code, parrain déjà connu,
--     course déjà terminée, parrainage croisé, compte non client) ;
--   - validation : notifications avec le montant ; sans récompense, pas de
--     notification ; parrain chauffeur : pas de lien.
-- Tout ce qui est créé ici est retiré à la fin.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set filleul    c0000000-0000-4000-8000-000000000004
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set nouveau1   e0000000-0000-4000-8000-000000000001
\set nouveau2   e0000000-0000-4000-8000-000000000002
\set nouveau3   e0000000-0000-4000-8000-000000000003

call test.systeme();
select count(*) as parrainages_avant from public.parrainages \gset
create temp table instantane_notifications as select * from public.notifications;
select code_parrainage as code_claire from public.profils where id = :'client1' \gset
select code_parrainage as code_chauffeur from public.profils where id = :'chauffeur1' \gset


-- #############################################################################
-- 1. VALIDATION À LA PREMIÈRE COURSE (SCÉNARIO 11) : MARRAINE ET FILLEULE PRÉVENUES
-- #############################################################################
select test.verifier(exists (select 1 from public.notifications where destinataire_id = :'client1' and type = 'paiement'
                               and titre = 'Parrainage validé' and lien = '/client/compte/#compte-solde'
                               and message like 'Votre filleul a terminé sa première course : 5,00 € crédités sur votre solde.%'),
                     'parrainage validé : la marraine est prévenue (montant, lien de son solde)');
select test.verifier(exists (select 1 from public.notifications where destinataire_id = :'filleul' and type = 'paiement'
                               and titre = 'Bienvenue chez LOC RÉACTION' and lien = '/client/compte/#compte-solde'
                               and message = 'Votre première course est terminée : 5,00 € crédités sur votre solde grâce à votre parrain.'),
                     'parrainage validé : la filleule est prévenue (montant, lien de son solde)');


-- #############################################################################
-- 2. SAISIR LE CODE DE SA MARRAINE APRÈS L'INSCRIPTION
-- #############################################################################
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data) values
  (:'nouveau1', 'nouveau1@exemple.test', '{"prenom":"Malo","nom":"Lefèvre"}'),
  (:'nouveau2', 'nouveau2@exemple.test', '{"prenom":"Zoé","nom":"Fontaine"}');
reset role;
select code_parrainage as code_nouveau1 from public.profils where id = :'nouveau1' \gset

call test.connexion(:'nouveau1');
select test.doit_echouer($$select public.appliquer_code_parrain('ab')$$, 'Code de parrainage invalide');
select test.doit_echouer($$select public.appliquer_code_parrain('K7M2-Q9XA!')$$, 'Code de parrainage invalide');
select test.doit_echouer($$select public.appliquer_code_parrain('ZZZZZZZZ')$$, 'Code de parrainage introuvable');
select test.doit_echouer(format('select public.appliquer_code_parrain(%L)', :'code_nouveau1'), 'votre propre code');
-- Code saisi en minuscules, avec des espaces : accepté
select public.appliquer_code_parrain(lower(substr(:'code_claire', 1, 4) || ' ' || substr(:'code_claire', 5))) as reponse \gset
select test.verifier((:'reponse'::jsonb ->> 'statut') = 'en_attente' and (:'reponse'::jsonb ->> 'recompense_filleul')::numeric = 5
                     and exists (select 1 from public.parrainages where parrain_id = :'client1' and filleul_id = auth.uid() and statut = 'en_attente'),
                     'code de la marraine saisi : parrainage en attente de la première course, récompense annoncée');
select test.doit_echouer(format('select public.appliquer_code_parrain(%L)', :'code_claire'), 'déjà un parrain');

-- Course déjà terminée : trop tard
call test.connexion(:'client2');
select test.verifier(exists (select 1 from public.courses where client_id = auth.uid() and statut = 'terminee')
                     and not exists (select 1 from public.parrainages where filleul_id = auth.uid()),
                     'Hugo : une course terminée, pas de parrain');
select test.doit_echouer(format('select public.appliquer_code_parrain(%L)', :'code_claire'), 'avant votre première course terminée');

-- Parrainage croisé : la marraine de Zoé ne peut pas devenir sa filleule
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data)
values (:'nouveau3', 'nouveau3@exemple.test', json_build_object('prenom', 'Inès', 'nom', 'Moulin', 'code_parrain', :'code_nouveau1')::jsonb);
reset role;
select code_parrainage as code_nouveau3 from public.profils where id = :'nouveau3' \gset
call test.connexion(:'nouveau1');
select test.doit_echouer(format('select public.appliquer_code_parrain(%L)', :'code_nouveau3'), 'déjà un parrain');
call test.systeme();
delete from public.parrainages where filleul_id = :'nouveau1';
call test.connexion(:'nouveau1');
select test.doit_echouer(format('select public.appliquer_code_parrain(%L)', :'code_nouveau3'), 'déjà votre filleul');

-- Compte chauffeur : pas de parrainage côté client
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.appliquer_code_parrain(%L)', :'code_claire'), 'réservé aux comptes clients');
-- Visiteur sans compte : la fonction ne lui est pas ouverte
call test.visiteur();
select test.doit_echouer(format('select public.appliquer_code_parrain(%L)', :'code_claire'), 'permission denied');


-- #############################################################################
-- 3. VALIDATION : MONTANTS, SANS RÉCOMPENSE, PARRAIN CHAUFFEUR
-- #############################################################################
call test.connexion(:'nouveau2');
select public.appliquer_code_parrain(:'code_chauffeur');
call test.systeme();
select now() as avant_validation \gset
-- Zoé (parrain : Paul, chauffeur) ; Inès (marraine : Malo, client) sans récompense pour le parrain
update public.parrainages set statut = 'valide', valide_le = now(), recompense_parrain = 7.50, recompense_filleul = 2.50
 where filleul_id = :'nouveau2';
update public.parrainages set statut = 'valide', valide_le = now(), recompense_parrain = 0, recompense_filleul = 5
 where filleul_id = :'nouveau3';
select test.verifier((select count(*) from public.notifications where destinataire_id = :'chauffeur1' and cree_le >= :'avant_validation'
                        and titre = 'Parrainage validé' and lien is null and message like '%7,50 € crédités sur votre solde.%') = 1,
                     'parrain chauffeur : prévenu du montant, sans lien (pas de solde dans son espace)');
select test.verifier((select count(*) from public.notifications where destinataire_id = :'nouveau2' and cree_le >= :'avant_validation'
                        and titre = 'Bienvenue chez LOC RÉACTION' and lien = '/client/compte/#compte-solde' and message like '%2,50 €%') = 1,
                     'filleule : prévenue du montant, lien de son solde');
select test.verifier((select count(*) from public.notifications where destinataire_id = :'nouveau1' and cree_le >= :'avant_validation') = 0
                     and (select count(*) from public.notifications where destinataire_id = :'nouveau3' and cree_le >= :'avant_validation'
                            and titre = 'Bienvenue chez LOC RÉACTION') = 1,
                     'récompense nulle pour le parrain : aucune notification pour lui');
-- Mise à jour sans changement de statut : rien de plus
update public.parrainages set valide_le = now() where filleul_id = :'nouveau2';
select test.verifier((select count(*) from public.notifications where cree_le >= :'avant_validation') = 3,
                     'parrainage déjà validé et modifié : aucune nouvelle notification');


-- #############################################################################
-- 4. RETOUR À L'ÉTAT DE DÉPART
-- #############################################################################
call test.systeme();
delete from auth.users where id in (:'nouveau1', :'nouveau2', :'nouveau3');
delete from public.notifications n where not exists (select 1 from instantane_notifications i where i.id = n.id);
select test.verifier((select count(*) from public.parrainages) = :parrainages_avant
                     and not exists (select 1 from public.profils where id in (:'nouveau1', :'nouveau2', :'nouveau3'))
                     and not exists (select * from public.notifications except select * from instantane_notifications)
                     and not exists (select * from instantane_notifications except select * from public.notifications),
                     'parrainage : retour à l''état de départ (comptes, parrainages, notifications)');

\o
\echo '✔ Parrainage dans l''espace client : tout est conforme.'
