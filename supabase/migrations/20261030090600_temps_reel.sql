-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 7/8 : TEMPS RÉEL ET RELANCE AUTOMATIQUE
-- -----------------------------------------------------------------------------
--   1. Temps réel : l'application est prévenue à l'instant d'un changement sur
--      les courses (suivi du client), les demandes envoyées aux chauffeurs, les
--      positions (voiture qui avance sur la carte), la messagerie et les
--      notifications. Chacun ne reçoit que ce que les règles d'accès lui
--      permettent de lire.
--   2. Relance automatique toutes les 20 secondes (pg_cron) : demande sans
--      réponse → chauffeur suivant ; réservation proche sans chauffeur →
--      recherche. L'application du chauffeur la déclenche aussi à la fin de son
--      compte à rebours : le dispatch avance même si la planification manque.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Temps réel
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['courses', 'propositions', 'positions', 'messages', 'notifications'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Relance automatique (si l'extension pg_cron est disponible)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;

    -- Relance du dispatch toutes les 20 secondes (même nom = tâche mise à jour)
    perform cron.schedule('relance-dispatch', '20 seconds', 'select public.relancer_dispatch()');

    -- Historique des exécutions : on ne garde que 3 jours (sinon plus de
    -- 4 000 lignes par jour s'accumulent). Tous les jours à 3 h 17 (UTC).
    perform cron.schedule('nettoyage-historique-planification', '17 3 * * *',
      'delete from cron.job_run_details where end_time < now() - interval ''3 days''');
  else
    raise notice 'pg_cron indisponible : la relance repose sur l''application du chauffeur.';
  end if;
end $$;
