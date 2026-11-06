-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 22 : NOTIFICATION DES MESSAGES DE COURSE
-- -----------------------------------------------------------------------------
-- Un message écrit dans la conversation d'une course prévient l'autre
-- personne par une notification (cloche de l'application) :
--   - le client écrit : son chauffeur reçoit « Message de Claire », avec le
--     lien de la course dans l'espace chauffeur ;
--   - le chauffeur écrit : son client reçoit « Message de Paul », avec le
--     lien du suivi de la course ;
--   - LOC RÉACTION écrit : le client et le chauffeur sont prévenus tous deux.
-- Une seule notification non lue par conversation : un nouveau message
-- reprend celle qui attend d'être lue (dernier texte, dernière heure) au lieu
-- d'en empiler une par message. Lire la conversation marque cette
-- notification « lue » (commun/discussion.js).
-- Les messages des demandes au support ne passent pas par ici : la réponse
-- de LOC RÉACTION est notifiée par admin_repondre_demande.
-- =============================================================================

create or replace function prive.notifier_message_course()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  c          record;
  v_extrait  text;
  v_dest     record;
begin
  if new.course_id is null then
    return new;
  end if;
  select x.id, x.client_id, x.chauffeur_id, x.client_prenom, x.chauffeur_prenom
    into c from public.courses x where x.id = new.course_id;
  if not found then
    return new;
  end if;
  -- Aperçu du message sur une ligne (200 caractères au plus)
  v_extrait := left(regexp_replace(btrim(coalesce(new.contenu, '')), '\s+', ' ', 'g'), 200);
  if v_extrait = '' then
    v_extrait := 'Nouveau message';
  end if;

  -- Destinataires : l'autre personne de la course (les deux quand LOC
  -- RÉACTION écrit), jamais l'auteur du message
  for v_dest in
    select d.destinataire, d.lien, d.titre
    from (values
      (c.chauffeur_id, '/chauffeur/course/?id=' || c.id::text,
       'Message de ' || case when new.auteur_id = c.client_id
                             then coalesce(nullif(btrim(c.client_prenom), ''), 'votre client')
                             else 'LOC RÉACTION' end),
      (c.client_id, '/client/course/?id=' || c.id::text,
       'Message de ' || case when new.auteur_id = c.chauffeur_id
                             then coalesce(nullif(btrim(c.chauffeur_prenom), ''), 'votre chauffeur')
                             else 'LOC RÉACTION' end)
    ) as d(destinataire, lien, titre)
    where d.destinataire is not null and d.destinataire <> new.auteur_id
  loop
    -- Notification de cette conversation encore non lue : reprise au dernier message
    update public.notifications n
       set titre = left(v_dest.titre, 120), message = v_extrait, cree_le = now()
     where n.destinataire_id = v_dest.destinataire and n.lien = v_dest.lien
       and n.type = 'course' and n.lu_le is null and n.titre like 'Message de %';
    if not found then
      perform prive.notifier(v_dest.destinataire, 'course', v_dest.titre, v_extrait, v_dest.lien);
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function prive.notifier_message_course() from public, anon, authenticated;

create trigger notifier_message_course
  after insert on public.messages
  for each row execute function prive.notifier_message_course();
