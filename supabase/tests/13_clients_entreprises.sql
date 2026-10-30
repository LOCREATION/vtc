-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios du module « Clients et entreprises » (migration 12), joués après
-- 12_administration.sql sur les mêmes comptes fictifs :
--   liste et fiche des clients, coordonnées corrigées par l'administration
--   (journal), blocage motivé avec annulation des réservations, comptes
--   professionnels (contrôles, membres, notifications), commande sur facture
--   mensuelle et plafond, relevé mensuel et encaissement en une fois, retard
--   de paiement au tableau de bord, notes internes, droits.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- Données entièrement fictives (SIRET 999 999 998 00019, domaine .test).
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

select (((now() at time zone 'Europe/Paris')::date + 1) + time '10:00') at time zone 'Europe/Paris' as demain_10h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '11:00') at time zone 'Europe/Paris' as demain_11h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '15:00') at time zone 'Europe/Paris' as demain_15h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '17:00') at time zone 'Europe/Paris' as demain_17h,
       (now() at time zone 'Europe/Paris')::date as aujourdhui
\gset


-- #############################################################################
-- 1. LISTE DES CLIENTS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_lister_clients() as liste \gset
select test.verifier((:'liste'::jsonb ->> 'total')::integer = (select count(*) from public.profils where role = 'client')
                     and (:'liste'::jsonb -> 'resume' ->> 'clients')::integer = 4,
                     'liste des clients : les 4 comptes clients, sans chauffeurs ni administrateurs');

-- Chiffres de Claire recalculés ici indépendamment
select count(*) filter (where statut = 'terminee')::integer as nb_claire,
       coalesce(sum(prix_total + frais_attente) filter (where statut = 'terminee'), 0)
     + coalesce(sum(frais_annulation) filter (where statut = 'annulee'), 0) as depense_claire
from public.courses where client_id = :'client1' \gset
select round(avg(note)::numeric, 2) as note_claire
from public.evaluations where cible_id = :'client1' and sens = 'chauffeur_vers_client' \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'liste'::jsonb -> 'lignes') l
                             where l ->> 'id' = :'client1' and (l ->> 'courses_terminees')::integer = :nb_claire
                               and (l ->> 'depense')::numeric = :depense_claire
                               and (l ->> 'note_moyenne')::numeric = :note_claire),
                     'liste : courses terminées (' || :nb_claire || '), dépense (' || :depense_claire || ' €) et note des chauffeurs ('
                     || :note_claire || ') de Claire');
select test.verifier(public.admin_lister_clients('06 11 11 11 11') -> 'lignes' -> 0 ->> 'id' = :'client1'
                     and (public.admin_lister_clients('06 11 11 11 11') ->> 'total')::integer = 1,
                     'recherche : téléphone saisi « 06 11 11 11 11 » (espaces et 0 initial)');
select test.verifier(public.admin_lister_clients('ROUX') -> 'lignes' -> 0 ->> 'id' = :'filleul', 'recherche : nom, majuscules ou non');
select test.verifier(public.admin_lister_clients(p_tri => 'depense') -> 'lignes' -> 0 ->> 'id' = :'client1', 'tri par dépense : Claire en tête');
select test.verifier(public.admin_lister_clients(p_tri => 'nom') -> 'lignes' -> 0 ->> 'prenom' = 'Claire', 'tri par nom : Claire en premier');
select test.verifier(jsonb_array_length(public.admin_lister_clients(p_limite => 2) -> 'lignes') = 2
                     and (public.admin_lister_clients(p_limite => 2, p_decalage => 2) -> 'lignes' -> 1) is not null
                     and (public.admin_lister_clients(p_limite => 2) ->> 'total')::integer = 4,
                     'pagination : 2 par page, total 4');
select test.doit_echouer($$select public.admin_lister_clients(p_statut => 'inconnu')$$, 'Statut inconnu');

-- Fermé à tout autre que l'administration avec double authentification
call test.connexion(:'admin');
select test.doit_echouer('select public.admin_lister_clients()', 'Réservé');
call test.connexion(:'client1', 'aal2');
select test.doit_echouer('select public.admin_lister_clients()', 'Réservé');
select test.doit_echouer(format('select public.admin_fiche_client(%L)', :'client1'), 'Réservé');


-- #############################################################################
-- 2. FICHE D'UN CLIENT
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_fiche_client(:'client1') as fiche \gset
select test.verifier((:'fiche'::jsonb -> 'chiffres' ->> 'courses_terminees')::integer = :nb_claire
                     and (:'fiche'::jsonb -> 'chiffres' ->> 'depense')::numeric = :depense_claire
                     and (:'fiche'::jsonb -> 'chiffres' ->> 'note_recue')::numeric = :note_claire,
                     'fiche : chiffres de Claire identiques à la liste');
select test.verifier(jsonb_array_length(:'fiche'::jsonb -> 'courses') = (select count(*) from public.courses where client_id = :'client1')
                     and jsonb_array_length(:'fiche'::jsonb -> 'factures') = (select count(*) from public.factures where client_id = :'client1'),
                     'fiche : toutes ses courses et factures');
select test.verifier(exists (select 1 from jsonb_array_elements(:'fiche'::jsonb -> 'notes_recues') n
                             where n ->> 'commentaire' = 'Ponctuelle' and n ->> 'auteur' = 'Paul Bernard'),
                     'fiche : note donnée par le chauffeur, avec son commentaire (administration seulement)');
select test.verifier(exists (select 1 from jsonb_array_elements(:'fiche'::jsonb -> 'filleuls') f
                             where f ->> 'id' = :'filleul' and f ->> 'statut' = 'valide'),
                     'fiche : filleule validée');
select test.verifier(exists (select 1 from jsonb_array_elements(:'fiche'::jsonb -> 'proches') p where p ->> 'nom' = 'Mamie Durand'),
                     'fiche : proches enregistrés');
select test.verifier(:'fiche'::jsonb ? 'connexion' and :'fiche'::jsonb -> 'profil' ->> 'code_parrainage' is not null,
                     'fiche : connexion et code de parrainage');
select test.verifier(public.admin_fiche_client(:'filleul') -> 'parrain' ->> 'id' = :'client1', 'fiche de la filleule : sa marraine');
select test.doit_echouer(format('select public.admin_fiche_client(%L)', 'f0000000-0000-4000-8000-000000000000'), 'Compte introuvable');


-- #############################################################################
-- 3. COORDONNÉES CORRIGÉES PAR L'ADMINISTRATION : JOURNAL
-- #############################################################################
-- Hugo n'a pas de téléphone : l'administration l'ajoute (il pourra commander)
update public.profils set telephone = '+33622222222' where id = :'client2';
select test.verifier((select count(*) from public.journal_lister('profils', :'client2')
                      where action = 'UPDATE' and apres ->> 'telephone' = '+33622222222' and acteur_id = :'admin') = 1,
                     'téléphone ajouté par l''administration : inscrit au journal, avec son auteur');
call test.connexion(:'client2');
update public.profils set langue = 'en' where id = auth.uid();
update public.profils set langue = 'fr' where id = auth.uid();
call test.connexion(:'admin', 'aal2');
select test.verifier((select count(*) from public.journal_lister('profils', :'client2') where apres ? 'langue') = 0,
                     'le client qui modifie ses propres préférences n''est pas inscrit au journal');


-- #############################################################################
-- 4. BLOCAGE ET DÉBLOCAGE D'UN CLIENT
-- #############################################################################
-- Léa a une réservation pour demain
call test.connexion(:'filleul');
select id as resa_lea from public.commander_course('berline_hybride', '5 rue de la Paix, 75002 Paris', 48.8686, 2.3310,
                                                   'Gare de Lyon, 75012 Paris', 48.8443, 2.3743,
                                                   p_type => 'planifiee', p_quand => :'demain_10h') \gset

call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_statut_client(%L, %L)', :'filleul', 'bloque'), 'motif du blocage');
select test.doit_echouer(format('select public.admin_statut_client(%L, %L, %L)', :'admin', 'bloque', 'essai'), 'propre compte');
select test.doit_echouer(format('select public.admin_statut_client(%L, %L, %L)', :'chauffeur1', 'bloque', 'essai'), 'module Chauffeurs');
select test.doit_echouer(format('select public.admin_statut_client(%L, %L)', :'filleul', 'actif'), 'déjà actif');
select public.admin_statut_client(:'filleul', 'bloque', 'Impayés répétés', true) as blocage \gset
select test.verifier((:'blocage'::jsonb ->> 'reservations_annulees')::integer = 1
                     and (select statut from public.profils where id = :'filleul') = 'bloque',
                     'blocage : compte bloqué, réservation à venir annulée');
select test.verifier((select statut = 'annulee' and annulee_par = 'admin' and frais_annulation = 0 and motif_annulation = 'Compte suspendu'
                      from public.courses where id = :'resa_lea'),
                     'blocage : réservation annulée sans frais, motif neutre pour la cliente');
select test.verifier(exists (select 1 from public.journal_lister('profils', :'filleul')
                             where action = 'blocage_compte' and apres ->> 'motif' = 'Impayés répétés'),
                     'blocage : motif inscrit au journal');
select test.verifier((public.admin_lister_clients(p_statut => 'bloque') ->> 'total')::integer = 1
                     and (public.admin_lister_clients() -> 'resume' ->> 'bloques')::integer = 1,
                     'liste : filtre des comptes bloqués');
select test.doit_echouer(format('select public.admin_statut_client(%L, %L, %L)', :'filleul', 'bloque', 'encore'), 'déjà bloqué');

call test.connexion(:'filleul');
select test.verifier(exists (select 1 from public.notifications where titre = 'Compte suspendu'), 'cliente prévenue de la suspension');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8686, 2.3310, 'B', 48.8443, 2.3743,
                           p_type => 'planifiee', p_quand => now() + interval '1 day')$$, 'suspendu');

call test.connexion(:'admin', 'aal2');
select public.admin_statut_client(:'filleul', 'actif');
select test.verifier((select statut from public.profils where id = :'filleul') = 'actif'
                     and exists (select 1 from public.journal_lister('profils', :'filleul') where action = 'deblocage_compte'),
                     'déblocage : compte actif, inscrit au journal');
call test.connexion(:'filleul');
select test.verifier(exists (select 1 from public.notifications where titre = 'Compte réactivé'), 'cliente prévenue de la réactivation');


-- #############################################################################
-- 5. COMPTES PROFESSIONNELS : CONTRÔLES, CRÉATION, MEMBRES
-- #############################################################################
call test.connexion(:'client1');
select test.doit_echouer($$insert into public.comptes_pro (raison_sociale, email_facturation) values ('Intrus', 'x@exemple.test')$$,
                         'row-level security');

call test.connexion(:'admin', 'aal2');
select test.doit_echouer($$insert into public.comptes_pro (raison_sociale, email_facturation, siret)
                           values ('Atelier Lumière SARL', 'compta@atelier-lumiere.test', '999 999 998')$$, 'comptes_pro_siret_check');
select test.doit_echouer($$insert into public.comptes_pro (raison_sociale, email_facturation, tva_intracommunautaire)
                           values ('Atelier Lumière SARL', 'compta@atelier-lumiere.test', 'FR 11 999')$$, 'comptes_pro_tva');
select test.doit_echouer($$insert into public.comptes_pro (raison_sociale, email_facturation)
                           values ('Atelier Lumière SARL', 'compta-atelier-lumiere.test')$$, 'comptes_pro_email');
select test.doit_echouer($$insert into public.comptes_pro (raison_sociale, email_facturation, delai_paiement_jours)
                           values ('Atelier Lumière SARL', 'compta@atelier-lumiere.test', 90)$$, 'comptes_pro_delai');
select test.doit_echouer($$insert into public.comptes_pro (raison_sociale, email_facturation, telephone)
                           values ('Atelier Lumière SARL', 'compta@atelier-lumiere.test', '01 23 45 67 89')$$, 'comptes_pro_telephone');

insert into public.comptes_pro (raison_sociale, siret, tva_intracommunautaire, adresse, code_postal, ville,
                                email_facturation, telephone, contact_nom)
values ('Atelier Lumière SARL', '99999999800019', 'FR11999999998', '12 rue des Essais', '75011', 'Paris',
        'compta@atelier-lumiere.test', '+33140000000', 'Sophie Laurent')
returning id as compte \gset
select test.verifier((select delai_paiement_jours = 30 and plafond_mensuel is null and statut = 'actif'
                      from public.comptes_pro where id = :'compte'),
                     'compte pro créé : règlement à 30 jours, sans plafond, actif');
select test.verifier(exists (select 1 from public.journal_lister('comptes_pro', :'compte') where action = 'INSERT'),
                     'création du compte pro inscrite au journal');

insert into public.comptes_pro_membres (compte_pro_id, profil_id, role) values
  (:'compte', :'client1', 'gestionnaire'),
  (:'compte', :'client2', 'membre');

call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications
                             where titre = 'Compte professionnel' and message like '%Atelier Lumière SARL%gestionnaire%'),
                     'gestionnaire prévenue du rattachement (et de ce qu''elle voit)');
select test.verifier((select count(*) from public.comptes_pro) = 1, 'membre : voit son compte professionnel');
call test.connexion(:'client2');
select test.verifier(exists (select 1 from public.notifications
                             where titre = 'Compte professionnel' and message like '%Atelier Lumière SARL%'
                               and message not like '%gestionnaire%'),
                     'membre prévenu du rattachement');
call test.connexion(:'clienttel');
select test.verifier((select count(*) from public.comptes_pro) = 0, 'non-membre : ne voit pas le compte professionnel');


-- #############################################################################
-- 6. COMMANDE SUR FACTURE MENSUELLE, PLAFOND
-- #############################################################################
-- Hugo (membre) : réservation facturée au compte
call test.connexion(:'client2');
select id as course_hugo, prix_total as prix_hugo from public.commander_course(
  'berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800, 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
  p_type => 'planifiee', p_quand => :'demain_10h', p_mode_paiement => 'facture_mensuelle', p_compte_pro => :'compte') \gset
select test.verifier((select compte_pro_id = :'compte' and mode_paiement = 'facture_mensuelle' from public.courses where id = :'course_hugo'),
                     'commande sur facture mensuelle : course rattachée au compte');

-- Plafond : il ne reste que 5 € ce mois-ci
call test.connexion(:'admin', 'aal2');
update public.comptes_pro set plafond_mensuel = :prix_hugo + 5 where id = :'compte';
call test.connexion(:'client1');
select test.doit_echouer(format($$select public.commander_course('berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800,
                                   'Aéroport Paris-Orly', 48.7262, 2.3652, p_type => 'planifiee', p_quand => %L,
                                   p_mode_paiement => 'facture_mensuelle', p_compte_pro => %L)$$, :'demain_11h', :'compte'),
                         'Plafond mensuel du compte « Atelier Lumière SARL » atteint : il reste 5,00 €');
-- Le plafond ne concerne que la facture mensuelle : sur place, la course passe
select id as course_claire_especes, prix_total as prix_claire_especes from public.commander_course(
  'berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800, 'Aéroport Paris-Orly', 48.7262, 2.3652,
  p_type => 'planifiee', p_quand => :'demain_11h', p_mode_paiement => 'especes', p_compte_pro => :'compte') \gset
select test.verifier(:prix_claire_especes > 5, 'plafond : une course payée sur place (' || :prix_claire_especes || ' €) reste possible');

-- Sans plafond, la facture mensuelle repasse
call test.connexion(:'admin', 'aal2');
update public.comptes_pro set plafond_mensuel = null where id = :'compte';
call test.connexion(:'client1');
select id as course_claire_pro from public.commander_course(
  'berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800, 'Gare de Lyon, 75012 Paris', 48.8443, 2.3743,
  p_type => 'planifiee', p_quand => :'demain_15h', p_mode_paiement => 'facture_mensuelle', p_compte_pro => :'compte') \gset

-- Non-membre et compte suspendu : refusés
call test.connexion(:'clienttel');
select test.doit_echouer(format($$select public.commander_course('berline_hybride', 'A', 48.8590, 2.3800, 'B', 48.8443, 2.3743,
                                   p_type => 'planifiee', p_quand => now() + interval '1 day',
                                   p_mode_paiement => 'facture_mensuelle', p_compte_pro => %L)$$, :'compte'),
                         'réservée aux membres');
call test.connexion(:'admin', 'aal2');
update public.comptes_pro set statut = 'suspendu' where id = :'compte';
call test.connexion(:'client2');
select test.doit_echouer(format($$select public.commander_course('berline_hybride', 'A', 48.8590, 2.3800, 'B', 48.8443, 2.3743,
                                   p_type => 'planifiee', p_quand => now() + interval '1 day',
                                   p_mode_paiement => 'facture_mensuelle', p_compte_pro => %L)$$, :'compte'),
                         'compte professionnel actif');
call test.connexion(:'admin', 'aal2');
update public.comptes_pro set statut = 'actif' where id = :'compte';

-- Les trois courses sont assurées par Paul (étapes passées par l'administration)
select public.attribuer_course(:'course_hugo', :'chauffeur1');
select public.attribuer_course(:'course_claire_especes', :'chauffeur1');
select public.attribuer_course(:'course_claire_pro', :'chauffeur1');
select public.avancer_course(:'course_hugo', 'en_route');
select public.avancer_course(:'course_hugo', 'arrivee');
select public.avancer_course(:'course_hugo', 'a_bord');
select public.avancer_course(:'course_hugo', 'terminee');
select public.avancer_course(:'course_claire_especes', 'en_route');
select public.avancer_course(:'course_claire_especes', 'arrivee');
select public.avancer_course(:'course_claire_especes', 'a_bord');
select public.avancer_course(:'course_claire_especes', 'terminee');
select public.avancer_course(:'course_claire_pro', 'en_route');
select public.avancer_course(:'course_claire_pro', 'arrivee');
select public.avancer_course(:'course_claire_pro', 'a_bord');
select public.avancer_course(:'course_claire_pro', 'terminee');
select test.verifier((select count(*) from public.courses where id in (:'course_hugo', :'course_claire_especes', :'course_claire_pro')
                      and statut = 'terminee') = 3, 'trois courses du compte terminées');
select test.verifier((select count(*) from public.factures
                      where course_id in (:'course_hugo', :'course_claire_especes', :'course_claire_pro')
                        and compte_pro_id = :'compte' and destinataire_nom = 'Atelier Lumière SARL'
                        and destinataire_adresse = '12 rue des Essais, 75011 Paris') = 3,
                     'factures au nom et à l''adresse de l''entreprise');
select test.verifier((select mode = 'facture_mensuelle' and statut = 'a_encaisser' from public.paiements
                      where course_id = :'course_hugo' and nature = 'course'),
                     'paiement sur facture mensuelle : en attente du relevé');

call test.connexion(:'chauffeur1');
select id as paiement_hugo from public.paiements where course_id = :'course_hugo' and nature = 'course' \gset
select test.doit_echouer(format('select public.confirmer_encaissement(%L)', :'paiement_hugo'), 'encaissés par l''administration');

-- Pourboire de Hugo : ajouté au relevé
call test.connexion(:'client2');
select public.ajouter_pourboire(:'course_hugo', 3.00);
select test.verifier((select count(*) from public.courses where compte_pro_id = :'compte') = 1,
                     'membre : ne voit que ses propres courses du compte');

-- La gestionnaire voit toutes les courses et factures du compte
call test.connexion(:'client1');
select test.verifier((select count(*) from public.courses where compte_pro_id = :'compte') = 3
                     and (select count(*) from public.factures where compte_pro_id = :'compte') = 3,
                     'gestionnaire : voit toutes les courses et factures du compte');


-- #############################################################################
-- 7. RELEVÉ MENSUEL ET ENCAISSEMENT EN UNE FOIS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_releve_compte_pro(:'compte', :'aujourdhui') as releve \gset

-- Attendus recalculés ici indépendamment
select coalesce(sum(montant_ht), 0) as ht_attendu, coalesce(sum(montant_tva), 0) as tva_attendue,
       coalesce(sum(montant_ttc), 0) as ttc_attendu, count(*)::integer as nb_factures
from public.factures
where compte_pro_id = :'compte' and statut = 'emise' and date_emission >= date_trunc('month', :'aujourdhui'::date) \gset
select coalesce(sum(p.montant), 0) as reste_attendu, count(*)::integer as nb_a_encaisser
from public.paiements p join public.courses c on c.id = p.course_id
where c.compte_pro_id = :'compte' and p.mode = 'facture_mensuelle' and p.statut = 'a_encaisser' \gset

select test.verifier(jsonb_array_length(:'releve'::jsonb -> 'lignes') = :nb_factures and :nb_factures = 3,
                     'relevé : les 3 factures du mois');
select test.verifier((:'releve'::jsonb -> 'totaux' ->> 'montant_ht')::numeric = :ht_attendu
                     and (:'releve'::jsonb -> 'totaux' ->> 'montant_tva')::numeric = :tva_attendue
                     and (:'releve'::jsonb -> 'totaux' ->> 'montant_ttc')::numeric = :ttc_attendu
                     and :ht_attendu + :tva_attendue = :ttc_attendu,
                     'relevé : HT ' || :ht_attendu || ' € + TVA ' || :tva_attendue || ' € = TTC ' || :ttc_attendu || ' €');
select test.verifier((:'releve'::jsonb -> 'totaux' ->> 'pourboires')::numeric = 3.00
                     and jsonb_array_length(:'releve'::jsonb -> 'pourboires') = 1,
                     'relevé : le pourboire, sur sa ligne');
select test.verifier((:'releve'::jsonb -> 'totaux' ->> 'reste_a_payer')::numeric = :reste_attendu
                     and (:'releve'::jsonb -> 'totaux' ->> 'paiements_a_encaisser')::integer = :nb_a_encaisser
                     and (:'releve'::jsonb -> 'totaux' ->> 'deja_regle')::numeric
                         = (:'releve'::jsonb -> 'totaux' ->> 'total')::numeric - :reste_attendu,
                     'relevé : reste à payer ' || :reste_attendu || ' € (facture mensuelle et pourboire), le paiement sur place déjà réglé');
select test.verifier(exists (select 1 from jsonb_array_elements(:'releve'::jsonb -> 'lignes') l
                             where l ->> 'course_id' = :'course_claire_especes' and l ->> 'paiement_mode' = 'especes'),
                     'relevé : la course payée sur place y figure, réglée');
select test.verifier((:'releve'::jsonb ->> 'provisoire')::boolean
                     and (:'releve'::jsonb ->> 'echeance')::date = (:'releve'::jsonb ->> 'date_releve')::date + 30
                     and :'releve'::jsonb -> 'societe' ->> 'raison_sociale' = 'LOC RÉACTION S.A.S'
                     and :'releve'::jsonb ->> 'mois_lisible' ~ '^[a-zéû]+ [0-9]{4}$'
                     and jsonb_array_length(:'releve'::jsonb -> 'tva_par_taux') = 1,
                     'relevé : provisoire (mois en cours), échéance à 30 jours, identité de LOC RÉACTION, mois en français, TVA par taux');
select test.doit_echouer(format('select public.admin_releve_compte_pro(%L, %L)', :'compte', (:'aujourdhui'::date + 62)::text),
                         'pas encore commencé');

-- Liste et fiche des comptes : ce qui reste à encaisser
select test.verifier(exists (select 1 from jsonb_array_elements(public.admin_lister_comptes_pro() -> 'lignes') l
                             where l ->> 'id' = :'compte' and (l ->> 'nb_membres')::integer = 2
                               and (l ->> 'nb_gestionnaires')::integer = 1 and (l ->> 'courses_mois')::integer = 3
                               and (l ->> 'a_encaisser')::numeric = :reste_attendu and (l ->> 'en_retard')::numeric = 0),
                     'liste des comptes pro : membres, courses du mois, à encaisser, pas de retard');
select test.verifier((public.admin_lister_comptes_pro('lumière') -> 'lignes' -> 0 ->> 'id') = :'compte'
                     and jsonb_array_length(public.admin_lister_comptes_pro('introuvable') -> 'lignes') = 0,
                     'liste des comptes pro : recherche');
select public.admin_fiche_compte_pro(:'compte') as fiche_pro \gset
select test.verifier(jsonb_array_length(:'fiche_pro'::jsonb -> 'membres') = 2
                     and :'fiche_pro'::jsonb -> 'membres' -> 0 ->> 'role' = 'gestionnaire'
                     and jsonb_array_length(:'fiche_pro'::jsonb -> 'courses') = 3
                     and (:'fiche_pro'::jsonb -> 'mois') ? to_char(:'aujourdhui'::date, 'YYYY-MM')
                     and (:'fiche_pro'::jsonb -> 'chiffres' ->> 'a_encaisser')::numeric = :reste_attendu,
                     'fiche du compte pro : gestionnaire en premier, courses, mois du relevé, à encaisser');

-- Encaissement : montant affiché différent → refusé, rien ne change
select test.doit_echouer(format('select public.admin_encaisser_releve(%L, %L, %s)', :'compte', :'aujourdhui', :reste_attendu + 1),
                         'Le relevé a changé');
select test.verifier((select count(*) from public.paiements p join public.courses c on c.id = p.course_id
                      where c.compte_pro_id = :'compte' and p.mode = 'facture_mensuelle' and p.statut = 'a_encaisser') = :nb_a_encaisser,
                     'encaissement refusé : rien n''est encaissé');
select public.admin_encaisser_releve(:'compte', :'aujourdhui', :reste_attendu, 'VIR-ESSAI-001') as encaissement \gset
select test.verifier((:'encaissement'::jsonb ->> 'paiements')::integer = :nb_a_encaisser
                     and (:'encaissement'::jsonb ->> 'montant')::numeric = :reste_attendu,
                     'relevé encaissé : ' || :nb_a_encaisser || ' paiements, ' || :reste_attendu || ' €');
select test.verifier((select count(*) from public.paiements p join public.courses c on c.id = p.course_id
                      where c.compte_pro_id = :'compte' and p.mode = 'facture_mensuelle'
                        and p.statut = 'encaisse' and p.reference_externe = 'VIR-ESSAI-001' and p.encaisse_par = :'admin') = :nb_a_encaisser,
                     'paiements encaissés avec la référence du virement et l''auteur');
select test.verifier((select count(*) from public.evenements_course
                      where type = 'paiement_encaisse' and details ->> 'releve' = to_char(:'aujourdhui'::date, 'YYYY-MM')
                        and course_id = :'course_hugo') = 2,
                     'chaque course garde la trace de l''encaissement (course et pourboire)');
select test.verifier(exists (select 1 from public.journal_lister('comptes_pro', :'compte')
                             where action = 'encaissement_releve' and apres ->> 'reference' = 'VIR-ESSAI-001'),
                     'encaissement du relevé inscrit au journal');
select test.doit_echouer(format('select public.admin_encaisser_releve(%L, %L, 0)', :'compte', :'aujourdhui'), 'Rien à encaisser');
select test.verifier((public.admin_releve_compte_pro(:'compte', :'aujourdhui') -> 'totaux' ->> 'reste_a_payer')::numeric = 0,
                     'relevé après encaissement : plus rien à payer');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Relevé réglé' and message like '%Atelier Lumière SARL%'),
                     'gestionnaire prévenue du règlement du relevé');
call test.connexion(:'client2');
select test.verifier(not exists (select 1 from public.notifications where titre = 'Relevé réglé'),
                     'simple membre : pas de message sur le règlement');


-- #############################################################################
-- 8. RETARD DE PAIEMENT : ALERTE DU TABLEAU DE BORD
-- #############################################################################
-- Nouvelle course de Hugo sur facture mensuelle, terminée
call test.connexion(:'client2');
select id as course_retard from public.commander_course(
  'berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800, 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
  p_type => 'planifiee', p_quand => :'demain_17h', p_mode_paiement => 'facture_mensuelle', p_compte_pro => :'compte') \gset
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'course_retard', :'chauffeur1');
select public.avancer_course(:'course_retard', 'en_route');
select public.avancer_course(:'course_retard', 'arrivee');
select public.avancer_course(:'course_retard', 'a_bord');
select public.avancer_course(:'course_retard', 'terminee');
select public.admin_tableau_de_bord() as tdb \gset
select test.verifier(not exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a where a ->> 'module' = 'clients'),
                     'paiement du mois sur facture mensuelle : pas d''alerte de retard');

-- Le même paiement, comme s'il datait de trois mois : relevé échu
call test.systeme();
update public.paiements set cree_le = cree_le - interval '3 months' where course_id = :'course_retard' and nature = 'course'
returning montant as montant_retard \gset
call test.connexion(:'admin', 'aal2');
select public.admin_tableau_de_bord() as tdb \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'module' = 'clients' and a ->> 'titre' = '1 compte professionnel en retard de paiement'),
                     'relevé échu : alerte « compte professionnel en retard de paiement »');
select test.verifier(not exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                                 where a ->> 'titre' like '%à encaisser depuis plus de 24 h'),
                     'facture mensuelle : jamais comptée parmi les paiements « à encaisser depuis plus de 24 h »');
select test.verifier((public.admin_lister_comptes_pro() -> 'resume' ->> 'en_retard')::numeric = :montant_retard
                     and (public.admin_fiche_compte_pro(:'compte') -> 'chiffres' ->> 'en_retard')::numeric = :montant_retard,
                     'liste et fiche du compte : ' || :montant_retard || ' € en retard');
call test.systeme();
update public.paiements set cree_le = cree_le + interval '3 months' where course_id = :'course_retard' and nature = 'course';


-- #############################################################################
-- 9. NOTES INTERNES
-- #############################################################################
call test.connexion(:'admin', 'aal2');
insert into public.notes_internes (profil_id, texte) values (:'client1', 'Préfère être appelée plutôt que recevoir un message.');
insert into public.notes_internes (compte_pro_id, texte) values (:'compte', 'Relevé à envoyer à Sophie Laurent, service comptable.');
select test.verifier(public.admin_fiche_client(:'client1') -> 'notes_internes' -> 0 ->> 'auteur' = 'Alice Martin'
                     and public.admin_fiche_compte_pro(:'compte') -> 'notes_internes' -> 0 ->> 'texte' like 'Relevé à envoyer%',
                     'notes internes : sur la fiche du client et du compte, avec leur auteur');
select test.doit_echouer($$insert into public.notes_internes (texte) values ('Sans cible')$$, 'notes_internes_une_cible');
select test.doit_echouer(format($$insert into public.notes_internes (profil_id, texte, auteur_id) values (%L, 'Signée par un autre', %L)$$,
                                :'client1', :'chauffeur1'), 'row-level security');

call test.connexion(:'client1');
select test.verifier((select count(*) from public.notes_internes) = 0, 'client : ne voit jamais les notes internes');
select test.doit_echouer(format($$insert into public.notes_internes (profil_id, texte) values (%L, 'Intrus')$$, :'client1'), 'row-level security');
call test.connexion(:'admin');
select test.verifier((select count(*) from public.notes_internes) = 0, 'administrateur sans double authentification : notes fermées');

-- Une note d'un autre auteur ne se retire pas
call test.systeme();
insert into public.notes_internes (profil_id, texte, auteur_id) values (:'client1', 'Note d''un autre administrateur', :'chauffeur1');
call test.connexion(:'admin', 'aal2');
delete from public.notes_internes where texte = 'Note d''un autre administrateur';
select test.verifier((select count(*) from public.notes_internes where texte = 'Note d''un autre administrateur') = 1,
                     'notes internes : chacun ne retire que les siennes');
delete from public.notes_internes where texte like 'Préfère être appelée%';
select test.verifier((select count(*) from public.notes_internes where profil_id = :'client1' and auteur_id = :'admin') = 0,
                     'notes internes : retrait de sa propre note');
call test.systeme();
delete from public.notes_internes where texte = 'Note d''un autre administrateur';


-- #############################################################################
-- 10. SUPPRESSION D'UN COMPTE PRO, CONTRÔLES D'ENSEMBLE
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('delete from public.comptes_pro where id = %L', :'compte'), 'violates foreign key');
insert into public.comptes_pro (raison_sociale, email_facturation) values ('Société Éphémère', 'contact@ephemere.test')
returning id as compte_vide \gset
insert into public.comptes_pro_membres (compte_pro_id, profil_id) values (:'compte_vide', :'clienttel');
delete from public.comptes_pro where id = :'compte_vide';
select test.verifier(not exists (select 1 from public.comptes_pro where id = :'compte_vide'), 'compte pro sans course : supprimé');
call test.connexion(:'clienttel');
select test.verifier((select count(*) from public.notifications where titre = 'Compte professionnel' and message like '%Éphémère%') = 1,
                     'compte supprimé : pas de second message au membre détaché par la suppression');

call test.systeme();
select test.verifier((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname like 'admin\_%'
                        and has_function_privilege('anon', p.oid, 'execute')) = 0,
                     'aucune fonction d''administration appelable par un visiteur');
select test.verifier((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname like 'admin\_%'
                        and not has_function_privilege('authenticated', p.oid, 'execute')) = 0,
                     'fonctions d''administration appelables une fois connecté (elles vérifient elles-mêmes)');
select test.verifier(not exists (select 1 from information_schema.role_table_grants
                                 where grantee = 'anon' and table_schema = 'public' and table_name = 'notes_internes')
                     and (select string_agg(privilege_type, ',' order by privilege_type)
                          from information_schema.role_table_grants
                          where grantee = 'authenticated' and table_schema = 'public' and table_name = 'notes_internes')
                         = 'DELETE,INSERT,SELECT',
                     'notes internes : rien pour un visiteur ; lecture, ajout et retrait pour l''administration');
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables restent protégées ligne par ligne');
select test.verifier((select max(right(numero, 6)::integer) = count(*) from public.factures), 'factures : numérotation toujours continue');
select test.verifier(not exists (select 1 from public.notifications where message = ''), 'notifications : aucune vide');
select test.verifier(not exists (select 1 from public.courses c join public.profils p on p.id = c.client_id
                                 where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')),
                     'aucune course laissée en cours pour les essais suivants');

\o
\echo '✔ Clients et entreprises : tout est conforme.'
