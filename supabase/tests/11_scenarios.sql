-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios complets, joués avec les vrais rôles de l'API (visiteur, client,
-- chauffeur, administration) : chaque règle d'accès et chaque fonction est
-- exercée comme le fera l'application. Comptes et données 100 % fictifs.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
-- Les résultats des requêtes sont masqués ; les « ok · … » s'affichent.
\o /dev/null

-- Comptes de test (identifiants fictifs)
\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set clienttel  c0000000-0000-4000-8000-000000000003
\set filleul    c0000000-0000-4000-8000-000000000004
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set chauffeuse d0000000-0000-4000-8000-000000000002

-- Instants de référence (demain midi et demain 23 h, heure de Paris) et prix
-- attendus pour Paris centre → Roissy, recalculés ici indépendamment.
select (((now() at time zone 'Europe/Paris')::date + 1) + time '12:00') at time zone 'Europe/Paris' as demain_midi,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '23:00') at time zone 'Europe/Paris' as demain_23h
\gset
select greatest(8.00, round(3.50 + d * 1.70 + ceil(d / 27.3 * 60) * 0.45, 2))                    as prix_jour,
       round(greatest(8.00, round(3.50 + d * 1.70 + ceil(d / 27.3 * 60) * 0.45, 2)) * 1.30, 2) as prix_nuit
from (select round(prive.distance_km(48.8566, 2.3522, 49.0097, 2.5479) * 1.30, 2) as d) x
\gset


-- #############################################################################
-- 1. INSCRIPTION
-- #############################################################################
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data) values
  (:'admin',      'admin@exemple.test',      '{"prenom":"Alice","nom":"Martin"}'),
  (:'client1',    'client1@exemple.test',    '{"prenom":"Claire","nom":"Durand","telephone":"+33 6 11 11 11 11","langue":"fr"}'),
  (:'client2',    'client2@exemple.test',    '{"prenom":"Hugo","nom":"Petit","role":"admin"}'),
  (:'chauffeur1', 'chauffeur1@exemple.test', '{"prenom":"Paul","nom":"Bernard","telephone":"+33633333333"}'),
  (:'chauffeuse', 'chauffeuse@exemple.test', '{"prenom":"Nadia","nom":"Moreau","telephone":"+33644444444"}');
-- inscription par téléphone (Supabase enregistre le numéro sans « + »)
insert into auth.users (id, phone, raw_user_meta_data) values (:'clienttel', '33655555555', '{}');
reset role;
select code_parrainage as code_client1 from public.profils where id = :'client1' \gset
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data)
values (:'filleul', 'filleul@exemple.test',
        json_build_object('prenom', 'Léa', 'nom', 'Roux', 'telephone', '+33666666666',
                          'code_parrain', lower(:'code_client1'))::jsonb);
reset role;

select test.verifier((select count(*) from public.profils) = 7, 'inscription : 7 profils créés automatiquement');
select test.verifier((select count(*) from public.profils where role = 'client') = 7,
                     'inscription : tous « client », même quand « admin » est demandé');
select test.verifier((select telephone from public.profils where id = :'client1') = '+33611111111',
                     'inscription : téléphone nettoyé au format international');
select test.verifier((select telephone from public.profils where id = :'clienttel') = '+33655555555',
                     'inscription par téléphone : « + » remis');
select test.verifier((select count(*) from public.soldes) = 7, 'inscription : un solde à zéro par compte');
select test.verifier(exists (select 1 from public.parrainages
                             where parrain_id = :'client1' and filleul_id = :'filleul' and statut = 'en_attente'),
                     'inscription : parrainage relié (code saisi en minuscules accepté)');
select test.verifier((select count(distinct code_parrainage) from public.profils) = 7, 'inscription : codes de parrainage uniques');

-- Premier administrateur : nommé directement en base, comme en production.
update public.profils set role = 'admin' where id = :'admin';


-- #############################################################################
-- 2. VISITEUR SANS COMPTE
-- #############################################################################
call test.visiteur();
select test.verifier((select count(*) from public.categories) = 1, 'visiteur : catégorie lisible');
select test.verifier((select count(*) from public.tarifs) = 1, 'visiteur : tarif lisible');
select test.verifier((select count(*) from public.zones) = 13, 'visiteur : 13 aéroports et gares');
select test.verifier((select raison_sociale from public.societe) = 'LOC RÉACTION S.A.S', 'visiteur : identité légale lisible');
select test.doit_echouer('select count(*) from public.profils', 'permission denied');
select test.doit_echouer('select count(*) from public.courses', 'permission denied');
select test.doit_echouer('select count(*) from public.positions', 'permission denied');
select test.doit_echouer('select count(*) from public.codes_promo', 'permission denied');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.85, 2.35, 'B', 48.86, 2.36)$$, 'permission denied');
select test.doit_echouer($$select public.verifier_code_promo('X', 10)$$, 'permission denied');

select test.verifier((public.estimer_course('berline_hybride', 48.8566, 2.3522, 49.0097, 2.5479, p_quand => :'demain_midi')
                      ->> 'prix_total')::numeric = :prix_jour,
                     'estimation Paris → Roissy de jour : ' || :prix_jour || ' €');
select test.verifier((public.estimer_course('berline_hybride', 48.8566, 2.3522, 49.0097, 2.5479, p_quand => :'demain_23h')
                      ->> 'prix_total')::numeric = :prix_nuit,
                     'estimation de nuit : +30 % (' || :prix_nuit || ' €)');
select test.verifier((public.estimer_course('berline_hybride', 48.8566, 2.3522, 48.8600, 2.3600, p_quand => :'demain_midi')
                      ->> 'prix_total')::numeric = 8.00,
                     'estimation courte : minimum de 8 €');
select test.verifier((public.estimer_course('berline_hybride', 48.8566, 2.3522, 45.7640, 4.8357) ->> 'hors_zone')::boolean,
                     'estimation Paris → Lyon : hors zone, sur devis');
select test.verifier((public.estimer_course('berline_hybride', 48.8566, 2.3522, 49.4542, 2.1128, p_quand => :'demain_midi')
                      ->> 'hors_zone')::boolean = false,
                     'estimation Paris → aéroport de Beauvais : dans la zone desservie');

insert into public.messages_contact (nom, email, sujet, message)
values ('Jean Visiteur', 'jean@exemple.test', 'Question', 'Bonjour, une question sur vos tarifs.');
select test.doit_echouer('select count(*) from public.messages_contact', 'permission denied');
select test.doit_echouer($$insert into public.demandes_devis (service, nom, email, description, montant)
                           values ('jardinage', 'Jean Visiteur', 'jean@exemple.test', 'Tailler une haie', 10)$$, 'row-level security');
insert into public.demandes_devis (service, nom, email, description)
values ('longue_distance', 'Jean Visiteur', 'jean@exemple.test', 'Paris → Lille le 12 novembre, 3 personnes.');
select test.verifier(true, 'visiteur : formulaire de contact et demande de devis envoyés');


-- #############################################################################
-- 3. ESPACE CLIENT
-- #############################################################################
call test.connexion(:'client1');
select test.verifier((select count(*) from public.profils) = 1, 'client : ne voit que son propre profil');
update public.profils set prenom = 'Claire' where id = auth.uid();
select test.doit_echouer($$update public.profils set role = 'admin' where id = auth.uid()$$, 'permission denied');
select test.doit_echouer($$update public.profils set statut = 'actif' where id = auth.uid()$$, 'permission denied');
select test.doit_echouer($$update public.profils set code_parrainage = 'ABCDEFGH' where id = auth.uid()$$, 'permission denied');
select test.doit_echouer($$insert into public.notifications (destinataire_id, titre, message) values (auth.uid(), 'x', 'y')$$, 'permission denied');
select test.doit_echouer($$select public.admin_definir_role(auth.uid(), 'admin')$$, 'Réservé');
insert into public.lieux (client_id, type, libelle, adresse, latitude, longitude)
values (auth.uid(), 'domicile', 'Maison', '10 rue de Rivoli, 75004 Paris', 48.855600, 2.360000);
select test.doit_echouer($$insert into public.lieux (client_id, type, adresse, latitude, longitude)
                           values ('c0000000-0000-4000-8000-000000000002', 'favori', 'Ailleurs', 48.8, 2.3)$$, 'row-level security');
select test.doit_echouer($$insert into public.lieux (client_id, type, adresse, latitude, longitude)
                           values (auth.uid(), 'domicile', 'Second domicile', 48.8, 2.3)$$, 'duplicate key');
insert into public.proches (client_id, nom, telephone, relation) values (auth.uid(), 'Mamie Durand', '+33677777777', 'Grand-mère');
select test.verifier((select count(*) from public.codes_promo) = 0, 'client : la liste des codes promo reste cachée');

call test.connexion(:'client2');
select test.verifier((select count(*) from public.lieux) = 0 and (select count(*) from public.proches) = 0,
                     'autre client : ne voit ni les lieux ni les proches du premier');
select test.doit_echouer($$select public.commander_course('berline_hybride', '1 place de la Concorde, Paris', 48.8656, 2.3212,
                                                          'Gare du Nord, Paris', 48.8809, 2.3553)$$, 'téléphone');


-- #############################################################################
-- 4. CANDIDATURE ET VALIDATION DES CHAUFFEURS
-- #############################################################################
call test.connexion(:'chauffeur1');
select public.deposer_candidature('Chaumontel', 'Cinq ans de VTC à Paris', true, null, 'VTC-0001', null, 'PERMIS-0001', null);
select test.doit_echouer($$select public.deposer_candidature('Chaumontel', 'x', true)$$, 'déjà envoyé');
insert into public.documents (chauffeur_id, type, fichier_chemin, numero, expire_le)
values (auth.uid(), 'carte_vtc', auth.uid()::text || '/carte_vtc.pdf', 'VTC-0001', current_date + 365);
insert into storage.objects (bucket_id, name, owner) values ('documents', auth.uid()::text || '/carte_vtc.pdf', auth.uid());
select test.doit_echouer($$insert into storage.objects (bucket_id, name)
                           values ('documents', 'c0000000-0000-4000-8000-000000000001/faux.pdf')$$, 'row-level security');
select test.doit_echouer($$insert into public.documents (chauffeur_id, type, fichier_chemin, statut)
                           values (auth.uid(), 'permis', 'x.pdf', 'valide')$$, 'row-level security');
select test.doit_echouer('select public.mettre_en_ligne(true, 48.86, 2.35)', 'pas encore validé');
select test.verifier((select statut from public.chauffeurs where id = auth.uid()) = 'candidat', 'candidat : fiche « candidat » créée');

call test.connexion(:'chauffeuse');
select public.deposer_candidature('Paris', 'Trois ans de VTC', true, null, 'VTC-0002', current_date + 300, null, null);

call test.connexion(:'admin', 'aal2');
select test.verifier((select count(*) from public.candidatures) = 2, 'admin : voit les 2 candidatures');
insert into public.vehicules (categorie_id, immatriculation, marque, modele, couleur)
select id, 'GA-123-BC', 'Toyota', 'Auris', 'Gris' from public.categories where code = 'berline_hybride';
insert into public.vehicules (categorie_id, immatriculation, marque, modele, couleur, assurance_expiration)
select id, 'GB-456-CD', 'Toyota', 'Auris', 'Blanc', current_date + 200 from public.categories where code = 'berline_hybride';
select public.valider_candidature(:'chauffeur1', (select id from public.vehicules where immatriculation = 'GA-123-BC'), false);
select public.valider_candidature(:'chauffeuse', (select id from public.vehicules where immatriculation = 'GB-456-CD'), true);
select public.verifier_document((select id from public.documents where chauffeur_id = :'chauffeur1' and type = 'carte_vtc'), 'valide');
insert into public.documents (vehicule_id, type, fichier_chemin, expire_le)
select id, 'assurance', 'vehicules/' || id || '/assurance.pdf', current_date + 200 from public.vehicules where immatriculation = 'GA-123-BC';
select public.verifier_document((select d.id from public.documents d join public.vehicules v on v.id = d.vehicule_id
                                 where v.immatriculation = 'GA-123-BC' and d.type = 'assurance'), 'valide');
select test.verifier((select role from public.profils where id = :'chauffeur1') = 'chauffeur', 'admin : candidature validée → rôle chauffeur');
select test.verifier((select carte_vtc_expiration from public.chauffeurs where id = :'chauffeur1') = current_date + 365,
                     'admin : carte VTC validée → date reportée sur la fiche');
select test.verifier((select assurance_expiration from public.vehicules where immatriculation = 'GA-123-BC') = current_date + 200,
                     'admin : assurance validée → date reportée sur le véhicule');

call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from storage.objects where bucket_id = 'documents') = 1,
                     'chauffeur : ne voit que ses propres pièces');


-- #############################################################################
-- 5. COMMANDE, DISPATCH ET COURSE COMPLÈTE
-- #############################################################################
-- Aucun chauffeur en ligne : la course passe « à attribuer »
call test.connexion(:'client1');
select (public.estimer_course('berline_hybride', 48.8656, 2.3212, 48.8809, 2.3553) ->> 'prix_total') as prix_c1 \gset
select id as course1 from public.commander_course(
  p_categorie        => 'berline_hybride',
  p_depart_adresse   => '1 place de la Concorde, 75008 Paris', p_depart_lat => 48.8656, p_depart_lng => 2.3212,
  p_arrivee_adresse  => 'Gare du Nord, 75010 Paris',          p_arrivee_lat => 48.8809, p_arrivee_lng => 2.3553,
  p_prix_annonce     => :prix_c1) \gset
select test.verifier((select statut from public.courses where id = :'course1') = 'a_attribuer',
                     'commande sans chauffeur en ligne → « à attribuer »');
select test.verifier(exists (select 1 from public.notifications where titre = 'Recherche en cours'),
                     'client prévenu que l''équipe s''occupe de sa course');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8656, 2.3212, 'B', 48.8809, 2.3553)$$,
                         'déjà une course en cours');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8656, 2.3212, 'B', 48.8809, 2.3553,
                           p_type => 'planifiee', p_quand => now() + interval '30 minutes')$$, 'au moins 60 minutes');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8656, 2.3212, 'B', 48.8809, 2.3553,
                           p_type => 'planifiee', p_quand => now() + interval '1 day', p_prix_annonce => 1.00)$$, 'Le prix a changé');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8656, 2.3212, 'B', 48.8809, 2.3553,
                           p_type => 'planifiee', p_quand => now() + interval '1 day', p_mode_paiement => 'solde')$$, 'prochaine version');

call test.connexion(:'admin', 'aal2');
select test.verifier(exists (select 1 from public.notifications where titre = 'Course à attribuer'),
                     'administration prévenue : course à attribuer');

-- Le chauffeur se connecte ; la relance automatique lui propose la course
call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.courses) = 0, 'chauffeur : aucune course visible tant qu''aucune ne lui est attribuée');
select public.mettre_en_ligne(true, 48.8700, 2.3300);
call test.systeme();
select test.verifier(public.relancer_dispatch() = 1, 'relance : 1 demande envoyée');
select test.verifier((select statut from public.courses where id = :'course1') = 'recherche',
                     'course « à attribuer » repartie automatiquement en recherche');
select id as prop1 from public.propositions where course_id = :'course1' and chauffeur_id = :'chauffeur1' \gset

call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.propositions) = 1, 'chauffeur : reçoit la demande');
select test.verifier((select count(*) from public.courses) = 0, 'chauffeur : ne lit pas la course complète avant d''accepter');
select test.verifier(public.demande_recue(:'prop1') ->> 'depart_adresse' = '1 place de la Concorde, 75008 Paris',
                     'chauffeur : résumé de la demande (adresses, prix, heure)');
select test.verifier(position('+3361' in public.demande_recue(:'prop1')::text) = 0
                     and position('Claire' in public.demande_recue(:'prop1')::text) = 0,
                     'chauffeur : ni nom ni téléphone du client avant acceptation');
select public.accepter_proposition(:'prop1');
select test.verifier((select statut from public.courses where id = :'course1') = 'acceptee', 'chauffeur : course acceptée');
select test.verifier((select client_prenom || ' ' || client_telephone from public.courses where id = :'course1') = 'Claire +33611111111',
                     'chauffeur : prénom et téléphone du client visibles après acceptation');

call test.connexion(:'client1');
select test.verifier((select chauffeur_prenom || ' · ' || vehicule_libelle || ' · ' || vehicule_immatriculation
                      from public.courses where id = :'course1') = 'Paul · Toyota Auris · GA-123-BC',
                     'client : voit son chauffeur, le véhicule et la plaque');
select test.verifier((select count(*) from public.positions) = 1, 'client : suit la position de son chauffeur');
insert into public.messages (course_id, auteur_id, contenu) values (:'course1', auth.uid(), 'Je suis devant l''entrée principale.');

call test.connexion(:'client2');
select test.verifier((select count(*) from public.positions) = 0, 'autre client : aucune position visible');
select test.verifier((select count(*) from public.messages) = 0, 'autre client : ne lit pas la conversation');
select test.doit_echouer(format('insert into public.messages (course_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'course1', 'Intrus'), 'row-level security');

call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.messages where course_id = :'course1') = 1, 'chauffeur : lit le message du client');
update public.messages set lu_le = now() where course_id = :'course1' and auteur_id <> auth.uid();
select test.verifier((select lu_le is not null from public.messages where course_id = :'course1'), 'chauffeur : message marqué lu');
select test.doit_echouer(format('update public.messages set contenu = %L where course_id = %L', 'modifié', :'course1'),
                         'permission denied');
select public.avancer_course(:'course1', 'arrivee');
select public.avancer_course(:'course1', 'a_bord');
select test.doit_echouer(format('select public.avancer_course(%L, %L)', :'course1', 'arrivee'), 'Étape impossible');
select public.avancer_course(:'course1', 'terminee');
select test.verifier((select statut from public.courses where id = :'course1') = 'terminee', 'course terminée');
select id as paiement1 from public.paiements where course_id = :'course1' and nature = 'course' \gset
select test.verifier((select statut from public.paiements where id = :'paiement1') = 'a_encaisser', 'paiement de la course à encaisser');
select public.confirmer_encaissement(:'paiement1');
select test.verifier((select statut from public.paiements where id = :'paiement1') = 'encaisse', 'chauffeur : encaissement confirmé');
select test.verifier((select count(*) from public.factures) = 0, 'chauffeur : ne voit pas la facture du client');

call test.connexion(:'client1');
select test.verifier((select count(*) from public.factures) = 1, 'client : voit sa facture');
select test.verifier((select numero = 'FA-' || extract(year from now() at time zone 'Europe/Paris') || '-000001' from public.factures),
                     'facture : numéro FA-année-000001');
select test.verifier((select montant_ttc = :prix_c1 and montant_ht + montant_tva = montant_ttc
                             and montant_ht = round(montant_ttc / 1.10, 2) and taux_tva = 10 from public.factures),
                     'facture : TTC = prix annoncé (' || :prix_c1 || ' €), HT + TVA 10 %');
select public.ajouter_pourboire(:'course1', 2.00);
select test.verifier((select pourboire from public.factures) = 0, 'pourboire : la facture émise reste inchangée');
select test.verifier((select count(*) from public.paiements where nature = 'pourboire' and montant = 2.00) = 1,
                     'pourboire : paiement à part pour le chauffeur');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 1)', :'course1'), 'déjà laissé');
select public.noter_course(:'course1', 5, 'Très bien');
select test.doit_echouer(format('select public.noter_course(%L, 4)', :'course1'), 'déjà noté');

call test.connexion(:'chauffeur1');
select public.noter_course(:'course1', 4, 'Ponctuelle');
select test.verifier((select note_moyenne from public.chauffeurs where id = auth.uid()) = 5.00, 'chauffeur : note moyenne mise à jour (5/5)');
select test.verifier((select count(*) from public.evaluations) = 2, 'chauffeur : voit la note reçue et celle qu''il a donnée');
select test.verifier((select sum(courses) from public.revenus_chauffeur(current_date - 1, current_date + 1)) = 1,
                     'chauffeur : revenus du jour (1 course)');

call test.connexion(:'client1');
select test.verifier((select count(*) from public.evaluations) = 1, 'client : ne voit pas la note que le chauffeur lui a donnée');


-- #############################################################################
-- 6. FACTURES : INCHANGEABLES, PDF ARCHIVÉ
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.doit_echouer('update public.factures set montant_ttc = montant_ttc + 1', 'permission denied');
call test.systeme();
select test.doit_echouer('update public.factures set montant_ttc = montant_ttc + 1', 'ne peut plus être modifiée');
select test.doit_echouer('delete from public.factures', 'ne peut pas être supprimée');

call test.connexion(:'admin', 'aal2');
update public.factures set pdf_chemin = client_id::text || '/' || numero || '.pdf';
insert into storage.objects (bucket_id, name, owner) select 'factures', pdf_chemin, auth.uid() from public.factures;
call test.connexion(:'client1');
select test.verifier((select count(*) from storage.objects where bucket_id = 'factures') = 1, 'client : télécharge sa facture en PDF');
call test.connexion(:'client2');
select test.verifier((select count(*) from storage.objects where bucket_id = 'factures') = 0, 'autre client : n''y a pas accès');


-- #############################################################################
-- 7. RÉSERVATIONS ET ANNULATIONS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
update public.tarifs set frais_annulation = 5.00;
select test.verifier((select count(*) from public.journal_lister('tarifs')) >= 2, 'journal : création et modification du tarif tracées');

call test.connexion(:'client1');
select id as course2 from public.commander_course('berline_hybride', '10 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                  'Aéroport Paris-Orly', 48.7280, 2.3700,
                                                  p_type => 'planifiee', p_quand => :'demain_midi', p_numero_vol => 'af 1234') \gset
select test.verifier((select statut || ' ' || numero_vol from public.courses where id = :'course2') = 'planifiee AF1234',
                     'réservation : planifiée, n° de vol normalisé');

call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.reservations_disponibles()) = 1, 'chauffeur : voit la réservation libre (résumé)');
select test.verifier((select count(*) from public.courses where id = :'course2') = 0, 'chauffeur : pas d''accès direct à la réservation libre');
select public.prendre_course_planifiee(:'course2');
select test.verifier((select chauffeur_id from public.courses where id = :'course2') = :'chauffeur1', 'chauffeur : réservation prise');
select test.verifier((select count(*) from public.reservations_disponibles()) = 0, 'réservation prise : retirée de la liste');

call test.connexion(:'client1');
select public.annuler_course(:'course2', 'Changement de programme');
select test.verifier((select frais_annulation from public.courses where id = :'course2') = 0, 'annulation plus de 2 h avant : gratuite');

select id as course3 from public.commander_course('berline_hybride', '10 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                  'Gare de Lyon, 75012 Paris', 48.8443, 2.3743,
                                                  p_type => 'planifiee', p_quand => now() + interval '90 minutes') \gset
call test.connexion(:'chauffeur1');
select public.prendre_course_planifiee(:'course3');
call test.connexion(:'client1');
select public.annuler_course(:'course3', null);
select test.verifier((select frais_annulation from public.courses where id = :'course3') = 5.00,
                     'annulation à moins de 2 h, chauffeur attribué : 5 € de frais');
select test.verifier((select count(*) from public.factures where nature = 'frais_annulation') = 1, 'frais d''annulation : facture émise');
select test.verifier((select count(*) from public.paiements where nature = 'frais_annulation' and statut = 'a_encaisser') = 1,
                     'frais d''annulation : paiement à encaisser');


-- #############################################################################
-- 8. OPTION « CHAUFFEUSE », DÉLAI DÉPASSÉ, ATTRIBUTION MANUELLE, DÉSISTEMENT
-- #############################################################################
call test.connexion(:'chauffeuse');
select public.mettre_en_ligne(true, 48.8500, 2.3400);
call test.connexion(:'chauffeur1');
update public.positions set latitude = 48.855700, longitude = 2.360100 where chauffeur_id = auth.uid();
select test.verifier((select maj_le > now() - interval '5 seconds' from public.positions where chauffeur_id = auth.uid()),
                     'position : heure de mise à jour posée par la base');
select test.doit_echouer('update public.positions set en_ligne = true', 'permission denied');

call test.visiteur();
select test.verifier((select count(*) from public.vehicules_a_proximite(48.8556, 2.3600)) = 2
                     and (select bool_and(scale(latitude) <= 3 and scale(longitude) <= 3) from public.vehicules_a_proximite(48.8556, 2.3600)),
                     'carte d''accueil : 2 voitures, positions arrondies (~100 m), sans identité');

call test.connexion(:'client1');
select id as course4 from public.commander_course('berline_hybride', '10 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                  'Gare Montparnasse, 75015 Paris', 48.8409, 2.3206,
                                                  p_option_chauffeuse => true) \gset
call test.systeme();
select test.verifier((select chauffeur_id from public.propositions where course_id = :'course4' and statut = 'envoyee') = :'chauffeuse',
                     'option chauffeuse : demande envoyée à la chauffeuse, même plus loin');
update public.propositions set expire_le = now() - interval '1 second' where course_id = :'course4' and statut = 'envoyee';
select test.verifier(public.relancer_dispatch() = 0, 'délai dépassé : aucune autre chauffeuse disponible');
select test.verifier((select statut from public.courses where id = :'course4') = 'a_attribuer', 'sans réponse → « à attribuer »');
select test.verifier((select count(*) from public.notifications where titre = 'Course à attribuer') = 2,
                     'administration prévenue une seule fois par course');

call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.attribuer_course(%L, %L)', :'course4', :'chauffeur1'), 'chauffeuse');
select public.attribuer_course(:'course4', :'chauffeuse');
select test.verifier((select statut || ' ' || attribution from public.courses where id = :'course4') = 'acceptee manuelle',
                     'admin : attribution manuelle à la chauffeuse');
select test.verifier((select count(*) from public.journal_lister(null, :'course4')) >= 1, 'journal : attribution manuelle tracée');

call test.connexion(:'chauffeuse');
select public.annuler_course(:'course4', 'Crevaison');
call test.systeme();
select test.verifier((select statut from public.courses where id = :'course4') = 'a_attribuer',
                     'désistement : nouvelle recherche, puis « à attribuer » (aucune autre chauffeuse)');
call test.connexion(:'client1');
select public.annuler_course(:'course4', null);
select test.verifier((select frais_annulation from public.courses where id = :'course4') = 0, 'annulation avant acceptation : gratuite');


-- #############################################################################
-- 9. FICHE CHAUFFEUR PROTÉGÉE
-- #############################################################################
call test.connexion(:'chauffeur1');
select test.doit_echouer($$update public.chauffeurs set note_moyenne = 5, chauffeuse = true where id = auth.uid()$$,
                         'Seule l''administration');
update public.chauffeurs set filtre_destination_actif = true, filtre_destination_lat = 49.125300, filtre_destination_lng = 2.430300
 where id = auth.uid();
select test.verifier((select filtre_destination_actif from public.chauffeurs where id = auth.uid()), 'chauffeur : règle son filtre de destination');
update public.chauffeurs set filtre_destination_actif = false where id = auth.uid();
select test.doit_echouer(format('select public.attribuer_course(%L, %L)', :'course4', :'chauffeur1'), 'Réservé');
select test.doit_echouer('select * from public.journal_lister()', 'Réservé');


-- #############################################################################
-- 10. CODES PROMO
-- #############################################################################
call test.connexion(:'admin', 'aal2');
-- Codes promo : écrits par la fonction du module Marketing (migration 18)
select test.doit_echouer($$insert into public.codes_promo (code, type, valeur) values ('DIRECT', 'montant', 5)$$, 'permission denied');
select public.admin_enregistrer_code_promo(null, '{"code": "bienvenue10", "libelle": "Bienvenue : 10 %", "type": "pourcentage",
                                                  "valeur": 10, "utilisations_par_client": 1}');
call test.connexion(:'chauffeur1');
select public.mettre_en_ligne(false);
call test.connexion(:'chauffeuse');
select public.mettre_en_ligne(false);

call test.connexion(:'client1');
select test.verifier((public.verifier_code_promo('bienvenue10', 30) ->> 'remise')::numeric = 3.00, 'code promo : 10 % de 30 € = 3 €');
select id as course5 from public.commander_course('berline_hybride', '10 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                  'Gare de Lyon, 75012 Paris', 48.8443, 2.3743, p_code_promo => 'BIENVENUE10') \gset
select test.verifier((select remise > 0 and remise = round((prix_total + remise) * 0.10, 2) from public.courses where id = :'course5'),
                     'code promo : remise appliquée au prix fixe');
select test.verifier((select count(*) from public.utilisations_promo) = 1, 'code promo : utilisation enregistrée');
select public.annuler_course(:'course5', null);
select test.verifier((select count(*) from public.utilisations_promo) = 0, 'annulation gratuite : le code promo est rendu');
select id as course6 from public.commander_course('berline_hybride', '10 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                  'Gare de Lyon, 75012 Paris', 48.8443, 2.3743, p_code_promo => 'BIENVENUE10') \gset
select test.verifier(not (public.verifier_code_promo('BIENVENUE10', 30) ->> 'valide')::boolean, 'code promo : une seule utilisation par client');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8556, 2.3600, 'B', 48.8443, 2.3743,
                           p_type => 'planifiee', p_quand => now() + interval '1 day', p_code_promo => 'BIENVENUE10')$$, 'déjà utilisé');
select public.annuler_course(:'course6', null);


-- #############################################################################
-- 11. POUR UN PROCHE, HORS ZONE, PARRAINAGE
-- #############################################################################
call test.connexion(:'admin', 'aal2');
update public.parametres set recompense_parrain = 5, recompense_filleul = 5;
call test.connexion(:'chauffeur1');
select public.mettre_en_ligne(true, 48.8557, 2.3601);

call test.connexion(:'filleul');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8556, 2.3600, 'Lyon', 45.7640, 4.8357)$$, 'devis');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8556, 2.3600, 'B', 48.8443, 2.3743,
                           p_pour_proche => true, p_beneficiaire_nom => 'Mamie')$$, 'format international');
select id as course7 from public.commander_course('berline_hybride', '5 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                  'Gare de Lyon, 75012 Paris', 48.8443, 2.3743,
                                                  p_pour_proche => true, p_beneficiaire_nom => 'Jeanne Roux',
                                                  p_beneficiaire_telephone => '+33688888888') \gset
call test.systeme();
select id as prop7 from public.propositions where course_id = :'course7' and statut = 'envoyee' \gset
call test.connexion(:'chauffeur1');
select public.accepter_proposition(:'prop7');
select test.verifier((select client_prenom || ' ' || client_telephone from public.courses where id = :'course7') = 'Jeanne Roux +33688888888',
                     'pour un proche : le chauffeur voit la personne transportée');
select public.avancer_course(:'course7', 'arrivee');
select public.avancer_course(:'course7', 'a_bord');
select public.avancer_course(:'course7', 'terminee');
call test.systeme();
select test.verifier((select statut from public.parrainages where filleul_id = :'filleul') = 'valide', 'parrainage validé à la première course terminée');
select test.verifier((select montant from public.soldes where profil_id = :'client1') = 5.00
                     and (select montant from public.soldes where profil_id = :'filleul') = 5.00,
                     'parrainage : 5 € crédités au parrain et au filleul');
call test.connexion(:'client1');
select test.verifier((select count(*) from public.ecritures_solde) = 1, 'client : voit l''écriture de son solde');


-- #############################################################################
-- 12. SUPPORT
-- #############################################################################
call test.connexion(:'client1');
select id as demande1 from public.ouvrir_demande('objet_perdu', 'Parapluie oublié',
                                                 'J''ai oublié mon parapluie noir dans la voiture.', :'course1') \gset
select test.verifier((select numero like 'S-%-000001' from public.demandes where id = :'demande1'), 'support : demande numérotée');
insert into public.messages (demande_id, auteur_id, contenu) values (:'demande1', auth.uid(), 'Il a un manche en bois.');
insert into storage.objects (bucket_id, name, owner) values ('support', :'demande1' || '/photo.jpg', auth.uid());

call test.connexion(:'client2');
select test.verifier((select count(*) from public.demandes) = 0, 'support : un autre client ne voit pas la demande');
select test.doit_echouer(format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'support', :'demande1' || '/intrus.jpg'),
                         'row-level security');

call test.connexion(:'admin', 'aal2');
select test.verifier((select count(*) from public.messages where demande_id = :'demande1') = 2, 'support : l''administration lit le fil');
-- Statut et attribution : par les fonctions du module Support (migration 17)
select test.doit_echouer(format('update public.demandes set statut = %L where id = %L', 'resolue', :'demande1'), 'permission denied');
select public.admin_repondre_demande(:'demande1', 'Nous l''avons retrouvé.', true);

call test.connexion(:'client1');
update public.messages set lu_le = now() where demande_id = :'demande1' and auteur_id <> auth.uid();
select test.verifier((select count(*) from public.messages where demande_id = :'demande1' and lu_le is not null) = 1,
                     'support : réponse de l''administration marquée lue');
select test.doit_echouer(format('insert into public.messages (demande_id, auteur_id, contenu) values (%L, auth.uid(), %L)',
                                :'demande1', 'Merci'), 'row-level security');


-- #############################################################################
-- 13. RH ET PAIE
-- #############################################################################
call test.connexion(:'admin', 'aal2');
insert into public.salaries (profil_id, matricule, civilite, prenom, nom, type_contrat, date_entree, salaire_base_mensuel)
values (:'chauffeur1', 'S0001', 'Monsieur', 'Paul', 'Bernard', 'CDI', date '2026-09-01', 1801.80)
returning id as salarie_id \gset
-- Bulletin écrit comme le font les fonctions de paie (depuis la migration 16,
-- l'application n'écrit plus directement dans la table des bulletins)
call test.systeme();
insert into public.bulletins (salarie_id, periode, brut, net_a_payer)
values (:'salarie_id', date '2026-10-01', 1801.80, 1410.00)
returning id as bulletin_id \gset
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('insert into public.bulletins (salarie_id, periode) values (%L, %L)', :'salarie_id', '2026-11-01'),
                         'permission denied');
insert into storage.objects (bucket_id, name, owner) values ('paie', :'salarie_id' || '/bulletin-2026-10.pdf', auth.uid());

call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.salaries) = 1, 'paie : le salarié voit sa fiche');
select test.verifier((select count(*) from public.bulletins) = 0, 'paie : bulletin en brouillon invisible pour le salarié');
select test.verifier((select count(*) from storage.objects where bucket_id = 'paie') = 1, 'paie : le salarié accède à ses documents');
insert into public.absences (salarie_id, type, debut, fin, jours) values (:'salarie_id', 'conges_payes', date '2026-12-21', date '2026-12-24', 4);
select test.doit_echouer(format('insert into public.absences (salarie_id, type, debut, fin, jours, statut) values (%L, %L, %L, %L, 1, %L)',
                                :'salarie_id', 'conges_payes', '2026-12-28', '2026-12-28', 'validee'), 'row-level security');

call test.systeme();
update public.bulletins set statut = 'valide', valide_par = :'admin', valide_le = now() where id = :'bulletin_id';
call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.bulletins) = 1, 'paie : bulletin validé visible par le salarié');
call test.connexion(:'client1');
select test.verifier((select count(*) from storage.objects where bucket_id = 'paie') = 0 and (select count(*) from public.salaries) = 0,
                     'paie : rien de visible pour un client');


-- #############################################################################
-- 14. BLOCAGE D'UN COMPTE, DERNIER ADMINISTRATEUR
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_definir_statut(%L, %L)', :'admin', 'bloque'), 'propre compte');
select public.admin_definir_statut(:'chauffeur1', 'bloque');
call test.systeme();
select test.verifier(not (select en_ligne from public.positions where chauffeur_id = :'chauffeur1'), 'compte bloqué : chauffeur mis hors ligne');
call test.connexion(:'chauffeur1');
select test.verifier(public.mon_role() is null, 'compte bloqué : plus aucun droit');
select test.doit_echouer('select public.mettre_en_ligne(true, 48.85, 2.35)', 'pas encore validé');
select public.mettre_en_ligne(false);
call test.connexion(:'admin', 'aal2');
select public.admin_definir_statut(:'chauffeur1', 'actif');
select test.doit_echouer(format('select public.admin_definir_role(%L, %L)', :'admin', 'client'), 'dernier administrateur');


-- #############################################################################
-- 15. REMBOURSEMENT, GESTE COMMERCIAL, REFUS, DOCUMENTS EXPIRÉS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.rembourser(%L, %s, %L)', :'paiement1', :prix_c1 + 1, 'Erreur'), 'il reste');
select public.rembourser(:'paiement1', 5.00, 'Retard de dix minutes');
select test.verifier((select statut from public.paiements where id = :'paiement1') = 'encaisse',
                     'remboursement partiel : le paiement reste « encaissé »');
select public.ajuster_solde(:'client2', 10.00, 'Geste commercial');
select test.doit_echouer(format('select public.ajuster_solde(%L, %s, %L)', :'client2', -20, 'Correction'), 'Solde insuffisant');
select test.doit_echouer(format('select public.ajuster_solde(%L, %s, %L)', 'f0000000-0000-4000-8000-000000000000', 5, 'Test'), 'introuvable');
call test.connexion(:'client1');
select test.verifier((select count(*) from public.remboursements) = 1, 'client : voit son remboursement');
call test.connexion(:'client2');
select test.verifier((select montant from public.soldes) = 10.00, 'client : geste commercial crédité sur son solde');

-- Refus d'une demande : elle passe au chauffeur suivant
call test.connexion(:'chauffeur1');
select public.mettre_en_ligne(true, 48.8557, 2.3601);
call test.connexion(:'chauffeuse');
select public.mettre_en_ligne(true, 48.8500, 2.3400);
call test.connexion(:'clienttel');
select id as course8 from public.commander_course('berline_hybride', '5 rue de Rivoli, 75004 Paris', 48.8556, 2.3600,
                                                  'Gare du Nord, 75010 Paris', 48.8809, 2.3553) \gset
call test.systeme();
select chauffeur_id as premier, id as prop8 from public.propositions where course_id = :'course8' and statut = 'envoyee' \gset
select test.verifier(:'premier' = :'chauffeur1', 'dispatch : le chauffeur le plus proche reçoit la demande');
call test.connexion(:'chauffeur1');
select public.refuser_proposition(:'prop8');
call test.systeme();
select test.verifier((select chauffeur_id from public.propositions where course_id = :'course8' and statut = 'envoyee') = :'chauffeuse',
                     'refus : la demande passe au chauffeur suivant');
call test.connexion(:'chauffeuse');
select public.accepter_proposition((select id from public.propositions where course_id = :'course8' and statut = 'envoyee'));
call test.connexion(:'clienttel');
select public.annuler_course(:'course8', 'Plus besoin');
select test.verifier((select frais_annulation from public.courses where id = :'course8') = 5.00,
                     'annulation après acceptation du chauffeur : frais appliqués');
select test.doit_echouer($$select public.commander_course('berline_hybride', 'A', 48.8556, 2.3600, 'B', 48.8443, 2.3743,
                           p_type => 'mise_a_disposition', p_duree_mad => 3)$$, 'pas encore proposée');

-- Candidature refusée
select test.doit_echouer($$select public.deposer_candidature('Paris', 'Débutant', false)$$, 'Complétez');
update public.profils set prenom = 'Karim', nom = 'Benali' where id = auth.uid();
select public.deposer_candidature('Paris', 'Débutant', false);
call test.connexion(:'admin', 'aal2');
select public.refuser_candidature(:'clienttel', 'Carte VTC manquante');
select test.verifier((select statut from public.candidatures where profil_id = :'clienttel') = 'refusee'
                     and (select statut from public.chauffeurs where id = :'clienttel') = 'refuse',
                     'candidature refusée, motif enregistré');
call test.connexion(:'clienttel');
select test.verifier(exists (select 1 from public.notifications where titre = 'Votre candidature'), 'candidat prévenu du refus');

-- Véhicule retiré, assurance expirée : impossible de passer en ligne
call test.connexion(:'admin', 'aal2');
select public.affecter_vehicule(:'chauffeur1', null);
call test.connexion(:'chauffeur1');
select public.mettre_en_ligne(false);
select test.doit_echouer('select public.mettre_en_ligne(true, 48.85, 2.35)', 'Aucun véhicule');
call test.connexion(:'admin', 'aal2');
select public.affecter_vehicule(:'chauffeur1', (select id from public.vehicules where immatriculation = 'GA-123-BC'));
update public.vehicules set assurance_expiration = current_date - 1 where immatriculation = 'GA-123-BC';
call test.connexion(:'chauffeur1');
select test.doit_echouer('select public.mettre_en_ligne(true, 48.85, 2.35)', 'assurance');
call test.connexion(:'admin', 'aal2');
update public.vehicules set assurance_expiration = current_date + 200 where immatriculation = 'GA-123-BC';
select public.admin_definir_role(:'client2', 'admin');
select public.admin_definir_role(:'client2', 'client');
-- 7 changements : 1er administrateur, 2 chauffeurs validés, blocage et
-- déblocage, nomination puis retrait d'un administrateur
select test.verifier((select count(*) from public.journal_lister('profils')) = 7
                     and (select apres from public.journal_lister('profils', p_limite => 1)) = '{"role": "client"}'::jsonb,
                     'journal : chaque changement de rôle ou de blocage tracé, colonnes modifiées seulement');


-- Questions fréquentes : le visiteur ne lit que les réponses publiées
call test.connexion(:'admin', 'aal2');
insert into public.faq (theme, ordre, question_fr, reponse_fr, publie) values
  ('commande', 1, 'Comment réserver une course ?', 'Depuis l''application, en indiquant le départ et l''arrivée.', true),
  ('paiement', 1, 'Question en préparation', 'Réponse en cours de rédaction.', false);
select test.verifier((select count(*) from public.faq) = 2, 'administration : voit toutes les questions fréquentes');
call test.visiteur();
select test.verifier((select count(*) from public.faq) = 1, 'visiteur : ne voit que les questions publiées');
call test.connexion(:'client1');
select test.verifier((select count(*) from public.faq) = 1, 'client : ne voit que les questions publiées');


-- #############################################################################
-- 16. CONTRÔLES D'ENSEMBLE
-- #############################################################################
call test.systeme();
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables sont protégées ligne par ligne');
select test.verifier((select string_agg(table_name || ':' || privilege_type, ',' order by table_name collate "C", privilege_type collate "C")
                      from information_schema.role_table_grants
                      where grantee = 'anon' and table_schema = 'public')
                     = 'categories:SELECT,demandes_devis:INSERT,faq:SELECT,forfaits:SELECT,jours_feries:SELECT,majorations:SELECT,'
                       'messages_contact:INSERT,parametres:SELECT,tarifs:SELECT,zones:SELECT',
                     'visiteur : uniquement le catalogue, le contact et les devis');
-- Identité de l'entreprise : colonne par colonne depuis la migration 14
select test.verifier(has_column_privilege('anon', 'public.societe', 'raison_sociale', 'select')
                     and has_column_privilege('anon', 'public.societe', 'siret', 'select')
                     and has_column_privilege('anon', 'public.societe', 'mentions_factures', 'select')
                     and not has_column_privilege('anon', 'public.societe', 'iban', 'select')
                     and not has_column_privilege('anon', 'public.societe', 'bic', 'select'),
                     'visiteur : identité légale de l''entreprise lisible, mais ni son IBAN ni son BIC');
select test.verifier((select string_agg(p.proname, ',' order by p.proname collate "C")
                      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute'))
                     = 'estimer_course,vehicules_a_proximite',
                     'visiteur : seules l''estimation et la carte sont appelables');
select test.verifier(not has_schema_privilege('authenticated', 'prive', 'usage')
                     and not has_schema_privilege('anon', 'prive', 'usage'),
                     'schéma privé : inaccessible depuis l''application');
select test.verifier((select max(right(numero, 6)::integer) = count(*) from public.factures), 'factures : numérotation continue, sans trou');
select test.verifier(not exists (select 1 from public.notifications where message = ''), 'notifications : aucune vide');
select test.verifier((select count(*) from prive.journal
                      where table_cible = 'courses' and action in ('INSERT', 'UPDATE', 'DELETE')) = 0,
                     'journal : les étapes normales des courses n''y sont pas (elles sont dans evenements_course)');
select test.verifier((select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 5, 'temps réel : 5 tables publiées');
select test.verifier((select count(*) from storage.buckets) = 7, 'stockage : 7 dossiers');

\o
\echo '✔ Scénarios : tout est conforme.'
