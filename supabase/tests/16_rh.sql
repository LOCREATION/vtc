-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Scénarios du module « RH et paie » (migrations 16a à 16e), joués après
-- 15_plateformes.sql sur les mêmes comptes fictifs :
--   droits ; paramètres de paie 2026 (valeurs, points à régler, validation
--   par l'expert-comptable, retrait, copie) ; fiches des salariés (contrôles,
--   matricule, n° de Sécurité sociale, SMIC) ; contrats (ce qui manque,
--   période d'essai, CDD, signature, protections) ; congés et absences ;
--   temps de travail et heures majorées ; bulletins (entrée en cours de mois,
--   congés, heures supplémentaires et complémentaires, absence, cadre,
--   reprise d'une paie faite ailleurs, ordre des mois, protections, remise),
--   rentabilité, journal.
-- Les montants attendus des bulletins viennent d'un calcul de référence
-- indépendant de la base (programme Python écrit à part, mêmes règles) : le
-- moindre centime d'écart arrête le script avec le message « ÉCHEC : … ».
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

\set admin      a0000000-0000-4000-8000-000000000001
\set client1    c0000000-0000-4000-8000-000000000001
\set chauffeur1 d0000000-0000-4000-8000-000000000001
\set chauffeuse d0000000-0000-4000-8000-000000000002

call test.systeme();
select id as paul from public.salaries where matricule = 'S0001' \gset


-- #############################################################################
-- 1. DROITS
-- #############################################################################
call test.visiteur();
select test.doit_echouer('select public.admin_lister_salaries()', 'permission denied');
call test.connexion(:'chauffeuse');
select test.doit_echouer('select public.admin_lister_salaries()', 'Réservé à l''administration');
select test.doit_echouer('select public.admin_parametres_paie(2026)', 'Réservé à l''administration');
select test.doit_echouer(format('select public.admin_preparer_bulletin(%L, %L)', :'paul', '2026-10-01'), 'Réservé à l''administration');
call test.connexion(:'admin');
select test.doit_echouer('select public.admin_lister_bulletins(''2026-09-01'')', 'Réservé à l''administration');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select prive.calculer_bulletin(%L, %L, %L)', :'paul', '2026-11-01', '{}'), 'permission denied');
select test.doit_echouer('insert into public.bulletin_lignes (bulletin_id, ordre, section, libelle) values (gen_random_uuid(), 1, ''x'', ''x'')',
                         'permission denied');
select test.doit_echouer('insert into public.reprises_paie (salarie_id, mois) values (gen_random_uuid(), ''2026-01-01'')', 'permission denied');


-- #############################################################################
-- 2. PARAMÈTRES DE PAIE 2026
-- #############################################################################
select test.verifier((select c.plafond_mensuel_ss = 4005 and c.smic_horaire = 12.02 and c.smic_horaire_rgdu = 12.02 and c.rgdu_tmin = 0.02
                             and c.rgdu_tdelta = 0.3781 and c.rgdu_p = 1.75 and c.rgdu_taux_at = 0.49 and c.abattement_csg = 1.75
                             and c.reduction_salariale_hs = 11.31 and c.deduction_patronale_hs = 1.50 and c.plafond_exoneration_hs = 7500
                             and not c.valide_par_comptable
                      from public.constantes_paie c where c.annee = 2026)
                     and (select count(*) from public.parametres_paie where annee = 2026) = 20
                     and (select count(*) from public.parametres_paie where annee = 2026 and rgdu) = 9
                     and (select count(*) from public.grille_taux_neutre where valable_du = '2026-05-01') = 20
                     and (select string_agg(horaire::text, ',' order by valable_du) from public.smic) = '12.0200,12.3100',
                     'paramètres 2026 : plafond, SMIC et sa revalorisation de juin, RGDU, 20 lignes de cotisation, grille du taux neutre');
select test.verifier((select (x -> 'points') @> '[{"code": "at_mp", "niveau": "bloquant"}]'::jsonb
                             and (x -> 'points') @> '[{"code": "sante", "niveau": "attention"}]'::jsonb
                             and jsonb_array_length(x -> 'lignes') = 20 and (x -> 'grille' ->> 'valable_du') = '2026-05-01'
                      from (select public.admin_parametres_paie(2026) as x) t),
                     'paramètres : taux accidents du travail à 0 (bloquant) et complémentaire santé inactive signalés');
select test.doit_echouer('select public.admin_valider_parametres_paie(2026, ''Cabinet Exemple Expertise, le 30/10/2026'')',
                         'Taux accidents du travail à 0');
-- Taux AT notifié à l'entreprise, complémentaire santé du contrat d'entreprise
update public.parametres_paie set taux_patronal = 0.90 where annee = 2026 and code = 'at_mp';
update public.parametres_paie set montant_salarial = 21.50, montant_patronal = 21.50, actif = true
 where annee = 2026 and code = 'complementaire_sante';
select test.doit_echouer('select public.admin_valider_parametres_paie(2026, '''')', 'Indiquez qui a validé');
select test.doit_echouer('update public.constantes_paie set valide_par_comptable = true, valide_le = now() where annee = 2026',
                         'bouton « Valider les paramètres »');
select test.doit_echouer('update public.parametres_paie set montant_salarial = null where annee = 2026 and code = ''complementaire_sante''',
                         'parametres_paie_forfait');


-- #############################################################################
-- 3. FICHES DES SALARIÉS
-- #############################################################################
select test.doit_echouer(format('select public.admin_enregistrer_salarie(null, %L)', '{"prenom": "Nadia"}'), 'Indiquez le prénom et le nom');
select test.doit_echouer(format('select public.admin_enregistrer_salarie(null, %L)',
  '{"prenom": "Nadia", "nom": "Moreau", "type_contrat": "CDI", "date_entree": "2026-07-06", "salaire_base_mensuel": 1900,
    "numero_securite_sociale": "2 85 07 75 123 456 54"}'), 'La clé ne correspond pas');
select test.doit_echouer(format('select public.admin_enregistrer_salarie(null, %L)',
  '{"prenom": "Nadia", "nom": "Moreau", "type_contrat": "CDI", "date_entree": "2026-07-06", "salaire_base_mensuel": 1700}'),
  'Salaire inférieur au SMIC');
select test.doit_echouer(format('select public.admin_enregistrer_salarie(null, %L)',
  '{"prenom": "Karim", "nom": "Haddad", "type_contrat": "CDD", "temps": "partiel", "heures_mensuelles": 151.67, "date_entree": "2026-09-01",
    "taux_horaire": 12.50}'), 'Temps partiel : indiquez les heures');
select test.doit_echouer(format('select public.admin_enregistrer_salarie(null, %L)',
  jsonb_build_object('prenom', 'Nadia', 'nom', 'Moreau', 'type_contrat', 'CDI', 'date_entree', '2026-07-06', 'salaire_base_mensuel', 1900,
                     'profil_id', :'chauffeur1')), 'déjà rattaché à un autre salarié');
select test.doit_echouer(format('select public.admin_enregistrer_salarie(null, %L)',
  '{"prenom": "Nadia", "nom": "Moreau", "type_contrat": "CDI", "date_entree": "2026-07-06", "date_sortie": "2026-12-31", "salaire_base_mensuel": 1900}'),
  'motif de la sortie');
select test.doit_echouer(format('select public.admin_enregistrer_salarie(null, %L)',
  '{"prenom": "Nadia", "nom": "Moreau", "type_contrat": "CDI", "date_entree": "2026-07-06", "salaire_base_mensuel": 1900, "iban": "FR76 ABC"}'),
  'IBAN invalide');

-- Nadia : conductrice, CDI à temps plein, entrée le lundi 6 juillet, compte chauffeuse
select (public.admin_enregistrer_salarie(null, jsonb_build_object(
  'civilite', 'Madame', 'prenom', 'Nadia', 'nom', 'Moreau', 'date_naissance', '1985-07-12', 'lieu_naissance', 'Paris 12e',
  'nationalite', 'Française', 'numero_securite_sociale', '2 85 07 75 123 456 55', 'adresse', '8 rue des Lilas', 'code_postal', '95270',
  'ville', 'Luzarches', 'emploi', 'Conductrice de VTC', 'qualification', 'Employée', 'type_contrat', 'CDI', 'temps', 'plein',
  'date_entree', '2026-07-06', 'salaire_base_mensuel', 1900, 'lieu_travail', 'Île-de-France, au départ du dépôt de Chaumontel',
  'profil_id', :'chauffeuse', 'iban', 'fr76 3000 6000 0112 3456 7890 189', 'bic', 'agrifrpp'))) ->> 'id' as nadia \gset
select test.verifier((select s.matricule = 'S0002' and s.numero_securite_sociale = '285077512345655' and s.heures_mensuelles = 151.67
                             and s.iban = 'FR7630006000011234567890189' and s.bic = 'AGRIFRPP' and s.actif and s.profil_id = :'chauffeuse'
                      from public.salaries s where s.id = :'nadia'),
                     'fiche de Nadia : matricule suivant, n° de Sécurité sociale et IBAN nettoyés, 151,67 h, compte rattaché');
-- Karim : CDD à temps partiel (24 h par semaine), payé à l'heure, taux personnalisé de prélèvement
select (public.admin_enregistrer_salarie(null, jsonb_build_object(
  'civilite', 'Monsieur', 'prenom', 'Karim', 'nom', 'Haddad', 'date_naissance', '1988-06-03', 'lieu_naissance', 'Lyon',
  'nationalite', 'Française', 'numero_securite_sociale', '188069212378923', 'adresse', '3 place de la Gare', 'code_postal', '95270',
  'ville', 'Chaumontel', 'qualification', 'Employé', 'type_contrat', 'CDD', 'temps', 'partiel', 'heures_mensuelles', 104,
  'repartition_horaire', 'Du lundi au jeudi, de 7 h à 13 h', 'date_entree', '2026-09-01', 'taux_horaire', 12.50, 'taux_pas', 3.2,
  'lieu_travail', 'Île-de-France'))) ->> 'id' as karim \gset
-- Sophie : cadre, CDI depuis mars 2025 (paie faite ailleurs jusqu'en août 2026)
select (public.admin_enregistrer_salarie(null, jsonb_build_object(
  'civilite', 'Madame', 'prenom', 'Sophie', 'nom', 'Lambert', 'date_naissance', '1979-03-20', 'lieu_naissance', 'Lille',
  'nationalite', 'Française', 'numero_securite_sociale', '279037545612337', 'adresse', '12 avenue Foch', 'code_postal', '95100',
  'ville', 'Argenteuil', 'emploi', 'Responsable d''exploitation', 'qualification', 'Cadre', 'cadre', true, 'type_contrat', 'CDI',
  'date_entree', '2025-03-01', 'salaire_base_mensuel', 2400, 'lieu_travail', 'Siège de Chaumontel'))) ->> 'id' as sophie \gset
select test.verifier((select s.matricule = 'S0003' and s.emploi = 'Conducteur de VTC' and s.taux_horaire = 12.50
                             and s.salaire_base_mensuel is null and s.taux_pas = 3.2 from public.salaries s where s.id = :'karim')
                     and (select s.matricule = 'S0004' and s.cadre from public.salaries s where s.id = :'sophie'),
                     'fiches de Karim (emploi par défaut, payé à l''heure) et de Sophie (cadre)');
select test.verifier((select jsonb_array_length(x -> 'lignes') = 4
                             and not exists (select 1 from jsonb_array_elements(x -> 'comptes') c where c ->> 'id' in (:'chauffeur1', :'chauffeuse'))
                             and exists (select 1 from jsonb_array_elements(x -> 'lignes') l where l ->> 'id' = :'sophie' and l ->> 'statut' = 'en_poste')
                      from (select public.admin_lister_salaries() as x) t),
                     'liste des salariés : 4 fiches ; les comptes déjà rattachés ne sont plus proposés');


-- #############################################################################
-- 4. CONTRATS DE TRAVAIL
-- #############################################################################
-- Entreprise incomplète : la liste précise de ce qui manque, jamais un contrat
-- avec des champs « à compléter »
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L)', :'nadia', 'CDI', '2026-07-06'),
                         'SIRET, convention collective, caisse de retraite complémentaire');
update public.societe set siret = '10005257000019', code_ape = '4932Z', numero_urssaf = '957000123456',
       convention_collective = 'Aucune convention collective applicable', caisse_retraite = 'Caisse de retraite Exemple',
       organisme_sante = 'Mutuelle Exemple', service_sante_travail = 'Service de santé au travail Exemple'
 where id = 1;
select test.verifier((select x -> 'manquants_contrat' = '[]'::jsonb from (select public.admin_dossier_salarie(:'nadia') as x) t),
                     'dossier de Nadia : plus rien ne manque pour établir son contrat');
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L, null, %L)', :'nadia', 'CDI', '2026-07-06', '2026-09-30'),
                         '2 mois au plus pour ce poste, soit jusqu''au 05/09/2026');
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L, %L)', :'nadia', 'CDI', '2026-07-06', '2027-07-05'),
                         'Un CDI n''a pas de date de fin');
select (public.admin_generer_contrat(:'nadia', 'CDI', '2026-07-06', null, '2026-09-05')) ->> 'id' as contrat_nadia \gset
select test.verifier((select k.statut = 'brouillon' and k.type = 'CDI' and k.essai_fin = '2026-09-05'
                             and k.champs -> 'societe' ->> 'raison_sociale' = 'LOC RÉACTION S.A.S'
                             and k.champs -> 'societe' ->> 'representant_nom' is not null
                             and (k.champs -> 'salarie' ->> 'taux_horaire')::numeric = 12.5272
                             and (k.champs -> 'salarie' ->> 'salaire_base_mensuel')::numeric = 1900
                             and (k.champs -> 'salarie' ->> 'heures_hebdo')::numeric = 35
                             and k.champs ->> 'convention_collective' = 'Aucune convention collective applicable'
                      from public.contrats k where k.id = :'contrat_nadia'),
                     'contrat de Nadia : identités recopiées, taux horaire exact, 35 h, essai de 2 mois');
select public.admin_statut_contrat(:'contrat_nadia', 'envoye');
select test.doit_echouer(format('select public.admin_statut_contrat(%L, %L)', :'contrat_nadia', 'termine'), 'Changement impossible');
select test.doit_echouer(format('select public.admin_classer_contrat(%L, %L)', :'contrat_nadia', 'autre/contrat.pdf'), 'Chemin du fichier invalide');
select test.doit_echouer(format('select public.admin_classer_contrat(%L, %L)', :'contrat_nadia', :'nadia' || '/contrats/../x.pdf'),
                         'Chemin du fichier invalide');
select public.admin_classer_contrat(:'contrat_nadia', :'nadia' || '/contrats/cdi-2026-07-06.pdf');
select test.verifier((select k.statut = 'signe' and k.signe_le is not null and k.pdf_chemin = :'nadia' || '/contrats/cdi-2026-07-06.pdf'
                      from public.contrats k where k.id = :'contrat_nadia'), 'contrat de Nadia signé et classé');
select test.doit_echouer(format('delete from public.contrats where id = %L', :'contrat_nadia'), 'Un contrat signé ne se supprime pas');
call test.systeme();
select test.doit_echouer(format('update public.contrats set date_debut = %L where id = %L', '2026-07-07', :'contrat_nadia'),
                         'Un contrat signé ne se modifie plus');
call test.connexion(:'admin', 'aal2');

-- CDD de Karim : motif obligatoire, 18 mois au plus, période d'essai d'un jour
-- par semaine (contrat de 6 mois : 2 semaines au plus)
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L, %L)', :'karim', 'CDD', '2026-09-01', '2027-02-28'), 'Motif du CDD');
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L, %L, null, %L)', :'karim', 'CDD', '2026-09-01', '2027-02-28',
                                'remplacement'), 'nom et la qualification du salarié remplacé');
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L, %L, null, %L)', :'karim', 'CDD', '2026-09-01', '2028-04-01',
                                'accroissement'), '18 mois au plus');
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L, %L, %L, %L)', :'karim', 'CDD', '2026-09-01', '2027-02-28',
                                '2026-09-20', 'accroissement'), 'soit jusqu''au 14/09/2026 compris au plus');
select (public.admin_generer_contrat(:'karim', 'CDD', '2026-09-01', '2027-02-28', '2026-09-14', 'accroissement')) ->> 'id' as contrat_karim \gset
select test.verifier((select k.champs ->> 'motif_libelle' = 'Accroissement temporaire de l''activité de l''entreprise'
                             and k.champs -> 'salarie' ->> 'repartition_horaire' = 'Du lundi au jeudi, de 7 h à 13 h'
                             and (k.champs -> 'salarie' ->> 'heures_hebdo')::numeric = 24 and k.date_fin = '2027-02-28'
                      from public.contrats k where k.id = :'contrat_karim'),
                     'CDD de Karim : motif, répartition des horaires du temps partiel, 24 h par semaine, terme précis');
delete from public.contrats where id = :'contrat_karim';
select test.verifier(not exists (select 1 from public.contrats where id = :'contrat_karim'), 'contrat non signé : supprimable par l''administration');
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L)', :'karim', 'apprentissage', '2026-09-01'), 'formulaire Cerfa');
select test.doit_echouer(format('select public.admin_generer_contrat(%L, %L, %L, null, null, null, %L)', :'nadia', 'avenant', '2027-01-01', 'Prime'),
                         'décrivez ce qui change');
-- Contrat signé ailleurs, avant l'application (Sophie)
select public.admin_classer_contrat(null, :'sophie' || '/contrats/cdi-2025-03-01.pdf', :'sophie', 'CDI', '2025-03-01');
select test.verifier((select count(*) = 1 and bool_and(k.statut = 'signe' and (k.champs ->> 'externe')::boolean)
                      from public.contrats k where k.salarie_id = :'sophie'), 'contrat signé ailleurs : classé tel quel');


-- #############################################################################
-- 5. CONGÉS ET ABSENCES
-- #############################################################################
-- Congés payés du lundi 17 au samedi 22 août : 6 jours ouvrables
select (public.admin_enregistrer_absence(null, :'nadia', 'conges_payes', '2026-08-17', '2026-08-22')) ->> 'id' as cp_nadia \gset
select test.verifier((select a.jours = 6 and a.statut = 'validee' and a.decide_par = :'admin' from public.absences a where a.id = :'cp_nadia'),
                     'congés payés : 6 jours ouvrables (lundi au samedi), validés d''office');
select test.doit_echouer(format('select public.admin_enregistrer_absence(null, %L, %L, %L, %L)', :'nadia', 'sans_solde', '2026-08-20', '2026-08-25'),
                         'déjà enregistrée du 17/08/2026 au 22/08/2026');
select test.doit_echouer(format('select public.admin_enregistrer_absence(null, %L, %L, %L, %L)', :'nadia', 'conges_payes', '2026-07-01', '2026-07-03'),
                         'sort du contrat (entrée le 06/07/2026)');
select test.doit_echouer(format('select public.admin_enregistrer_absence(null, %L, %L, %L, %L)', :'nadia', 'conges_payes', '2026-08-23', '2026-08-23'),
                         'Aucun jour ouvrable');
-- Arrêt maladie du lundi 14 au mercredi 16 septembre : 3 jours calendaires
select (public.admin_enregistrer_absence(null, :'nadia', 'maladie', '2026-09-14', '2026-09-16', null, 'Arrêt de travail')) ->> 'id' as maladie_nadia \gset
select test.verifier((select a.jours = 3 from public.absences a where a.id = :'maladie_nadia'), 'arrêt maladie : jours calendaires');
-- Demande de la salariée depuis l'application, puis décision
call test.connexion(:'chauffeuse');
insert into public.absences (salarie_id, type, debut, fin) values (:'nadia', 'conges_payes', '2026-12-21', '2026-12-26')
returning id as demande_nadia \gset
select test.verifier((select a.jours = 5 and a.statut = 'demandee' from public.absences a where a.id = :'demande_nadia'),
                     'demande de la salariée : 5 jours ouvrables (le 25 décembre, férié, ne compte pas), en attente');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_decider_absence(%L, %L)', :'demande_nadia', 'refusee'), 'motif du refus');
select public.admin_decider_absence(:'demande_nadia', 'validee');
call test.systeme();
select test.verifier((select a.statut = 'validee' and a.decide_par = :'admin' from public.absences a where a.id = :'demande_nadia')
                     and exists (select 1 from public.notifications n where n.destinataire_id = :'chauffeuse' and n.titre = 'Demande d''absence acceptée'),
                     'demande acceptée : la salariée est prévenue');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_decider_absence(%L, %L, %L)', :'demande_nadia', 'refusee', 'Trop tard'), 'déjà reçu une réponse');


-- #############################################################################
-- 6. TEMPS DE TRAVAIL
-- #############################################################################
-- Nadia : 44 h la semaine du 7 septembre (8 h à 25 %, 1 h à 50 %), 38 h la
-- semaine du 21 (3 h à 25 %)
select public.admin_enregistrer_temps(:'nadia', '[{"jour": "2026-09-07", "heures": 8}, {"jour": "2026-09-08", "heures": 8},
  {"jour": "2026-09-09", "heures": 8}, {"jour": "2026-09-10", "heures": 8}, {"jour": "2026-09-11", "heures": 8},
  {"jour": "2026-09-12", "heures": 4}, {"jour": "2026-09-21", "heures": 7.6}, {"jour": "2026-09-22", "heures": 7.6},
  {"jour": "2026-09-23", "heures": 7.6}, {"jour": "2026-09-24", "heures": 7.6}, {"jour": "2026-09-25", "heures": 7.6}]');
select test.verifier((select sum((w ->> 'sup_25')::numeric) = 11 and sum((w ->> 'sup_50')::numeric) = 1 and count(*) = 4
                      from jsonb_array_elements(public.admin_temps_travail(:'nadia', '2026-09-01') -> 'payees_ce_mois') w)
                     and (select jsonb_array_length(x -> 'semaines') = 5
                                 and (x -> 'semaines' -> 4 ->> 'paye_en') = '2026-10-01'
                                 and (x -> 'semaines' -> 1 ->> 'total')::numeric = 44
                                 and (x -> 'semaines' -> 2 -> 'jours' -> 0 ->> 'absence') = 'maladie'
                          from (select public.admin_temps_travail(:'nadia', '2026-09-01') as x) t),
                     'temps de travail de septembre : 5 semaines affichées, 4 payées en septembre (11 h à 25 %, 1 h à 50 %), absences repérées');
select test.doit_echouer(format('select public.admin_enregistrer_temps(%L, %L)', :'nadia', '[{"jour": "2026-09-14", "heures": 25}]'), 'entre 0 et 24');
select test.doit_echouer(format('select public.admin_enregistrer_temps(%L, %L)', :'nadia', '[{"jour": "2026-07-01", "heures": 5}]'), 'hors du contrat');
-- Karim (24 h par semaine) : 26 h puis 28 h → 4,40 h à 10 %, 1,60 h à 25 %
select public.admin_enregistrer_temps(:'karim', '[{"jour": "2026-09-07", "heures": 6.5}, {"jour": "2026-09-08", "heures": 6.5},
  {"jour": "2026-09-09", "heures": 6.5}, {"jour": "2026-09-10", "heures": 6.5}, {"jour": "2026-09-14", "heures": 7},
  {"jour": "2026-09-15", "heures": 7}, {"jour": "2026-09-16", "heures": 7}, {"jour": "2026-09-17", "heures": 7}]');
select test.verifier((select sum((w ->> 'comp_10')::numeric) = 4.40 and sum((w ->> 'comp_25')::numeric) = 1.60
                             and sum((w ->> 'sup_25')::numeric) = 0
                      from jsonb_array_elements(public.admin_temps_travail(:'karim', '2026-09-01') -> 'payees_ce_mois') w),
                     'temps partiel : heures complémentaires à 10 % dans la limite du dixième du contrat, puis à 25 %');


-- #############################################################################
-- 7. BULLETINS DE NADIA : JUILLET (ENTRÉE LE 6), AOÛT (CONGÉS), SEPTEMBRE
-- #############################################################################
select test.verifier((select (x -> 'suggestion' ->> 'heures_sup_25')::numeric = 0 and x -> 'suggestion' -> 'absences' = '[]'::jsonb
                             and x -> 'existant' = 'null'::jsonb and x -> 'precedent' = 'null'::jsonb
                      from (select public.admin_preparer_bulletin(:'nadia', '2026-07-01') as x) t),
                     'préparation de juillet : rien à reprendre');
select (public.admin_enregistrer_bulletin(:'nadia', '2026-07-01', '{}')) ->> 'id' as b_juillet \gset
-- Référence : 19 jours ouvrés payés sur 22 (14 juillet férié) ; brut 1 640,91 ;
-- cotisations salariales 365,55, patronales 115,79 (réduction générale 588,76,
-- coefficient 0,3588) ; net avant impôt 1 275,36 ; net imposable 1 344,24 ;
-- taux neutre 0 % ; coût employeur 1 756,70 ; 2,10 jours de congés acquis
select test.verifier((select b.brut = 1640.91 and b.total_cotisations_salariales = 365.55 and b.total_cotisations_patronales = 115.79
                             and b.net_avant_impot = 1275.36 and b.net_social = 1275.36 and b.net_imposable = 1344.24 and b.taux_pas = 0
                             and b.montant_pas = 0 and b.net_a_payer = 1275.36 and b.cout_employeur = 1756.70 and b.allegements = 588.76
                             and b.taux_horaire = 12.5272 and b.heures = 130.99 and b.statut = 'brouillon'
                             and (b.calcul -> 'rgdu' ->> 'coefficient')::numeric = 0.3588
                             and (b.calcul -> 'rgdu' ->> 'smic_mois')::numeric = 1574.44
                             and (b.calcul -> 'constantes' ->> 'plafond_applique')::numeric = 3359.03
                             and b.calcul ->> 'precedent' = 'entree'
                             and (b.conges ->> 'acquis_mois')::numeric = 2.10 and (b.conges ->> 'n_solde')::numeric = 2.10
                             and b.calcul -> 'remuneration' -> 1 ->> 'code' = 'entree_sortie'
                             and (b.calcul -> 'remuneration' -> 1 ->> 'montant')::numeric = -259.09
                      from public.bulletins b where b.id = :'b_juillet'),
                     'juillet (entrée le 6) : chaque montant égal au calcul de référence, au centime');
select test.verifier((select bool_and(x ->> 'niveau' <> 'bloquant' or x ->> 'code' = 'parametres')
                             and bool_or(x ->> 'code' = 'parametres') and bool_or(x ->> 'code' = 'pas_neutre')
                      from public.bulletins b, jsonb_array_elements(b.calcul -> 'controles') x where b.id = :'b_juillet'),
                     'juillet : seul point bloquant, les paramètres pas encore validés ; taux neutre signalé');
select test.doit_echouer(format('select public.admin_valider_bulletin(%L)', :'b_juillet'), 'pas encore validés par l''expert-comptable');

-- Validation des paramètres 2026 par l'expert-comptable ; une année validée ne
-- se modifie plus ; retrait (motif) puis nouvelle validation
select public.admin_valider_parametres_paie(2026, 'Validé par le cabinet Exemple Expertise le 30/10/2026');
select test.verifier((select c.valide_par_comptable and c.valide_le is not null and c.valide_par = :'admin'
                             and c.validation_note = 'Validé par le cabinet Exemple Expertise le 30/10/2026'
                      from public.constantes_paie c where c.annee = 2026), 'paramètres 2026 validés : qui, quand');
select test.doit_echouer('update public.parametres_paie set taux_patronal = 1 where annee = 2026 and code = ''at_mp''', 'retirez la validation');
select test.doit_echouer('update public.constantes_paie set plafond_mensuel_ss = 4000 where annee = 2026', 'retirez la validation');
select test.doit_echouer('insert into public.parametres_paie (annee, code, libelle, section, assiette) values (2026, ''essai'', ''Essai'', ''autres'', ''brut'')',
                         'retirez la validation');
select test.doit_echouer('select public.admin_retirer_validation_paie(2026, '''')', 'motif du retrait');
select public.admin_retirer_validation_paie(2026, 'Correction demandée par le cabinet');
select test.verifier((select not c.valide_par_comptable and c.validation_note = 'Validation retirée : Correction demandée par le cabinet'
                      from public.constantes_paie c where c.annee = 2026), 'validation retirée, motif conservé');
select public.admin_valider_parametres_paie(2026, 'Validé par le cabinet Exemple Expertise le 31/10/2026');

select public.admin_valider_bulletin(:'b_juillet');
call test.systeme();
select test.verifier((select b.statut = 'valide' and b.valide_par = :'admin' and b.valide_le is not null and b.net_a_payer = 1275.36
                      from public.bulletins b where b.id = :'b_juillet')
                     and (select count(*) from public.bulletin_lignes l where l.bulletin_id = :'b_juillet') = 20
                     and (select count(*) = jsonb_array_length(b.calcul -> 'remuneration') + jsonb_array_length(b.calcul -> 'cotisations')
                                            + jsonb_array_length(b.calcul -> 'allegements') + 1 + jsonb_array_length(b.calcul -> 'apres_net')
                          from public.bulletins b join public.bulletin_lignes l on l.bulletin_id = b.id where b.id = :'b_juillet' group by b.calcul)
                     and (select sum(l.montant_salarial) from public.bulletin_lignes l
                           where l.bulletin_id = :'b_juillet' and l.section not in ('remuneration', 'impot', 'apres_net')) = 365.55
                     and exists (select 1 from public.notifications n where n.destinataire_id = :'chauffeuse'
                                   and n.titre = 'Bulletin de paie disponible' and n.message like '%juillet 2026%1 275,36 €%'),
                     'juillet validé : 20 lignes recopiées (totaux identiques), salariée prévenue du net à payer');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('delete from public.bulletins where id = %L', :'b_juillet'), 'ne peut pas être supprimé');
call test.systeme();
select test.doit_echouer(format('update public.bulletins set net_a_payer = 0 where id = %L', :'b_juillet'), 'ne se modifie plus');
select test.doit_echouer(format('update public.bulletin_lignes set montant_salarial = 0 where bulletin_id = %L', :'b_juillet'), 'ne se modifient pas');
call test.connexion(:'admin', 'aal2');
select test.doit_echouer(format('select public.admin_enregistrer_bulletin(%L, %L, %L)', :'nadia', '2026-07-01', '{}'), 'déjà validé');
select test.doit_echouer(format('select public.admin_enregistrer_temps(%L, %L)', :'nadia', '[{"jour": "2026-07-20", "heures": 7}]'),
                         'payée sur un bulletin validé');
select test.doit_echouer(format('select public.admin_enregistrer_absence(null, %L, %L, %L, %L)', :'nadia', 'sans_solde', '2026-07-27', '2026-07-28'),
                         'Le bulletin de juillet 2026 est validé');

-- Ordre des mois : septembre ne se valide pas avant août
select (public.admin_enregistrer_bulletin(:'nadia', '2026-09-01', '{}')) ->> 'id' as b_sept_tot \gset
select test.verifier((select b.calcul -> 'controles' @> '[{"code": "precedent", "niveau": "bloquant"}]'::jsonb
                      from public.bulletins b where b.id = :'b_sept_tot'), 'septembre avant août : contrôle bloquant (cumuls et congés)');
select test.doit_echouer(format('select public.admin_valider_bulletin(%L)', :'b_sept_tot'), 'Aucun bulletin validé en août 2026');
delete from public.bulletins where id = :'b_sept_tot';
select test.verifier(not exists (select 1 from public.bulletins where id = :'b_sept_tot'), 'brouillon supprimable par l''administration');

-- Août : prime exceptionnelle de 100 € ; congés pris du 17 au 22
select (public.admin_enregistrer_bulletin(:'nadia', '2026-08-01', '{"primes": [{"libelle": " Prime exceptionnelle ", "montant": 100}]}')) ->> 'id' as b_aout \gset
select public.admin_valider_bulletin(:'b_aout');
-- Référence : brut 2 000,00 ; salariales 440,39 ; patronales 225,62 (réduction
-- 628,40) ; net avant impôt 1 559,61 ; net imposable 1 638,72 ; taux neutre
-- 0,5 % : 8,19 ; net à payer 1 551,42 ; coût 2 225,62 ; congés : 6 pris,
-- solde −1,40 (pris par anticipation)
select test.verifier((select b.brut = 2000.00 and b.total_cotisations_salariales = 440.39 and b.total_cotisations_patronales = 225.62
                             and b.net_avant_impot = 1559.61 and b.net_imposable = 1638.72 and b.taux_pas = 0.5 and b.montant_pas = 8.19
                             and b.net_a_payer = 1551.42 and b.cout_employeur = 2225.62 and b.allegements = 628.40
                             and b.variables -> 'primes' = '[{"libelle": "Prime exceptionnelle", "montant": 100}]'::jsonb
                             and b.calcul ->> 'precedent' = 'bulletin'
                             and (b.conges ->> 'pris_mois')::numeric = 6 and (b.conges ->> 'n_solde')::numeric = -1.40
                             and (b.cumuls ->> 'brut')::numeric = 3640.91 and (b.cumuls ->> 'rgdu')::numeric = 1217.16
                             and b.calcul -> 'controles' @> '[{"code": "conges", "niveau": "attention"}]'::jsonb
                      from public.bulletins b where b.id = :'b_aout'),
                     'août : chaque montant égal au calcul de référence, cumuls de l''année, congés pris par anticipation signalés');

-- Septembre : préparation (heures majorées des semaines payées ce mois-ci,
-- absence maladie en heures, prime du mois précédent proposée)
select test.verifier((select (x -> 'suggestion' ->> 'heures_sup_25')::numeric = 11 and (x -> 'suggestion' ->> 'heures_sup_50')::numeric = 1
                             and x -> 'suggestion' -> 'absences' = '[{"libelle": "Absence maladie du 14/09 au 16/09", "heures": 21}]'::jsonb
                             and x -> 'precedent' -> 'primes' = '[{"libelle": "Prime exceptionnelle", "montant": 100}]'::jsonb
                      from (select public.admin_preparer_bulletin(:'nadia', '2026-09-01') as x) t),
                     'préparation de septembre : heures majorées, absence maladie de 21 h, prime d''août proposée');
-- Variables mal saisies : messages clairs
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'nadia', '2026-09-01', '{"heures_sup_25": "dix"}'), 'nombre attendu');
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'nadia', '2026-09-01', '{"heures_comp_10": 2}'), 'concernent un temps partiel');
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'nadia', '2026-09-01',
                                '{"absences": [{"libelle": "Absence", "heures": 160}]}'), 'dépassent les heures payées');
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'nadia', '2026-09-01',
                                '{"primes": [{"libelle": " ", "montant": 10}]}'), 'chaque ligne a un libellé');
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'nadia', '2026-09-01', '{"date_paiement": "2026-12-31"}'),
                         'Date de paiement : entre le 01/09/2026 et le 15/10/2026');
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'nadia', '2026-06-01', '{}'),
                         'n''est pas sous contrat en juin 2026');
select (public.admin_enregistrer_bulletin(:'nadia', '2026-09-01', jsonb_build_object(
  'heures_sup_25', 11, 'heures_sup_50', 1,
  'absences', '[{"libelle": "Absence maladie du 14/09 au 16/09", "heures": 21}]'::jsonb,
  'non_soumis', '[{"libelle": "Remboursement transport (50 %)", "montant": 43.20}]'::jsonb,
  'acompte', 300, 'date_paiement', '2026-10-02'))) ->> 'id' as b_sept \gset
select public.admin_valider_bulletin(:'b_sept');
-- Référence : heures supplémentaires 191,04 € (taux majorés 15,659 et
-- 18,7908) ; réduction salariale 21,61 ; déduction patronale 18,00 ;
-- réduction générale 619,29 ; brut 1 827,97 ; salariales 382,93 ;
-- patronales 145,12 ; net avant impôt 1 445,04 ; heures supplémentaires
-- exonérées 191,04 (CSG non déductible 12,76) ; net imposable 1 340,97 ;
-- taux neutre 0 % ; net à payer 1 188,24 ; coût 1 973,09 ; congés : 2,45
-- acquis (3 jours de maladie à 2 jours par mois), solde 1,05
select test.verifier((select b.brut = 1827.97 and b.total_cotisations_salariales = 382.93 and b.total_cotisations_patronales = 145.12
                             and b.net_avant_impot = 1445.04 and b.net_social = 1445.04 and b.net_imposable = 1340.97 and b.montant_pas = 0
                             and b.net_a_payer = 1188.24 and b.cout_employeur = 1973.09 and b.allegements = 637.29 and b.date_paiement = '2026-10-02'
                             and (b.calcul -> 'heures_sup' ->> 'montant')::numeric = 191.04
                             and (b.calcul -> 'heures_sup' ->> 'reduction_salariale')::numeric = 21.61
                             and (b.calcul -> 'heures_sup' ->> 'deduction_patronale')::numeric = 18.00
                             and (b.calcul -> 'heures_sup' ->> 'exoneration_impot')::numeric = 191.04
                             and (b.calcul -> 'heures_sup' ->> 'csg_non_deductible')::numeric = 12.76
                             and (b.calcul -> 'rgdu' ->> 'reduction_mois')::numeric = 619.29
                             and (b.conges ->> 'acquis_mois')::numeric = 2.45 and (b.conges ->> 'n_solde')::numeric = 1.05
                             and exists (select 1 from jsonb_array_elements(b.calcul -> 'remuneration') r
                                          where r ->> 'code' = 'heures_sup_25' and (r ->> 'taux')::numeric = 15.659 and (r ->> 'montant')::numeric = 172.25)
                             and b.calcul -> 'apres_net' = '[{"code": "non_soumis", "libelle": "Remboursement transport (50 %)", "montant": 43.20},
                                                           {"code": "acompte", "libelle": "Acompte versé", "montant": -300}]'::jsonb
                      from public.bulletins b where b.id = :'b_sept'),
                     'septembre : heures supplémentaires, maladie, transport et acompte égaux au calcul de référence, au centime');


-- #############################################################################
-- 8. KARIM (TEMPS PARTIEL) ET SOPHIE (CADRE, REPRISE D'UNE PAIE FAITE AILLEURS)
-- #############################################################################
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'karim', '2026-09-01', '{"heures_sup_25": 2}'),
                         'temps partiel fait des heures complémentaires');
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'karim', '2026-08-01', '{}'), 'n''est pas sous contrat en août 2026');
select (public.admin_enregistrer_bulletin(:'karim', '2026-09-01', '{"heures_comp_10": 4.40, "heures_comp_25": 1.60}')) ->> 'id' as b_karim \gset
select public.admin_valider_bulletin(:'b_karim');
-- Référence : plafond réduit à 2 746,23 (104 h / 151,67 h) ; brut 1 385,50 ;
-- salariales 302,66 (réduction sur heures complémentaires 9,67) ;
-- patronales 107,90 ; net imposable 1 064,65 ; taux personnalisé 3,2 % :
-- 34,07 ; net à payer 1 048,77 ; coût 1 493,40
select test.verifier((select b.brut = 1385.50 and b.total_cotisations_salariales = 302.66 and b.total_cotisations_patronales = 107.90
                             and b.net_avant_impot = 1082.84 and b.net_imposable = 1064.65 and b.taux_pas = 3.2 and b.montant_pas = 34.07
                             and b.net_a_payer = 1048.77 and b.cout_employeur = 1493.40 and b.taux_horaire = 12.5
                             and (b.calcul -> 'constantes' ->> 'plafond_applique')::numeric = 2746.23
                             and (b.calcul -> 'heures_sup' ->> 'reduction_salariale')::numeric = 9.67
                             and (b.calcul -> 'heures_sup' ->> 'deduction_patronale')::numeric = 0
                             and b.calcul -> 'pas' ->> 'type' = 'personnalise'
                             and exists (select 1 from jsonb_array_elements(b.calcul -> 'allegements') a
                                          where a ->> 'libelle' = 'Réduction de cotisations salariales sur heures complémentaires')
                      from public.bulletins b where b.id = :'b_karim'),
                     'Karim (temps partiel) : plafond réduit, heures complémentaires, taux personnalisé, égaux au calcul de référence');

-- Sophie : entrée en 2025, aucun bulletin ici avant septembre → bloquant
select (public.admin_enregistrer_bulletin(:'sophie', '2026-09-01', '{}')) ->> 'id' as b_sophie \gset
select test.verifier((select b.calcul -> 'controles' @> '[{"code": "precedent", "niveau": "bloquant"}]'::jsonb
                      from public.bulletins b where b.id = :'b_sophie'), 'Sophie sans reprise : cumuls de l''année inconnus, bloquant');
select test.doit_echouer(format('select public.admin_enregistrer_reprise(%L, %L, %L, 8.5, 7.5)', :'sophie', '2026-09-01', '{"brut": 19200}'),
                         'Un bulletin existe déjà pour septembre 2026');
select test.doit_echouer(format('select public.admin_enregistrer_reprise(%L, %L, %L, 8.5, 7.5)', :'sophie', '2026-08-01', '{"inconnu": 1}'),
                         'Cumul inconnu');
select test.doit_echouer(format('select public.admin_enregistrer_reprise(%L, %L, %L, 8.5, 7.5)', :'sophie', '2026-08-01', '{"brut": 19200}'),
                         'heures payées');
select public.admin_enregistrer_reprise(:'sophie', '2026-08-01',
  '{"brut": 19200.00, "heures": 1213.36, "smic_rgdu": 14584.27, "rgdu": 3703.68, "net_imposable": 15100.00, "pas": 800.00, "cout_employeur": 26500.00}',
  8.5, 7.5, 'Cumuls du bulletin d''août 2026 du cabinet');
select test.doit_echouer(format('select public.admin_calculer_bulletin(%L, %L, %L)', :'sophie', '2026-08-01', '{}'), 'a été faite ailleurs');
select public.admin_enregistrer_bulletin(:'sophie', '2026-09-01', '{}');
select public.admin_valider_bulletin(:'b_sophie');
-- Référence : brut 2 400,00 ; prévoyance des cadres 36,00 et Apec ;
-- salariales 527,82 ; patronales 594,42 (réduction générale 462,96 sur les
-- cumuls repris, coefficient 0,1929) ; net social 1 908,18 (prévoyance
-- patronale ajoutée) ; net imposable 1 963,73 ; taux neutre 2,9 % : 56,95 ;
-- net à payer 1 815,23 ; coût 2 994,42 ; congés : 8,5 (N-1) et 10 (N)
select test.verifier((select b.brut = 2400.00 and b.total_cotisations_salariales = 527.82 and b.total_cotisations_patronales = 594.42
                             and b.net_avant_impot = 1872.18 and b.net_social = 1908.18 and b.net_imposable = 1963.73 and b.taux_pas = 2.9
                             and b.montant_pas = 56.95 and b.net_a_payer = 1815.23 and b.cout_employeur = 2994.42 and b.allegements = 462.96
                             and b.calcul ->> 'precedent' = 'reprise' and (b.calcul -> 'rgdu' ->> 'coefficient')::numeric = 0.1929
                             and (b.cumuls ->> 'brut')::numeric = 21600 and (b.cumuls ->> 'rgdu')::numeric = 4166.64
                             and (b.conges ->> 'n1_solde')::numeric = 8.5 and (b.conges ->> 'n_solde')::numeric = 10
                             and exists (select 1 from jsonb_array_elements(b.calcul -> 'cotisations') c where c ->> 'code' = 'apec')
                             and exists (select 1 from jsonb_array_elements(b.calcul -> 'cotisations') c
                                          where c ->> 'code' = 'prevoyance_cadres' and (c ->> 'montant_patronal')::numeric = 36.00)
                      from public.bulletins b where b.id = :'b_sophie'),
                     'Sophie (cadre, reprise) : prévoyance, Apec, net social, réduction générale sur les cumuls repris, égaux au calcul de référence');
-- Reprise de Paul : SMIC des heures payées calculé s'il n'est pas indiqué
select public.admin_enregistrer_reprise(:'paul', '2026-09-01', '{"brut": 1801.80, "heures": 151.67}', 0, 2.5);
select test.verifier((select (r.cumuls ->> 'smic_rgdu')::numeric = 1823.07 from public.reprises_paie r where r.salarie_id = :'paul'),
                     'reprise : SMIC des heures payées calculé (12,02 € × 151,67 h)');


-- #############################################################################
-- 9. LISTE DU MOIS, DOCUMENT, REMISE, VUE DE LA SALARIÉE, RENTABILITÉ
-- #############################################################################
select test.verifier((select (x -> 'totaux' ->> 'brut')::numeric = 5613.47 and (x -> 'totaux' ->> 'valides')::integer = 3
                             and (x -> 'totaux' ->> 'brouillons')::integer = 0 and (x -> 'manquants')::integer = 0
                             and (x -> 'parametres' ->> 'valides')::boolean
                             and jsonb_array_length(x -> 'lignes') = 4
                      from (select public.admin_lister_bulletins('2026-09-15') as x) t),
                     'bulletins de septembre : 3 validés (1 827,97 + 1 385,50 + 2 400,00 de brut), Paul couvert par sa reprise');
select test.verifier((select (x -> 'calcul' ->> 'net_a_payer')::numeric = 1188.24 and x ->> 'statut' = 'valide' and x ->> 'valide_par_nom' is not null
                      from (select public.admin_document_bulletin(:'b_sept') as x) t), 'document : le bulletin tel que validé');
select test.doit_echouer(format('select public.admin_remettre_bulletin(%L, %L)', :'b_sept', 'autre/x.pdf'), 'Chemin du fichier invalide');
select public.admin_remettre_bulletin(:'b_sept', :'nadia' || '/bulletins/2026-09.pdf');
select test.verifier((select b.statut = 'envoye' and b.pdf_chemin = :'nadia' || '/bulletins/2026-09.pdf' from public.bulletins b where b.id = :'b_sept'),
                     'septembre remis à la salariée avec son PDF');
call test.systeme();
select test.doit_echouer(format('update public.bulletins set statut = %L where id = %L', 'valide', :'b_sept'), 'ne se modifie plus');
call test.connexion(:'chauffeuse');
select test.verifier((select count(*) from public.bulletins) = 3 and (select count(*) from public.bulletin_lignes) > 0
                     and (select count(*) from public.salaries) = 1,
                     'la salariée voit ses 3 bulletins validés, leurs lignes et sa seule fiche');
select test.doit_echouer(format('select public.admin_document_bulletin(%L)', :'b_sept'), 'Réservé à l''administration');
call test.connexion(:'admin', 'aal2');
select test.verifier((select (c -> 'cout_salarial' ->> 'montant')::numeric = 1756.70 + 2225.62 + 1973.09
                             and (c -> 'cout_salarial' ->> 'bulletins')::integer = 3
                      from jsonb_array_elements(public.admin_rentabilite_chauffeurs('2026-07-01', '2026-09-30') -> 'chauffeurs') c
                      where c ->> 'chauffeur_id' = :'chauffeuse'),
                     'rentabilité : le coût salarial de Nadia est le coût total employeur de ses 3 bulletins validés');


-- #############################################################################
-- 10. SOLDES DE CONGÉS, PARAMÈTRES 2027, SUPPRESSIONS, JOURNAL
-- #############################################################################
select test.verifier((select (s ->> 'n_solde')::numeric = 1.05 and s ->> 'au' = '2026-09-01' and (s ->> 'pris_ensuite')::numeric = 5
                      from jsonb_array_elements(public.admin_lister_absences('2026-07-01', '2026-12-31') -> 'soldes') s
                      where s ->> 'salarie_id' = :'nadia')
                     and (select count(*) = 0 from jsonb_array_elements(public.admin_lister_absences('2026-07-01', '2026-12-31') -> 'demandes') d
                          where d ->> 'salarie_id' = :'nadia')
                     and (select count(*) = 1 from jsonb_array_elements(public.admin_lister_absences('2026-07-01', '2026-12-31') -> 'demandes') d
                          where d ->> 'salarie_id' = :'paul'),
                     'congés de Nadia : solde au dernier bulletin, 5 jours acceptés pour décembre ; seule la demande de Paul attend');
select public.admin_copier_parametres_paie(2026, 2027);
select test.verifier((select not c.valide_par_comptable and c.plafond_mensuel_ss = 4005 and c.rgdu_taux_at = 0.49
                      from public.constantes_paie c where c.annee = 2027)
                     and (select count(*) from public.parametres_paie where annee = 2027) = 20
                     and (select taux_patronal from public.parametres_paie where annee = 2027 and code = 'at_mp') = 0.90,
                     'copie vers 2027 : non validée, 20 lignes reprises (taux AT compris)');
select test.doit_echouer('select public.admin_copier_parametres_paie(2026, 2027)', 'existent déjà');
-- Un salarié avec des bulletins ne se supprime pas ; une fiche créée par erreur, si
select test.doit_echouer(format('delete from public.salaries where id = %L', :'karim'), 'foreign key');
select (public.admin_enregistrer_salarie(null, '{"prenom": "Erreur", "nom": "Saisie", "type_contrat": "CDI", "date_entree": "2026-11-02",
                                                "salaire_base_mensuel": 1900}')) ->> 'id' as erreur \gset
delete from public.salaries where id = :'erreur';
select test.verifier(not exists (select 1 from public.salaries where id = :'erreur'), 'fiche créée par erreur : supprimable');

call test.systeme();
select test.verifier(exists (select 1 from prive.journal j where j.table_cible = 'constantes_paie' and j.action = 'UPDATE'
                               and j.apres ->> 'validation_note' = 'Validation retirée : Correction demandée par le cabinet')
                     and exists (select 1 from prive.journal j where j.table_cible = 'bulletins' and j.action = 'DELETE')
                     and exists (select 1 from prive.journal j where j.table_cible = 'reprises_paie' and j.action = 'INSERT')
                     and exists (select 1 from prive.journal j where j.table_cible = 'parametres_paie' and j.action = 'UPDATE'
                                   and j.apres ->> 'taux_patronal' = '0.9000'),
                     'journal : validation retirée, brouillon supprimé, reprise, taux AT');
select test.verifier(not has_function_privilege('anon', 'public.admin_valider_bulletin(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.admin_valider_bulletin(uuid)', 'execute')
                     and not has_function_privilege('authenticated', 'prive.calculer_bulletin(uuid, date, jsonb)', 'execute')
                     and not has_table_privilege('authenticated', 'public.bulletins', 'insert')
                     and not has_table_privilege('authenticated', 'public.bulletins', 'update')
                     and has_table_privilege('authenticated', 'public.bulletins', 'delete'),
                     'fonctions du module : fermées aux visiteurs ; bulletins écrits par les fonctions seulement');
select test.verifier(not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
                     'toutes les tables restent protégées ligne par ligne');

\o
\echo '✔ RH et paie : tout est conforme.'
