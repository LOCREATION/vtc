-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Pourboire en fin de course (migration 26), joué après
-- 24_parrainage_client.sql sur les mêmes comptes fictifs :
--   - Claire laisse un pourboire en espèces à Paul : contrôles (course d'un
--     autre client, course pas encore terminée, montant hors de 0,50 € à
--     100 €, deuxième pourboire), paiement à part, facture inchangée, Paul
--     prévenu (« Pourboire en espèces », lien vers la course) et confirmation
--     de l'encaissement par Paul, lue par Claire ;
--   - par carte au terminal : refusé après 30 minutes, accepté avant (« Pourboire
--     par carte ») ; course payée par le solde : refusé ;
--   - sur facture mensuelle (compte professionnel) : refusé après 24 heures ou
--     sans heure de fin, accepté avant (« Pourboire reçu », lien des revenus) ;
--     encaissé par l'administration seulement.
-- Tout se joue dans une transaction annulée à la fin : la base revient à son
-- état de départ (courses, paiements, factures, compteurs, notifications).
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
select count(*) as courses_avant, (select count(*) from public.paiements) as paiements_avant,
       (select count(*) from public.notifications) as notifications_avant,
       (select coalesce(sum(valeur), 0) from prive.compteurs) as compteurs_avant
from public.courses \gset
select cp.id as compte from public.comptes_pro cp
join public.comptes_pro_membres m on m.compte_pro_id = cp.id
where m.profil_id = :'client1' and cp.statut = 'actif' limit 1 \gset

begin;

-- Course immédiate de Claire, assurée par Paul (étapes passées par
-- l'administration) jusqu'à « Client à bord » ; « terminer » la termine.
create procedure test.course_a_bord(p_mode text, p_compte uuid, inout course uuid)
language plpgsql
as $$
begin
  call test.connexion('c0000000-0000-4000-8000-000000000001');
  select c.id into course from public.commander_course(
    'berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800, 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
    p_mode_paiement => p_mode, p_compte_pro => p_compte) c;
  call test.connexion('a0000000-0000-4000-8000-000000000001', 'aal2');
  perform public.attribuer_course(course, 'd0000000-0000-4000-8000-000000000001');
  perform public.avancer_course(course, 'arrivee');
  perform public.avancer_course(course, 'a_bord');
end;
$$;
create procedure test.terminer(p_course uuid)
language plpgsql
as $$
begin
  call test.connexion('a0000000-0000-4000-8000-000000000001', 'aal2');
  perform public.avancer_course(p_course, 'terminee');
end;
$$;


-- #############################################################################
-- 1. EN ESPÈCES : CONTRÔLES, PAIEMENT À PART, CHAUFFEUR PRÉVENU, ENCAISSEMENT
-- #############################################################################
call test.course_a_bord('especes', null, null) \gset a_
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 5)', :'a_course'), 'une fois la course terminée');
call test.terminer(:'a_course');
select numero as a_numero from public.courses where id = :'a_course' \gset

call test.connexion(:'client2');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 5)', :'a_course'), 'Course introuvable');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 5)', :'a_course'), 'Course introuvable');
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 0.49)', :'a_course'), 'de 0,50 € à 100 €');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 100.01)', :'a_course'), 'de 0,50 € à 100 €');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, null)', :'a_course'), 'de 0,50 € à 100 €');
select test.verifier((select pourboire from public.ajouter_pourboire(:'a_course', 5)) = 5.00,
                     'espèces : pourboire de 5,00 € enregistré sur la course');
select test.verifier((select count(*) from public.paiements where course_id = :'a_course' and nature = 'pourboire'
                        and mode = 'especes' and montant = 5.00 and statut = 'a_encaisser') = 1
                     and (select pourboire from public.factures where course_id = :'a_course' and nature = 'course') = 0,
                     'espèces : paiement « pourboire » à part, à encaisser ; la facture de la course reste inchangée');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 2)', :'a_course'), 'déjà laissé un pourboire');

call test.systeme();
select test.verifier((select count(*) from public.notifications
                       where destinataire_id = :'chauffeur1' and type = 'paiement' and titre = 'Pourboire en espèces'
                         and message = '5,00 € pour la course ' || :'a_numero'
                                       || ' : le client vous le remet en espèces. Confirmez-le dans la course une fois reçu.'
                         and lien = '/chauffeur/course/?id=' || :'a_course') = 1,
                     'espèces : Paul prévenu (« Pourboire en espèces », à recevoir du client, lien vers la course)');
select id as pourboire_a from public.paiements where course_id = :'a_course' and nature = 'pourboire' \gset
call test.connexion(:'chauffeur1');
select test.verifier((select count(*) from public.paiements where course_id = :'a_course') = 2,
                     'chauffeur : voit le paiement de la course et celui du pourboire');
select public.confirmer_encaissement(:'pourboire_a');
call test.connexion(:'client1');
select test.verifier((select statut = 'encaisse' and encaisse_le is not null from public.paiements where id = :'pourboire_a'),
                     'espèces : Paul confirme l''avoir reçu ; Claire lit son pourboire « encaissé »');
call test.systeme();
select test.verifier((select especes_chauffeur_id = :'chauffeur1' from public.paiements where id = :'pourboire_a'),
                     'espèces : le pourboire reste à Paul (espèces gardées par le chauffeur)');


-- #############################################################################
-- 2. PAR CARTE AU TERMINAL : 30 MINUTES ; PAR LE SOLDE : REFUSÉ
-- #############################################################################
call test.course_a_bord('carte', null, null) \gset b_
call test.terminer(:'b_course');
select numero as b_numero from public.courses where id = :'b_course' \gset
call test.systeme();
update public.courses set mode_paiement = 'solde' where id = :'b_course';
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 2)', :'b_course'), 'par le solde arrive dans une prochaine version');
call test.systeme();
update public.courses set mode_paiement = 'carte', terminee_le = now() - interval '31 minutes' where id = :'b_course';
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 2)', :'b_course'),
                         'en espèces ou par carte se donne à votre chauffeur dans les 30 minutes qui suivent la course');
call test.systeme();
update public.courses set terminee_le = now() - interval '29 minutes' where id = :'b_course';
call test.connexion(:'client1');
select test.verifier((select pourboire from public.ajouter_pourboire(:'b_course', 2)) = 2.00,
                     'carte : accepté 29 minutes après la fin (refusé à 31 minutes)');
call test.systeme();
select test.verifier((select count(*) from public.paiements where course_id = :'b_course' and nature = 'pourboire'
                        and mode = 'carte' and montant = 2.00 and statut = 'a_encaisser') = 1
                     and (select count(*) from public.notifications
                           where destinataire_id = :'chauffeur1' and titre = 'Pourboire par carte'
                             and message = '2,00 € pour la course ' || :'b_numero'
                                           || ' : à encaisser sur votre terminal. Confirmez-le dans la course une fois encaissé.'
                             and lien = '/chauffeur/course/?id=' || :'b_course') = 1,
                     'carte : paiement à encaisser au terminal ; Paul prévenu (« Pourboire par carte », lien vers la course)');


-- #############################################################################
-- 3. SUR FACTURE MENSUELLE : 24 HEURES, ENCAISSÉ PAR L'ADMINISTRATION
-- #############################################################################
call test.course_a_bord('facture_mensuelle', :'compte', null) \gset c_
call test.terminer(:'c_course');
select numero as c_numero from public.courses where id = :'c_course' \gset
call test.systeme();
update public.courses set terminee_le = now() - interval '25 hours' where id = :'c_course';
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 3.5)', :'c_course'), 'dans les 24 heures qui suivent la course');
call test.systeme();
update public.courses set terminee_le = null where id = :'c_course';
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 3.5)', :'c_course'), 'dans les 24 heures qui suivent la course');
call test.systeme();
update public.courses set terminee_le = now() - interval '23 hours' where id = :'c_course';
call test.connexion(:'client1');
select test.verifier((select pourboire from public.ajouter_pourboire(:'c_course', 3.499)) = 3.50,
                     'facture mensuelle : accepté 23 heures après la fin, montant arrondi au centime (refusé à 25 heures et sans heure de fin)');
call test.systeme();
select id as pourboire_c from public.paiements where course_id = :'c_course' and nature = 'pourboire' \gset
select test.verifier((select mode = 'facture_mensuelle' and montant = 3.50 and statut = 'a_encaisser'
                        from public.paiements where id = :'pourboire_c')
                     and (select count(*) from public.notifications
                           where destinataire_id = :'chauffeur1' and titre = 'Pourboire reçu'
                             and message = '3,50 € pour la course ' || :'c_numero' || ', sur la facture mensuelle de l''entreprise. Merci !'
                             and lien = '/chauffeur/revenus/') = 1,
                     'facture mensuelle : paiement sur le relevé ; Paul prévenu (« Pourboire reçu », lien de ses revenus)');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.confirmer_encaissement(%L)', :'pourboire_c'), 'encaissés par l''administration');


-- #############################################################################
-- 4. RETOUR À L'ÉTAT DE DÉPART
-- #############################################################################
rollback;
call test.systeme();
select test.verifier((select count(*) from public.courses) = :courses_avant
                     and (select count(*) from public.paiements) = :paiements_avant
                     and (select count(*) from public.notifications) = :notifications_avant
                     and (select coalesce(sum(valeur), 0) from prive.compteurs) = :compteurs_avant
                     and to_regprocedure('test.course_a_bord(text, uuid, uuid)') is null,
                     'pourboire : retour à l''état de départ (courses, paiements, compteurs, notifications)');

\o
\echo '✔ Pourboire en fin de course : tout est conforme.'
