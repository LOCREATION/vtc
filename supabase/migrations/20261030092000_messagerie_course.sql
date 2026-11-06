-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 21 : MESSAGERIE DE LA COURSE (client ↔ chauffeur)
-- -----------------------------------------------------------------------------
-- Le client et le chauffeur d'une course s'écrivent depuis le suivi de la
-- course (client/course/) et la course du chauffeur (chauffeur/course/).
-- Jusqu'ici, la règle d'accès laissait écrire à tout moment, même des
-- semaines après la course. Désormais, un message de course s'écrit :
--   - pendant la course : acceptée, chauffeur arrivé, client à bord ;
--   - et pendant les 24 heures qui suivent sa fin (un objet oublié, un
--     dernier mot) ; ensuite, la conversation se lit mais ne s'écrit plus :
--     le support prend le relais (« Mes demandes »).
-- Un message vide (espaces seulement) est refusé.
-- Inchangé : la lecture (client et chauffeur de la course, administration),
-- le fil des demandes au support, et l'administration qui peut toujours
-- écrire. Marquer « lu » un message reçu reste possible à tout moment.
-- =============================================================================

alter policy messages_envoi on public.messages
  with check (
    auteur_id = (select auth.uid()) and lu_le is null and (
      (select public.est_admin())
      or (course_id is not null
          and contenu is not null and char_length(btrim(contenu)) between 1 and 2000
          and exists (
            select 1 from public.courses c where c.id = messages.course_id
            and (c.client_id = (select auth.uid()) or c.chauffeur_id = (select auth.uid()))
            and (c.statut in ('acceptee', 'arrivee', 'en_cours')
                 or (c.statut = 'terminee' and c.terminee_le > now() - interval '24 hours'))))
      or (demande_id is not null and exists (
            select 1 from public.demandes d where d.id = messages.demande_id and d.auteur_id = (select auth.uid())
            and d.statut in ('ouverte', 'en_cours')))
    )
  );

comment on policy messages_envoi on public.messages is
  'Message de course : client ou chauffeur de la course, pendant la course et 24 heures après sa fin. '
  'Message de demande : son auteur, tant qu''elle est ouverte ou en cours. Administration : toujours.';
