-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 11 : COMPLÉMENTS DE L'ADMINISTRATION
-- -----------------------------------------------------------------------------
--   1. Changement de chauffeur sur une réservation : l'ancien chauffeur est
--      prévenu (jusqu'ici, seul le nouveau l'était) ; attribuer la course au
--      chauffeur qui l'assure déjà est refusé avec un message clair.
--   2. Vérification d'un document par l'administration avec correction du
--      numéro et de la date d'expiration lus sur la pièce : un document validé
--      reporte ces informations sur la fiche du chauffeur ou du véhicule.
-- =============================================================================


-- #############################################################################
-- 1. ATTRIBUTION À LA MAIN (remplace la version de la migration 3)
-- #############################################################################
create or replace function public.attribuer_course(p_course uuid, p_chauffeur uuid)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course  public.courses;
  v_param   public.parametres;
  v_statut  text;
  v_ancien  uuid;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut not in ('planifiee', 'recherche', 'a_attribuer') then
    raise exception 'Cette course est déjà en cours, terminée ou annulée.';
  end if;
  if v_course.chauffeur_id = p_chauffeur then
    raise exception 'Ce chauffeur assure déjà cette course.';
  end if;
  if not exists (select 1 from public.chauffeurs c
                 join public.profils p on p.id = c.id and p.role = 'chauffeur' and p.statut = 'actif'
                 join public.vehicules v on v.id = c.vehicule_id and v.actif
                 where c.id = p_chauffeur and c.statut = 'valide') then
    raise exception 'Ce chauffeur n''est pas validé ou n''a pas de véhicule.';
  end if;
  if v_course.option_chauffeuse and not exists (select 1 from public.chauffeurs c where c.id = p_chauffeur and c.chauffeuse) then
    raise exception 'La cliente a demandé une chauffeuse.';
  end if;

  v_ancien := v_course.chauffeur_id;
  select * into v_param from public.parametres where id = 1;
  -- Réservation encore lointaine : elle reste « planifiée », chauffeur désigné.
  v_statut := case when v_course.prise_en_charge_le > now() + make_interval(mins => v_param.recherche_planifiee_avant_min)
                   then 'planifiee' else 'acceptee' end;

  -- Demandes encore en attente pour cette course : closes
  update public.propositions set statut = 'annulee', repondue_le = now()
   where course_id = p_course and statut = 'envoyee';

  v_course := prive.attribuer(p_course, p_chauffeur, 'manuelle', v_statut);
  perform prive.evenement(p_course, 'attribution_manuelle',
    jsonb_strip_nulls(jsonb_build_object('chauffeur_id', p_chauffeur, 'ancien_chauffeur_id', v_ancien)));
  perform prive.journaliser_action('attribution_manuelle', 'courses', p_course::text,
    jsonb_strip_nulls(jsonb_build_object('chauffeur_id', p_chauffeur, 'statut', v_statut, 'ancien_chauffeur_id', v_ancien)));

  -- L'ancien chauffeur d'une réservation confiée à quelqu'un d'autre est prévenu
  if v_ancien is not null then
    perform prive.notifier(v_ancien, 'course', 'Course retirée',
      'L''administration a confié la course ' || v_course.numero || ' du '
      || to_char(prive.heure_paris(v_course.prise_en_charge_le), 'DD/MM à HH24:MI') || ' à un autre chauffeur.',
      '/chauffeur/');
  end if;
  perform prive.notifier(p_chauffeur, 'course', 'Course attribuée',
    v_course.numero || ' · ' || to_char(prive.heure_paris(v_course.prise_en_charge_le), 'DD/MM HH24:MI') || ' · '
    || v_course.depart_adresse, '/chauffeur/');
  perform prive.notifier(v_course.client_id, 'course', 'Chauffeur attribué',
    v_course.chauffeur_prenom || ' assurera votre course en ' || v_course.vehicule_libelle
    || ' (' || v_course.vehicule_immatriculation || ').', '/client/course/?id=' || v_course.id);
  return v_course;
end;
$$;


-- #############################################################################
-- 2. VÉRIFICATION D'UN DOCUMENT AVEC CORRECTION DES INFORMATIONS LUES
-- #############################################################################
-- Le chauffeur ne saisit pas toujours le numéro ou la date d'expiration en
-- déposant sa pièce : l'administration les lit sur le document et les corrige
-- avant de valider. La validation elle-même reste celle de verifier_document
-- (report des dates sur la fiche, notification, journal).
create or replace function public.admin_verifier_document(
  p_document     uuid,
  p_statut       text,
  p_commentaire  text default null,
  p_numero       text default null,
  p_expire_le    date default null
)
returns public.documents
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut = 'valide' and p_expire_le is not null and p_expire_le < prive.heure_paris()::date then
    raise exception 'Ce document est expiré (%) : refusez-le et demandez la pièce à jour.', to_char(p_expire_le, 'DD/MM/YYYY');
  end if;
  update public.documents
     set numero    = coalesce(nullif(left(trim(coalesce(p_numero, '')), 60), ''), numero),
         expire_le = coalesce(p_expire_le, expire_le)
   where id = p_document;
  return public.verifier_document(p_document, p_statut, p_commentaire);
end;
$$;

revoke all on function public.admin_verifier_document(uuid, text, text, text, date) from public, anon;
grant execute on function public.admin_verifier_document(uuid, text, text, text, date) to authenticated;
