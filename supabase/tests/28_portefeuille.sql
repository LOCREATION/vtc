-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Portefeuille, recharges Mollie et virement (migration 30), joué après
-- 27_suppressions_admin.sql sur les comptes fictifs :
--   1. droits : visiteur, client, administration, clé de service ;
--   2. recharge : montant de 5 € à 500 €, paiement Mollie rattaché, état lu
--      chez Mollie (paiement d'une autre recharge, autre mode, montant ou
--      devise différents, état inconnu : refusés), crédit unique, échec,
--      annulation, expiration, rattachement au premier avis, garde-fou des
--      5 recharges en attente, compte suspendu ;
--   3. courses payées par le portefeuille : disponible à la commande (deux
--      commandes ne comptent pas deux fois le même argent), prélèvement à la
--      fin, reste dû quand le solde ne suffit plus (frais d'attente), prélevé
--      à la recharge suivante ; pourboire dans le disponible ; frais
--      d'annulation prélevés ; remboursement recrédité au portefeuille ;
--   4. virement : proposé seulement avec l'IBAN et le BIC de l'entreprise,
--      rien à encaisser pour le chauffeur, enregistré par l'administration ;
--   5. administration : tableau de bord, Finances (synthèse, listes,
--      Portefeuilles), suppression d'une recharge sans suite ;
--   6. données personnelles et suppression de compte.
-- Tout se joue dans une transaction annulée à la fin : la base revient à son
-- état de départ. Le moindre écart arrête le script avec « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set chauffeur1 d0000000-0000-4000-8000-000000000001

call test.systeme();
select (select count(*) from public.recharges) as recharges_avant,
       (select count(*) from public.courses) as courses_avant,
       (select count(*) from public.paiements) as paiements_avant,
       (select count(*) from public.notifications) as notifications_avant,
       (select coalesce(sum(montant), 0) from public.soldes) as soldes_avant,
       (select coalesce(sum(valeur), 0) from prive.compteurs) as compteurs_avant \gset

begin;

-- Solde d'un compte fixé à un montant exact (écriture d'ajustement)
create procedure test.pf_solde(p_client uuid, p_montant numeric)
language plpgsql
as $$
declare
  v numeric;
begin
  call test.systeme();
  insert into public.soldes (profil_id) values (p_client) on conflict (profil_id) do nothing;
  select s.montant into v from public.soldes s where s.profil_id = p_client;
  if p_montant <> v then
    perform prive.ecrire_solde(p_client, p_montant - v, 'Essai : solde fixé', null);
  end if;
end;
$$;

-- Course de Claire (trajet des essais), immédiate ou demain à 10 h
create procedure test.pf_commander(p_mode text, p_type text, inout course uuid)
language plpgsql
as $$
begin
  call test.connexion('c0000000-0000-4000-8000-000000000001');
  select c.id into course from public.commander_course(
    'berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800, 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
    p_type => p_type,
    p_quand => case when p_type = 'planifiee' then date_trunc('day', now()) + interval '1 day 10 hours' end,
    p_mode_paiement => p_mode) c;
end;
$$;

-- Paul prend la course, arrive, client à bord (étapes passées par l'administration)
create procedure test.pf_a_bord(p_course uuid)
language plpgsql
as $$
begin
  call test.connexion('a0000000-0000-4000-8000-000000000001', 'aal2');
  perform public.attribuer_course(p_course, 'd0000000-0000-4000-8000-000000000001');
  perform public.avancer_course(p_course, 'arrivee');
  perform public.avancer_course(p_course, 'a_bord');
end;
$$;

create procedure test.pf_terminer(p_course uuid)
language plpgsql
as $$
begin
  call test.connexion('a0000000-0000-4000-8000-000000000001', 'aal2');
  perform public.avancer_course(p_course, 'terminee');
end;
$$;

-- Avis Mollie (ce que rapporte la fonction du serveur, clé de service)
create procedure test.pf_mollie(p_recharge uuid, p_id text, p_statut text, p_montant numeric default null, inout etat jsonb default null)
language plpgsql
as $$
begin
  call test.systeme();
  select public.recharge_mollie_etat(p_recharge, p_id, p_statut, 'test',
           coalesce(p_montant, (select r.montant from public.recharges r where r.id = p_recharge)), 'EUR', 'creditcard')
    into etat;
end;
$$;

-- Prix du trajet des essais, maintenant et demain à 10 h
call test.connexion(:'client1');
select (public.estimer_course('berline_hybride', 48.8590, 2.3800, 48.8809, 2.3553) ->> 'prix_total')::numeric as prix_imm,
       (public.estimer_course('berline_hybride', 48.8590, 2.3800, 48.8809, 2.3553,
          p_quand => date_trunc('day', now()) + interval '1 day 10 hours', p_type => 'planifiee') ->> 'prix_total')::numeric as prix_plan \gset
select test.verifier(:prix_imm > 5 and :prix_plan > 5, 'prix du trajet des essais connus (immédiat et réservé)');


-- #############################################################################
-- 1. DROITS
-- #############################################################################
call test.visiteur();
select test.doit_echouer('select public.mon_portefeuille()', 'permission denied');
select test.doit_echouer('select public.recharge_demander(20)', 'permission denied');
select test.doit_echouer(format('select public.ma_recharge(%L)', gen_random_uuid()), 'permission denied');
select test.doit_echouer('select count(*) from public.recharges', 'permission denied');

call test.connexion(:'client1');
select test.doit_echouer(format('select public.recharge_mollie_ouverte(%L, %L, %L)', gen_random_uuid(), 'tr_essai00001', 'test'),
                         'permission denied');
select test.doit_echouer(format('select public.recharge_mollie_etat(%L, %L, %L, %L, 20, %L)', gen_random_uuid(), 'tr_essai00001', 'paid', 'test', 'EUR'),
                         'permission denied');
select test.doit_echouer(format('insert into public.recharges (numero, client_id, montant) values (%L, %L, 20)', 'R-2026-999999', :'client1'),
                         'permission denied');
select test.doit_echouer('select public.admin_paiements_resume()', 'Réservé à l''administration');
select test.doit_echouer($$select public.admin_portefeuilles(current_date, current_date)$$, 'Réservé à l''administration');
select test.doit_echouer(format('select public.admin_supprimer_recharge(%L)', gen_random_uuid()), 'Réservé à l''administration');

call test.systeme();
select test.verifier(has_function_privilege('service_role', 'public.recharge_mollie_etat(uuid, text, text, text, numeric, text, text)', 'execute')
                     and has_function_privilege('service_role', 'public.recharge_mollie_ouverte(uuid, text, text)', 'execute')
                     and not has_function_privilege('authenticated', 'public.recharge_mollie_etat(uuid, text, text, text, numeric, text, text)', 'execute')
                     and not has_function_privilege('anon', 'public.recharge_mollie_ouverte(uuid, text, text)', 'execute')
                     and not has_function_privilege('authenticated', 'prive.payer_par_portefeuille(public.courses, text, numeric)', 'execute'),
                     'fonctions Mollie : clé de service seulement ; fonctions internes fermées');
select test.verifier(not has_table_privilege('authenticated', 'public.recharges', 'insert')
                     and not has_table_privilege('authenticated', 'public.recharges', 'update')
                     and not has_table_privilege('authenticated', 'public.recharges', 'delete')
                     and has_table_privilege('authenticated', 'public.recharges', 'select'),
                     'recharges : lecture seule pour les comptes, aucune écriture directe');


-- #############################################################################
-- 2. RECHARGE PAR MOLLIE
-- #############################################################################
call test.pf_solde(:'client1', 0);
call test.connexion(:'client1');
select test.doit_echouer('select public.recharge_demander(4.99)', 'de 5 € à 500 €');
select test.doit_echouer('select public.recharge_demander(500.01)', 'de 5 € à 500 €');
select test.doit_echouer('select public.recharge_demander(null)', 'de 5 € à 500 €');
select (r ->> 'id')::uuid as r1, r ->> 'numero' as r1_numero from public.recharge_demander(20) r \gset
select test.verifier(:'r1_numero' ~ '^R-[0-9]{4}-[0-9]{6}$'
                     and (select statut = 'creee' and montant = 20 and client_id = :'client1' and mollie_id is null
                          from public.recharges where id = :'r1'),
                     'recharge demandée : numérotée R-AAAA-000001, « créée », à son nom');
select test.verifier((public.mon_portefeuille() -> 'recharges') = '[]'::jsonb
                     and (public.mon_portefeuille() ->> 'solde')::numeric = 0
                     and (public.mon_portefeuille() ->> 'recharge_min')::numeric = 5,
                     'portefeuille : une recharge sans paiement Mollie n''apparaît pas');
call test.connexion(:'client2');
select test.doit_echouer(format('select public.ma_recharge(%L)', :'r1'), 'Recharge introuvable');
select test.verifier((select count(*) from public.recharges where id = :'r1') = 0, 'un autre client ne voit pas la recharge');

call test.systeme();
select test.doit_echouer(format('select public.recharge_mollie_ouverte(%L, %L, %L)', :'r1', 'pas_un_id', 'test'), 'Paiement Mollie invalide');
select public.recharge_mollie_ouverte(:'r1', 'tr_essai00001', 'test');
select test.doit_echouer(format('select public.recharge_mollie_ouverte(%L, %L, %L)', :'r1', 'tr_essai00002', 'test'), 'déjà rattachée');
select test.verifier((select statut = 'ouverte' and mollie_id = 'tr_essai00001' and mollie_mode = 'test' from public.recharges where id = :'r1'),
                     'paiement Mollie rattaché : recharge « ouverte »');

-- État rapporté : refusé s'il ne correspond pas exactement
select test.doit_echouer(format('select public.recharge_mollie_etat(%L, %L, %L, %L, 20, %L)', :'r1', 'tr_autre0001', 'paid', 'test', 'EUR'),
                         'n''est pas celui de la recharge');
select test.doit_echouer(format('select public.recharge_mollie_etat(%L, %L, %L, %L, 20, %L)', :'r1', 'tr_essai00001', 'paid', 'live', 'EUR'),
                         'n''est pas celui de la recharge');
select test.doit_echouer(format('select public.recharge_mollie_etat(%L, %L, %L, %L, 19.99, %L)', :'r1', 'tr_essai00001', 'paid', 'test', 'EUR'),
                         'rien n''est crédité');
select test.doit_echouer(format('select public.recharge_mollie_etat(%L, %L, %L, %L, 20, %L)', :'r1', 'tr_essai00001', 'paid', 'test', 'USD'),
                         'rien n''est crédité');
select test.doit_echouer(format('select public.recharge_mollie_etat(%L, %L, %L, %L, 20, %L)', :'r1', 'tr_essai00001', 'refunded', 'test', 'EUR'),
                         'État Mollie inconnu');
call test.pf_mollie(:'r1', 'tr_essai00001', 'open') \gset r1_
select test.verifier(:'r1_etat'::jsonb ->> 'statut' = 'ouverte'
                     and (select montant from public.soldes where profil_id = :'client1') = 0,
                     'paiement encore ouvert chez Mollie : rien n''est crédité');

-- Payée : créditée une seule fois, client prévenu
call test.pf_mollie(:'r1', 'tr_essai00001', 'paid') \gset r1_
call test.pf_mollie(:'r1', 'tr_essai00001', 'paid') \gset r1_
call test.pf_mollie(:'r1', 'tr_essai00001', 'failed') \gset r1_
select test.verifier((select statut = 'payee' and payee_le is not null and methode = 'creditcard' from public.recharges where id = :'r1')
                     and (select montant from public.soldes where profil_id = :'client1') = 20
                     and (select count(*) from public.ecritures_solde where profil_id = :'client1' and motif = 'Recharge ' || :'r1_numero' and montant = 20) = 1
                     and (:'r1_etat'::jsonb ->> 'solde')::numeric = 20,
                     'recharge payée : portefeuille crédité de 20 € une seule fois (avis répétés, échec tardif sans effet)');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications
                             where titre = 'Portefeuille rechargé' and lien = '/client/compte/#compte-solde'
                               and message = '20,00 € ajoutés à votre portefeuille (recharge ' || :'r1_numero' || '). Solde : 20,00 €.'),
                     'client prévenu : montant, numéro de la recharge, nouveau solde');
select test.verifier((public.ma_recharge(:'r1') ->> 'statut') = 'payee' and (public.ma_recharge(:'r1') ->> 'solde')::numeric = 20
                     and jsonb_array_length(public.mon_portefeuille() -> 'recharges') = 1,
                     'page de retour : la recharge payée et le nouveau solde');

-- Échec, annulation, expiration
select (r ->> 'id')::uuid as r2 from public.recharge_demander(15) r \gset
select (r ->> 'id')::uuid as r3 from public.recharge_demander(15) r \gset
select (r ->> 'id')::uuid as r4 from public.recharge_demander(15) r \gset
call test.systeme();
select public.recharge_mollie_ouverte(:'r2', 'tr_essai00002', 'test');
select public.recharge_mollie_ouverte(:'r3', 'tr_essai00003', 'test');
select public.recharge_mollie_ouverte(:'r4', 'tr_essai00004', 'test');
call test.pf_mollie(:'r2', 'tr_essai00002', 'failed') \gset x_
call test.pf_mollie(:'r3', 'tr_essai00003', 'canceled') \gset x_
call test.pf_mollie(:'r4', 'tr_essai00004', 'expired') \gset x_
select test.verifier((select string_agg(statut, ' ' order by cree_le, numero) from public.recharges where id in (:'r2', :'r3', :'r4'))
                       = 'echouee annulee expiree'
                     and (select montant from public.soldes where profil_id = :'client1') = 20,
                     'paiement échoué, annulé ou expiré : recharge close, rien n''est crédité');

-- Paiement créé chez Mollie mais lien pas enregistré : le premier avis le rattache
call test.connexion(:'client1');
select (r ->> 'id')::uuid as r5 from public.recharge_demander(5) r \gset
call test.pf_mollie(:'r5', 'tr_essai00005', 'paid') \gset x_
select test.verifier((select statut = 'payee' and mollie_id = 'tr_essai00005' from public.recharges where id = :'r5')
                     and (select montant from public.soldes where profil_id = :'client1') = 25,
                     'lien Mollie manquant : le premier avis rattache le paiement et crédite');

-- Garde-fou : 5 recharges en attente au plus par heure ; compte suspendu
call test.connexion(:'client2');
select public.recharge_demander(10) from generate_series(1, 5) \g /dev/null
select test.doit_echouer('select public.recharge_demander(10)', 'déjà 5 recharges en attente');
call test.systeme();
delete from public.recharges where client_id = :'client2';
update public.profils set statut = 'bloque' where id = :'client2';
call test.connexion(:'client2');
select test.doit_echouer('select public.recharge_demander(10)', 'compte est suspendu');
call test.systeme();
update public.profils set statut = 'actif' where id = :'client2';


-- #############################################################################
-- 3. COURSES PAYÉES PAR LE PORTEFEUILLE
-- #############################################################################

-- 3a. Disponible à la commande ; la course réserve son prix
call test.pf_solde(:'client1', :prix_imm - 0.01);
call test.connexion(:'client1');
select test.doit_echouer($$select public.commander_course('berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800,
                           'Gare du Nord, 75010 Paris', 48.8809, 2.3553, p_mode_paiement => 'solde')$$, 'Solde insuffisant');
call test.pf_solde(:'client1', :prix_imm + 3);
call test.pf_commander('solde', 'immediate', null) \gset a_
call test.connexion(:'client1');
select test.verifier((public.mon_portefeuille() ->> 'engage')::numeric = :prix_imm
                     and (public.mon_portefeuille() ->> 'disponible')::numeric = 3
                     and (public.mon_portefeuille() ->> 'solde')::numeric = :prix_imm + 3,
                     'commande payée par le portefeuille : son prix est réservé (disponible 3 €), rien n''est encore prélevé');
select test.doit_echouer($$select public.commander_course('berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800,
                           'Gare du Nord, 75010 Paris', 48.8809, 2.3553, p_type => 'planifiee',
                           p_quand => date_trunc('day', now()) + interval '1 day 10 hours', p_mode_paiement => 'solde')$$,
                         'Solde insuffisant');

-- 3b. Fin de course : prélevé, paiement encaissé, client prévenu
call test.pf_a_bord(:'a_course');
call test.pf_terminer(:'a_course');
call test.systeme();
select numero as a_numero, prix_total + frais_attente as a_total from public.courses where id = :'a_course' \gset
select test.verifier((select count(*) = 1 and bool_and(mode = 'solde' and statut = 'encaisse' and encaisse_le is not null and montant = :a_total)
                      from public.paiements where course_id = :'a_course' and nature = 'course')
                     and (select montant from public.soldes where profil_id = :'client1') = 3
                     and exists (select 1 from public.ecritures_solde where profil_id = :'client1' and motif = 'Course ' || :'a_numero'
                                 and montant = -:a_total and course_id = :'a_course')
                     and exists (select 1 from public.factures where course_id = :'a_course' and nature = 'course'),
                     'fin de course : total prélevé sur le portefeuille, paiement encaissé, facture émise');
select test.verifier(exists (select 1 from public.notifications where destinataire_id = :'client1' and titre = 'Course terminée'
                             and message like '%, payé avec votre portefeuille (solde : 3,00 €). Notez votre chauffeur%'),
                     'fin de course : le client lit le montant prélevé et son solde');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.confirmer_encaissement(%L)',
                                (select id from public.paiements where course_id = :'a_course' and nature = 'course')),
                         'déjà été traité');

-- 3c. Pourboire dans le disponible
call test.connexion(:'client1');
select test.doit_echouer(format('select public.ajouter_pourboire(%L, 5)', :'a_course'), 'Solde insuffisant pour ce pourboire');
select public.ajouter_pourboire(:'a_course', 2) \g /dev/null
call test.systeme();
select test.verifier((select mode = 'solde' and statut = 'encaisse' and montant = 2 from public.paiements
                      where course_id = :'a_course' and nature = 'pourboire')
                     and (select montant from public.soldes where profil_id = :'client1') = 1
                     and exists (select 1 from public.notifications where destinataire_id = :'chauffeur1' and titre = 'Pourboire reçu'
                                 and message = '2,00 € pour la course ' || :'a_numero' || ', payé avec le portefeuille du client. Merci !'),
                     'pourboire par le portefeuille : prélevé aussitôt, chauffeur prévenu');

-- 3d. Frais d'attente au-delà du solde : reste dû, prélevé à la recharge suivante
call test.pf_solde(:'client1', :prix_imm);
call test.pf_commander('solde', 'immediate', null) \gset b_
call test.pf_a_bord(:'b_course');
call test.systeme();
update public.courses set frais_attente = 2.50 where id = :'b_course';
call test.pf_terminer(:'b_course');
call test.systeme();
select numero as b_numero from public.courses where id = :'b_course' \gset
select id as b_dette from public.paiements where course_id = :'b_course' and nature = 'course' and statut = 'a_encaisser' \gset
select test.verifier((select string_agg(statut || ' ' || montant, ', ' order by statut desc) from public.paiements
                      where course_id = :'b_course' and nature = 'course') = 'encaisse ' || :prix_imm || ', a_encaisser 2.50'
                     and (select montant from public.soldes where profil_id = :'client1') = 0
                     and exists (select 1 from public.notifications where destinataire_id = :'client1' and titre = 'Portefeuille insuffisant'
                                 and message = 'Il manque 2,50 € sur votre portefeuille pour la course ' || :'b_numero'
                                               || ' : rechargez-le, la somme sera prélevée aussitôt.'),
                     'solde insuffisant à la fin (frais d''attente) : le solde est pris, 2,50 € restent dus, client prévenu');
call test.connexion(:'client1');
select test.verifier((public.mon_portefeuille() ->> 'du')::numeric = 2.50 and (public.mon_portefeuille() ->> 'disponible')::numeric = 0,
                     'portefeuille : reste dû affiché, rien de disponible');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.confirmer_encaissement(%L)', :'b_dette'), 'portefeuille du client : rien à encaisser');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.confirmer_encaissement(%L)', :'b_dette'), 'Solde insuffisant');
select test.verifier(jsonb_array_length(public.admin_portefeuilles(current_date, current_date) -> 'dettes') = 1,
                     'Finances > Portefeuilles : le reste dû est listé');
call test.connexion(:'client1');
select (r ->> 'id')::uuid as r6 from public.recharge_demander(10) r \gset
call test.systeme();
select public.recharge_mollie_ouverte(:'r6', 'tr_essai00006', 'test');
call test.pf_mollie(:'r6', 'tr_essai00006', 'paid') \gset x_
select test.verifier((select statut = 'encaisse' and encaisse_le is not null from public.paiements where id = :'b_dette')
                     and (select montant from public.soldes where profil_id = :'client1') = 7.50
                     and exists (select 1 from public.ecritures_solde where profil_id = :'client1'
                                 and motif = 'Course ' || :'b_numero' || ' (reste dû)' and montant = -2.50),
                     'recharge suivante : le reste dû est prélevé aussitôt (solde 7,50 €)');

-- 3e. Annulation avec frais : prélevés sur le portefeuille, la réservation libérée
call test.connexion(:'admin', 'aal2');
update public.tarifs set frais_annulation = 4.00;
call test.pf_solde(:'client1', :prix_imm + 10);
call test.pf_commander('solde', 'immediate', null) \gset c_
call test.connexion(:'admin', 'aal2');
select public.attribuer_course(:'c_course', :'chauffeur1') \g /dev/null
call test.connexion(:'client1');
select public.annuler_course(:'c_course', 'Essai') \g /dev/null
call test.systeme();
select test.verifier((select mode = 'solde' and statut = 'encaisse' and montant = 4 from public.paiements
                      where course_id = :'c_course' and nature = 'frais_annulation')
                     and (select montant from public.soldes where profil_id = :'client1') = :prix_imm + 6
                     and exists (select 1 from public.factures where course_id = :'c_course' and nature = 'frais_annulation'),
                     'annulation avec frais : 4 € prélevés sur le portefeuille, facture des frais émise');
call test.connexion(:'client1');
select test.verifier((public.mon_portefeuille() ->> 'engage')::numeric = 0
                     and (public.mon_portefeuille() ->> 'disponible')::numeric = :prix_imm + 6,
                     'course annulée : son prix n''est plus réservé');

-- 3f. Remboursement d'un paiement fait par le portefeuille : recrédité
call test.connexion(:'admin', 'aal2');
select public.rembourser((select id from public.paiements where course_id = :'a_course' and nature = 'course'), 5, 'Geste commercial')
  \g /dev/null
select test.verifier((select mode = 'solde' from public.remboursements
                      where paiement_id = (select id from public.paiements where course_id = :'a_course' and nature = 'course'))
                     and (select montant from public.soldes where profil_id = :'client1') = :prix_imm + 11
                     and exists (select 1 from public.ecritures_solde where profil_id = :'client1'
                                 and motif = 'Remboursement ' || :'a_numero' and montant = 5)
                     and exists (select 1 from public.avoirs where course_id = :'a_course'),
                     'remboursement d''un paiement par le portefeuille : 5 € recrédités, avoir émis');
call test.systeme();
select test.verifier(exists (select 1 from public.notifications where destinataire_id = :'client1' and titre = 'Remboursement'
                             and message like '5,00 € vous sont remboursés sur votre portefeuille : Geste commercial (avoir %'),
                     'remboursement : le client lit « sur votre portefeuille »');


-- #############################################################################
-- 4. VIREMENT BANCAIRE
-- #############################################################################
call test.systeme();
update public.societe set iban = null, bic = null where id = 1;
call test.connexion(:'client1');
select test.verifier(not (public.mon_portefeuille() ->> 'virement_possible')::boolean,
                     'virement : pas proposé sans les coordonnées bancaires de l''entreprise');
select test.doit_echouer($$select public.commander_course('berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800,
                           'Gare du Nord, 75010 Paris', 48.8809, 2.3553, p_mode_paiement => 'virement')$$, 'pas encore proposé');
call test.systeme();
update public.societe set iban = 'FR7630006000011234567890189', bic = 'AGRIFRPP' where id = 1;
call test.connexion(:'client1');
select test.verifier((public.mon_portefeuille() ->> 'virement_possible')::boolean, 'virement proposé une fois l''IBAN et le BIC saisis');
call test.pf_commander('virement', 'immediate', null) \gset d_
call test.pf_a_bord(:'d_course');
call test.pf_terminer(:'d_course');
call test.systeme();
select id as d_paiement from public.paiements where course_id = :'d_course' and nature = 'course' \gset
select test.verifier((select mode = 'virement' and statut = 'a_encaisser' from public.paiements where id = :'d_paiement')
                     and exists (select 1 from public.notifications where destinataire_id = :'client1' and titre = 'Course terminée'
                                 and message like '%, à régler par virement : coordonnées bancaires sur la page de la course. Notez%'),
                     'virement : la somme est à encaisser, le client sait comment régler');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.confirmer_encaissement(%L)', :'d_paiement'), 'l''administration l''enregistre à réception');
call test.connexion(:'client1');
select public.ajouter_pourboire(:'d_course', 3) \g /dev/null
call test.systeme();
select test.verifier((select mode = 'virement' and statut = 'a_encaisser' and montant = 3 from public.paiements
                      where course_id = :'d_course' and nature = 'pourboire')
                     and exists (select 1 from public.notifications where destinataire_id = :'chauffeur1' and titre = 'Pourboire reçu'
                                 and message like '3,00 € pour la course %, réglé par virement avec la course. Merci !'),
                     'virement : pourboire ajouté à la somme à virer, chauffeur prévenu');
call test.connexion(:'admin', 'aal2');
select public.confirmer_encaissement(:'d_paiement') \g /dev/null
select test.verifier((select statut = 'encaisse' and encaisse_par = :'admin' from public.paiements where id = :'d_paiement'),
                     'virement reçu : enregistré par l''administration');


-- #############################################################################
-- 5. ADMINISTRATION
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_paiements_resume() as resume \gset
select test.verifier((:'resume'::jsonb -> 'portefeuilles' ->> 'total')::numeric = (select sum(montant) from public.soldes)
                     and (:'resume'::jsonb -> 'recharges' ->> 'nb_mois')::integer >= 3
                     and (:'resume'::jsonb -> 'recharges' ->> 'mois')::numeric >= 35
                     and (:'resume'::jsonb ->> 'mode_test')::boolean
                     and (:'resume'::jsonb -> 'paye_mois' ->> 'solde')::numeric >= :prix_imm * 2 + 6
                     and (:'resume'::jsonb -> 'paye_mois' ->> 'virement')::numeric >= :prix_imm
                     and (:'resume'::jsonb -> 'a_recevoir' ->> 'virements')::numeric >= 3
                     and (:'resume'::jsonb -> 'a_recevoir' ->> 'nb_portefeuille')::integer = 0,
                     'tableau de bord : portefeuilles, recharges du mois, mode test, payé par mode, virements à recevoir');
select public.admin_finances_synthese(current_date, current_date) as synthese \gset
select test.verifier((:'synthese'::jsonb -> 'encaisse' ->> 'virement')::numeric >= :prix_imm
                     and (:'synthese'::jsonb -> 'rembourse' ->> 'solde')::numeric = 5
                     and (:'synthese'::jsonb -> 'a_encaisser' ->> 'virements')::numeric >= 3
                     and (:'synthese'::jsonb -> 'a_encaisser' ->> 'nb_virements')::integer >= 1,
                     'Finances : virement et portefeuille dans la synthèse');
select test.verifier((public.admin_lister_paiements('a_encaisser', p_mode => 'virement') ->> 'total')::integer >= 1,
                     'Finances : filtre « virement » des paiements');
select public.admin_portefeuilles(current_date, current_date) as pf \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'pf'::jsonb -> 'clients') c
                             where (c ->> 'id')::uuid = :'client1' and (c ->> 'solde')::numeric = :prix_imm + 11)
                     and (:'pf'::jsonb -> 'recharges' ->> 'nb_payees')::integer = 3
                     and (:'pf'::jsonb -> 'recharges' ->> 'payees')::numeric = 35
                     and jsonb_array_length(:'pf'::jsonb -> 'dettes') = 0
                     and exists (select 1 from jsonb_array_elements(:'pf'::jsonb -> 'lignes') l
                                 where l ->> 'numero' = :'r1_numero' and l ->> 'statut' = 'payee' and l ->> 'mollie_id' = 'tr_essai00001'),
                     'Finances > Portefeuilles : soldes, recharges de la période (Mollie), plus de reste dû');
select test.doit_echouer(format('select public.admin_supprimer_recharge(%L)', :'r1'), 'pièce comptable');
call test.connexion(:'client1');
select (r ->> 'id')::uuid as r7 from public.recharge_demander(30) r \gset
call test.systeme();
select public.recharge_mollie_ouverte(:'r7', 'tr_essai00007', 'test');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_supprimer_recharge(%L)', :'r7'), 'attend la réponse de Mollie');
select public.admin_supprimer_recharge(:'r2') \g /dev/null
call test.systeme();
select test.verifier(not exists (select 1 from public.recharges where id = :'r2')
                     and exists (select 1 from prive.journal where action = 'suppression_recharge' and ligne_id = :'r2'),
                     'recharge échouée supprimée par l''administration, inscrite au journal');


-- #############################################################################
-- 6. DONNÉES PERSONNELLES ET SUPPRESSION DE COMPTE
-- #############################################################################
call test.connexion(:'client1');
select test.verifier(jsonb_array_length(public.mes_donnees() -> 'solde' -> 'recharges') = 6
                     and public.mes_donnees() -> 'a_propos' ->> 'contenu' like '%recharges du portefeuille%',
                     'export des données : les recharges du portefeuille y figurent');
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'Une somme reste à régler');
call test.systeme();
update public.paiements set statut = 'encaisse', encaisse_le = now()
 where course_id = :'d_course' and nature = 'pourboire';
call test.connexion(:'client1');
select test.doit_echouer($$select public.supprimer_mon_compte('SUPPRIMER')$$, 'attend la réponse de Mollie');

-- Suppression par l'administration : la recharge payée est gardée, le compte archivé
call test.connexion(:'client2');
select (r ->> 'id')::uuid as r8 from public.recharge_demander(12) r \gset
call test.systeme();
select public.recharge_mollie_ouverte(:'r8', 'tr_essai00008', 'test');
call test.pf_mollie(:'r8', 'tr_essai00008', 'paid') \gset x_
call test.connexion(:'admin', 'aal2');
select public.admin_supprimer_client(:'client2') as suppression \gset
call test.systeme();
select test.verifier(:'suppression'::jsonb ->> 'mode' = 'archive'
                     and (select statut = 'payee' and client_id = :'client2' from public.recharges where id = :'r8')
                     and (select statut from public.profils where id = :'client2') = 'supprime',
                     'compte supprimé par l''administration : archivé, la recharge payée gardée (pièce comptable)');

rollback;

call test.systeme();
select test.verifier((select count(*) from public.recharges) = :recharges_avant
                     and (select count(*) from public.courses) = :courses_avant
                     and (select count(*) from public.paiements) = :paiements_avant
                     and (select count(*) from public.notifications) = :notifications_avant
                     and (select coalesce(sum(montant), 0) from public.soldes) = :soldes_avant
                     and (select coalesce(sum(valeur), 0) from prive.compteurs) = :compteurs_avant,
                     'fin des essais du portefeuille : la base est revenue à son état de départ');
