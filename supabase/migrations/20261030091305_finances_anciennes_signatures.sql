-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 14b, préalable : FINANCES — anciennes signatures supprimées
-- -----------------------------------------------------------------------------
-- La migration 14b recrée deux fonctions avec un paramètre facultatif en plus :
--   - confirmer_encaissement(paiement, espèces reçues au bureau = non) ;
--   - rembourser(paiement, montant, motif, mode = celui du paiement).
-- Les anciennes versions doivent disparaître d'abord : deux versions d'une
-- même fonction, l'une avec un paramètre facultatif, rendraient ambigu
-- l'appel avec les seuls paramètres d'origine.
-- Ce sont les seules instructions destructives du module : sur la base en
-- ligne, elles s'exécutent dans l'éditeur SQL de Supabase (l'outil de
-- migration exige une confirmation qu'il ne peut pas afficher ici), puis la
-- migration 14b est appliquée aussitôt après.
-- =============================================================================

drop function public.confirmer_encaissement(uuid);
drop function public.rembourser(uuid, numeric, text);
