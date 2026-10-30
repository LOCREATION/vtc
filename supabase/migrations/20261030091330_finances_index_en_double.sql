-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 14d : FINANCES — deux index en double retirés
-- -----------------------------------------------------------------------------
-- La migration 14a a posé deux index qui existaient déjà sous un autre nom :
-- la migration 2 (tables) indexe d'office chaque clé étrangère
-- (paiements_encaisse_par_fk_idx, remboursements_cree_par_fk_idx). Un index
-- en double ralentit chaque écriture sans accélérer aucune lecture : les deux
-- doublons sont retirés, les index d'origine restent.
-- Instructions destructives : sur la base en ligne, si l'outil de migration
-- ne peut pas afficher sa demande de confirmation, elles s'exécutent dans
-- l'éditeur SQL de Supabase.
-- =============================================================================

drop index public.paiements_encaisse_par_idx;
drop index public.remboursements_cree_par_idx;
