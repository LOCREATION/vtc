-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios de l'espace d'administration (migration 10), joués après
-- 11_scenarios.sql sur les mêmes comptes fictifs :
--   double authentification, tableau de bord, dispatch et attribution à la
--   main, retrait d'une course, relance de la recherche, suspension d'un
--   chauffeur, option chauffeuse, liste et fiche des courses, chauffeurs,
--   activité, recherche de comptes, droits d'exécution.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set clienttel  c0000000-0000-4000-8000-000000000003
\set filleul    c0000000-0000-4000-8000-000000000004
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set chauffeuse d0000000-0000-4000-8000-000000000002

select (((now() at time zone 'Europe/Paris')::date + 1) + time '12:00') at time zone 'Europe/Paris' as demain_midi,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '16:00') at time zone 'Europe/Paris' as demain_16h,
       (now() at time zone 'Europe/Paris')::date as aujourdhui
\gset


-- #############################################################################
-- 1. DOUBLE AUTHENTIFICATION
-- #############################################################################
-- Administrateur connecté par code e-mail seulement (aal1) : droits d'un client
call test.connexion(:'admin');
select test.verifier(not public.est_admin(), 'administrateur sans double authentification : droits d''administration fermés');
select test.verifier((select count(*) from public.profils) = 1, 'administrateur en aal1 : ne voit que son propre profil');
select test.verifier(public.mon_role() = 'admin', 'administrateur en aal1 : son rôle reste lisible (écran de double authentification)');
select test.doit_echouer('select public.admin_tableau_de_bord()', 'Réservé');
select test.doit_echouer('select public.admin_dispatch()', 'Réservé');
select test.doit_echouer('select count(*) from public.journal_lister()', 'Réservé');
-- (une modification refusée par les règles d'accès ne touche simplement aucune ligne)
update public.parametres set attente_gratuite_min = 9;
select test.verifier((select attente_gratuite_min from public.parametres) <> 9, 'administrateur en aal1 : réglages non modifiables');
select test.verifier((select count(*) from public.codes_promo) = 0, 'administrateur en aal1 : codes promo invisibles');

-- Même compte après le code de l'application d'authentification (aal2)
call test.connexion(:'admin', 'aal2');
select test.verifier(public.est_admin(), 'administrateur avec double authentification : droits ouverts');
select test.verifier((select count(*) from public.profils) = 7, 'administrateur en aal2 : voit tous les comptes');

-- Un client, même en aal2, n'est jamais administrateur
call test.connexion(:'client1', 'aal2');
select test.verifier(not public.est_admin(), 'client avec double authentification : toujours pas administrateur');
select test.doit_echouer('select public.admin_lister_chauffeurs()', 'Réservé');
select test.doit_echouer('select public.admin_lister_courses()', 'Réservé');
call test.connexion(:'chauffeuse', 'aal2');
select test.doit_echouer('select public.admin_dispatch()', 'Réservé');

-- Visiteur : aucune fonction d'administration appelable
call test.visiteur();
select test.doit_echouer('select public.admin_tableau_de_bord()', 'permission denied');
select test.doit_echouer('select public.admin_rechercher_comptes(''exemple'')', 'permission denied');


-- #############################################################################
-- 2. TABLEAU DE BORD
-- #############################################################################
-- Échéances proches ou dépassées, paiement en attente depuis 2 jours
call test.connexion(:'admin', 'aal2');
update public.chauffeurs set permis_expiration = current_date + 10 where id = :'chauffeur1';
update public.vehicules set controle_technique_expiration = current_date - 1 where immatriculation = 'GB-456-CD';
call test.systeme();
insert into public.paiements (course_id, client_id, nature, mode, montant, cree_le)
select c.id, c.client_id, 'pourboire', 'especes', 2.00, now() - interval '2 days'
from public.courses c where c.numero = 'C-2026-000001'
returning id as paiement_ancien \gset

-- Valeurs attendues, recalculées ici indépendamment (heure de Paris)
select count(*) filter (where statut = 'terminee' and (terminee_le at time zone 'Europe/Paris')::date = :'aujourdhui')::integer as nb_jour,
       coalesce(sum(prix_total + frais_attente) filter (where statut = 'terminee' and (terminee_le at time zone 'Europe/Paris')::date = :'aujourdhui'), 0)
     + coalesce(sum(frais_annulation) filter (where statut = 'annulee' and (annulee_le at time zone 'Europe/Paris')::date = :'aujourdhui'), 0) as ca_jour,
       count(*) filter (where statut = 'annulee' and (annulee_le at time zone 'Europe/Paris')::date = :'aujourdhui')::integer as annul_jour
from public.courses \gset

call test.connexion(:'admin', 'aal2');
select public.admin_tableau_de_bord() as tdb \gset
select test.verifier((:'tdb'::jsonb -> 'jour' ->> 'courses_terminees')::integer = :nb_jour,
                     'tableau de bord : courses terminées du jour (' || :nb_jour || ')');
select test.verifier((:'tdb'::jsonb -> 'jour' ->> 'chiffre_affaires')::numeric = :ca_jour,
                     'tableau de bord : chiffre d''affaires du jour, frais d''annulation compris (' || :ca_jour || ' €)');
select test.verifier((:'tdb'::jsonb -> 'jour' ->> 'annulations')::integer = :annul_jour, 'tableau de bord : annulations du jour');
select test.verifier((:'tdb'::jsonb -> 'mois' ->> 'chiffre_affaires')::numeric >= :ca_jour, 'tableau de bord : le mois contient le jour');
select test.verifier(jsonb_array_length(:'tdb'::jsonb -> 'serie') = 14
                     and (:'tdb'::jsonb -> 'serie' -> 13 ->> 'jour')::date = :'aujourdhui'
                     and (:'tdb'::jsonb -> 'serie' -> 13 ->> 'courses')::integer = :nb_jour,
                     'tableau de bord : série de 14 jours finissant aujourd''hui');
select test.verifier((:'tdb'::jsonb -> 'chauffeurs' ->> 'valides')::integer = 2
                     and (:'tdb'::jsonb -> 'chauffeurs' ->> 'en_ligne')::integer = 1,
                     'tableau de bord : 2 chauffeurs validés, 1 en ligne');
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'niveau' = 'urgent' and a ->> 'titre' = 'Contrôle technique · GB-456-CD'),
                     'alerte urgente : contrôle technique expiré');
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'niveau' = 'attention' and a ->> 'titre' = 'Permis de conduire · Paul Bernard'),
                     'alerte : permis expirant dans 10 jours');
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'module' = 'finances' and a ->> 'lien' = 'finances/?vue=a_encaisser'
                               and a ->> 'titre' like '%à encaisser depuis plus de 24 h'),
                     'alerte : paiement à encaisser depuis plus de 24 h (mène aux encaissements du module Finances)');
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'titre' = 'Numéro d''inscription au registre VTC manquant'),
                     'alerte : n° d''inscription au registre VTC manquant');
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'titre' = 'Mise à disposition non tarifée · Berline hybride'),
                     'alerte : mise à disposition non tarifée');
select test.verifier(not exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                                 where a ->> 'titre' like 'Frais d''annulation à 0 €%'),
                     'pas d''alerte sur les frais d''annulation (5 € fixés)');
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'titre' = '1 message du formulaire de contact')
                     and exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                                 where a ->> 'titre' = '1 demande de devis'),
                     'alertes : message de contact et demande de devis à traiter');

-- Remise en état
update public.chauffeurs set permis_expiration = null where id = :'chauffeur1';
update public.vehicules set controle_technique_expiration = null where immatriculation = 'GB-456-CD';
call test.systeme();
delete from public.paiements where id = :'paiement_ancien';


-- #############################################################################
-- 3. DISPATCH, ATTRIBUTION À LA MAIN, RETRAIT, RELANCE
-- #############################################################################
-- Course immédiate : la chauffeuse (seule en ligne) reçoit la demande
call test.connexion(:'client1');
select id as c_imm from public.commander_course('berline_hybride', '2 rue de Rivoli, 75004 Paris', 48.8556, 2.3590,
                                                'Gare de Lyon, 75012 Paris', 48.8443, 2.3743) \gset

call test.connexion(:'admin', 'aal2');
select public.admin_dispatch() as dispatch \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'dispatch'::jsonb -> 'courses') c
                             where c ->> 'id' = :'c_imm' and c ->> 'statut' = 'recherche'
                               and c -> 'demande' ->> 'chauffeur_nom' = 'Nadia Moreau'
                               and c ->> 'client_nom' = 'Claire Durand' and c ->> 'client_telephone' = '+33611111111'),
                     'dispatch : course en recherche, demande en attente chez Nadia, client identifié');
select test.verifier(exists (select 1 from jsonb_array_elements(:'dispatch'::jsonb -> 'chauffeurs') c
                             where c ->> 'nom' = 'Nadia Moreau' and (c ->> 'en_ligne')::boolean
                               and (c ->> 'signal_recent')::boolean and (c ->> 'demande_en_attente')::boolean)
                     and exists (select 1 from jsonb_array_elements(:'dispatch'::jsonb -> 'chauffeurs') c
                                 where c ->> 'nom' = 'Paul Bernard' and not (c ->> 'en_ligne')::boolean),
                     'dispatch : chauffeurs avec position, état en ligne et demande en attente');

select test.verifier((select count(*) from public.admin_chauffeurs_pour_course(:'c_imm')) = 2
                     and (select nom from public.admin_chauffeurs_pour_course(:'c_imm') limit 1) = 'Nadia Moreau',
                     'attribution à la main : chauffeurs proposés, celle en ligne d''abord');
select test.verifier((select attribuable and motif is null and not en_ligne from public.admin_chauffeurs_pour_course(:'c_imm')
                      where nom = 'Paul Bernard'),
                     'attribution à la main : chauffeur hors ligne attribuable quand même');

-- Attribution à Paul : la demande en attente chez Nadia est retirée
select public.attribuer_course(:'c_imm', :'chauffeur1');
select test.verifier((select statut = 'acceptee' and chauffeur_id = :'chauffeur1' and attribution = 'manuelle'
                      from public.courses where id = :'c_imm'),
                     'attribution à la main : course acceptée par Paul');
select test.verifier((select statut from public.propositions where course_id = :'c_imm' and chauffeur_id = :'chauffeuse') = 'annulee',
                     'attribution à la main : demande en attente chez Nadia retirée');

-- Retrait : la course repart en recherche ; Nadia a déjà été sollicitée,
-- personne d'autre en ligne → « à attribuer »
select public.admin_retirer_chauffeur(:'c_imm', 'Retard du chauffeur');
select test.verifier((select chauffeur_id is null and statut = 'a_attribuer' and vehicule_immatriculation is null
                      from public.courses where id = :'c_imm'),
                     'retrait du chauffeur : course sans chauffeur, « à attribuer » faute de candidat');
call test.connexion(:'chauffeur1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Course retirée' and message like '%Retard du chauffeur%'),
                     'retrait : le chauffeur est prévenu, avec le motif');
select test.verifier((select count(*) from public.courses where id = :'c_imm') = 0,
                     'retrait : le chauffeur ne voit plus la course');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Changement de chauffeur'),
                     'retrait : le client est prévenu');
call test.systeme();
select test.verifier(exists (select 1 from public.evenements_course where course_id = :'c_imm' and type = 'chauffeur_retire'
                             and acteur_id = :'admin')
                     and exists (select 1 from prive.journal where action = 'retrait_chauffeur' and ligne_id = :'c_imm'),
                     'retrait : étape horodatée et action inscrite au journal');

-- Relance de la recherche : impossible tant que personne n'est disponible
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_lancer_recherche(%L)', :'c_imm'), 'Aucun chauffeur en ligne');
select test.verifier((select statut from public.courses where id = :'c_imm') = 'a_attribuer',
                     'relance sans chauffeur disponible : rien ne change');
-- Paul passe en ligne : la relance lui envoie la demande
call test.connexion(:'chauffeur1');
select public.mettre_en_ligne(true, 48.8560, 2.3600);
call test.connexion(:'admin', 'aal2');
select public.admin_lancer_recherche(:'c_imm');
select test.verifier((select statut from public.courses where id = :'c_imm') = 'recherche'
                     and (select chauffeur_id from public.propositions where course_id = :'c_imm' and statut = 'envoyee') = :'chauffeur1',
                     'relance de la recherche : demande envoyée au chauffeur en ligne');
select test.doit_echouer(format('select public.admin_lancer_recherche(%L)', :'c_imm'), 'ne se relance que');

-- Paul accepte et prend le client à bord : plus de retrait ni de suspension possible
call test.connexion(:'chauffeur1');
select public.accepter_proposition((select id from public.propositions where course_id = :'c_imm' and statut = 'envoyee'));
select public.avancer_course(:'c_imm', 'arrivee');
select public.avancer_course(:'c_imm', 'a_bord');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_retirer_chauffeur(%L)', :'c_imm'), 'déjà à bord');
select test.doit_echouer(format('select public.admin_statut_chauffeur(%L, %L)', :'chauffeur1', 'suspendu'), 'course en cours');
call test.connexion(:'chauffeur1');
select public.avancer_course(:'c_imm', 'terminee');
select public.mettre_en_ligne(false);


-- #############################################################################
-- 4. SUSPENSION D'UN CHAUFFEUR
-- #############################################################################
-- Réservation de demain attribuée à Paul, puis Paul suspendu : la réservation
-- revient au dispatch, Paul ne peut plus passer en ligne
call test.connexion(:'filleul');
select id as c_plan from public.commander_course('berline_hybride', 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
                                                 'Aéroport Paris-Orly', 48.7262, 2.3652,
                                                 p_type => 'planifiee', p_quand => :'demain_midi') \gset
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'c_plan', :'chauffeur1');
select test.verifier((select statut = 'planifiee' and chauffeur_id = :'chauffeur1' from public.courses where id = :'c_plan'),
                     'réservation de demain attribuée : reste « planifiée », chauffeur désigné');
select public.admin_statut_chauffeur(:'chauffeur1', 'suspendu', 'Contrôle des documents');
select test.verifier((select statut from public.chauffeurs where id = :'chauffeur1') = 'suspendu',
                     'suspension : fiche « suspendue »');
select test.verifier((select chauffeur_id is null and statut = 'planifiee' from public.courses where id = :'c_plan'),
                     'suspension : la réservation à venir revient au dispatch');
select test.verifier((select count(*) from public.admin_chauffeurs_pour_course(:'c_plan')) = 1,
                     'suspension : le chauffeur suspendu n''est plus proposé à l''attribution');
select test.doit_echouer(format('select public.attribuer_course(%L, %L)', :'c_plan', :'chauffeur1'), 'pas validé');
call test.connexion(:'chauffeur1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Compte chauffeur suspendu'
                             and message like '%Contrôle des documents%'),
                     'suspension : le chauffeur est prévenu, avec le motif');
select test.doit_echouer('select public.mettre_en_ligne(true, 48.85, 2.35)', 'pas encore validé');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_statut_chauffeur(%L, %L)', :'chauffeur1', 'suspendu'), 'Seul un chauffeur validé');
select public.admin_statut_chauffeur(:'chauffeur1', 'valide');
select test.verifier((select statut from public.chauffeurs where id = :'chauffeur1') = 'valide', 'réactivation : fiche de nouveau « validée »');
select test.doit_echouer(format('select public.admin_statut_chauffeur(%L, %L)', :'chauffeur1', 'valide'), 'Seul un chauffeur suspendu');
select test.doit_echouer(format('select public.admin_statut_chauffeur(%L, %L)', :'clienttel', 'valide'), 'Seul un chauffeur suspendu');
select test.verifier((select count(*) from public.journal_lister('chauffeurs', :'chauffeur1')
                      where action in ('suspension_chauffeur', 'reactivation_chauffeur')) = 2,
                     'suspension et réactivation inscrites au journal (lecture par l''administration)');


-- #############################################################################
-- 5. OPTION CHAUFFEUSE ET AVERTISSEMENTS
-- #############################################################################
call test.connexion(:'clienttel');
select id as c_chf from public.commander_course('berline_hybride', '10 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                'Gare de Lyon, 75012 Paris', 48.8443, 2.3743,
                                                p_type => 'planifiee', p_quand => :'demain_16h', p_option_chauffeuse => true) \gset
call test.connexion(:'admin', 'aal2');
update public.chauffeurs set permis_expiration = current_date - 1 where id = :'chauffeuse';
select test.verifier((select not attribuable and motif = 'La cliente a demandé une chauffeuse'
                      from public.admin_chauffeurs_pour_course(:'c_chf') where nom = 'Paul Bernard'),
                     'option chauffeuse : le chauffeur n''est pas attribuable, motif affiché');
select test.verifier((select attribuable and 'Permis expiré le ' || to_char(current_date - 1, 'DD/MM/YYYY') = any (avertissements)
                      from public.admin_chauffeurs_pour_course(:'c_chf') where nom = 'Nadia Moreau'),
                     'option chauffeuse : la chauffeuse est attribuable, avec l''avertissement du permis expiré');
select test.doit_echouer(format('select public.attribuer_course(%L, %L)', :'c_chf', :'chauffeur1'), 'chauffeuse');
update public.chauffeurs set permis_expiration = null where id = :'chauffeuse';
select public.annuler_course(:'c_chf', 'Essai terminé');
select public.annuler_course(:'c_plan', 'Essai terminé');


-- #############################################################################
-- 6. LISTE ET FICHE DES COURSES
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.verifier((public.admin_lister_courses() ->> 'total')::integer = (select count(*) from public.courses),
                     'liste des courses : toutes comptées');
select test.verifier((public.admin_lister_courses(p_statuts => array['terminee']) ->> 'total')::integer
                     = (select count(*) from public.courses where statut = 'terminee'),
                     'liste des courses : filtre par statut');
select test.verifier((select bool_and(l ->> 'chauffeur_nom' = 'Nadia Moreau')
                      from jsonb_array_elements(public.admin_lister_courses(p_texte => 'moreau') -> 'lignes') l)
                     and (public.admin_lister_courses(p_texte => 'moreau') ->> 'total')::integer
                         = (select count(*) from public.courses where chauffeur_id = :'chauffeuse'),
                     'liste des courses : recherche sans majuscules sur le nom du chauffeur');
select test.verifier((select (public.admin_lister_courses(p_texte => 'Claire Durand') ->> 'total')::integer)
                     = (select count(*) from public.courses where client_id = :'client1'),
                     'liste des courses : recherche sur le prénom et le nom du client');
select test.verifier((public.admin_lister_courses(p_texte => '100%_') ->> 'total')::integer = 0,
                     'liste des courses : « % » et « _ » cherchés tels quels');
select test.verifier(jsonb_array_length(public.admin_lister_courses(p_limite => 2) -> 'lignes') = 2
                     and (public.admin_lister_courses(p_limite => 2, p_decalage => 1000) ->> 'total')::integer
                         = (select count(*) from public.courses),
                     'liste des courses : pagination, total exact même au-delà de la dernière page');
select test.verifier((public.admin_lister_courses(p_debut => :'aujourdhui'::date + 1, p_fin => :'aujourdhui'::date + 1)
                      ->> 'total')::integer
                     = (select count(*) from public.courses
                        where (prise_en_charge_le at time zone 'Europe/Paris')::date = (:'aujourdhui'::date + 1)),
                     'liste des courses : période à l''heure de Paris');

select public.admin_fiche_course(:'c_imm') as fiche \gset
select test.verifier(:'fiche'::jsonb -> 'client' ->> 'prenom' = 'Claire'
                     and :'fiche'::jsonb -> 'chauffeur' ->> 'prenom' = 'Paul'
                     and :'fiche'::jsonb ->> 'categorie' = 'Berline hybride',
                     'fiche de course : client, chauffeur et catégorie');
select test.verifier(exists (select 1 from jsonb_array_elements(:'fiche'::jsonb -> 'evenements') e
                             where e ->> 'type' = 'chauffeur_retire' and e ->> 'acteur_nom' = 'Alice Martin'
                               and e ->> 'acteur_role' = 'admin'),
                     'fiche de course : étapes avec l''auteur de chaque action');
select test.verifier(jsonb_array_length(:'fiche'::jsonb -> 'propositions') = 2
                     and jsonb_array_length(:'fiche'::jsonb -> 'paiements') = 1
                     and jsonb_array_length(:'fiche'::jsonb -> 'factures') = 1
                     and (:'fiche'::jsonb -> 'factures' -> 0 ->> 'montant_ttc')::numeric
                         = (:'fiche'::jsonb -> 'course' ->> 'prix_total')::numeric,
                     'fiche de course : demandes aux chauffeurs, paiement et facture');
select test.doit_echouer('select public.admin_fiche_course(''f0000000-0000-4000-8000-000000000000'')', 'introuvable');


-- #############################################################################
-- 7. CHAUFFEURS, ACTIVITÉ, RECHERCHE DE COMPTES
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_lister_chauffeurs() as chauffeurs \gset
select test.verifier(jsonb_array_length(:'chauffeurs'::jsonb) = 3
                     and :'chauffeurs'::jsonb -> 0 ->> 'prenom' = 'Nadia'
                     and :'chauffeurs'::jsonb -> 2 ->> 'statut' = 'refuse',
                     'chauffeurs : validés d''abord, candidature refusée en dernier');
select test.verifier((select c -> 'candidature' ->> 'statut' = 'refusee' and c -> 'candidature' ->> 'ville' = 'Paris'
                      from jsonb_array_elements(:'chauffeurs'::jsonb) c where c ->> 'prenom' = 'Karim'),
                     'chauffeurs : candidature et motif conservés');
select test.verifier((select jsonb_array_length(c -> 'documents') = 1 and c -> 'documents' -> 0 ->> 'statut' = 'valide'
                      from jsonb_array_elements(:'chauffeurs'::jsonb) c where c ->> 'prenom' = 'Paul'),
                     'chauffeurs : documents déposés et leur statut');

select test.verifier((select courses_terminees >= 1 and chiffre_affaires > 0 and demandes_acceptees >= 1
                      from public.admin_activite_chauffeurs(:'aujourdhui', :'aujourdhui') where chauffeur_id = :'chauffeur1'),
                     'activité du jour : courses, chiffre d''affaires et demandes de Paul');
select test.doit_echouer(format('select * from public.admin_activite_chauffeurs(%L, %L)', :'aujourdhui', :'aujourdhui'::date - 1),
                         'Période invalide');

select test.verifier((select count(*) from public.admin_rechercher_comptes('exemple.test')) = 6,
                     'recherche de comptes : par morceau d''e-mail (le compte sans e-mail n''y figure pas)');
select test.verifier((select chauffeur_statut from public.admin_rechercher_comptes('moreau')) = 'valide',
                     'recherche de comptes : statut de chauffeur indiqué');
select test.verifier((select count(*) from public.admin_rechercher_comptes('+3365555')) = 1,
                     'recherche de comptes : par numéro de téléphone');
select test.doit_echouer('select * from public.admin_rechercher_comptes(''a'')', 'au moins 2 caractères');


-- #############################################################################
-- 8. CHANGEMENT DE CHAUFFEUR, VÉRIFICATION DES DOCUMENTS (migration 11)
-- #############################################################################
call test.connexion(:'filleul');
select id as c_resa from public.commander_course('berline_hybride', 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
                                                 'Aéroport Paris-Orly', 48.7262, 2.3652,
                                                 p_type => 'planifiee', p_quand => :'demain_16h') \gset
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'c_resa', :'chauffeur1');
select test.doit_echouer(format('select public.attribuer_course(%L, %L)', :'c_resa', :'chauffeur1'), 'assure déjà');
select public.attribuer_course(:'c_resa', :'chauffeuse');
select test.verifier((select chauffeur_id = :'chauffeuse' and statut = 'planifiee' from public.courses where id = :'c_resa'),
                     'changement de chauffeur : réservation confiée à Nadia');
call test.connexion(:'chauffeur1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Course retirée' and message like '%confié la course%'),
                     'changement de chauffeur : l''ancien chauffeur est prévenu');
call test.connexion(:'admin', 'aal2');
select public.annuler_course(:'c_resa', 'Essai terminé');

-- Pièce déposée sans numéro ni date : l'administration les lit sur le document
call test.connexion(:'chauffeuse');
insert into public.documents (chauffeur_id, type, fichier_chemin)
values (auth.uid(), 'permis', auth.uid()::text || '/permis.pdf')
returning id as doc_permis \gset
select test.doit_echouer(format('select public.admin_verifier_document(%L, %L)', :'doc_permis', 'valide'), 'Réservé');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_verifier_document(%L, %L, null, null, %L)', :'doc_permis', 'valide', current_date - 1),
                         'expiré');
select public.admin_verifier_document(:'doc_permis', 'valide', null, 'P-778899', current_date + 3650);
select test.verifier((select permis_numero = 'P-778899' and permis_expiration = current_date + 3650
                      from public.chauffeurs where id = :'chauffeuse')
                     and (select statut from public.documents where id = :'doc_permis') = 'valide',
                     'document validé avec le numéro et la date lus : reportés sur la fiche');
update public.chauffeurs set permis_expiration = null, permis_numero = null where id = :'chauffeuse';


-- #############################################################################
-- 9. CONTRÔLES D'ENSEMBLE
-- #############################################################################
call test.systeme();
select test.verifier((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname like 'admin\_%'
                        and has_function_privilege('anon', p.oid, 'execute')) = 0,
                     'aucune fonction d''administration appelable par un visiteur');
select test.verifier((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname like 'admin\_%'
                        and not has_function_privilege('authenticated', p.oid, 'execute')) = 0,
                     'fonctions d''administration appelables une fois connecté (elles vérifient elles-mêmes)');
select test.verifier((select string_agg(policyname || ':' || array_to_string(roles, '+'), ',' order by policyname)
                      from pg_policies where schemaname = 'public' and tablename = 'faq' and cmd = 'SELECT')
                     = 'faq_lecture:authenticated,faq_lecture_publique:anon',
                     'questions fréquentes : une règle de lecture par public');
select test.verifier(not exists (select 1 from public.notifications where message = ''), 'notifications : aucune vide');
select test.verifier((select max(right(numero, 6)::integer) = count(*) from public.factures), 'factures : numérotation toujours continue');

\o
\echo '✔ Administration : tout est conforme.'
