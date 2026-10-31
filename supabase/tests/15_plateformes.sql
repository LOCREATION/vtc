-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios du module « Plateformes » (migration 15), joués après
-- 14_finances.sql sur les mêmes comptes fictifs :
--   droits, saisie d'un relevé (net et montant viré calculés), contrôles
--   (plateforme, chauffeur, dates, montants, chevauchement), correction, PDF
--   joint, liste d'une période et ses filtres, rentabilité par chauffeur,
--   suppression et journal.
-- Les montants attendus sont recalculés ici indépendamment, à partir des
-- tables. Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set chauffeuse d0000000-0000-4000-8000-000000000002

-- Aujourd'hui (Paris), et les deux semaines écoulées (du lundi au dimanche)
select (now() at time zone 'Europe/Paris')::date                         as aujourdhui,
       date_trunc('week', now() at time zone 'Europe/Paris')::date - 7    as s1_debut,
       date_trunc('week', now() at time zone 'Europe/Paris')::date - 1    as s1_fin,
       date_trunc('week', now() at time zone 'Europe/Paris')::date - 14   as s2_debut,
       date_trunc('week', now() at time zone 'Europe/Paris')::date - 8    as s2_fin
\gset


-- #############################################################################
-- 1. DROITS
-- #############################################################################
call test.visiteur();
select test.doit_echouer(format('select public.admin_lister_releves(%L, %L)', :'s1_debut', :'s1_fin'), 'permission denied');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.admin_lister_releves(%L, %L)', :'s1_debut', :'s1_fin'), 'Réservé à l''administration');
select test.doit_echouer(format('select public.admin_rentabilite_chauffeurs(%L, %L)', :'s1_debut', :'s1_fin'), 'Réservé à l''administration');
-- Administrateur sans la double authentification
call test.connexion(:'admin');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L, 10, 100, 17, 0, 0, 0)',
                                'bolt', :'chauffeur1', :'s1_debut', :'s1_fin'), 'Réservé à l''administration');


-- #############################################################################
-- 2. SAISIE D'UN RELEVÉ
-- #############################################################################
call test.connexion(:'admin', 'aal2');
-- Relevé Bolt de Paul, semaine dernière : 812,40 € de trajets, 143,79 € de
-- frais de service (17,7 %), 12 € de pourboires, 25 € de bonus, 96,50 €
-- d'espèces collectées
select (public.admin_enregistrer_releve(null, 'bolt', :'chauffeur1', :'s1_debut', :'s1_fin', 31, 812.40, 143.79, 12.00, 25.00, 96.50,
        '  BOLT-FR-2026-0042  ', 'Relevé de la semaine')).id as releve1 \gset
select test.verifier((select r.montant_net = 705.61 and r.virement = 609.11 and r.cree_par = :'admin'
                             and r.reference = 'BOLT-FR-2026-0042' and r.nb_courses = 31 and r.plateforme = 'bolt'
                      from public.releves_plateformes r where r.id = :'releve1'),
                     'relevé Bolt : net 705,61 € (trajets − frais + pourboires + ajustements), viré 609,11 € (net − espèces), référence nettoyée');

-- Même semaine sur Uber : autorisé (autre plateforme), frais à 25 %
select (public.admin_enregistrer_releve(null, 'uber', :'chauffeur1', :'s1_debut', :'s1_fin', 6, 154.20, 38.55, 0, 0, 0)).id as releve_uber \gset
-- Nadia : deux semaines Bolt, dont une avec des espèces au-delà du net
select (public.admin_enregistrer_releve(null, 'bolt', :'chauffeuse', :'s2_debut', :'s2_fin', 24, 640.00, 113.28, 0, -4.50, 210.00)).id as releve_nadia2 \gset
select (public.admin_enregistrer_releve(null, 'bolt', :'chauffeuse', :'s1_debut', :'s1_fin', 27, 702.35, 124.32, 5.00, 0, 0)).id as releve_nadia1 \gset
select test.verifier((select r.montant_net = 522.22 and r.virement = 312.22 from public.releves_plateformes r where r.id = :'releve_nadia2')
                     and (select r.montant_net = 583.03 and r.virement = 583.03 from public.releves_plateformes r where r.id = :'releve_nadia1'),
                     'relevés de Nadia : ajustement négatif déduit du net, montant viré net des espèces');


-- #############################################################################
-- 3. CONTRÔLES
-- #############################################################################
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L, 1, 10, 1, 0, 0, 0)',
                                'blablacar', :'chauffeur1', :'s2_debut', :'s2_fin'), 'Plateforme inconnue : Bolt, Uber, Heetch ou autre.');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, null, %L, %L, 1, 10, 1, 0, 0, 0)',
                                'bolt', :'s2_debut', :'s2_fin'), 'Choisissez le chauffeur');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L, 1, 10, 1, 0, 0, 0)',
                                'bolt', :'client1', :'s2_debut', :'s2_fin'), 'Chauffeur introuvable.');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L, 1, 10, 1, 0, 0, 0)',
                                'bolt', :'chauffeur1', :'s2_fin', :'s2_debut'), 'La date de fin est avant la date de début.');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L::date - 35, %L, 1, 10, 1, 0, 0, 0)',
                                'heetch', :'chauffeur1', :'s2_fin', :'s2_fin'), 'Un relevé couvre au plus 35 jours');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L::date + 1, 1, 10, 1, 0, 0, 0)',
                                'heetch', :'chauffeur1', :'aujourdhui', :'aujourdhui'), 'Le relevé se termine après aujourd''hui');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L, 1, 10, -1, 0, 0, 0)',
                                'heetch', :'chauffeur1', :'s2_debut', :'s2_fin'), 'ne peuvent pas être négatifs');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L, 0, 0, 0, 0, 0, 0)',
                                'heetch', :'chauffeur1', :'s2_debut', :'s2_fin'), 'Le relevé est vide');
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L, %L, -2, 10, 1, 0, 0, 0)',
                                'heetch', :'chauffeur1', :'s2_debut', :'s2_fin'), 'Nombre de courses invalide.');
-- Chevauchement : un relevé Bolt de Paul du mercredi au mardi suivant
select test.doit_echouer(format('select public.admin_enregistrer_releve(null, %L, %L, %L::date + 2, %L::date + 1, 5, 100, 17, 0, 0, 0)',
                                'bolt', :'chauffeur1', :'s2_debut', :'s1_debut'),
                         format('Paul Bernard a déjà un relevé Bolt du %s au %s qui couvre une partie de ces dates',
                                to_char(:'s1_debut'::date, 'DD/MM/YYYY'), to_char(:'s1_fin'::date, 'DD/MM/YYYY')));
-- La table elle-même refuse un net incohérent et un doublon
select test.doit_echouer(format($$insert into public.releves_plateformes (plateforme, chauffeur_id, debut, fin, montant_trajets, frais_service, montant_net)
                                  values ('heetch', %L, %L, %L, 100, 20, 90)$$, :'chauffeuse', :'s1_debut', :'s1_fin'), 'releves_net');
select test.doit_echouer(format($$insert into public.releves_plateformes (plateforme, chauffeur_id, debut, fin, montant_trajets, frais_service, montant_net)
                                  values ('bolt', %L, %L, %L, 100, 20, 80)$$, :'chauffeuse', :'s1_debut', :'s1_debut'), 'releves_plateformes_periode_idx');
select test.doit_echouer(format($$update public.releves_plateformes set virement = 0 where id = %L$$, :'releve1'), 'virement');


-- #############################################################################
-- 4. CORRECTION
-- #############################################################################
-- Faute de frappe sur les frais (143,80 €) : même période, pas de chevauchement avec lui-même
select public.admin_enregistrer_releve(:'releve1', 'bolt', :'chauffeur1', :'s1_debut', :'s1_fin', 31, 812.40, 143.80, 12.00, 25.00, 96.50,
                                       'BOLT-FR-2026-0042', '');
select test.verifier((select r.montant_net = 705.60 and r.virement = 609.10 and r.note is null and r.maj_le >= r.cree_le
                      from public.releves_plateformes r where r.id = :'releve1'),
                     'relevé corrigé : net et montant viré recalculés, note vide effacée');
select test.doit_echouer(format('select public.admin_enregistrer_releve(%L, %L, %L, %L, %L, 1, 10, 1, 0, 0, 0)',
                                gen_random_uuid(), 'heetch', :'chauffeur1', :'s2_debut', :'s2_fin'), 'Relevé introuvable.');
call test.systeme();
select test.verifier((select count(*) from prive.journal where table_cible = 'releves_plateformes' and ligne_id = :'releve1') = 2
                     and exists (select 1 from prive.journal where table_cible = 'releves_plateformes' and ligne_id = :'releve1'
                                 and action = 'UPDATE' and avant ->> 'frais_service' = '143.79' and apres ->> 'frais_service' = '143.80'),
                     'journal : saisie et correction du relevé, avec la valeur avant et après');
call test.connexion(:'admin', 'aal2');


-- #############################################################################
-- 5. PDF DU RELEVÉ
-- #############################################################################
select test.verifier(public.admin_fichier_releve(:'releve1', 'releves/' || :'releve1' || '/releve-bolt.pdf') is null,
                     'PDF joint : aucun ancien fichier à retirer');
select test.verifier(public.admin_fichier_releve(:'releve1', 'releves/' || :'releve1' || '/releve-bolt-corrige.pdf')
                     = 'releves/' || :'releve1' || '/releve-bolt.pdf',
                     'PDF remplacé : l''ancien emplacement est renvoyé pour le retirer du dossier');
select test.doit_echouer(format('select public.admin_fichier_releve(%L, %L)', :'releve1', 'factures/autre.pdf'), 'Emplacement du fichier invalide.');
select test.doit_echouer(format('select public.admin_fichier_releve(%L, %L)', :'releve1', 'releves/' || :'releve1' || '/../x.pdf'),
                         'Emplacement du fichier invalide.');
select test.doit_echouer(format('select public.admin_fichier_releve(%L, %L)', :'releve_uber', 'releves/' || :'releve1' || '/x.pdf'),
                         'Emplacement du fichier invalide.');


-- #############################################################################
-- 6. LISTE D'UNE PÉRIODE
-- #############################################################################
select public.admin_lister_releves(:'s2_debut', :'s1_fin') as liste \gset
select test.verifier((:'liste'::jsonb ->> 'total')::integer
                       = (select count(*) from public.releves_plateformes where fin between :'s2_debut' and :'s1_fin')
                     and (:'liste'::jsonb -> 'totaux' ->> 'trajets')::numeric
                       = (select sum(montant_trajets) from public.releves_plateformes where fin between :'s2_debut' and :'s1_fin')
                     and (:'liste'::jsonb -> 'totaux' ->> 'frais')::numeric
                       = (select sum(frais_service) from public.releves_plateformes where fin between :'s2_debut' and :'s1_fin')
                     and (:'liste'::jsonb -> 'totaux' ->> 'net')::numeric
                       = (select sum(montant_net) from public.releves_plateformes where fin between :'s2_debut' and :'s1_fin')
                     and (:'liste'::jsonb -> 'totaux' ->> 'especes')::numeric = 306.50
                     and (:'liste'::jsonb -> 'totaux' ->> 'virement')::numeric
                       = (select sum(montant_net) - sum(especes) from public.releves_plateformes where fin between :'s2_debut' and :'s1_fin')
                     and (:'liste'::jsonb -> 'totaux' ->> 'nb_courses')::integer = 88
                     and (:'liste'::jsonb -> 'totaux' ->> 'taux_frais')::numeric
                       = (select round(100 * sum(frais_service) / sum(montant_trajets), 1) from public.releves_plateformes
                          where fin between :'s2_debut' and :'s1_fin'),
                     'liste de deux semaines : 4 relevés, totaux et taux moyen des frais recalculés');
select test.verifier((select jsonb_agg(x ->> 'plateforme' || ':' || (x ->> 'nb') || ':' || (x ->> 'taux_frais') order by x ->> 'plateforme')
                      from jsonb_array_elements(:'liste'::jsonb -> 'par_plateforme') x)
                     = '["bolt:3:17.7", "uber:1:25.0"]'::jsonb,
                     'répartition par plateforme : Bolt 3 relevés à 17,7 %, Uber 1 à 25 %');
select test.verifier((select x ->> 'chauffeur_nom' = 'Paul Bernard' and (x ->> 'taux_frais')::numeric = 17.7
                             and x ->> 'cree_par_nom' is not null and (x ->> 'virement')::numeric = 609.10
                      from jsonb_array_elements(:'liste'::jsonb -> 'lignes') x where x ->> 'id' = :'releve1'),
                     'ligne du relevé : chauffeur, taux des frais, auteur de la saisie, montant viré');
select test.verifier((select x ->> 'fin' from jsonb_array_elements(:'liste'::jsonb -> 'lignes') with ordinality as l(x, n) where n = 1)
                     = :'s1_fin'
                     and (select x ->> 'fin' from jsonb_array_elements(:'liste'::jsonb -> 'lignes') with ordinality as l(x, n)
                          where n = jsonb_array_length(:'liste'::jsonb -> 'lignes')) = :'s2_fin',
                     'liste : les relevés les plus récents d''abord');
select test.verifier((select count(*) from jsonb_array_elements(:'liste'::jsonb -> 'chauffeurs') x
                      where x ->> 'id' in (:'chauffeur1', :'chauffeuse')) = 2,
                     'liste des chauffeurs proposée pour les filtres et la saisie');
select test.verifier((public.admin_lister_releves(:'s2_debut', :'s1_fin', :'chauffeuse') ->> 'total')::integer = 2
                     and (public.admin_lister_releves(:'s2_debut', :'s1_fin', null, 'uber') ->> 'total')::integer = 1
                     and (public.admin_lister_releves(:'s1_debut', :'s1_fin') ->> 'total')::integer = 3,
                     'filtres : par chauffeur, par plateforme ; un relevé compte dans la période où il se termine');
select test.doit_echouer(format('select public.admin_lister_releves(%L, %L, null, %L)', :'s2_debut', :'s1_fin', 'blablacar'),
                         'Plateforme inconnue');


-- #############################################################################
-- 7. RENTABILITÉ PAR CHAUFFEUR
-- #############################################################################
select public.admin_rentabilite_chauffeurs(:'s2_debut', :'aujourdhui') as renta \gset
select (select taux_tva_transport from public.parametres where id = 1) as tva \gset

-- Chiffres de Paul recalculés à partir des tables
select coalesce(sum(f.montant_ht - coalesce((select sum(a.montant_ht) from public.avoirs a where a.facture_id = f.id), 0)), 0) as paul_d_ht,
       coalesce(sum(f.montant_ttc - coalesce((select sum(a.montant_ttc) from public.avoirs a where a.facture_id = f.id), 0)), 0) as paul_d_ttc,
       count(*) filter (where f.nature = 'course') as paul_d_courses
from public.factures f join public.courses c on c.id = f.course_id
where c.chauffeur_id = :'chauffeur1'
  and ((f.nature = 'course' and c.statut = 'terminee'
        and (c.terminee_le at time zone 'Europe/Paris')::date between :'s2_debut' and :'aujourdhui')
    or (f.nature = 'frais_annulation' and c.statut = 'annulee'
        and (c.annulee_le at time zone 'Europe/Paris')::date between :'s2_debut' and :'aujourdhui')) \gset
select sum(montant_trajets) as paul_r_trajets, sum(frais_service) as paul_r_frais, round(sum(montant_trajets) / (1 + :tva / 100), 2) as paul_r_ht
from public.releves_plateformes where chauffeur_id = :'chauffeur1' and fin between :'s2_debut' and :'aujourdhui' \gset
select sum(frais_service) / sum(montant_trajets) as taux_moyen
from public.releves_plateformes where chauffeur_id is not null and fin between :'s2_debut' and :'aujourdhui' \gset
select x as paul from jsonb_array_elements(:'renta'::jsonb -> 'chauffeurs') x where x ->> 'chauffeur_id' = :'chauffeur1' \gset

select test.verifier(:paul_d_courses > 0 and :paul_d_ht > 0, 'Paul a des courses facturées dans la période (données des scénarios précédents)');
select test.verifier((:'paul'::jsonb -> 'direct' ->> 'ht')::numeric = :paul_d_ht
                     and (:'paul'::jsonb -> 'direct' ->> 'ttc')::numeric = :paul_d_ttc
                     and (:'paul'::jsonb -> 'direct' ->> 'courses')::integer = :paul_d_courses,
                     'rentabilité de Paul : courses en direct, HT et TTC avoirs déduits');
select test.verifier((:'paul'::jsonb -> 'plateformes' ->> 'trajets')::numeric = :paul_r_trajets
                     and (:'paul'::jsonb -> 'plateformes' ->> 'ht')::numeric = :paul_r_ht
                     and (:'paul'::jsonb -> 'plateformes' ->> 'frais')::numeric = :paul_r_frais
                     and (:'paul'::jsonb -> 'plateformes' ->> 'releves')::integer = 2
                     and (:'paul'::jsonb -> 'plateformes' ->> 'courses')::integer = 37,
                     'rentabilité de Paul : plateformes (trajets, HT à la TVA du transport, frais, relevés, courses)');
select test.verifier((:'paul'::jsonb ->> 'ca_ht')::numeric = :paul_d_ht + :paul_r_ht
                     and (:'paul'::jsonb ->> 'part_direct')::numeric = round(100 * :paul_d_ht / (:paul_d_ht + :paul_r_ht), 1)
                     and (:'paul'::jsonb ->> 'marge')::numeric = :paul_d_ht + :paul_r_ht - :paul_r_frais
                     and (:'paul'::jsonb -> 'cout_salarial' ->> 'montant')::numeric = 0
                     and (:'paul'::jsonb ->> 'commission_evitee')::numeric = round(:paul_d_ttc * :taux_moyen, 2),
                     'rentabilité de Paul : chiffre d''affaires HT, part du direct, marge après salaire, commission évitée');
select test.verifier((:'renta'::jsonb ->> 'taux_frais_moyen')::numeric = round(100 * :taux_moyen, 1)
                     and (:'renta'::jsonb -> 'totaux' ->> 'ca_ht')::numeric
                       = (select sum((x ->> 'ca_ht')::numeric) from jsonb_array_elements(:'renta'::jsonb -> 'chauffeurs') x)
                     and (:'renta'::jsonb -> 'totaux' ->> 'marge')::numeric
                       = (select sum((x ->> 'marge')::numeric) from jsonb_array_elements(:'renta'::jsonb -> 'chauffeurs') x)
                     and (:'renta'::jsonb -> 'totaux' -> 'plateformes' ->> 'frais')::numeric
                       = (select sum(frais_service) from public.releves_plateformes where fin between :'s2_debut' and :'aujourdhui'),
                     'rentabilité : taux moyen des frais, totaux égaux à la somme des chauffeurs');
select test.verifier((select count(*) from jsonb_array_elements(:'renta'::jsonb -> 'chauffeurs'))
                     >= (select count(*) from public.chauffeurs where statut in ('valide', 'suspendu')),
                     'rentabilité : tous les chauffeurs validés figurent, même sans activité');
select test.verifier((select (x -> 'direct' ->> 'ht')::numeric = 0 and (x ->> 'commission_evitee')::numeric = 0
                      from jsonb_array_elements(public.admin_rentabilite_chauffeurs(:'s2_debut', :'s2_fin') -> 'chauffeurs') x
                      where x ->> 'chauffeur_id' = :'chauffeuse'),
                     'rentabilité d''une semaine sans course en direct : rien en direct, aucune commission évitée');


-- #############################################################################
-- 8. SUPPRESSION (directement dans la table : règle d'accès de l'administration)
-- #############################################################################
call test.connexion(:'chauffeur1');
delete from public.releves_plateformes where id = :'releve1';
call test.connexion(:'admin', 'aal2');
select test.verifier((select count(*) from public.releves_plateformes where id = :'releve1') = 1,
                     'un chauffeur ne peut supprimer aucun relevé');
call test.connexion(:'admin');
delete from public.releves_plateformes where id = :'releve1';
call test.connexion(:'admin', 'aal2');
select test.verifier((select count(*) from public.releves_plateformes where id = :'releve1') = 1,
                     'un administrateur sans double authentification ne peut pas non plus');
delete from public.releves_plateformes where id = :'releve1';
select test.verifier((select count(*) from public.releves_plateformes where id = :'releve1') = 0,
                     'relevé supprimé par l''administration (double authentification)');
call test.systeme();
select test.verifier(exists (select 1 from prive.journal where table_cible = 'releves_plateformes' and ligne_id = :'releve1'
                             and action = 'DELETE' and (avant ->> 'montant_trajets')::numeric = 812.40
                             and avant ->> 'fichier_chemin' = 'releves/' || :'releve1' || '/releve-bolt-corrige.pdf'),
                     'journal : la suppression y figure, avec le relevé complet et son PDF');
-- Le relevé de Paul est ressaisi (données du parcours dans le navigateur)
call test.connexion(:'admin', 'aal2');
select public.admin_enregistrer_releve(null, 'bolt', :'chauffeur1', :'s1_debut', :'s1_fin', 31, 812.40, 143.79, 12.00, 25.00, 96.50,
                                       'BOLT-FR-2026-0042', null);


-- #############################################################################
-- 9. DROITS SUR LA TABLE ET LES FONCTIONS
-- #############################################################################
call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.releves_plateformes) = 0, 'un chauffeur ne lit aucun relevé, pas même les siens');
call test.systeme();
select test.verifier(not has_function_privilege('anon', 'public.admin_lister_releves(date, date, uuid, text)', 'execute')
                     and not has_function_privilege('anon', 'public.admin_rentabilite_chauffeurs(date, date)', 'execute')
                     and has_function_privilege('authenticated', 'public.admin_enregistrer_releve(uuid, text, uuid, date, date, integer, numeric, numeric, numeric, numeric, numeric, text, text)', 'execute')
                     and not has_function_privilege('authenticated', 'prive.nom_plateforme(text)', 'execute'),
                     'fonctions du module : fermées aux visiteurs, ouvertes une fois connecté (contrôle dans la fonction)');
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables restent protégées ligne par ligne');

\o
\echo '✔ Plateformes : tout est conforme.'
