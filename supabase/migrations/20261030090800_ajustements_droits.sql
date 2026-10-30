-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 9 : AJUSTEMENT DES DROITS DU VISITEUR
-- -----------------------------------------------------------------------------
-- Après le contrôle de sécurité de Supabase : un visiteur sans compte n'a
-- besoin d'appeler que deux fonctions, l'estimation du prix et les voitures
-- à proximité. Les fonctions de contrôle de rôle (est_admin, mon_role…) ne lui
-- servaient qu'à la lecture des questions fréquentes : cette lecture passe
-- désormais par une règle sans fonction, et ces fonctions lui sont retirées.
-- =============================================================================

-- Questions fréquentes : une règle par public
drop policy faq_lecture on public.faq;
create policy faq_lecture_publique on public.faq for select to anon
  using (publie);
create policy faq_lecture on public.faq for select to authenticated
  using (publie or (select public.est_admin()));

-- Fonctions de contrôle de rôle : réservées aux utilisateurs connectés
revoke execute on function public.est_admin(), public.est_chauffeur_actif(), public.mon_role(),
                           public.peut_voir_course(uuid)
  from anon;
