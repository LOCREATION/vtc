-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios du module « Support » (migration 17), joués après 16_rh.sql sur
-- les mêmes comptes fictifs :
--   droits ; demandes ouvertes par les clients et un chauffeur ; file (vues,
--   attente, non lus, recherche) ; fil (auteur, course, conversation, autres
--   demandes, messages lus) ; réponse (pièce jointe, résolution), statuts
--   (date de clôture, fermeture motivée, réouverture), attribution, demande
--   enregistrée pour un client ; objets trouvés (registre, client prévenu,
--   restitution, correction, suppression) ; messages du site (contact,
--   devis) ; fiche de la course ; journal.
-- Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set clienttel  c0000000-0000-4000-8000-000000000003
\set chauffeur1 d0000000-0000-4000-8000-000000000001

call test.systeme();
select id as demande1, course_id as course1 from public.demandes where numero like 'S-%-000001' \gset
select numero as numero_c1, (prise_en_charge_le at time zone 'Europe/Paris')::date as jour_c1 from public.courses where id = :'course1' \gset
select (now() at time zone 'Europe/Paris')::date as aujourdhui \gset


-- #############################################################################
-- 1. DROITS
-- #############################################################################
call test.visiteur();
select test.doit_echouer('select public.admin_lister_demandes()', 'permission denied');
select test.doit_echouer('select public.admin_lister_objets()', 'permission denied');
select test.doit_echouer('select public.admin_lister_messages_site()', 'permission denied');
call test.connexion(:'client1');
select test.doit_echouer('select public.admin_lister_demandes()', 'Réservé à l''administration');
select test.doit_echouer(format('select public.admin_fil_demande(%L)', :'demande1'), 'Réservé à l''administration');
select test.doit_echouer(format('select public.admin_repondre_demande(%L, %L)', :'demande1', 'Intrus'), 'Réservé à l''administration');
select test.doit_echouer(format('select public.admin_enregistrer_objet(null, null, %L, null)', 'Parapluie'), 'Réservé à l''administration');
-- Administrateur sans la double authentification
call test.connexion(:'admin');
select test.doit_echouer('select public.admin_lister_demandes()', 'Réservé à l''administration');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('update public.demandes set statut = %L where id = %L', 'en_cours', :'demande1'), 'permission denied');
select test.doit_echouer(format('insert into public.objets_trouves (numero, description) values (%L, %L)', 'OT-ESSAI', 'Essai'), 'permission denied');
select test.doit_echouer($$update public.messages_contact set traite = true$$, 'permission denied');
select test.doit_echouer($$update public.demandes_devis set statut = 'acceptee'$$, 'permission denied');
select test.verifier((select statut = 'resolue' and cloturee_le is not null from public.demandes where id = :'demande1'),
                     'demande résolue (scénario 12) : date de clôture posée par la base');


-- #############################################################################
-- 2. NOUVELLES DEMANDES ET FILE
-- #############################################################################
call test.connexion(:'client1');
select id as d_paiement from public.ouvrir_demande('paiement', 'Double débit ?',
  'Bonjour, ma carte a été débitée deux fois pour cette course.', :'course1') \gset
select id as d_lunettes from public.ouvrir_demande('objet_perdu', 'Lunettes oubliées',
  'J''ai oublié mes lunettes de vue (étui bleu) sur la banquette arrière.', :'course1') \gset
call test.connexion(:'chauffeur1');
select id as d_compte from public.ouvrir_demande('compte', 'Changer mon RIB', 'Comment mettre à jour mon RIB ?') \gset

call test.connexion(:'admin', 'aal2');
select public.admin_lister_demandes() as file \gset
select test.verifier((:'file'::jsonb ->> 'total')::int = 3
                     and (:'file'::jsonb -> 'compteurs' ->> 'a_traiter')::int = 3
                     and (:'file'::jsonb -> 'compteurs' ->> 'non_attribuees')::int = 3
                     and (:'file'::jsonb -> 'compteurs' ->> 'cloturees')::int = 1
                     and (:'file'::jsonb -> 'compteurs' ->> 'toutes')::int = 4,
                     'file « à traiter » : 3 demandes ouvertes, non attribuées ; 1 clôturée ; 4 en tout');
select test.verifier((select bool_and((x ->> 'attente')::boolean) and bool_and((x ->> 'non_lus')::int = 1)
                      from jsonb_array_elements(:'file'::jsonb -> 'lignes') x),
                     'chaque auteur attend une réponse : un message non lu chacun');
select test.verifier(:'file'::jsonb -> 'lignes' -> 0 ->> 'id' = :'d_paiement'
                     and :'file'::jsonb -> 'lignes' -> 0 -> 'course' ->> 'numero' = :'numero_c1'
                     and :'file'::jsonb -> 'lignes' -> 0 -> 'auteur' ->> 'nom' = 'Claire Durand',
                     'en tête : la demande qui attend depuis le plus longtemps, avec sa course et son auteur');
select test.verifier((public.admin_lister_demandes('toutes', null, '06 11 11 11 11') ->> 'total')::int = 3,
                     'recherche par téléphone saisi avec espaces : les 3 demandes de Claire');
select test.verifier((public.admin_lister_demandes('toutes', null, lower(:'numero_c1')) ->> 'total')::int = 3,
                     'recherche par numéro de course');
select test.verifier((public.admin_lister_demandes('a_traiter', 'objet_perdu') ->> 'total')::int = 1
                     and (public.admin_lister_demandes('cloturees') -> 'lignes' -> 0 ->> 'id') = :'demande1',
                     'filtres : type, clôturées');
select test.verifier((public.admin_lister_demandes('toutes', null, null, 2, 2) -> 'lignes' ->> 0) is not null
                     and jsonb_array_length(public.admin_lister_demandes('toutes', null, null, 2, 2) -> 'lignes') = 2
                     and (public.admin_lister_demandes('toutes', null, null, 2, 2) ->> 'total')::int = 4,
                     'pagination : 2 lignes par page, le total reste celui de la file');
select test.doit_echouer($$select public.admin_lister_demandes('inconnue')$$, 'Vue inconnue');


-- #############################################################################
-- 3. FIL D'UNE DEMANDE
-- #############################################################################
select public.admin_fil_demande(:'d_paiement') as fil \gset
select test.verifier(:'fil'::jsonb -> 'auteur' ->> 'email' = 'client1@exemple.test'
                     and :'fil'::jsonb -> 'course' ->> 'numero' = :'numero_c1'
                     and :'fil'::jsonb -> 'course' ->> 'chauffeur' = 'Paul Bernard'
                     and jsonb_array_length(:'fil'::jsonb -> 'messages') = 1
                     and (:'fil'::jsonb -> 'messages' -> 0 ->> 'de_l_administration')::boolean = false
                     and jsonb_array_length(:'fil'::jsonb -> 'autres') = 2,
                     'fil : auteur, course et chauffeur, message de l''auteur, 2 autres demandes de Claire');
select test.verifier(jsonb_array_length(:'fil'::jsonb -> 'conversation') = 1
                     and :'fil'::jsonb -> 'conversation' -> 0 ->> 'auteur_role' = 'client'
                     and :'fil'::jsonb -> 'conversation' -> 0 ->> 'contenu' like 'Je suis devant%',
                     'fil : conversation entre le client et le chauffeur pendant la course (lecture)');
select test.verifier((select lu_le is not null from public.messages where demande_id = :'d_paiement'),
                     'fil ouvert : le message de l''auteur passe « lu »');
select test.verifier((select (x ->> 'non_lus')::int from jsonb_array_elements(public.admin_lister_demandes() -> 'lignes') x
                      where x ->> 'id' = :'d_paiement') = 0,
                     'file : plus aucun message non lu sur cette demande');
select test.doit_echouer(format('select public.admin_fil_demande(%L)', gen_random_uuid()), 'Demande introuvable');


-- #############################################################################
-- 4. RÉPONSE, STATUTS, ATTRIBUTION
-- #############################################################################
select public.admin_repondre_demande(:'d_paiement', 'Bonjour, nous vérifions avec la banque et revenons vers vous.');
select test.verifier((select statut = 'en_cours' and assignee_a = :'admin' and cloturee_le is null from public.demandes where id = :'d_paiement'),
                     'réponse : demande « en cours », attribuée à qui répond');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications
                             where titre = 'Réponse du support' and message like '%Double débit ? : Bonjour, nous vérifions%'),
                     'auteur prévenu de la réponse dans l''application');
select test.verifier((select count(*) from public.messages where demande_id = :'d_paiement') = 2, 'auteur : lit la réponse dans son fil');
insert into public.messages (demande_id, auteur_id, contenu) values (:'d_paiement', auth.uid(), 'Merci, j''attends votre retour.');
call test.connexion(:'admin', 'aal2');
select test.verifier((select (x ->> 'attente')::boolean from jsonb_array_elements(public.admin_lister_demandes() -> 'lignes') x
                      where x ->> 'id' = :'d_paiement'),
                     'l''auteur a répondu : il attend de nouveau');
select test.doit_echouer(format('select public.admin_repondre_demande(%L, %L)', :'d_paiement', '   '), 'Écrivez la réponse');
select test.doit_echouer(format('select public.admin_repondre_demande(%L, %L, false, %L)', :'d_paiement', 'Voir la pièce', 'autre/fichier.pdf'),
                         'Chemin de la pièce jointe invalide');
insert into storage.objects (bucket_id, name, owner) values ('support', :'d_paiement' || '/justificatif.pdf', auth.uid());
select public.admin_repondre_demande(:'d_paiement', 'Voici le justificatif du remboursement du second débit.', true,
                                     :'d_paiement' || '/justificatif.pdf');
select test.verifier((select statut = 'resolue' and cloturee_le is not null from public.demandes where id = :'d_paiement')
                     and (select piece_jointe_chemin from public.messages where demande_id = :'d_paiement' order by cree_le desc, id desc limit 1)
                         = :'d_paiement' || '/justificatif.pdf',
                     'réponse avec pièce jointe et résolution d''un coup : date de clôture posée');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Réponse du support' and message like '%justificatif%(demande résolue)'),
                     'auteur prévenu : réponse et résolution');
select test.doit_echouer(format('insert into public.messages (demande_id, auteur_id, contenu) values (%L, auth.uid(), %L)', :'d_paiement', 'Encore'),
                         'row-level security');

call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_statut_demande(%L, %L)', :'d_paiement', 'resolue'), 'déjà ce statut');
select public.admin_statut_demande(:'d_paiement', 'en_cours');
select test.verifier((select statut = 'en_cours' and cloturee_le is null from public.demandes where id = :'d_paiement'),
                     'demande rouverte : date de clôture retirée');
select test.doit_echouer(format('select public.admin_statut_demande(%L, %L)', :'d_compte', 'fermee'), 'Indiquez pourquoi');
select public.admin_statut_demande(:'d_compte', 'fermee', 'Le RIB se change dans l''espace chauffeur, rubrique Compte.');
select test.verifier((select statut = 'fermee' and cloturee_le is not null from public.demandes where id = :'d_compte')
                     and exists (select 1 from public.messages where demande_id = :'d_compte' and auteur_id = :'admin' and contenu like 'Le RIB%'),
                     'fermée sans suite : motif ajouté au fil');
call test.connexion(:'chauffeur1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Demande fermée' and message like '%Changer mon RIB : Le RIB se change%'),
                     'auteur prévenu de la fermeture, avec le motif');

call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_attribuer_demande(%L, %L)', :'d_lunettes', :'chauffeur1'), 'administrateur actif');
select public.admin_definir_role(:'client2', 'admin');
select public.admin_attribuer_demande(:'d_lunettes', :'client2');
select test.verifier((select assignee_a = :'client2' from public.demandes where id = :'d_lunettes'), 'demande attribuée à un autre administrateur');
select test.doit_echouer(format('select public.admin_attribuer_demande(%L, %L)', :'d_lunettes', :'client2'), 'Rien à changer');
select test.verifier((public.admin_lister_demandes('a_moi') ->> 'total')::int = 1 and (public.admin_lister_demandes('non_attribuees') ->> 'total')::int = 0,
                     'files « attribuées à moi » (1) et « non attribuées » (0)');
call test.connexion(:'client2');
select test.verifier(exists (select 1 from public.notifications where titre = 'Demande au support à traiter'
                             and lien = '/admin/support/?demande=' || :'d_lunettes'),
                     'administrateur désigné prévenu, avec le lien vers la demande');
call test.connexion(:'admin', 'aal2');
select public.admin_attribuer_demande(:'d_lunettes', null);
select public.admin_definir_role(:'client2', 'client');
select test.verifier((select assignee_a is null from public.demandes where id = :'d_lunettes'), 'attribution retirée');

-- Demande enregistrée pour le compte d'un client (appel téléphonique)
select test.doit_echouer(format('select public.admin_creer_demande(%L, %L, %L, %L, %L)', :'clienttel', 'course', 'Retard', 'Appel du client', :'numero_c1'),
                         'n''est pas une course de');
select test.doit_echouer(format('select public.admin_creer_demande(%L, %L, %L, %L)', :'admin', 'autre', 'Essai', 'Essai'), 'client ou le chauffeur');
select test.doit_echouer(format('select public.admin_creer_demande(%L, %L, %L, %L, %L)', :'clienttel', 'course', 'Retard', 'Appel', 'C-2026-999999'),
                         'introuvable');
select public.admin_creer_demande(:'clienttel', 'autre', 'Facture à renvoyer',
                                  'Appel : le client souhaite recevoir sa dernière facture par e-mail.') as creee \gset
select test.verifier((select statut = 'en_cours' and assignee_a = :'admin' and auteur_id = :'clienttel' and numero like 'S-%'
                      from public.demandes where id = (:'creee'::jsonb ->> 'id')::uuid)
                     and (select count(*) = 1 from public.messages where demande_id = (:'creee'::jsonb ->> 'id')::uuid and auteur_id = :'admin'),
                     'demande enregistrée pour un client : en cours, à mon nom, première note de l''administration');
select test.verifier((public.admin_fil_demande((:'creee'::jsonb ->> 'id')::uuid) -> 'messages' -> 0 ->> 'de_l_administration')::boolean,
                     'fil : la note de l''appel est marquée « administration »');
call test.connexion(:'clienttel');
select test.verifier(exists (select 1 from public.notifications where titre = 'Demande enregistrée' and message like '%Facture à renvoyer%')
                     and (select count(*) from public.demandes) = 1,
                     'client prévenu ; il voit la demande enregistrée pour lui');


-- #############################################################################
-- 5. OBJETS TROUVÉS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select test.verifier(exists (select 1 from jsonb_array_elements(public.admin_lister_objets() -> 'demandes_objet_perdu') x
                             where x ->> 'id' = :'d_lunettes' and x -> 'course' ->> 'numero' = :'numero_c1'),
                     'registre : la demande « objet perdu » de Claire attend son objet');
select test.doit_echouer(format('select public.admin_enregistrer_objet(null, %L, %L, null)', 'C-2026-999999', 'Lunettes de vue'), 'introuvable');
select test.doit_echouer(format('select public.admin_enregistrer_objet(null, %L, %L, null, %L)', :'numero_c1', 'Lunettes de vue', :'aujourdhui'::date + 1),
                         'dans le futur');
select test.doit_echouer(format('select public.admin_enregistrer_objet(null, %L, %L, null, %L)', :'numero_c1', 'Lunettes de vue', :'jour_c1'::date - 1),
                         'avant la course');
select test.doit_echouer(format('select public.admin_enregistrer_objet(null, null, %L, null)', 'ab'), 'Décrivez l''objet');
select public.admin_enregistrer_objet(null, ' ' || lower(:'numero_c1') || ' ', 'Lunettes de vue, étui bleu', 'Bureau, armoire 2', null, :'d_lunettes') as objet1 \gset
select :'objet1'::jsonb ->> 'id' as o1 \gset
select test.verifier(:'objet1'::jsonb ->> 'numero' like 'OT-%-000001' and :'objet1'::jsonb ->> 'statut' = 'trouve'
                     and :'objet1'::jsonb ->> 'course_id' = :'course1' and :'objet1'::jsonb ->> 'demande_id' = :'d_lunettes'
                     and (:'objet1'::jsonb ->> 'trouve_le')::date = :'aujourdhui'::date and :'objet1'::jsonb ->> 'declare_par' = :'admin',
                     'objet déclaré : numéro du registre, course retrouvée par son numéro (minuscules, espaces), demande rattachée, date du jour');
select test.doit_echouer(format('select public.admin_enregistrer_objet(null, null, %L, null, null, %L)', 'Parapluie noir', :'d_lunettes'), 'déjà rattaché');
select public.admin_lister_objets() as registre \gset
select test.verifier(jsonb_array_length(:'registre'::jsonb -> 'lignes') = 1
                     and (:'registre'::jsonb -> 'compteurs' ->> 'a_prevenir')::int = 1
                     and :'registre'::jsonb -> 'lignes' -> 0 -> 'course' ->> 'client' = 'Claire Durand'
                     and :'registre'::jsonb -> 'lignes' -> 0 -> 'course' ->> 'client_telephone' = '+33611111111'
                     and :'registre'::jsonb -> 'lignes' -> 0 -> 'demande' ->> 'id' = :'d_lunettes'
                     and jsonb_array_length(:'registre'::jsonb -> 'demandes_objet_perdu') = 0,
                     'registre : l''objet, son client et sa demande ; plus de demande à rapprocher');

select public.admin_statut_objet(:'o1', 'signale');
select test.verifier((select statut = 'signale' and client_prevenu_le is not null from public.objets_trouves where id = :'o1')
                     and (select statut = 'en_cours' and assignee_a = :'admin' from public.demandes where id = :'d_lunettes')
                     and exists (select 1 from public.messages where demande_id = :'d_lunettes' and contenu like 'Votre objet a été retrouvé (référence OT-%'),
                     'client prévenu : réponse dans le fil de sa demande, qui passe « en cours »');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Objet trouvé'
                             and message like '%après votre course ' || :'numero_c1' || ' du %Lunettes de vue, étui bleu%référence OT-%'),
                     'client prévenu dans l''application : course, objet, référence');
select test.verifier((select count(*) from public.objets_trouves) = 1, 'le client voit l''objet trouvé après sa course');
select test.doit_echouer($$update public.objets_trouves set statut = 'rendu'$$, 'permission denied');

call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_statut_objet(%L, %L)', :'o1', 'rendu'), 'comment l''objet a été rendu');
select public.admin_statut_objet(:'o1', 'rendu', 'Remis en main propre au bureau le ' || to_char(:'aujourdhui'::date, 'DD/MM/YYYY') || '.');
select test.verifier((select statut = 'rendu' and restitution like 'Remis en main propre%' from public.objets_trouves where id = :'o1')
                     and jsonb_array_length(public.admin_lister_objets('clos') -> 'lignes') = 1
                     and jsonb_array_length(public.admin_lister_objets('en_cours') -> 'lignes') = 0,
                     'objet rendu : restitution notée, il passe dans « clos »');
select test.verifier((public.admin_lister_objets('tous', 'étui bleu') -> 'lignes' -> 0 ->> 'id') = :'o1'
                     and jsonb_array_length(public.admin_lister_objets('tous', 'introuvable') -> 'lignes') = 0,
                     'registre : recherche dans la description');

-- Objet sans course connue : personne à prévenir dans l'application
select public.admin_enregistrer_objet(null, null, 'Écharpe grise en laine', 'Coffre de la Toyota', null, null) ->> 'id' as o2 \gset
select test.verifier((select numero from public.objets_trouves where id = :'o2') like 'OT-%-000002', 'registre : numéros consécutifs');
select test.doit_echouer(format('select public.admin_statut_objet(%L, %L)', :'o2', 'signale'), 'Aucun client à prévenir');
select test.doit_echouer(format('select public.admin_statut_objet(%L, %L, %L)', :'o2', 'detruit', 'x'), 'pourquoi l''objet n''est pas rendu');
select public.admin_statut_objet(:'o2', 'detruit', 'Remise au service des objets trouvés de la mairie.');
select public.admin_statut_objet(:'o2', 'trouve');
select test.verifier((select statut = 'trouve' and restitution is null from public.objets_trouves where id = :'o2'),
                     'objet rouvert (correction) : restitution effacée');
select public.admin_enregistrer_objet(:'o2', :'numero_c1', 'Écharpe grise en laine', 'Bureau, armoire 2', null, null);
select test.verifier((select course_id = :'course1' and lieu_stockage = 'Bureau, armoire 2' from public.objets_trouves where id = :'o2'),
                     'objet corrigé : course rattachée, lieu changé');
delete from public.objets_trouves where id = :'o2';
select test.verifier(not exists (select 1 from public.objets_trouves where id = :'o2'), 'erreur de saisie supprimée par l''administration');


-- #############################################################################
-- 6. MESSAGES DU SITE : CONTACT ET DEVIS
-- #############################################################################
select public.admin_lister_messages_site() as site \gset
select :'site'::jsonb -> 'contacts' -> 0 ->> 'id' as contact1, :'site'::jsonb -> 'devis' -> 0 ->> 'id' as devis1 \gset
select test.verifier(jsonb_array_length(:'site'::jsonb -> 'contacts') = 1 and jsonb_array_length(:'site'::jsonb -> 'devis') = 1
                     and (:'site'::jsonb -> 'compteurs' ->> 'contacts_a_traiter')::int = 1
                     and (:'site'::jsonb -> 'compteurs' ->> 'devis_nouveaux')::int = 1,
                     'messages du site à traiter : le message de contact et la demande de devis du visiteur');
select test.verifier(jsonb_array_length(public.admin_lister_messages_site('tous', 'jean@exemple') -> 'contacts') = 1
                     and jsonb_array_length(public.admin_lister_messages_site('tous', 'Lille') -> 'devis') = 1
                     and jsonb_array_length(public.admin_lister_messages_site('tous', 'Lille') -> 'contacts') = 0,
                     'recherche : e-mail, texte de la demande');
select public.admin_traiter_contact(:'contact1', true, 'Rappelé, tarifs envoyés par e-mail.');
select test.verifier((select traite and traite_par = :'admin' and traite_le is not null and note like 'Rappelé%'
                      from public.messages_contact where id = :'contact1'),
                     'message de contact traité : par qui, quand, note');
select test.verifier(jsonb_array_length(public.admin_lister_messages_site('a_traiter') -> 'contacts') = 0
                     and jsonb_array_length(public.admin_lister_messages_site('traites') -> 'contacts') = 1,
                     'il quitte « à traiter » pour « traités »');
select public.admin_traiter_contact(:'contact1', false, null);
select test.verifier((select not traite and traite_par is null and traite_le is null and note like 'Rappelé%'
                      from public.messages_contact where id = :'contact1'),
                     'à reprendre : la note reste');
select public.admin_traiter_contact(:'contact1', true, null);

select test.doit_echouer(format('select public.admin_suivre_devis(%L, %L)', :'devis1', 'devis_envoye'), 'montant du devis');
select test.doit_echouer(format('select public.admin_suivre_devis(%L, %L)', :'devis1', 'acceptee'), 'montant du devis');
select public.admin_suivre_devis(:'devis1', 'devis_envoye', 480, 'Devis envoyé par e-mail.');
select test.verifier((select statut = 'devis_envoye' and montant = 480 and devis_envoye_le is not null and traite_par = :'admin'
                      from public.demandes_devis where id = :'devis1'),
                     'devis envoyé : montant, date d''envoi, suivi par');
select test.verifier((public.admin_lister_messages_site('en_attente') -> 'compteurs' ->> 'devis_envoyes')::int = 1
                     and jsonb_array_length(public.admin_lister_messages_site('en_attente') -> 'devis') = 1,
                     'devis en attente de la réponse du client');
select public.admin_suivre_devis(:'devis1', 'acceptee');
select test.verifier((select statut = 'acceptee' and montant = 480 and note = 'Devis envoyé par e-mail.' from public.demandes_devis where id = :'devis1'),
                     'devis accepté : montant et note gardés');
select public.admin_suivre_devis(:'devis1', 'nouvelle');
select test.verifier((select statut = 'nouvelle' and montant is null and devis_envoye_le is null from public.demandes_devis where id = :'devis1'),
                     'revenu à « nouvelle » (correction) : montant retiré');


-- #############################################################################
-- 7. FICHE DE LA COURSE, JOURNAL, DROITS
-- #############################################################################
select public.admin_fiche_course(:'course1') as fiche \gset
select test.verifier(jsonb_array_length(:'fiche'::jsonb -> 'demandes') = 3
                     and jsonb_array_length(:'fiche'::jsonb -> 'objets') = 1
                     and :'fiche'::jsonb -> 'objets' -> 0 ->> 'statut' = 'rendu'
                     and jsonb_array_length(:'fiche'::jsonb -> 'conversation') = 1,
                     'fiche de la course : ses 3 demandes, l''objet rendu, la conversation');

call test.systeme();
select test.verifier(exists (select 1 from prive.journal where table_cible = 'demandes' and ligne_id = :'d_compte'
                             and action = 'UPDATE' and apres ->> 'statut' = 'fermee')
                     and exists (select 1 from prive.journal where table_cible = 'objets_trouves' and ligne_id = :'o2' and action = 'DELETE')
                     and exists (select 1 from prive.journal where table_cible = 'objets_trouves' and ligne_id = :'o1' and action = 'INSERT')
                     and exists (select 1 from prive.journal where table_cible = 'messages_contact' and ligne_id = :'contact1' and action = 'UPDATE')
                     and exists (select 1 from prive.journal where table_cible = 'demandes_devis' and ligne_id = :'devis1' and action = 'UPDATE'),
                     'journal : statuts des demandes, objets trouvés, messages du site');
select test.verifier(not has_function_privilege('anon', 'public.admin_lister_demandes(text, text, text, integer, integer)', 'execute')
                     and not has_function_privilege('anon', 'public.admin_lister_objets(text, text)', 'execute')
                     and not has_function_privilege('anon', 'public.admin_lister_messages_site(text, text)', 'execute')
                     and has_function_privilege('authenticated', 'public.admin_repondre_demande(uuid, text, boolean, text)', 'execute')
                     and not has_function_privilege('authenticated', 'prive.dater_cloture_demande()', 'execute'),
                     'fonctions du module : fermées aux visiteurs, ouvertes une fois connecté (contrôle dans la fonction)');
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables restent protégées ligne par ligne');

\o
\echo '✔ Support : tout est conforme.'
