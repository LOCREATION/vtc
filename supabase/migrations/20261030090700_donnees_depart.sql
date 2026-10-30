-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 8/8 : DONNÉES DE DÉPART
-- -----------------------------------------------------------------------------
-- Uniquement des informations réelles, toutes modifiables ensuite depuis
-- l'administration :
--   - identité de la société (extrait Kbis du 22/01/2026) ;
--   - réglages de la plateforme ;
--   - catégorie « Berline hybride » et son tarif, repris de la version 1 en
--     service (3,50 € + 1,70 €/km + 0,45 €/min, minimum 8 €, nuit +30 % de
--     22 h à 6 h, distance × 1,3 et 2,2 minutes par km) ;
--   - jours fériés 2026 à 2028 ;
--   - aéroports et grandes gares (zones de prise en charge et futurs forfaits).
-- Volontairement absents tant que les montants ne sont pas décidés : forfaits,
-- frais d'annulation, tarif de mise à disposition, supplément « chauffeuse »,
-- majorations du dimanche et des jours fériés, codes promo, questions fréquentes.
-- Chaque insertion est ignorée si la ligne existe déjà (rejouable sans risque).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Identité de la société
-- ---------------------------------------------------------------------------
-- À compléter dans l'administration : SIRET, code APE, n° de TVA, n° URSSAF,
-- n° d'inscription au registre des exploitants VTC, téléphone, WhatsApp.
insert into public.societe (
  id, raison_sociale, forme_juridique, capital, siren, rcs,
  adresse, code_postal, ville, pays,
  representant_nom, representant_qualite, email, site_web
) values (
  1, 'LOC RÉACTION S.A.S', 'SAS à associé unique', 1500.00, '100052570', 'RCS Pontoise 100 052 570',
  '1 allée de la Poire Bezy de Chaumontel', '95270', 'Chaumontel', 'France',
  'Régine Gatibelza', 'Présidente', 'locreaction@outlook.com', 'https://www.vtclocreation.site'
)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- 2. Réglages de la plateforme
-- ---------------------------------------------------------------------------
-- Les valeurs par défaut de la table s'appliquent, sauf :
--   - vitesse moyenne 27,3 km/h : 2,2 minutes par km, comme la version 1 ;
--   - zone desservie étendue au nord jusqu'à 49,50° pour inclure l'aéroport
--     de Beauvais (49,45° laissait l'aérogare juste à l'extérieur).
insert into public.parametres (id, vitesse_moyenne_kmh, zone_lat_max)
values (1, 27.3, 49.50)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- 3. Catégorie de véhicule et tarif
-- ---------------------------------------------------------------------------
insert into public.categories (code, nom_fr, nom_en, description_fr, description_en, places, bagages, ordre)
values (
  'berline_hybride', 'Berline hybride', 'Hybrid sedan',
  'Toyota Auris hybride ou équivalent, jusqu''à 4 passagers.',
  'Toyota Auris hybrid or similar, up to 4 passengers.',
  4, 2, 1
)
on conflict (code) do nothing;

-- Tarif en vigueur depuis le 1er octobre 2026 (repris de la version 1).
-- Attente, mise à disposition, annulation et option « chauffeuse » : à fixer.
insert into public.tarifs (
  categorie_id, valide_du, prise_en_charge, prix_km, prix_minute, minimum,
  prix_attente_minute, prix_heure_mad, frais_annulation, supplement_chauffeuse
)
select c.id, date '2026-10-01', 3.50, 1.70, 0.45, 8.00, 0, null, 0, 0
from public.categories c
where c.code = 'berline_hybride'
on conflict (categorie_id, valide_du) do nothing;

-- Majorations (non cumulables). Nuit : +30 % de 22 h à 6 h, comme la
-- version 1. Dimanche et jours fériés : prêtes, à activer avec un taux.
insert into public.majorations (type, pourcentage, heure_debut, heure_fin, active) values
  ('nuit',     30, time '22:00', time '06:00', true),
  ('dimanche',  0, null,         null,         false),
  ('ferie',     0, null,         null,         false)
on conflict (type) do nothing;


-- ---------------------------------------------------------------------------
-- 4. Jours fériés (France métropolitaine) — dates vérifiées
-- ---------------------------------------------------------------------------
insert into public.jours_feries (jour, libelle) values
  -- 2026 (Pâques le 5 avril)
  ('2026-01-01', 'Jour de l''an'),
  ('2026-04-06', 'Lundi de Pâques'),
  ('2026-05-01', 'Fête du Travail'),
  ('2026-05-08', 'Victoire 1945'),
  ('2026-05-14', 'Ascension'),
  ('2026-05-25', 'Lundi de Pentecôte'),
  ('2026-07-14', 'Fête nationale'),
  ('2026-08-15', 'Assomption'),
  ('2026-11-01', 'Toussaint'),
  ('2026-11-11', 'Armistice 1918'),
  ('2026-12-25', 'Noël'),
  -- 2027 (Pâques le 28 mars)
  ('2027-01-01', 'Jour de l''an'),
  ('2027-03-29', 'Lundi de Pâques'),
  ('2027-05-01', 'Fête du Travail'),
  ('2027-05-06', 'Ascension'),
  ('2027-05-08', 'Victoire 1945'),
  ('2027-05-17', 'Lundi de Pentecôte'),
  ('2027-07-14', 'Fête nationale'),
  ('2027-08-15', 'Assomption'),
  ('2027-11-01', 'Toussaint'),
  ('2027-11-11', 'Armistice 1918'),
  ('2027-12-25', 'Noël'),
  -- 2028 (Pâques le 16 avril)
  ('2028-01-01', 'Jour de l''an'),
  ('2028-04-17', 'Lundi de Pâques'),
  ('2028-05-01', 'Fête du Travail'),
  ('2028-05-08', 'Victoire 1945'),
  ('2028-05-25', 'Ascension'),
  ('2028-06-05', 'Lundi de Pentecôte'),
  ('2028-07-14', 'Fête nationale'),
  ('2028-08-15', 'Assomption'),
  ('2028-11-01', 'Toussaint'),
  ('2028-11-11', 'Armistice 1918'),
  ('2028-12-25', 'Noël')
on conflict (jour) do nothing;


-- ---------------------------------------------------------------------------
-- 5. Aéroports et grandes gares
-- ---------------------------------------------------------------------------
-- Centre et rayon couvrant les terminaux ou le parvis. Servent à demander la
-- précision utile (terminal, sortie) et, plus tard, aux forfaits.
insert into public.zones (code, nom, type, latitude, longitude, rayon_km) values
  ('aeroport_cdg',        'Aéroport Paris-Charles-de-Gaulle',  'aeroport', 49.009700, 2.547900, 4.00),
  ('aeroport_orly',       'Aéroport Paris-Orly',               'aeroport', 48.728000, 2.370000, 3.00),
  ('aeroport_beauvais',   'Aéroport Paris-Beauvais',           'aeroport', 49.454200, 2.112800, 1.50),
  ('aeroport_le_bourget', 'Aéroport Paris-Le Bourget',         'aeroport', 48.969400, 2.441400, 2.00),
  ('gare_du_nord',        'Gare du Nord',                      'gare',     48.880900, 2.355300, 0.40),
  ('gare_de_l_est',       'Gare de l''Est',                    'gare',     48.876800, 2.359200, 0.30),
  ('gare_de_lyon',        'Gare de Lyon',                      'gare',     48.844300, 2.374300, 0.40),
  ('gare_de_bercy',       'Gare de Bercy',                     'gare',     48.839200, 2.382600, 0.30),
  ('gare_d_austerlitz',   'Gare d''Austerlitz',                'gare',     48.842000, 2.365500, 0.40),
  ('gare_montparnasse',   'Gare Montparnasse',                 'gare',     48.840900, 2.320600, 0.40),
  ('gare_saint_lazare',   'Gare Saint-Lazare',                 'gare',     48.876300, 2.325300, 0.40),
  ('gare_marne_la_vallee','Gare de Marne-la-Vallée–Chessy',    'gare',     48.869700, 2.782800, 0.50),
  ('gare_massy_tgv',      'Gare de Massy TGV',                 'gare',     48.725400, 2.260300, 0.40)
on conflict (code) do nothing;
