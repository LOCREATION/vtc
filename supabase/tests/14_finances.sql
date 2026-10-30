-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios du module « Finances » (migration 14), joués après
-- 13_clients_entreprises.sql sur les mêmes comptes fictifs :
--   avoirs (au centime près, jamais modifiés), espèces encaissées chez le
--   chauffeur ou au bureau, remises d'espèces et leur annulation, paiements
--   impayés puis encaissés, sommes annulées en tout ou partie, remboursements
--   (mode, avoir automatique), relevé mensuel avec avoirs, registre et
--   continuité des numéros, documents imprimables, listes et synthèse, TVA
--   mois par mois, alertes du tableau de bord, droits.
-- Les montants attendus sont recalculés ici indépendamment, à partir des
-- tables. Le moindre écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set client2    c0000000-0000-4000-8000-000000000002
\set clienttel  c0000000-0000-4000-8000-000000000003
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set chauffeuse d0000000-0000-4000-8000-000000000002

select (((now() at time zone 'Europe/Paris')::date + 1) + time '07:00') at time zone 'Europe/Paris' as demain_7h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '08:00') at time zone 'Europe/Paris' as demain_8h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '09:00') at time zone 'Europe/Paris' as demain_9h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '12:00') at time zone 'Europe/Paris' as demain_12h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '13:00') at time zone 'Europe/Paris' as demain_13h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '14:00') at time zone 'Europe/Paris' as demain_14h,
       (((now() at time zone 'Europe/Paris')::date + 1) + time '16:00') at time zone 'Europe/Paris' as demain_16h,
       (now() at time zone 'Europe/Paris')::date as aujourdhui,
       extract(year from (now() at time zone 'Europe/Paris'))::integer as annee,
       to_char(now() at time zone 'Europe/Paris', 'YYYY-MM') as mois_courant
\gset

-- Course commandée par un client, assurée par Paul de bout en bout (étapes
-- passées par l'administration) : renvoie la course terminée, avec son
-- paiement à encaisser et sa facture.
create procedure test.course_terminee(p_client uuid, p_quand timestamptz, p_mode text, p_compte uuid, inout course uuid)
language plpgsql
as $$
begin
  call test.connexion(p_client);
  select c.id into course from public.commander_course(
    'berline_hybride', '12 rue des Essais, 75011 Paris', 48.8590, 2.3800, 'Gare du Nord, 75010 Paris', 48.8809, 2.3553,
    p_type => 'planifiee', p_quand => p_quand, p_mode_paiement => p_mode, p_compte_pro => p_compte) c;
  call test.connexion('a0000000-0000-4000-8000-000000000001', 'aal2');
  perform public.attribuer_course(course, 'd0000000-0000-4000-8000-000000000001');
  perform public.avancer_course(course, 'en_route');
  perform public.avancer_course(course, 'arrivee');
  perform public.avancer_course(course, 'a_bord');
  perform public.avancer_course(course, 'terminee');
end;
$$;


-- #############################################################################
-- 1. L'AVOIR DU REMBOURSEMENT DU SCÉNARIO 11, PROTECTIONS
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select r.id as remb1, r.paiement_id as paiement1, r.montant as remb1_montant, r.mode as remb1_mode
from public.remboursements r order by r.cree_le limit 1 \gset
select f.id as facture1, f.montant_ttc as f1_ttc, f.taux_tva as f1_taux, c.prix_total + c.frais_attente as total_course1
from public.factures f
join public.paiements p on p.course_id = f.course_id and p.nature = f.nature
join public.courses c on c.id = f.course_id
where p.id = :'paiement1' \gset

select test.verifier((select count(*) from public.avoirs a where a.remboursement_id = :'remb1') = 1
                     and (select a.numero = 'AV-' || :annee || '-000001' and a.facture_id = :'facture1'
                                 and a.origine = 'remboursement' and a.paiement_id = :'paiement1'
                                 and a.montant_ttc = :remb1_montant
                                 and a.montant_ht = round(:remb1_montant / (1 + :f1_taux / 100), 2)
                                 and a.montant_ht + a.montant_tva = a.montant_ttc
                                 and a.destinataire_nom = (select destinataire_nom from public.factures where id = :'facture1')
                          from public.avoirs a where a.remboursement_id = :'remb1'),
                     'remboursement du scénario 11 : avoir AV-' || :annee || '-000001 de ' || :remb1_montant || ' € sur sa facture, HT et TVA au centime');
select test.verifier(:'remb1_mode' = 'especes', 'remboursement sans mode indiqué : celui du paiement (espèces)');
select test.verifier(:f1_ttc = :total_course1, 'la facture remboursée en partie reste intacte (' || :f1_ttc || ' €)');

-- Un avoir ne s'écrit, ne se modifie ni ne se supprime jamais à la main
select test.doit_echouer(format('update public.avoirs set motif = %L', 'Autre motif'), 'permission denied');
select test.doit_echouer('delete from public.avoirs', 'permission denied');
select test.doit_echouer($$insert into public.avoirs (numero, facture_id, course_id, client_id, destinataire_nom, date_emission,
                                                      origine, motif, montant_ht, taux_tva, montant_tva, montant_ttc)
                           select 'AV-0000-000001', id, course_id, client_id, 'X', current_date, 'annulation', 'x', 1, 10, 0.1, 1.1
                           from public.factures limit 1$$, 'permission denied');
call test.systeme();
select test.doit_echouer(format('update public.avoirs set motif = %L', 'Autre motif'), 'ne peut plus être modifié');
select test.doit_echouer('delete from public.avoirs', 'ne peut pas être supprimé');

-- Lecture : la cliente concernée, pas les autres ; administration en aal2
call test.connexion(:'client1');
select test.verifier((select count(*) from public.avoirs) = 1, 'cliente : voit son avoir');
select test.verifier(exists (select 1 from public.notifications
                             where titre = 'Remboursement' and message like '% en espèces : Retard de dix minutes (avoir AV-%'),
                     'cliente prévenue du remboursement, du mode et du numéro de l''avoir');
call test.connexion(:'clienttel');
select test.verifier((select count(*) from public.avoirs) = 0, 'autre client : aucun avoir visible');
call test.connexion(:'admin');
select test.verifier((select count(*) from public.avoirs) = 0, 'administrateur sans double authentification : avoirs fermés');
select test.doit_echouer('select public.admin_finances_synthese(current_date, current_date)', 'Réservé');
call test.connexion(:'client1', 'aal2');
select test.doit_echouer('select public.admin_lister_factures()', 'Réservé');
select test.doit_echouer(format('select public.admin_enregistrer_remise(%L, 1)', :'chauffeur1'), 'Réservé');
select test.doit_echouer(format('select public.rembourser(%L, 1, %L)', :'paiement1', 'Intrus'), 'Réservé');


-- #############################################################################
-- 2. ESPÈCES : CHEZ LE CHAUFFEUR OU AU BUREAU
-- #############################################################################
call test.systeme();
select prive.especes_a_remettre(:'chauffeur1') as especes_a_remettre_avant \gset

-- A : Claire paie en espèces, Paul confirme lui-même (il garde l'argent)
call test.course_terminee(:'client1', :'demain_7h', 'especes', null, null) \gset a_
-- B : Karim paie en espèces, l'administration confirme pour Paul (téléphone en panne)
call test.course_terminee(:'clienttel', :'demain_8h', 'especes', null, null) \gset b_
-- C : Claire paie en espèces directement au bureau
call test.course_terminee(:'client1', :'demain_9h', 'especes', null, null) \gset c_
select id as pa from public.paiements where course_id = :'a_course' and nature = 'course' \gset
select id as pb from public.paiements where course_id = :'b_course' and nature = 'course' \gset
select id as pc from public.paiements where course_id = :'c_course' and nature = 'course' \gset

call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.confirmer_encaissement(%L, true)', :'pa'), 'Seule l''administration');
select public.confirmer_encaissement(:'pa');
call test.connexion(:'admin', 'aal2');
select public.confirmer_encaissement(:'pb');
select public.confirmer_encaissement(:'pc', p_especes_au_bureau => true);
select test.verifier((select especes_chauffeur_id = :'chauffeur1' and encaisse_par = :'chauffeur1' from public.paiements where id = :'pa')
                     and (select especes_chauffeur_id = :'chauffeur1' and encaisse_par = :'admin' from public.paiements where id = :'pb')
                     and (select especes_chauffeur_id is null and statut = 'encaisse' from public.paiements where id = :'pc'),
                     'espèces : chez Paul (confirmées par lui, ou pour lui par l''administration), ou reçues au bureau');
select test.verifier(exists (select 1 from public.evenements_course
                             where course_id = :'c_course' and type = 'paiement_encaisse' and (details ->> 'au_bureau')::boolean),
                     'encaissement au bureau tracé sur la course');

-- Ce que Paul détient, recalculé ici à partir des paiements et des remises
select coalesce(sum(p.montant), 0) - coalesce((select sum(r.montant) from public.remises_especes r
                                                where r.chauffeur_id = :'chauffeur1' and r.annulee_le is null), 0) as detenu_paul
from public.paiements p
where p.especes_chauffeur_id = :'chauffeur1' and p.mode = 'especes' and p.nature <> 'pourboire' and p.statut in ('encaisse', 'rembourse') \gset
select montant as montant_a from public.paiements where id = :'pa' \gset
select montant as montant_b from public.paiements where id = :'pb' \gset
select test.verifier(:detenu_paul = :especes_a_remettre_avant + :montant_a + :montant_b,
                     'Paul détient ' || :detenu_paul || ' € : ses espèces d''avant, plus A et B ; pas C (reçue au bureau)');
select public.admin_especes_chauffeurs() as especes \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'especes'::jsonb -> 'chauffeurs') c
                             where c ->> 'chauffeur_id' = :'chauffeur1' and (c ->> 'a_remettre')::numeric = :detenu_paul
                               and c ->> 'nom' = 'Paul Bernard'),
                     'espèces des chauffeurs : Paul, ' || :detenu_paul || ' € à remettre');
select test.verifier((:'especes'::jsonb ->> 'total_a_remettre')::numeric
                     = (select coalesce(sum(a_remettre), 0) from jsonb_to_recordset(:'especes'::jsonb -> 'chauffeurs') as x(a_remettre numeric)),
                     'espèces des chauffeurs : total = somme des chauffeurs');
select test.verifier(exists (select 1 from jsonb_array_elements(:'especes'::jsonb -> 'chauffeurs') c
                             where c ->> 'chauffeur_id' = :'chauffeuse' and (c ->> 'a_remettre')::numeric = 0),
                     'espèces des chauffeurs : Nadia (chauffeuse validée) figure, à 0 €');
-- Paiements en espèces de ses courses encore à confirmer
select count(*) as nb_non_confirmes_paul, coalesce(sum(p.montant), 0) as montant_non_confirmes_paul
from public.paiements p join public.courses c on c.id = p.course_id
where c.chauffeur_id = :'chauffeur1' and p.mode = 'especes' and p.statut = 'a_encaisser' and p.nature <> 'pourboire' \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'especes'::jsonb -> 'chauffeurs') c
                             where c ->> 'chauffeur_id' = :'chauffeur1'
                               and (c -> 'non_confirmes' ->> 'nb')::integer = :nb_non_confirmes_paul
                               and (c -> 'non_confirmes' ->> 'montant')::numeric = :montant_non_confirmes_paul),
                     'espèces de Paul : ' || :nb_non_confirmes_paul || ' paiement(s) en espèces encore à confirmer');


-- #############################################################################
-- 3. REMISES D'ESPÈCES AU BUREAU
-- #############################################################################
select test.doit_echouer(format('select public.admin_enregistrer_remise(%L, %s)', :'chauffeur1', :detenu_paul + 1), 'ne détient que');
select test.doit_echouer(format('select public.admin_enregistrer_remise(%L, 0)', :'chauffeur1'), 'Indiquez le montant');
select test.doit_echouer(format('select public.admin_enregistrer_remise(%L, 10)', :'chauffeuse'), 'aucune espèce à remettre');
select test.doit_echouer(format('select public.admin_enregistrer_remise(%L, 10)', :'client1'), 'Chauffeur introuvable');

-- Première remise : elle couvre les plus anciens encaissements
select (:detenu_paul - :montant_b - 1)::numeric(10,2) as remise1_montant \gset
select id as remise1, numero as remise1_numero from public.admin_enregistrer_remise(:'chauffeur1', :remise1_montant, 'Enveloppe du soir') \gset
select test.verifier(:'remise1_numero' = 'RE-' || :annee || '-000001'
                     and (select recue_par = :'admin' and note = 'Enveloppe du soir' and annulee_le is null
                          from public.remises_especes where id = :'remise1'),
                     'remise enregistrée : reçu RE-' || :annee || '-000001, à votre nom, avec sa note');
-- Les remises couvrent les encaissements dans l'ordre : il reste 1,00 € de A, puis B en entier
select test.verifier(exists (select 1 from jsonb_array_elements(public.admin_especes_chauffeurs() -> 'chauffeurs') c
                             where c ->> 'chauffeur_id' = :'chauffeur1' and (c ->> 'a_remettre')::numeric = :montant_b + 1
                               and (c ->> 'depuis_le')::timestamptz = (select encaisse_le from public.paiements where id = :'pa')
                               and jsonb_array_length(c -> 'non_remis') = 2
                               and c -> 'non_remis' -> 0 ->> 'paiement_id' = :'pa'
                               and (c -> 'non_remis' -> 0 ->> 'reste')::numeric = 1
                               and c -> 'non_remis' -> 1 ->> 'paiement_id' = :'pb'
                               and (c -> 'non_remis' -> 1 ->> 'reste')::numeric = :montant_b),
                     'après la remise : ' || (:montant_b + 1) || ' € à remettre, depuis l''encaissement de A (1,00 € restant), puis B');
call test.systeme();
select 'Il vous reste ' || prive.euros(:montant_b + 1) || ' d''espèces à remettre.' as reste_attendu \gset
call test.connexion(:'chauffeur1');
select test.verifier(exists (select 1 from public.notifications
                             where titre = 'Remise d''espèces enregistrée' and message like '%(reçu ' || :'remise1_numero' || ').%'
                               and message like '%' || :'reste_attendu'),
                     'Paul reçoit le numéro du reçu et ce qu''il lui reste à remettre');
select test.verifier((select count(*) from public.remises_especes) = 1, 'chauffeur : voit ses propres remises');
call test.connexion(:'chauffeuse');
select test.verifier((select count(*) from public.remises_especes) = 0, 'autre chauffeur : ne voit pas les remises de Paul');
call test.connexion(:'client1');
select test.verifier((select count(*) from public.remises_especes) = 0, 'client : aucune remise visible');

-- Seconde remise : tout est remis
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('insert into public.remises_especes (numero, chauffeur_id, montant) values (%L, %L, 1)', 'RE-X', :'chauffeur1'),
                         'permission denied');
select id as remise2, numero as remise2_numero from public.admin_enregistrer_remise(:'chauffeur1', :montant_b + 1) \gset
select test.verifier(exists (select 1 from jsonb_array_elements(public.admin_especes_chauffeurs() -> 'chauffeurs') c
                             where c ->> 'chauffeur_id' = :'chauffeur1' and (c ->> 'a_remettre')::numeric = 0
                               and c ->> 'depuis_le' is null and jsonb_array_length(c -> 'non_remis') = 0),
                     'seconde remise : Paul n''a plus rien à remettre');
select test.doit_echouer(format('select public.admin_enregistrer_remise(%L, 1)', :'chauffeur1'), 'aucune espèce à remettre');

-- Annulation d'une remise : motif obligatoire, la remise reste visible
select test.doit_echouer(format('select public.admin_annuler_remise(%L, %L)', :'remise2', ' '), 'motif de l''annulation');
select public.admin_annuler_remise(:'remise2', 'Erreur de montant : enveloppe recomptée');
select (c ->> 'a_remettre')::numeric as detenu_apres_annulation
from jsonb_array_elements(public.admin_especes_chauffeurs() -> 'chauffeurs') c
where c ->> 'chauffeur_id' = :'chauffeur1' \gset
select test.verifier((select annulee_par = :'admin' and motif_annulation = 'Erreur de montant : enveloppe recomptée'
                      from public.remises_especes where id = :'remise2')
                     and :detenu_apres_annulation = :montant_b + 1,
                     'remise annulée : les espèces redeviennent à remettre (' || (:montant_b + 1) || ' €)');
select test.doit_echouer(format('select public.admin_annuler_remise(%L, %L)', :'remise2', 'Encore'), 'déjà annulée');
select public.admin_lister_remises(:'aujourdhui', :'aujourdhui') as remises \gset
select test.verifier((:'remises'::jsonb ->> 'nb')::integer = 1 and (:'remises'::jsonb ->> 'total')::numeric = :remise1_montant
                     and jsonb_array_length(:'remises'::jsonb -> 'lignes') = 2
                     and :'remises'::jsonb -> 'lignes' -> 0 ->> 'annulee_par_nom' = 'Alice Martin'
                     and :'remises'::jsonb -> 'lignes' -> 1 ->> 'recue_par_nom' = 'Alice Martin'
                     and :'remises'::jsonb -> 'lignes' -> 1 ->> 'chauffeur_nom' = 'Paul Bernard',
                     'liste des remises : les deux, l''annulée exclue du total');
select test.verifier(jsonb_array_length(public.admin_lister_remises(:'aujourdhui', :'aujourdhui', :'chauffeuse') -> 'lignes') = 0,
                     'liste des remises : filtre par chauffeur');
select test.doit_echouer(format('select public.admin_lister_remises(%L, %L)', :'aujourdhui', (:'aujourdhui'::date - 1)::text),
                         'avant la date de début');
call test.connexion(:'chauffeur1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Remise d''espèces annulée'
                             and message like '%' || :'remise2_numero' || '%Erreur de montant%'),
                     'Paul prévenu de l''annulation de la remise');
-- Le pourboire en espèces revient au chauffeur : il ne s'ajoute pas aux espèces à remettre
call test.connexion(:'client1');
select public.ajouter_pourboire(:'a_course', 4.00);
call test.connexion(:'chauffeur1');
select id as pourboire_a from public.paiements where course_id = :'a_course' and nature = 'pourboire' \gset
select public.confirmer_encaissement(:'pourboire_a');
call test.connexion(:'admin', 'aal2');
select test.verifier(exists (select 1 from jsonb_array_elements(public.admin_especes_chauffeurs() -> 'chauffeurs') c
                             where c ->> 'chauffeur_id' = :'chauffeur1' and (c ->> 'a_remettre')::numeric = :montant_b + 1),
                     'pourboire en espèces : gardé par le chauffeur, hors des espèces à remettre');


-- #############################################################################
-- 4. PAIEMENT IMPAYÉ
-- #############################################################################
-- D : Karim, espèces, ne paie pas
call test.course_terminee(:'clienttel', :'demain_12h', 'especes', null, null) \gset d_
select id as pd, montant as montant_d from public.paiements where course_id = :'d_course' and nature = 'course' \gset
select test.doit_echouer(format('select public.admin_paiement_impaye(%L, %L)', :'pd', ''), 'Indiquez le motif');
select public.admin_paiement_impaye(:'pd', 'Client injoignable depuis la course');
select test.verifier((select statut = 'echoue' and motif = 'Client injoignable depuis la course' from public.paiements where id = :'pd')
                     and exists (select 1 from public.evenements_course where course_id = :'d_course' and type = 'paiement_impaye'),
                     'paiement déclaré impayé, avec son motif, tracé sur la course');
select test.verifier(exists (select 1 from public.journal_lister('paiements', :'pd')
                             where action = 'UPDATE' and apres ->> 'statut' = 'echoue' and acteur_id = :'admin'),
                     'impayé inscrit au journal, avec son auteur');
select test.doit_echouer(format('select public.admin_paiement_impaye(%L, %L)', :'pd', 'Encore'), 'Seul un paiement à encaisser');
select test.doit_echouer(format('select public.admin_paiement_impaye(%L, %L)', :'pa', 'Essai'), 'Seul un paiement à encaisser');
call test.connexion(:'chauffeur1');
select test.doit_echouer(format('select public.confirmer_encaissement(%L)', :'pd'), 'déjà été traité');


-- #############################################################################
-- 5. SOMME ANNULÉE EN TOUT OU PARTIE (AVOIRS AU CENTIME)
-- #############################################################################
-- E : Claire, espèces ; la somme due est réduite, puis annulée
call test.course_terminee(:'client1', :'demain_13h', 'especes', null, null) \gset e_
select id as pe, montant as montant_e from public.paiements where course_id = :'e_course' and nature = 'course' \gset
select id as facture_e, montant_ht as fe_ht, montant_tva as fe_tva, montant_ttc as fe_ttc, taux_tva as fe_taux
from public.factures where course_id = :'e_course' and nature = 'course' \gset

select test.doit_echouer(format('select public.admin_annuler_paiement(%L, 1, %L)', :'pa', 'Essai'), 'se rembourse');
select test.doit_echouer(format('select public.admin_annuler_paiement(%L, 0, %L)', :'pe', 'Essai'), 'Montant invalide');
select test.doit_echouer(format('select public.admin_annuler_paiement(%L, %s, %L)', :'pe', :montant_e + 0.01, 'Essai'), 'Montant invalide');
select test.doit_echouer(format('select public.admin_annuler_paiement(%L, 1, %L)', :'pe', ''), 'motif de l''annulation');

select public.admin_annuler_paiement(:'pe', 1.11, 'Geste commercial : attente au départ') as annulation1 \gset
select test.verifier((select statut = 'a_encaisser' and montant = :montant_e - 1.11 from public.paiements where id = :'pe')
                     and (:'annulation1'::jsonb -> 'avoir' ->> 'montant_ttc')::numeric = 1.11
                     and (:'annulation1'::jsonb -> 'avoir' ->> 'montant_ht')::numeric = round(1.11 / (1 + :fe_taux / 100), 2)
                     and :'annulation1'::jsonb -> 'avoir' ->> 'origine' = 'annulation',
                     'annulation partielle : 1,11 € retirés de la somme due, avoir de 1,11 € (HT au centime)');
call test.connexion(:'client1');
select test.verifier(exists (select 1 from public.notifications where titre = 'Somme annulée'
                             and message like '1,11 € sont retirés de la somme due pour la course C-% ; il reste % à régler (avoir AV-%). Motif : Geste commercial : attente au départ.'),
                     'cliente prévenue : ce qui est retiré, ce qui reste, l''avoir et le motif');
call test.connexion(:'admin', 'aal2');
select public.admin_annuler_paiement(:'pe', :montant_e - 1.11, 'Course offerte') as annulation2 \gset
select test.verifier((select statut = 'annule' and motif = 'Course offerte' from public.paiements where id = :'pe'),
                     'annulation du reste : paiement « annulé »');
select test.verifier((select sum(montant_ht) = :fe_ht and sum(montant_tva) = :fe_tva and sum(montant_ttc) = :fe_ttc and count(*) = 2
                      from public.avoirs where facture_id = :'facture_e'),
                     'deux avoirs : ensemble, exactement la facture (' || :fe_ht || ' € HT + ' || :fe_tva || ' € TVA = ' || :fe_ttc || ' €)');
select test.verifier((select count(*) from public.evenements_course where course_id = :'e_course' and type = 'paiement_annule') = 2,
                     'chaque annulation tracée sur la course');
select test.doit_echouer(format('select public.admin_annuler_paiement(%L, 1, %L)', :'pe', 'Encore'), 'pas encore encaissée');


-- #############################################################################
-- 6. REMBOURSEMENTS : MODE, AVOIRS AU CENTIME, POURBOIRE SANS AVOIR
-- #############################################################################
-- F : Karim paie par carte au terminal
call test.course_terminee(:'clienttel', :'demain_14h', 'carte', null, null) \gset f_
select id as pf, montant as montant_f from public.paiements where course_id = :'f_course' and nature = 'course' \gset
select id as facture_f, montant_ht as ff_ht, montant_tva as ff_tva, montant_ttc as ff_ttc
from public.factures where course_id = :'f_course' and nature = 'course' \gset
select test.doit_echouer(format('select public.confirmer_encaissement(%L, true)', :'pf'), 'pas en espèces');
select test.doit_echouer(format('select public.rembourser(%L, 1, %L)', :'pf', 'Trop tôt'), 'Seul un paiement encaissé');
select public.confirmer_encaissement(:'pf');
select test.verifier((select especes_chauffeur_id is null from public.paiements where id = :'pf'), 'carte : aucune espèce chez le chauffeur');

select test.doit_echouer(format('select public.rembourser(%L, 1, %L, %L)', :'pf', 'Essai', 'cheque'), 'Mode de remboursement inconnu');
select test.doit_echouer(format('select public.rembourser(%L, 1, %L, %L)', :'pb', 'Essai', 'carte'), 'sur la carte');
select test.doit_echouer(format('select public.rembourser(%L, %s, %L)', :'pf', :montant_f + 0.01, 'Essai'), 'il reste');

select id as remb_f1 from public.rembourser(:'pf', 3.33, 'Détour imposé par des travaux') \gset
select test.verifier((select mode = 'carte' from public.remboursements where id = :'remb_f1')
                     and (select statut = 'encaisse' from public.paiements where id = :'pf'),
                     'remboursement partiel : sur la carte par défaut, paiement toujours « encaissé »');
select id as remb_f2 from public.rembourser(:'pf', :montant_f - 3.33, 'Course remboursée en totalité', 'virement') \gset
select test.verifier((select statut = 'rembourse' from public.paiements where id = :'pf')
                     and (select mode = 'virement' from public.remboursements where id = :'remb_f2'),
                     'remboursement du reste par virement : paiement « remboursé »');
select test.verifier((select count(*) = 2 and sum(montant_ht) = :ff_ht and sum(montant_tva) = :ff_tva and sum(montant_ttc) = :ff_ttc
                             and bool_and(origine = 'remboursement' and remboursement_id is not null)
                      from public.avoirs where facture_id = :'facture_f'),
                     'deux avoirs de remboursement : ensemble, exactement la facture, au centime');
select test.doit_echouer(format('select public.rembourser(%L, 0.01, %L)', :'pf', 'Encore'), 'il reste 0,00 €');
call test.connexion(:'clienttel');
select test.verifier(exists (select 1 from public.notifications where titre = 'Remboursement'
                             and message like '3,33 € vous sont remboursés sur votre carte : Détour imposé par des travaux (avoir AV-%')
                     and exists (select 1 from public.notifications where titre = 'Remboursement'
                                 and message like '% vous sont remboursés par virement : Course remboursée en totalité (avoir AV-%'),
                     'client prévenu de chaque remboursement, du mode et de l''avoir');

-- Pourboire remboursé : pas de facture, donc pas d'avoir
call test.connexion(:'admin', 'aal2');
select count(*) as nb_avoirs_avant from public.avoirs \gset
select public.rembourser(:'pourboire_a', 1.00, 'Pourboire saisi deux fois');
select test.verifier((select count(*) from public.avoirs) = :nb_avoirs_avant
                     and (select mode = 'especes' from public.remboursements where paiement_id = :'pourboire_a'),
                     'pourboire remboursé : aucun avoir (pas de facture), en espèces comme le paiement');
select test.verifier(exists (select 1 from public.evenements_course where course_id = :'f_course' and type = 'remboursement'
                             and details ->> 'mode' = 'virement' and details ->> 'avoir' like 'AV-%'),
                     'remboursement tracé sur la course, avec son mode et son avoir');


-- #############################################################################
-- 7. RELEVÉ MENSUEL AVEC AVOIRS (COMPTE PROFESSIONNEL)
-- #############################################################################
select id as compte from public.comptes_pro where raison_sociale = 'Atelier Lumière SARL' \gset
-- G : Hugo, sur facture mensuelle ; une partie de la somme est annulée
call test.course_terminee(:'client2', :'demain_16h', 'facture_mensuelle', :'compte', null) \gset g_
select id as pg, montant as montant_g from public.paiements where course_id = :'g_course' and nature = 'course' \gset
select test.doit_echouer(format('select public.admin_paiement_impaye(%L, %L)', :'pg', 'Essai'), 'facture mensuelle se règle avec le relevé');
select (public.admin_releve_compte_pro(:'compte', :'aujourdhui') -> 'totaux' ->> 'reste_a_payer')::numeric as reste_avant \gset
select public.admin_annuler_paiement(:'pg', 2.25, 'Attente non due') as annulation_g \gset

select public.admin_releve_compte_pro(:'compte', :'aujourdhui') as releve \gset
-- Attendus recalculés ici : factures du mois du compte, leurs avoirs, pourboires nets
select coalesce(sum(f.montant_ttc), 0) as fact_ttc_mois,
       coalesce(sum(f.montant_ht), 0) as fact_ht_mois,
       coalesce((select sum(a.montant_ttc) from public.avoirs a join public.factures x on x.id = a.facture_id
                 where x.compte_pro_id = :'compte' and x.date_emission >= date_trunc('month', :'aujourdhui'::date)), 0) as av_ttc_mois,
       coalesce((select sum(a.montant_ht) from public.avoirs a join public.factures x on x.id = a.facture_id
                 where x.compte_pro_id = :'compte' and x.date_emission >= date_trunc('month', :'aujourdhui'::date)), 0) as av_ht_mois
from public.factures f
where f.compte_pro_id = :'compte' and f.date_emission >= date_trunc('month', :'aujourdhui'::date) \gset
select coalesce(sum(p.montant - coalesce((select sum(r.montant) from public.remboursements r where r.paiement_id = p.id), 0)), 0) as pourboires_mois
from public.paiements p join public.courses c on c.id = p.course_id
where p.nature = 'pourboire' and p.statut <> 'annule' and c.compte_pro_id = :'compte'
  and p.cree_le >= date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris' \gset

select test.verifier((:'releve'::jsonb -> 'totaux' ->> 'montant_ttc')::numeric = :fact_ttc_mois - :av_ttc_mois
                     and (:'releve'::jsonb -> 'totaux' ->> 'montant_ht')::numeric = :fact_ht_mois - :av_ht_mois
                     and (:'releve'::jsonb -> 'totaux' ->> 'avoirs_ttc')::numeric = :av_ttc_mois
                     and :av_ttc_mois >= 2.25,
                     'relevé : factures du mois moins leurs avoirs (' || :fact_ttc_mois || ' − ' || :av_ttc_mois || ' €)');
select test.verifier((:'releve'::jsonb -> 'totaux' ->> 'reste_a_payer')::numeric = :reste_avant - 2.25
                     and (:'releve'::jsonb -> 'totaux' ->> 'deja_regle')::numeric
                         = (:'releve'::jsonb -> 'totaux' ->> 'total')::numeric - (:'releve'::jsonb -> 'totaux' ->> 'reste_a_payer')::numeric
                     and (:'releve'::jsonb -> 'totaux' ->> 'pourboires')::numeric = :pourboires_mois,
                     'relevé : reste à payer réduit de 2,25 €, déjà réglé cohérent, pourboires nets (' || :pourboires_mois || ' €)');
select test.verifier(exists (select 1 from jsonb_array_elements(:'releve'::jsonb -> 'lignes') l
                             where l ->> 'course_id' = :'g_course' and jsonb_array_length(l -> 'avoirs') = 1
                               and (l -> 'avoirs' -> 0 ->> 'montant_ttc')::numeric = 2.25
                               and l -> 'avoirs' -> 0 ->> 'motif' = 'Attente non due'),
                     'relevé : l''avoir figure sous la facture qu''il corrige');
select test.verifier((select sum((t ->> 'montant_ht')::numeric) from jsonb_array_elements(:'releve'::jsonb -> 'tva_par_taux') t)
                     = (:'releve'::jsonb -> 'totaux' ->> 'montant_ht')::numeric,
                     'relevé : TVA par taux, avoirs déduits');
select (:'releve'::jsonb -> 'totaux' ->> 'reste_a_payer')::numeric as reste_releve \gset
select public.admin_encaisser_releve(:'compte', :'aujourdhui', :reste_releve, 'VIR-ESSAI-002');
select test.verifier((select statut = 'encaisse' and montant = :montant_g - 2.25 from public.paiements where id = :'pg'),
                     'relevé encaissé : la somme réduite de la course G');
select test.verifier((public.admin_fiche_compte_pro(:'compte') -> 'chiffres' ->> 'total_facture')::numeric
                     = (select sum(montant_ttc) from public.factures where compte_pro_id = :'compte')
                       - (select coalesce(sum(montant_ttc), 0) from public.avoirs where compte_pro_id = :'compte'),
                     'fiche du compte : total facturé net des avoirs');


-- #############################################################################
-- 8. REGISTRE DES FACTURES ET DES AVOIRS, CONTINUITÉ DES NUMÉROS
-- #############################################################################
select public.admin_lister_factures('tout', :'aujourdhui', :'aujourdhui') as registre \gset
select (select count(*) from public.factures where date_emission = :'aujourdhui') as nb_fact_jour,
       (select count(*) from public.avoirs where date_emission = :'aujourdhui') as nb_av_jour,
       (select coalesce(sum(montant_ht), 0) from public.factures where date_emission = :'aujourdhui')
     - (select coalesce(sum(montant_ht), 0) from public.avoirs where date_emission = :'aujourdhui') as net_ht_jour,
       (select coalesce(sum(montant_tva), 0) from public.factures where date_emission = :'aujourdhui')
     - (select coalesce(sum(montant_tva), 0) from public.avoirs where date_emission = :'aujourdhui') as net_tva_jour,
       (select coalesce(sum(montant_ttc), 0) from public.avoirs where date_emission = :'aujourdhui') as av_ttc_jour \gset
select test.verifier((:'registre'::jsonb ->> 'total')::integer = :nb_fact_jour + :nb_av_jour
                     and (:'registre'::jsonb -> 'totaux' -> 'factures' ->> 'nb')::integer = :nb_fact_jour
                     and (:'registre'::jsonb -> 'totaux' -> 'avoirs' ->> 'nb')::integer = :nb_av_jour
                     and (:'registre'::jsonb -> 'totaux' -> 'avoirs' ->> 'ttc')::numeric = :av_ttc_jour
                     and (:'registre'::jsonb -> 'totaux' -> 'net' ->> 'ht')::numeric = :net_ht_jour
                     and (:'registre'::jsonb -> 'totaux' -> 'net' ->> 'tva')::numeric = :net_tva_jour,
                     'registre du jour : ' || :nb_fact_jour || ' factures et ' || :nb_av_jour || ' avoirs ; net ' || :net_ht_jour || ' € HT, '
                     || :net_tva_jour || ' € de TVA');
select test.verifier(:'registre'::jsonb -> 'lignes' -> 0 ->> 'date_emission' = :'aujourdhui'
                     and (select bool_and((l ->> 'type') in ('facture', 'avoir')) from jsonb_array_elements(:'registre'::jsonb -> 'lignes') l),
                     'registre : lignes typées, les plus récentes d''abord');
select test.verifier(exists (select 1 from jsonb_array_elements(:'registre'::jsonb -> 'lignes') l
                             where l ->> 'type' = 'facture' and l ->> 'id' = :'facture_f'
                               and (l ->> 'credite')::numeric = :ff_ttc and l -> 'paiement' ->> 'statut' = 'rembourse'),
                     'registre : facture de F entièrement créditée, paiement remboursé');
select test.verifier((public.admin_lister_factures('avoirs', :'aujourdhui', :'aujourdhui') ->> 'total')::integer = :nb_av_jour
                     and (public.admin_lister_factures('factures', :'aujourdhui', :'aujourdhui') ->> 'total')::integer = :nb_fact_jour,
                     'registre : factures seules, avoirs seuls');
select public.admin_lister_factures('tout', :'aujourdhui', :'aujourdhui', 'AV-' || :annee || '-000002') as recherche_avoir \gset
select test.verifier((:'recherche_avoir'::jsonb ->> 'total')::integer = 1
                     and :'recherche_avoir'::jsonb -> 'lignes' -> 0 ->> 'type' = 'avoir'
                     and :'recherche_avoir'::jsonb -> 'lignes' -> 0 ->> 'facture_id' = :'facture_e'
                     and :'recherche_avoir'::jsonb -> 'lignes' -> 0 ->> 'motif' = 'Geste commercial : attente au départ',
                     'registre : recherche d''un avoir par son numéro, avec la facture qu''il corrige');
select test.verifier((public.admin_lister_factures('tout', :'aujourdhui', :'aujourdhui', 'benali') ->> 'total')::integer
                     = (select count(*) from public.factures where client_id = :'clienttel' and date_emission = :'aujourdhui')
                       + (select count(*) from public.avoirs where client_id = :'clienttel' and date_emission = :'aujourdhui'),
                     'registre : recherche par nom du client');
select test.verifier((select bool_and((s ->> 'nb_manquants')::integer = 0 and (s ->> 'nombre')::integer = (s ->> 'dernier')::integer)
                      from jsonb_array_elements(:'registre'::jsonb -> 'continuite') s)
                     and (select count(*) from jsonb_array_elements(:'registre'::jsonb -> 'continuite') s
                          where (s ->> 'annee')::integer = :annee and s ->> 'serie' in ('facture', 'avoir')) = 2,
                     'numérotation continue : factures et avoirs, aucun numéro manquant');
select test.doit_echouer(format('select public.admin_lister_factures(%L, %L, %L)', 'devis', :'aujourdhui', :'aujourdhui'), 'Type inconnu');
select test.doit_echouer('select public.admin_lister_factures()', 'Indiquez le début');

-- Un numéro attribué sans document serait signalé (simulation d'anomalie)
call test.systeme();
update prive.compteurs set valeur = valeur + 1 where nom = 'avoir' and annee = :annee returning valeur as avoir_fantome \gset
call test.connexion(:'admin', 'aal2');
select test.verifier(exists (select 1 from jsonb_array_elements(public.admin_lister_factures('tout', :'aujourdhui', :'aujourdhui') -> 'continuite') s
                             where s ->> 'serie' = 'avoir' and (s ->> 'nb_manquants')::integer = 1
                               and (s -> 'manquants') = jsonb_build_array(:avoir_fantome)),
                     'contrôle de continuité : un numéro d''avoir manquant serait signalé (n° ' || :avoir_fantome || ')');
call test.systeme();
update prive.compteurs set valeur = valeur - 1 where nom = 'avoir' and annee = :annee;


-- #############################################################################
-- 9. DOCUMENTS IMPRIMABLES
-- #############################################################################
call test.connexion(:'admin', 'aal2');
select public.admin_document_facture(:'facture_f') as doc_facture \gset
select test.verifier(:'doc_facture'::jsonb -> 'facture' ->> 'id' = :'facture_f'
                     and :'doc_facture'::jsonb -> 'societe' ->> 'raison_sociale' = 'LOC RÉACTION S.A.S'
                     and :'doc_facture'::jsonb -> 'course' ->> 'categorie' is not null
                     and (:'doc_facture'::jsonb -> 'course' ->> 'prix_total')::numeric
                         + (:'doc_facture'::jsonb -> 'course' ->> 'frais_attente')::numeric = :ff_ttc
                     and :'doc_facture'::jsonb -> 'paiement' ->> 'mode' = 'carte'
                     and jsonb_array_length(:'doc_facture'::jsonb -> 'avoirs') = 2
                     and :'doc_facture'::jsonb -> 'client' ->> 'nom' = 'Benali',
                     'facture imprimable : facture, entreprise, détail du prix, règlement, ses deux avoirs');
select a.id as avoir_e1 from public.avoirs a where a.facture_id = :'facture_e' order by a.numero limit 1 \gset
select public.admin_document_avoir(:'avoir_e1') as doc_avoir \gset
select test.verifier(:'doc_avoir'::jsonb -> 'facture' ->> 'id' = :'facture_e'
                     and (:'doc_avoir'::jsonb ->> 'credite_total')::numeric = :fe_ttc
                     and :'doc_avoir'::jsonb -> 'remboursement' = 'null'::jsonb
                     and :'doc_avoir'::jsonb -> 'course' ->> 'numero' like 'C-%',
                     'avoir imprimable : facture corrigée, total crédité sur la facture, sans remboursement (annulation)');
select test.verifier(public.admin_document_avoir((select id from public.avoirs where remboursement_id = :'remb_f1')) -> 'remboursement' ->> 'mode' = 'carte',
                     'avoir de remboursement imprimable : avec le mode du remboursement');
select test.doit_echouer(format('select public.admin_document_facture(%L)', 'f0000000-0000-4000-8000-000000000000'), 'Facture introuvable');
select test.doit_echouer(format('select public.admin_document_avoir(%L)', 'f0000000-0000-4000-8000-000000000000'), 'Avoir introuvable');


-- #############################################################################
-- 10. LISTES DES PAIEMENTS
-- #############################################################################
select public.admin_lister_paiements('a_encaisser') as a_encaisser \gset
select count(*) as nb_a_encaisser, coalesce(sum(montant), 0) as total_a_encaisser,
       (select id from public.paiements where statut = 'a_encaisser' order by cree_le, id limit 1) as plus_ancien
from public.paiements where statut = 'a_encaisser' \gset
select test.verifier((:'a_encaisser'::jsonb ->> 'total')::integer = :nb_a_encaisser
                     and (:'a_encaisser'::jsonb -> 'totaux' ->> 'montant')::numeric = :total_a_encaisser
                     and :'a_encaisser'::jsonb -> 'lignes' -> 0 ->> 'id' = :'plus_ancien',
                     'à encaisser : ' || :nb_a_encaisser || ' paiements, ' || :total_a_encaisser || ' €, le plus ancien en tête');
select test.verifier((select sum((m ->> 'montant')::numeric) from jsonb_array_elements(:'a_encaisser'::jsonb -> 'par_mode') m) = :total_a_encaisser,
                     'à encaisser : la répartition par mode redonne le total');
select test.verifier((public.admin_lister_paiements('a_encaisser', p_mode => 'facture_mensuelle') ->> 'total')::integer
                     = (select count(*) from public.paiements where statut = 'a_encaisser' and mode = 'facture_mensuelle'),
                     'à encaisser : filtre par mode');
select test.verifier((public.admin_lister_paiements('impayes') ->> 'total')::integer = 1
                     and public.admin_lister_paiements('impayes') -> 'lignes' -> 0 ->> 'motif' = 'Client injoignable depuis la course'
                     and public.admin_lister_paiements('impayes') -> 'lignes' -> 0 ->> 'client_nom' = 'Karim Benali',
                     'impayés : celui de Karim, avec son motif');
select test.verifier((public.admin_lister_paiements('annules') ->> 'total')::integer = (select count(*) from public.paiements where statut = 'annule')
                     and exists (select 1 from jsonb_array_elements(public.admin_lister_paiements('annules') -> 'lignes') l
                                 where l ->> 'id' = :'pe' and (l ->> 'annule')::numeric = :montant_e),
                     'annulés : la course E, avec le total annulé par ses avoirs');

select public.admin_lister_paiements('encaisses', :'aujourdhui', :'aujourdhui') as encaisses \gset
select count(*) as nb_encaisses_jour, coalesce(sum(montant), 0) as total_encaisse_jour
from public.paiements
where statut in ('encaisse', 'rembourse') and (encaisse_le at time zone 'Europe/Paris')::date = :'aujourdhui' \gset
select test.verifier((:'encaisses'::jsonb ->> 'total')::integer = :nb_encaisses_jour
                     and (:'encaisses'::jsonb -> 'totaux' ->> 'montant')::numeric = :total_encaisse_jour
                     and (select sum((m ->> 'montant')::numeric) from jsonb_array_elements(:'encaisses'::jsonb -> 'par_mode') m) = :total_encaisse_jour,
                     'encaissés du jour : ' || :nb_encaisses_jour || ' paiements, ' || :total_encaisse_jour || ' €, par mode');
select test.verifier(exists (select 1 from jsonb_array_elements(:'encaisses'::jsonb -> 'lignes') l
                             where l ->> 'id' = :'pb' and l ->> 'especes_chez' = 'Paul Bernard' and l ->> 'encaisse_par_nom' = 'Alice Martin'
                               and l ->> 'facture_numero' like 'FA-%')
                     and exists (select 1 from jsonb_array_elements(:'encaisses'::jsonb -> 'lignes') l
                                 where l ->> 'id' = :'pc' and l ->> 'especes_chez' is null),
                     'encaissés : qui a encaissé, qui garde les espèces, la facture');
select test.verifier((public.admin_lister_paiements('encaisses', :'aujourdhui', :'aujourdhui',
                                                    (select numero from public.courses where id = :'f_course')) ->> 'total')::integer = 1,
                     'encaissés : recherche par numéro de course');
-- Téléphone de Karim saisi « à la française », avec des espaces
select '0' || substr(telephone, 4, 1) || ' ' || regexp_replace(substr(telephone, 5), '(\d{2})(?=\d)', '\1 ', 'g') as tel_karim_saisi
from public.profils where id = :'clienttel' \gset
select test.verifier((public.admin_lister_paiements('encaisses', :'aujourdhui', :'aujourdhui', :'tel_karim_saisi') ->> 'total')::integer
                     = (select count(*) from public.paiements p
                        where p.client_id = :'clienttel' and p.statut in ('encaisse', 'rembourse')
                          and (p.encaisse_le at time zone 'Europe/Paris')::date = :'aujourdhui')
                     and (public.admin_lister_paiements('encaisses', :'aujourdhui', :'aujourdhui', :'tel_karim_saisi') ->> 'total')::integer > 0,
                     'encaissés : recherche par téléphone saisi « ' || :'tel_karim_saisi' || ' »');
select test.doit_echouer('select public.admin_lister_paiements(''tous'')', 'Vue inconnue');
select test.doit_echouer('select public.admin_lister_paiements(''encaisses'')', 'Indiquez le début');
select test.doit_echouer('select public.admin_lister_paiements(''a_encaisser'', p_mode => ''cheque'')', 'Mode de paiement inconnu');


-- #############################################################################
-- 11. SYNTHÈSE ET REMBOURSEMENTS DE LA PÉRIODE
-- #############################################################################
select public.admin_finances_synthese(:'aujourdhui', :'aujourdhui') as synthese \gset
select coalesce(sum(r.montant), 0) as rembourse_jour,
       coalesce(sum(r.montant) filter (where r.mode = 'carte'), 0) as rembourse_carte_jour,
       count(*) as nb_remb_jour
from public.remboursements r where (r.cree_le at time zone 'Europe/Paris')::date = :'aujourdhui' \gset
select test.verifier((:'synthese'::jsonb -> 'encaisse' ->> 'total')::numeric = :total_encaisse_jour
                     and (:'synthese'::jsonb -> 'encaisse' ->> 'especes')::numeric
                         + (:'synthese'::jsonb -> 'encaisse' ->> 'carte')::numeric
                         + (:'synthese'::jsonb -> 'encaisse' ->> 'facture_mensuelle')::numeric
                         + (:'synthese'::jsonb -> 'encaisse' ->> 'solde')::numeric = :total_encaisse_jour
                     and (:'synthese'::jsonb -> 'rembourse' ->> 'total')::numeric = :rembourse_jour
                     and (:'synthese'::jsonb -> 'rembourse' ->> 'carte')::numeric = :rembourse_carte_jour
                     and (:'synthese'::jsonb -> 'a_encaisser' ->> 'total')::numeric = :total_a_encaisser
                     and (:'synthese'::jsonb -> 'impayes' ->> 'total')::numeric = :montant_d
                     and (:'synthese'::jsonb -> 'especes' ->> 'a_remettre')::numeric
                         = (public.admin_especes_chauffeurs() ->> 'total_a_remettre')::numeric,
                     'synthèse du jour : encaissé ' || :total_encaisse_jour || ' € (par mode), remboursé ' || :rembourse_jour
                     || ' €, à encaisser, impayés, espèces chez les chauffeurs');

select public.admin_lister_remboursements(:'aujourdhui', :'aujourdhui') as remboursements \gset
select test.verifier((:'remboursements'::jsonb ->> 'total')::integer = :nb_remb_jour
                     and (:'remboursements'::jsonb -> 'totaux' ->> 'montant')::numeric = :rembourse_jour
                     and (:'remboursements'::jsonb -> 'totaux' ->> 'virement')::numeric
                         + (:'remboursements'::jsonb -> 'totaux' ->> 'carte')::numeric
                         + (:'remboursements'::jsonb -> 'totaux' ->> 'especes')::numeric = :rembourse_jour,
                     'remboursements du jour : ' || :nb_remb_jour || ', ' || :rembourse_jour || ' €, par mode');
select test.verifier(exists (select 1 from jsonb_array_elements(:'remboursements'::jsonb -> 'lignes') l
                             where l ->> 'id' = :'remb_f1' and l ->> 'avoir_numero' like 'AV-%' and l ->> 'cree_par_nom' = 'Alice Martin'
                               and l ->> 'client_nom' = 'Karim Benali' and l ->> 'mode' = 'carte')
                     and exists (select 1 from jsonb_array_elements(:'remboursements'::jsonb -> 'lignes') l
                                 where l ->> 'paiement_nature' = 'pourboire' and l ->> 'avoir_numero' is null),
                     'remboursements : avoir, auteur, client, mode ; le pourboire sans avoir');
select test.verifier((public.admin_lister_remboursements(:'aujourdhui', :'aujourdhui', 'travaux') ->> 'total')::integer = 1,
                     'remboursements : recherche dans le motif');


-- #############################################################################
-- 12. TVA MOIS PAR MOIS
-- #############################################################################
select public.admin_tva(:annee) as tva \gset
-- Attendus du mois en cours, recalculés ici
select (select coalesce(sum(montant_ht), 0) from public.factures where to_char(date_emission, 'YYYY-MM') = :'mois_courant')
     - (select coalesce(sum(montant_ht), 0) from public.avoirs where to_char(date_emission, 'YYYY-MM') = :'mois_courant') as ca_ht_mois,
       (select coalesce(sum(montant_tva), 0) from public.factures where to_char(date_emission, 'YYYY-MM') = :'mois_courant')
     - (select coalesce(sum(montant_tva), 0) from public.avoirs where to_char(date_emission, 'YYYY-MM') = :'mois_courant') as tva_facturee_mois,
       (select coalesce(sum(f.montant_tva - coalesce((select sum(a.montant_tva) from public.avoirs a
                                                       where a.facture_id = f.id and a.origine = 'annulation'), 0)), 0)
          from public.paiements p join public.factures f on f.course_id = p.course_id and f.nature = p.nature
         where p.statut in ('encaisse', 'rembourse') and to_char(p.encaisse_le at time zone 'Europe/Paris', 'YYYY-MM') = :'mois_courant')
     - (select coalesce(sum(montant_tva), 0) from public.avoirs
         where origine = 'remboursement' and to_char(date_emission, 'YYYY-MM') = :'mois_courant') as tva_exigible_mois,
       (select coalesce(sum(p.montant), 0) from public.paiements p
         where p.nature = 'pourboire' and p.statut in ('encaisse', 'rembourse')
           and to_char(p.encaisse_le at time zone 'Europe/Paris', 'YYYY-MM') = :'mois_courant')
     - (select coalesce(sum(r.montant), 0) from public.remboursements r join public.paiements p on p.id = r.paiement_id
         where p.nature = 'pourboire' and to_char(r.cree_le at time zone 'Europe/Paris', 'YYYY-MM') = :'mois_courant') as pourboires_mois_tva \gset
select (m.ligne) as tva_mois from jsonb_array_elements(:'tva'::jsonb -> 'mois') m(ligne) where m.ligne ->> 'periode' = :'mois_courant' \gset
select test.verifier((:'tva_mois'::jsonb ->> 'ca_ht')::numeric = :ca_ht_mois
                     and (:'tva_mois'::jsonb ->> 'tva_facturee')::numeric = :tva_facturee_mois
                     and (:'tva_mois'::jsonb ->> 'tva_exigible')::numeric = :tva_exigible_mois
                     and (:'tva_mois'::jsonb ->> 'pourboires')::numeric = :pourboires_mois_tva,
                     'TVA du mois : CA ' || :ca_ht_mois || ' € HT, TVA facturée ' || :tva_facturee_mois || ' €, TVA sur encaissements '
                     || :tva_exigible_mois || ' €, pourboires ' || :pourboires_mois_tva || ' € hors TVA');
select test.verifier((:'tva_mois'::jsonb ->> 'base_exigible')::numeric + (:'tva_mois'::jsonb ->> 'tva_exigible')::numeric
                     = (:'tva_mois'::jsonb -> 'encaisse' ->> 'ttc')::numeric - (:'tva_mois'::jsonb -> 'rembourse' ->> 'ttc')::numeric,
                     'TVA du mois : base HT + TVA = encaissé − remboursé (hors pourboires)');
select test.verifier(jsonb_array_length(:'tva'::jsonb -> 'mois') = 12 and jsonb_array_length(:'tva'::jsonb -> 'trimestres') = 4
                     and (:'tva'::jsonb -> 'total' ->> 'tva_exigible')::numeric
                         = (select sum((m ->> 'tva_exigible')::numeric) from jsonb_array_elements(:'tva'::jsonb -> 'mois') m)
                     and (:'tva'::jsonb -> 'total' ->> 'ca_ht')::numeric
                         = (select sum((t ->> 'ca_ht')::numeric) from jsonb_array_elements(:'tva'::jsonb -> 'trimestres') t)
                     and exists (select 1 from jsonb_array_elements(:'tva'::jsonb -> 'annees') a where (a #>> '{}')::integer = :annee),
                     'TVA : 12 mois, 4 trimestres, l''année = somme des mois et des trimestres ; année proposée au choix');
select test.verifier((select sum((t ->> 'tva_exigible')::numeric) from jsonb_array_elements(:'tva_mois'::jsonb -> 'par_taux') t)
                     = (:'tva_mois'::jsonb ->> 'tva_exigible')::numeric,
                     'TVA du mois : détail par taux');
-- Course F encaissée puis remboursée dans le mois : sa TVA s'annule
select test.verifier(:ff_tva - (select sum(montant_tva) from public.avoirs where facture_id = :'facture_f') = 0,
                     'course encaissée puis remboursée : TVA due nulle au final');
select test.doit_echouer('select public.admin_tva(1999)', 'Année invalide');


-- #############################################################################
-- 13. FICHES DE COURSE ET DE CLIENT
-- #############################################################################
select public.admin_fiche_course(:'f_course') as fiche_f \gset
select test.verifier(jsonb_array_length(:'fiche_f'::jsonb -> 'avoirs') = 2
                     and (select bool_and(r ->> 'avoir_numero' like 'AV-%') from jsonb_array_elements(:'fiche_f'::jsonb -> 'remboursements') r)
                     and exists (select 1 from jsonb_array_elements(:'fiche_f'::jsonb -> 'remboursements') r where r ->> 'mode' = 'carte')
                     and :'fiche_f'::jsonb -> 'paiements' -> 0 ->> 'statut' = 'rembourse'
                     and (:'fiche_f'::jsonb -> 'paiements' -> 0 ->> 'rembourse')::numeric = :montant_f
                     and :'fiche_f'::jsonb -> 'paiements' -> 0 ->> 'encaisse_par_nom' = 'Alice Martin',
                     'fiche de la course F : avoirs, remboursements (mode, avoir), paiement remboursé');
select test.verifier(public.admin_fiche_course(:'a_course') -> 'paiements' -> 0 ->> 'especes_chez' = 'Paul Bernard'
                     and public.admin_fiche_course(:'e_course') -> 'paiements' -> 0 ->> 'motif' = 'Course offerte',
                     'fiches de course : qui garde les espèces, motif d''une annulation');
select test.verifier((select count(*) from jsonb_array_elements(public.admin_fiche_client(:'client1') -> 'avoirs') a
                      where a ->> 'facture_id' = :'facture_e') = 2
                     and exists (select 1 from jsonb_array_elements(public.admin_fiche_client(:'client1') -> 'factures') f
                                 where f ->> 'id' = :'facture_e' and (f ->> 'credite')::numeric = :fe_ttc),
                     'fiche de la cliente : ses avoirs, et ce qui est crédité sur chaque facture');


-- #############################################################################
-- 14. ALERTES DU TABLEAU DE BORD
-- #############################################################################
select public.admin_tableau_de_bord() as tdb \gset
select test.verifier(exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a
                             where a ->> 'titre' = '1 paiement impayé' and a ->> 'lien' = 'finances/?vue=impayes'
                               and a ->> 'module' = 'finances'),
                     'alerte : 1 paiement impayé, lien vers les impayés');
select test.verifier(not exists (select 1 from jsonb_array_elements(:'tdb'::jsonb -> 'alertes') a where a ->> 'lien' = 'finances/?vue=especes'),
                     'espèces gardées depuis moins de 7 jours : pas d''alerte');
-- Les espèces de Paul, comme s'il les gardait depuis 8 jours (tous ses
-- encaissements reculés d'autant : leur ordre ne change pas)
call test.systeme();
update public.paiements set encaisse_le = encaisse_le - interval '8 days' where especes_chauffeur_id = :'chauffeur1';
call test.connexion(:'admin', 'aal2');
select test.verifier(exists (select 1 from jsonb_array_elements(public.admin_tableau_de_bord() -> 'alertes') a
                             where a ->> 'titre' = '1 chauffeur garde des espèces depuis plus de 7 jours'
                               and a ->> 'lien' = 'finances/?vue=especes' and a ->> 'niveau' = 'attention'),
                     'alerte : espèces gardées depuis plus de 7 jours, lien vers les espèces des chauffeurs');
call test.systeme();
update public.paiements set encaisse_le = encaisse_le + interval '8 days' where especes_chauffeur_id = :'chauffeur1';

-- Karim finit par payer au bureau : l'impayé est encaissé, l'alerte disparaît
call test.connexion(:'admin', 'aal2');
select public.confirmer_encaissement(:'pd', p_especes_au_bureau => true);
select test.verifier((select statut = 'encaisse' and motif is null and especes_chauffeur_id is null from public.paiements where id = :'pd'),
                     'impayé encaissé plus tard (au bureau) : motif effacé');
select test.verifier(not exists (select 1 from jsonb_array_elements(public.admin_tableau_de_bord() -> 'alertes') a
                                 where a ->> 'lien' = 'finances/?vue=impayes'),
                     'plus d''impayé : plus d''alerte');


-- #############################################################################
-- 15. CONTRÔLES D'ENSEMBLE
-- #############################################################################
call test.systeme();
select test.verifier((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname in ('rembourser', 'confirmer_encaissement')) = 2,
                     'une seule version de rembourser et de confirmer_encaissement');
select test.verifier(not has_function_privilege('anon', 'public.rembourser(uuid, numeric, text, text)', 'execute')
                     and not has_function_privilege('anon', 'public.confirmer_encaissement(uuid, boolean)', 'execute')
                     and has_function_privilege('authenticated', 'public.confirmer_encaissement(uuid, boolean)', 'execute'),
                     'encaissement et remboursement : fermés aux visiteurs, ouverts une fois connecté (contrôle dans la fonction)');
select test.verifier(not exists (select 1 from information_schema.role_table_grants
                                 where grantee = 'anon' and table_schema = 'public' and table_name in ('avoirs', 'remises_especes'))
                     and (select string_agg(table_name || ':' || privilege_type, ',' order by table_name)
                          from information_schema.role_table_grants
                          where grantee = 'authenticated' and table_schema = 'public' and table_name in ('avoirs', 'remises_especes'))
                         = 'avoirs:SELECT,remises_especes:SELECT',
                     'avoirs et remises : lecture seule une fois connecté, rien pour un visiteur');
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables restent protégées ligne par ligne');
select test.verifier(not exists (select 1 from public.factures f
                                 where (select coalesce(sum(a.montant_ttc), 0) from public.avoirs a where a.facture_id = f.id) > f.montant_ttc),
                     'aucune facture créditée au-delà de son montant');
select test.verifier(not exists (select 1 from public.factures f
                                 join (select a.facture_id, sum(a.montant_ht) as ht, sum(a.montant_tva) as tva, sum(a.montant_ttc) as ttc
                                       from public.avoirs a group by a.facture_id) s on s.facture_id = f.id
                                 where s.ttc = f.montant_ttc and (s.ht <> f.montant_ht or s.tva <> f.montant_tva)),
                     'facture entièrement créditée : ses avoirs redonnent exactement son HT et sa TVA');
select test.verifier((select count(*) from public.remboursements r join public.paiements p on p.id = r.paiement_id
                      where p.nature <> 'pourboire')
                     = (select count(*) from public.avoirs where origine = 'remboursement'),
                     'chaque remboursement de course ou de frais a son avoir, et un seul');
select test.verifier((select max(right(numero, 6)::integer) = count(*) from public.factures)
                     and (select max(right(numero, 6)::integer) = count(*) from public.avoirs)
                     and (select max(right(numero, 6)::integer) = count(*) from public.remises_especes),
                     'factures, avoirs, remises : numérotation continue');
select test.verifier(not exists (select 1 from public.notifications where message = ''), 'notifications : aucune vide');
select test.verifier(not exists (select 1 from public.courses c
                                 where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')),
                     'aucune course laissée en cours');

drop procedure test.course_terminee(uuid, timestamptz, text, uuid, uuid);

\o
\echo '✔ Finances : tout est conforme.'
