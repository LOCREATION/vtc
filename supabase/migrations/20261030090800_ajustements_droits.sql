-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 9 : AJUSTEMENT DES DROITS DU VISITEUR
-- -----------------------------------------------------------------------------
-- Après le contrôle de sécurité de Supabase : un visiteur sans compte n'a
-- besoin d'appeler que deux fonctions, l'estimation du prix et les voitures
-- à proximité. Les fonctions de contrôle de rôle (est_admin, mon_role…) ne lui
-- servaient qu'à la lecture des questions fréquentes : cette lecture passe
-- désormais par une règle sans fonction, et ces fonctions lui sont retirées.
-- Écrite sans aucune suppression (la règle existante est modifiée sur place) :
-- elle s'applique sans confirmation et sans fenêtre où la lecture serait coupée.
-- =============================================================================

-- Questions fréquentes : une règle par public.
-- La règle existante ne sert plus qu'aux utilisateurs connectés…
alter policy faq_lecture on public.faq
  to authenticated
  using (publie or (select public.est_admin()));
-- … et les visiteurs reçoivent la leur, sans appel de fonction.
create policy faq_lecture_publique on public.faq for select to anon
  using (publie);

-- Fonctions de contrôle de rôle : réservées aux utilisateurs connectés
revoke execute on function public.est_admin(), public.est_chauffeur_actif(), public.mon_role(),
                           public.peut_voir_course(uuid)
  from anon;

-- Extension « http » (installée en ligne pour charger les migrations depuis le
-- dépôt) : ses fonctions ne doivent être appelables ni par un visiteur ni par
-- un utilisateur connecté. Sans effet là où l'extension n'existe pas.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid and e.extname = 'http'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.signature);
  end loop;
end $$;
