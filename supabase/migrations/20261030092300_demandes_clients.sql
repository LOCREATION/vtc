-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 24 : MES DEMANDES AU SUPPORT (espace client)
-- -----------------------------------------------------------------------------
-- Le client suit lui aussi ses demandes au support depuis son espace (onglet
-- Compte, page d'une course terminée ou annulée, notifications) :
--   1. prive.lien_demande : le lien d'une demande pour son auteur vaut
--      désormais pour un client (« /client/demandes/?id=… ») comme pour un
--      chauffeur ; les notifications du support (réponse, demande résolue ou
--      fermée, demande enregistrée par LOC RÉACTION) ouvrent la demande ;
--   2. pièce jointe déposée mais message refusé (demande close entre-temps,
--      réseau coupé) : son auteur peut retirer ce fichier tant qu'aucun
--      message ne l'utilise ; une pièce jointe d'un message reste, et seule
--      l'administration peut la retirer.
-- mes_demandes(), ouvrir_demande et les règles d'accès des demandes, des
-- messages et du dossier « support » valent déjà pour toute personne
-- connectée, client compris.
-- =============================================================================


-- #############################################################################
-- 1. LIEN D'UNE DEMANDE POUR SON AUTEUR : CHAUFFEUR OU CLIENT
-- #############################################################################
create or replace function prive.lien_demande(p_demande uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case p.role
           when 'chauffeur' then '/chauffeur/demandes/?id=' || d.id::text
           when 'client'    then '/client/demandes/?id=' || d.id::text
         end
  from public.demandes d join public.profils p on p.id = d.auteur_id
  where d.id = p_demande;
$$;

comment on function prive.lien_demande(uuid) is
  'Lien d''une demande au support pour son auteur (espace chauffeur ou espace client), '
  'porté par les notifications du support ; aucun lien pour un autre rôle.';

revoke all on function prive.lien_demande(uuid) from public, anon, authenticated;


-- #############################################################################
-- 2. PIÈCE JOINTE INUTILISÉE : SON AUTEUR PEUT LA RETIRER
-- #############################################################################
-- Le fichier est déposé avant le message qui l'utilise. Si le message est
-- refusé, l'application retire le fichier : seulement le sien (déposé par
-- lui), dans le dossier d'une de ses demandes, et qu'aucun message
-- n'utilise.
create policy support_auteur_retrait on storage.objects for delete to authenticated
  using (bucket_id = 'support'
         and owner_id = (select auth.uid())::text
         and exists (select 1 from public.demandes d
                     where d.id::text = (storage.foldername(objects.name))[1] and d.auteur_id = (select auth.uid()))
         and not exists (select 1 from public.messages m where m.piece_jointe_chemin = objects.name));
