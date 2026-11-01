-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios du module « Marketing » (migration 18), joués après
-- 17_support.sql sur les mêmes comptes fictifs :
--   droits ; codes promo (création contrôlée, période en jours de Paris,
--   statuts actif, à venir, expiré, épuisé, désactivé, statistiques,
--   utilisations, suppression) ; parrainage (liste, chiffres, meilleurs
--   parrains, annulation d'un parrainage en attente) ; notifications
--   groupées (brouillon, canal, envoi, lectures, protection après envoi) ;
--   journal.
-- Les nombres attendus sont recalculés ici à partir des tables.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set filleul    c0000000-0000-4000-8000-000000000004
\set filleul2   c0000000-0000-4000-8000-000000000009
\set chauffeur1 d0000000-0000-4000-8000-000000000001

call test.systeme();
select (now() at time zone 'Europe/Paris')::date as aujourdhui \gset
select id as bienvenue from public.codes_promo where code = 'BIENVENUE10' \gset
select id as course1, numero as numero_c1, prix_total + frais_attente as total_c1
  from public.courses where client_id = :'client1' and statut = 'terminee' and code_promo_id is null
  order by terminee_le limit 1 \gset


-- #############################################################################
-- 1. DROITS
-- #############################################################################
call test.visiteur();
select test.doit_echouer('select public.admin_lister_codes_promo()', 'permission denied');
select test.doit_echouer('select public.admin_lister_campagnes()', 'permission denied');
call test.connexion(:'client1');
select test.doit_echouer('select public.admin_lister_codes_promo()', 'Réservé à l''administration');
select test.doit_echouer('select public.admin_lister_parrainages()', 'Réservé à l''administration');
select test.doit_echouer(format('select public.admin_envoyer_campagne(%L)', gen_random_uuid()), 'Réservé à l''administration');
call test.connexion(:'admin');
select test.doit_echouer('select public.admin_lister_codes_promo()', 'Réservé à l''administration');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer($$update public.codes_promo set valeur = 50$$, 'permission denied');
select test.doit_echouer($$insert into public.campagnes (titre, message, cible, canal) values ('Essai', 'Essai', 'tous', 'application')$$,
                         'permission denied');


-- #############################################################################
-- 2. CODES PROMO
-- #############################################################################
select public.admin_lister_codes_promo() as codes \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'codes'::jsonb -> 'lignes') x
                             where x ->> 'code' = 'BIENVENUE10' and x ->> 'statut' = 'actif'
                               and (x ->> 'utilisations')::int = (select count(*) from public.utilisations_promo u where u.code_promo_id = :'bienvenue')),
                     'liste : BIENVENUE10 actif, utilisations comptées');

-- Création contrôlée
select test.doit_echouer($$select public.admin_enregistrer_code_promo(null, '{"code": "AB", "type": "montant", "valeur": 5}')$$, 'de 3 à 20');
select test.doit_echouer($$select public.admin_enregistrer_code_promo(null, '{"code": " bienvenue10 ", "type": "montant", "valeur": 5}')$$, 'existe déjà');
select test.doit_echouer($$select public.admin_enregistrer_code_promo(null, '{"code": "MOITIE", "type": "pourcentage", "valeur": 120}')$$, '100 % au plus');
select test.doit_echouer($$select public.admin_enregistrer_code_promo(null, '{"code": "ETE2026", "type": "montant", "valeur": 5,
                           "debut": "2026-08-31", "fin": "2026-08-01"}')$$, 'avant le début');
select test.doit_echouer($$select public.admin_enregistrer_code_promo(null, '{"code": "ETE2026", "type": "montant", "valeur": 5, "utilisations_max": 0}')$$,
                         '1 au moins');
select public.admin_enregistrer_code_promo(null, jsonb_build_object('code', 'ete2026', 'libelle', 'Offre d''été', 'type', 'montant', 'valeur', 5,
  'debut', :'aujourdhui'::date + 10, 'fin', :'aujourdhui'::date + 40, 'utilisations_max', 100, 'utilisations_par_client', 1,
  'minimum_course', 20)) as ete \gset
select :'ete'::jsonb ->> 'id' as code_ete \gset
select test.verifier(:'ete'::jsonb ->> 'code' = 'ETE2026'
                     and (:'ete'::jsonb ->> 'debut')::timestamptz = ((:'aujourdhui'::date + 10)::timestamp at time zone 'Europe/Paris')
                     and (:'ete'::jsonb ->> 'fin')::timestamptz = ((:'aujourdhui'::date + 41)::timestamp at time zone 'Europe/Paris')
                     and (:'ete'::jsonb ->> 'minimum_course')::numeric = 20,
                     'code créé en majuscules ; période en jours de Paris, fin comprise (jusqu''au lendemain 0 h)');
select test.verifier((select x ->> 'statut' from jsonb_array_elements(public.admin_lister_codes_promo() -> 'lignes') x where x ->> 'code' = 'ETE2026') = 'a_venir',
                     'statut : à venir');
select public.admin_enregistrer_code_promo(null, '{"code": "NOEL2025", "type": "pourcentage", "valeur": 15, "debut": "2025-12-01", "fin": "2025-12-31"}');
select test.verifier((select x ->> 'statut' from jsonb_array_elements(public.admin_lister_codes_promo() -> 'lignes') x where x ->> 'code' = 'NOEL2025') = 'expire',
                     'statut : expiré');
call test.connexion(:'client2');
select test.verifier(public.verifier_code_promo('noel2025', 30) ->> 'message' = 'Ce code promo a expiré.'
                     and public.verifier_code_promo('ete2026', 30) ->> 'message' = 'Ce code promo n''est pas encore valable.',
                     'à la commande : code expiré, code pas encore valable');
call test.connexion(:'admin', 'aal2');
select public.admin_activer_code_promo(:'bienvenue', false);
select test.verifier((select x ->> 'statut' from jsonb_array_elements(public.admin_lister_codes_promo() -> 'lignes') x where x ->> 'code' = 'BIENVENUE10') = 'desactive',
                     'statut : désactivé');
call test.connexion(:'client2');
select test.verifier(public.verifier_code_promo('BIENVENUE10', 30) ->> 'message' = 'Ce code promo n''existe pas.', 'code désactivé : refusé à la commande');
call test.connexion(:'admin', 'aal2');
select public.admin_activer_code_promo(:'bienvenue', true);

-- Code à usage unique, déjà servi sur une course terminée de Claire
select public.admin_enregistrer_code_promo(null, '{"code": "UNIQUE1", "type": "montant", "valeur": 3, "utilisations_max": 1}') ->> 'id' as code_unique \gset
call test.systeme();
insert into public.utilisations_promo (code_promo_id, client_id, course_id, remise) values (:'code_unique', :'client1', :'course1', 3);
call test.connexion(:'admin', 'aal2');
select (select x from jsonb_array_elements(public.admin_lister_codes_promo() -> 'lignes') x where x ->> 'code' = 'UNIQUE1') as unique1 \gset
select test.verifier(:'unique1'::jsonb ->> 'statut' = 'epuise' and (:'unique1'::jsonb ->> 'utilisations')::int = 1
                     and (:'unique1'::jsonb ->> 'clients')::int = 1 and (:'unique1'::jsonb ->> 'remises')::numeric = 3
                     and (:'unique1'::jsonb ->> 'courses_terminees')::int = 1 and (:'unique1'::jsonb ->> 'chiffre_affaires')::numeric = :'total_c1'::numeric,
                     'statistiques : épuisé, 1 utilisation, 1 client, 3 € de remise, chiffre d''affaires de la course terminée');
select test.verifier(jsonb_array_length(public.admin_utilisations_code(:'code_unique')) = 1
                     and public.admin_utilisations_code(:'code_unique') -> 0 ->> 'course_numero' = :'numero_c1'
                     and public.admin_utilisations_code(:'code_unique') -> 0 ->> 'client' = 'Claire Durand',
                     'utilisations du code : client et course');
select test.doit_echouer(format('select public.admin_enregistrer_code_promo(%L, %L)', :'code_unique',
                                '{"code": "UNIQUE2", "type": "montant", "valeur": 3, "utilisations_max": 1}'), 'ne change plus');
select public.admin_enregistrer_code_promo(:'code_unique', '{"code": "UNIQUE1", "type": "montant", "valeur": 4, "utilisations_max": 2}');
select test.verifier((select valeur = 4 and utilisations_max = 2 from public.codes_promo where id = :'code_unique'),
                     'code déjà servi : son montant et son plafond se modifient, pas son nom');
select test.doit_echouer(format('delete from public.codes_promo where id = %L', :'code_unique'), 'foreign key');
select test.verifier(jsonb_array_length(public.admin_lister_codes_promo() -> 'lignes') = (select count(*) from public.codes_promo),
                     'code déjà servi : il ne se supprime pas');
call test.systeme();
delete from public.utilisations_promo where code_promo_id = :'code_unique';
call test.connexion(:'admin', 'aal2');
delete from public.codes_promo where id in (:'code_unique', :'code_ete');
select test.verifier(not exists (select 1 from public.codes_promo where code in ('UNIQUE1', 'ETE2026')), 'codes jamais utilisés : supprimés');
call test.systeme();
select test.verifier(exists (select 1 from prive.journal where table_cible = 'codes_promo' and ligne_id = :'code_ete' and action = 'INSERT')
                     and exists (select 1 from prive.journal where table_cible = 'codes_promo' and ligne_id = :'code_ete' and action = 'DELETE')
                     and exists (select 1 from prive.journal where table_cible = 'codes_promo' and ligne_id = :'bienvenue' and action = 'UPDATE'),
                     'journal : création, désactivation, suppression des codes');


-- #############################################################################
-- 3. PARRAINAGE
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_lister_parrainages() as parrainages \gset
select test.verifier((:'parrainages'::jsonb -> 'compteurs' ->> 'valides')::int = (select count(*) from public.parrainages where statut = 'valide')
                     and (:'parrainages'::jsonb -> 'compteurs' ->> 'credits')::numeric
                         = (select coalesce(sum(recompense_parrain + recompense_filleul), 0) from public.parrainages where statut = 'valide')
                     and (:'parrainages'::jsonb -> 'recompenses' ->> 'parrain')::numeric = (select recompense_parrain from public.parametres)
                     and :'parrainages'::jsonb -> 'meilleurs' -> 0 ->> 'nom' = 'Claire Durand',
                     'parrainage : validés, crédits versés, récompenses en vigueur, Claire en tête des parrains');
select test.verifier(:'parrainages'::jsonb -> 'lignes' -> 0 -> 'filleul' ->> 'nom' = 'Léa Roux'
                     and (:'parrainages'::jsonb -> 'lignes' -> 0 -> 'filleul' ->> 'courses_terminees')::int >= 1,
                     'liste : le filleul et ses courses terminées');

-- Nouveau filleul, en attente : annulé pour abus
call test.systeme();
select code_parrainage as code_claire from public.profils where id = :'client1' \gset
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data)
values (:'filleul2', 'filleul2@exemple.test', json_build_object('prenom', 'Inès', 'nom', 'Garnier', 'code_parrain', :'code_claire')::jsonb);
reset role;
select id as parrainage2 from public.parrainages where filleul_id = :'filleul2' \gset
call test.connexion(:'admin', 'aal2');
select test.verifier((public.admin_lister_parrainages('en_attente', 'Garnier') -> 'lignes' -> 0 ->> 'id') = :'parrainage2',
                     'filtre « en attente » et recherche par nom');
select test.verifier(jsonb_array_length(public.admin_lister_parrainages(null, :'code_claire') -> 'lignes') = 2,
                     'recherche par code de parrainage');
select test.doit_echouer(format('select public.admin_annuler_parrainage(%L, null)', :'parrainage2'), 'motif');
select public.admin_annuler_parrainage(:'parrainage2', 'Même personne que la marraine : compte créé pour la récompense.');
select test.verifier((select statut from public.parrainages where id = :'parrainage2') = 'annule', 'parrainage en attente annulé');
select test.doit_echouer(format('select public.admin_annuler_parrainage(%L, %L)',
                                (select id from public.parrainages where filleul_id = :'filleul'), 'Essai'), 'Seul un parrainage en attente');
call test.systeme();
select test.verifier(exists (select 1 from prive.journal where table_cible = 'parrainages' and ligne_id = :'parrainage2'
                             and action = 'annulation_parrainage' and apres ->> 'motif' like 'Même personne%')
                     and exists (select 1 from prive.journal where table_cible = 'parrainages' and ligne_id = :'parrainage2' and action = 'UPDATE'),
                     'journal : annulation et son motif');


-- #############################################################################
-- 4. NOTIFICATIONS GROUPÉES
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select (select count(*) from public.profils where role = 'client' and statut = 'actif') as nb_clients \gset
select (select count(*) from public.profils p join public.chauffeurs c on c.id = p.id
        where p.role = 'chauffeur' and p.statut = 'actif' and c.statut = 'valide') as nb_chauffeurs \gset
select test.verifier((public.admin_lister_campagnes() -> 'cibles' ->> 'clients')::int = :nb_clients
                     and (public.admin_lister_campagnes() -> 'cibles' ->> 'chauffeurs')::int = :nb_chauffeurs
                     and (public.admin_lister_campagnes() -> 'cibles' ->> 'tous')::int = :nb_clients + :nb_chauffeurs,
                     'destinataires possibles : clients actifs, chauffeurs validés');
select test.doit_echouer($$select public.admin_enregistrer_campagne(null, 'Horaires des fêtes', 'Texte', 'clients', 'email')$$, 'pas encore relié');
select test.doit_echouer($$select public.admin_enregistrer_campagne(null, '', 'Texte', 'clients')$$, 'Titre');
select test.doit_echouer($$select public.admin_enregistrer_campagne(null, 'Titre', 'Texte', 'proches')$$, 'Destinataires');
select public.admin_enregistrer_campagne(null, 'Horaires des fêtes', 'Brouillon', 'clients') ->> 'id' as campagne \gset
select public.admin_enregistrer_campagne(:'campagne', 'Horaires des fêtes',
  'Le 24 et le 31 décembre, réservez avant 18 h : nos chauffeurs vous attendent toute la nuit.', 'clients');
select test.verifier((select message like 'Le 24 et le 31 décembre%' and envoyee_le is null and cree_par = :'admin'
                      from public.campagnes where id = :'campagne'),
                     'brouillon enregistré, puis modifié');
select public.admin_envoyer_campagne(:'campagne') as envoi \gset
call test.systeme();
select test.verifier((:'envoi'::jsonb ->> 'destinataires')::int = :nb_clients
                     and (select count(*) from public.notifications where campagne_id = :'campagne') = :nb_clients
                     and (select count(distinct n.destinataire_id) from public.notifications n join public.profils p on p.id = n.destinataire_id
                          where n.campagne_id = :'campagne' and p.role = 'client' and p.statut = 'actif') = :nb_clients
                     and (select envoyee_le is not null and nb_destinataires = :nb_clients and envoyee_par = :'admin'
                          from public.campagnes where id = :'campagne'),
                     'envoyée : une notification par client actif, nombre et auteur notés');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_envoyer_campagne(%L)', :'campagne'), 'déjà envoyée');
select test.doit_echouer(format('select public.admin_enregistrer_campagne(%L, %L, %L, %L)', :'campagne', 'Autre', 'Autre', 'tous'), 'déjà envoyée');
select test.doit_echouer(format('delete from public.campagnes where id = %L', :'campagne'), 'déjà envoyée');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications where campagne_id = :'campagne' and titre = 'Horaires des fêtes'),
                     'Claire la reçoit dans l''application');
update public.notifications set lu_le = now() where campagne_id = :'campagne';
call test.connexion(:'chauffeur1');
select test.verifier(not exists (select 1 from public.notifications where campagne_id = :'campagne'), 'un chauffeur ne la reçoit pas');
call test.connexion(:'admin', 'aal2');
select test.verifier((select (x ->> 'lus')::int from jsonb_array_elements(public.admin_lister_campagnes() -> 'lignes') x
                      where x ->> 'id' = :'campagne') = 1,
                     'lectures comptées');
select public.admin_enregistrer_campagne(null, 'Essai', 'À supprimer', 'chauffeurs') ->> 'id' as brouillon \gset
delete from public.campagnes where id = :'brouillon';
select test.verifier(not exists (select 1 from public.campagnes where id = :'brouillon'), 'brouillon supprimé');
call test.systeme();
select test.verifier(exists (select 1 from prive.journal where table_cible = 'campagnes' and ligne_id = :'campagne' and action = 'UPDATE'
                             and apres ->> 'envoyee_le' is not null),
                     'journal : envoi de la campagne');


-- #############################################################################
-- 5. TABLEAU DE BORD : ALERTES DES MODULES RH ET SUPPORT (migration 19)
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.verifier(not exists (select 1 from jsonb_array_elements(public.admin_tableau_de_bord() -> 'alertes') a
                                 where a ->> 'titre' like '%attend% une réponse'),
                     'aucune demande dont l''auteur attend une réponse : pas d''alerte');
call test.connexion(:'client1');
select id as d_attente from public.demandes where sujet = 'Double débit ?' \gset
insert into public.messages (demande_id, auteur_id, contenu) values (:'d_attente', auth.uid(), 'Le second débit apparaît toujours sur mon relevé.');
call test.connexion(:'admin', 'aal2');
select public.admin_tableau_de_bord() -> 'alertes' as alertes \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a
                             where a ->> 'titre' = '1 demande au support attend une réponse' and a ->> 'lien' = 'support/' and a ->> 'module' = 'support'),
                     'alerte : la demande dont l''auteur a répondu, lien vers le support');
select test.verifier(exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a
                             where a ->> 'titre' = '1 demande de devis' and a ->> 'lien' = 'support/?vue=site')
                     and not exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a where a ->> 'titre' like '%formulaire de contact%'),
                     'alertes des messages du site : la demande de devis nouvelle (lien vers la vue), plus de message de contact à traiter');
call test.systeme();
select count(*) as absences_demandees from public.absences where statut = 'demandee' \gset
select (date_trunc('month', now() at time zone 'Europe/Paris') - interval '1 month')::date as mois_ecoule \gset
select count(*) as bulletins_attendus from public.salaries s
 where s.date_entree <= (:'mois_ecoule'::date + interval '1 month')::date - 1 and (s.date_sortie is null or s.date_sortie >= :'mois_ecoule'::date)
   and not exists (select 1 from public.bulletins b where b.salarie_id = s.id and b.periode = :'mois_ecoule'::date and b.statut <> 'brouillon')
   and not exists (select 1 from public.reprises_paie rp where rp.salarie_id = s.id and rp.mois >= :'mois_ecoule'::date) \gset
select prive.de_mois(:'mois_ecoule'::date) as de_mois_ecoule \gset
call test.connexion(:'admin', 'aal2');
select test.verifier(case when :absences_demandees = 0
                          then not exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a where a ->> 'lien' = 'rh/?vue=absences')
                          else exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a where a ->> 'lien' = 'rh/?vue=absences'
                                       and a ->> 'titre' like :absences_demandees || ' demande%') end,
                     'alerte RH : demandes d''absence à décider (' || :absences_demandees || ')');
select test.verifier(case when :bulletins_attendus = 0
                          then not exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a where a ->> 'lien' like 'rh/?vue=bulletins%')
                          else exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a
                                       where a ->> 'lien' = 'rh/?vue=bulletins&periode=' || :'mois_ecoule'
                                         and a ->> 'titre' = :bulletins_attendus || case when :bulletins_attendus = 1 then ' bulletin ' else ' bulletins ' end
                                                             || :'de_mois_ecoule' || ' à valider') end,
                     'alerte RH : bulletins du mois écoulé à valider (' || :bulletins_attendus || ', « ' || :'de_mois_ecoule' || ' »)');
select test.verifier(not exists (select 1 from jsonb_array_elements(:'alertes'::jsonb) a where a ->> 'lien' = 'rh/?vue=parametres'),
                     'paramètres de paie de l''année validés : pas d''alerte');


-- #############################################################################
-- 6. DROITS SUR LES FONCTIONS
-- #############################################################################
call test.systeme();
select test.verifier(not has_function_privilege('anon', 'public.admin_lister_codes_promo()', 'execute')
                     and not has_function_privilege('anon', 'public.admin_envoyer_campagne(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.admin_enregistrer_code_promo(uuid, jsonb)', 'execute')
                     and not has_function_privilege('authenticated', 'prive.destinataires_campagne(text)', 'execute')
                     and not has_function_privilege('authenticated', 'prive.statut_code_promo(public.codes_promo, integer)', 'execute'),
                     'fonctions du module : fermées aux visiteurs, ouvertes une fois connecté (contrôle dans la fonction)');
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables restent protégées ligne par ligne');

\o
\echo '✔ Marketing : tout est conforme.'
