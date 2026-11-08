-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 29 : SUPPRESSIONS PAR L'ADMINISTRATION, COMPLÉMENTS
-- -----------------------------------------------------------------------------
-- Ce que les boutons « Supprimer » des modules demandent en plus de la
-- migration 28 :
--   1. fiche d'une course (admin_fiche_course) : chaque message de la
--      conversation entre le client et le chauffeur porte son identifiant,
--      pour être supprimé un par un (admin_supprimer_message) ;
--   2. un compte au rôle « chauffeur » sans fiche chauffeur (rôle changé
--      directement dans la base) se supprime depuis le module Chauffeurs
--      (admin_supprimer_chauffeur) ;
--   3. messages de refus d'une course ou d'un paiement facturés : ils
--      nomment les boutons de la page (« Annuler la somme », « Rembourser »)
--      qui établissent l'avoir corrigeant la facture.
-- Les droits d'exécution ne changent pas (create or replace les garde).
-- =============================================================================


-- #############################################################################
-- 1. FICHE D'UNE COURSE : IDENTIFIANT DES MESSAGES DE LA CONVERSATION
-- #############################################################################
CREATE OR REPLACE FUNCTION public.admin_fiche_course(p_course uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_course public.courses;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;

  return jsonb_build_object(
    'course', to_jsonb(v_course),
    'categorie', (select cat.nom_fr from public.categories cat where cat.id = v_course.categorie_id),
    'client', (select jsonb_build_object('id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email,
                                         'telephone', p.telephone, 'statut', p.statut, 'langue', p.langue)
               from public.profils p where p.id = v_course.client_id),
    'chauffeur', (select jsonb_build_object('id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email,
                                            'telephone', p.telephone)
                  from public.profils p where p.id = v_course.chauffeur_id),
    'attribuee_par', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = v_course.attribuee_par),
    'tarif', (select to_jsonb(t) from public.tarifs t where t.id = v_course.tarif_id),
    'forfait', (select jsonb_build_object('prix', f.prix, 'zone_a', za.nom, 'zone_b', zb.nom)
                from public.forfaits f
                join public.zones za on za.id = f.zone_a_id
                join public.zones zb on zb.id = f.zone_b_id
                where f.id = v_course.forfait_id),
    'code_promo', (select cp.code from public.codes_promo cp where cp.id = v_course.code_promo_id),
    'compte_pro', (select cp.raison_sociale from public.comptes_pro cp where cp.id = v_course.compte_pro_id),
    'arrets', coalesce((select jsonb_agg(jsonb_build_object('ordre', a.ordre, 'adresse', a.adresse,
                                                           'latitude', a.latitude, 'longitude', a.longitude) order by a.ordre)
                        from public.course_arrets a where a.course_id = v_course.id), '[]'::jsonb),
    'evenements', coalesce((select jsonb_agg(jsonb_build_object('type', e.type, 'cree_le', e.cree_le, 'details', e.details,
                                                               'acteur_nom', nullif(trim(p.prenom || ' ' || p.nom), ''),
                                                               'acteur_role', p.role) order by e.cree_le, e.id)
                            from public.evenements_course e left join public.profils p on p.id = e.acteur_id
                            where e.course_id = v_course.id), '[]'::jsonb),
    'propositions', coalesce((select jsonb_agg(jsonb_build_object('chauffeur_nom', nullif(trim(p.prenom || ' ' || p.nom), ''),
                                                                 'statut', pr.statut, 'distance_km', pr.distance_km,
                                                                 'envoyee_le', pr.envoyee_le, 'expire_le', pr.expire_le,
                                                                 'repondue_le', pr.repondue_le) order by pr.envoyee_le)
                              from public.propositions pr join public.profils p on p.id = pr.chauffeur_id
                              where pr.course_id = v_course.id), '[]'::jsonb),
    'paiements', coalesce((select jsonb_agg(prive.ligne_paiement(pa.id) order by pa.cree_le)
                           from public.paiements pa where pa.course_id = v_course.id), '[]'::jsonb),
    'remboursements', coalesce((select jsonb_agg(jsonb_build_object('paiement_id', r.paiement_id, 'montant', r.montant,
                                                                   'motif', r.motif, 'mode', r.mode, 'cree_le', r.cree_le,
                                                                   'cree_par', nullif(trim(p.prenom || ' ' || p.nom), ''),
                                                                   'avoir_id', a.id, 'avoir_numero', a.numero)
                                                 order by r.cree_le)
                                from public.remboursements r
                                join public.paiements pa on pa.id = r.paiement_id
                                left join public.profils p on p.id = r.cree_par
                                left join public.avoirs a on a.remboursement_id = r.id
                                where pa.course_id = v_course.id), '[]'::jsonb),
    'factures', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'numero', f.numero, 'nature', f.nature,
                                                             'date_emission', f.date_emission, 'montant_ht', f.montant_ht,
                                                             'taux_tva', f.taux_tva, 'montant_tva', f.montant_tva,
                                                             'montant_ttc', f.montant_ttc, 'pourboire', f.pourboire,
                                                             'statut', f.statut, 'pdf_chemin', f.pdf_chemin) order by f.numero)
                          from public.factures f where f.course_id = v_course.id), '[]'::jsonb),
    'avoirs', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'numero', a.numero, 'date_emission', a.date_emission,
                                                           'origine', a.origine, 'motif', a.motif, 'facture_numero', f.numero,
                                                           'montant_ht', a.montant_ht, 'taux_tva', a.taux_tva,
                                                           'montant_tva', a.montant_tva, 'montant_ttc', a.montant_ttc) order by a.numero)
                        from public.avoirs a join public.factures f on f.id = a.facture_id
                        where a.course_id = v_course.id), '[]'::jsonb),
    'evaluations', coalesce((select jsonb_agg(jsonb_build_object('sens', e.sens, 'note', e.note,
                                                                'commentaire', e.commentaire, 'cree_le', e.cree_le) order by e.cree_le)
                             from public.evaluations e where e.course_id = v_course.id), '[]'::jsonb),
    -- Support : demandes liées à la course, objets trouvés, conversation
    -- entre le client et le chauffeur (lecture)
    'demandes', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'numero', d.numero, 'sujet', d.sujet, 'type', d.type,
                                                             'statut', d.statut, 'cree_le', d.cree_le,
                                                             'auteur', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email),
                                                             'auteur_role', p.role) order by d.cree_le desc)
                          from public.demandes d join public.profils p on p.id = d.auteur_id
                          where d.course_id = v_course.id), '[]'::jsonb),
    'objets', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'numero', o.numero, 'description', o.description,
                                                           'statut', o.statut, 'trouve_le', o.trouve_le) order by o.trouve_le desc, o.numero)
                        from public.objets_trouves o where o.course_id = v_course.id), '[]'::jsonb),
    'conversation', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', m.id,
                                'auteur_nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Compte supprimé'),
                                'auteur_role', case when m.auteur_id = v_course.client_id then 'client'
                                                    when m.auteur_id = v_course.chauffeur_id then 'chauffeur' else 'administration' end,
                                'contenu', m.contenu, 'piece_jointe', m.piece_jointe_chemin is not null, 'cree_le', m.cree_le)
                                order by m.cree_le, m.id)
                              from public.messages m left join public.profils p on p.id = m.auteur_id
                              where m.course_id = v_course.id), '[]'::jsonb)
  );
end;
$function$;


-- #############################################################################
-- 2. CHAUFFEUR SANS FICHE : SUPPRESSION DEPUIS LE MODULE CHAUFFEURS
-- #############################################################################
create or replace function public.admin_supprimer_chauffeur(p_chauffeur uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil public.profils;
  v_statut text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select ch.statut into v_statut from public.chauffeurs ch where ch.id = p_chauffeur;
  select * into v_profil from public.profils p where p.id = p_chauffeur;
  -- Un compte au rôle « chauffeur » sans fiche chauffeur (rôle changé
  -- directement dans la base) se supprime aussi d'ici
  if v_profil.id is null or (v_statut is null and v_profil.role <> 'chauffeur') then
    raise exception 'Chauffeur introuvable.';
  end if;
  if v_statut = 'supprime' or v_profil.statut = 'supprime' then
    raise exception 'Ce chauffeur est déjà supprimé.';
  end if;
  if v_profil.id = auth.uid() then
    raise exception 'Vous ne pouvez pas supprimer votre propre compte.';
  end if;
  if v_profil.role = 'admin' then
    raise exception 'Ce compte est administrateur : retirez d''abord son rôle (Paramètres, Administrateurs).';
  end if;
  return prive.supprimer_compte(p_chauffeur, 'administration');
end;
$$;


-- #############################################################################
-- 3. MESSAGES DE REFUS : LES BOUTONS DE LA PAGE
-- #############################################################################
create or replace function public.admin_supprimer_course(p_course uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course  public.courses;
  v_piece   text;
  v_montant numeric;
  v_noter   boolean;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut not in ('terminee', 'annulee') then
    raise exception 'La course % n''est pas terminée : annulez-la d''abord (le client et le chauffeur sont prévenus), puis supprimez-la.', v_course.numero;
  end if;
  select f.numero into v_piece from public.factures f where f.course_id = p_course order by f.numero limit 1;
  if v_piece is not null then
    raise exception 'La facture % a été émise pour cette course : la loi impose de la conserver 10 ans, avec sa course. Pour ne plus réclamer une somme ou pour la rendre, utilisez « Annuler la somme » ou « Rembourser » dans ses paiements : un avoir corrige la facture.', v_piece;
  end if;
  select a.numero into v_piece from public.avoirs a where a.course_id = p_course order by a.numero limit 1;
  if v_piece is not null then
    raise exception 'L''avoir % a été établi pour cette course : la loi impose de le conserver 10 ans, avec sa course.', v_piece;
  end if;
  select pa.montant into v_montant from public.paiements pa
   where pa.course_id = p_course and pa.statut in ('encaisse', 'rembourse') limit 1;
  if v_montant is not null then
    raise exception 'Un paiement de % a été encaissé pour cette course : c''est une écriture comptable, conservée 10 ans avec sa course.', prive.euros(v_montant);
  end if;
  if exists (select 1 from public.ecritures_solde e where e.course_id = p_course) then
    raise exception 'Le solde d''un client a bougé avec cette course : l''écriture reste dans la comptabilité, avec sa course.';
  end if;

  v_noter := exists (select 1 from public.evaluations e where e.course_id = p_course and e.sens = 'client_vers_chauffeur');
  delete from public.paiements where course_id = p_course;            -- jamais encaissés (contrôlé ci-dessus)
  update public.demandes set course_id = null where course_id = p_course;
  update public.objets_trouves set course_id = null where course_id = p_course;
  perform prive.retirer_notifications_liees(p_course);
  delete from public.courses where id = p_course;                      -- arrêts, historique, conversation, notes…
  if v_noter and v_course.chauffeur_id is not null then
    perform prive.recalculer_note_chauffeur(v_course.chauffeur_id);
  end if;

  -- Journal : la course effacée n'y garde ni coordonnées ni trajet
  perform prive.journal_sans('courses', array[p_course::text],
    array['client_prenom', 'client_telephone', 'depart_precision', 'beneficiaire_nom', 'beneficiaire_telephone',
          'chauffeur_prenom', 'chauffeur_telephone', 'chauffeur_photo', 'depart_adresse', 'depart_lat', 'depart_lng',
          'arrivee_adresse', 'arrivee_lat', 'arrivee_lng', 'numero_vol', 'terminal', 'motif_annulation',
          'vehicule_immatriculation']);
  perform prive.journaliser_action('suppression_course', 'courses', p_course::text,
    jsonb_build_object('numero', v_course.numero, 'statut', v_course.statut));
  return jsonb_build_object('mode', 'efface', 'numero', v_course.numero);
end;
$$;

create or replace function public.admin_supprimer_paiement(p_paiement uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement public.paiements;
  v_facture  text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_paiement from public.paiements pa where pa.id = p_paiement for update;
  if v_paiement.id is null then
    raise exception 'Paiement introuvable.';
  end if;
  if v_paiement.statut in ('encaisse', 'rembourse') then
    raise exception 'Un paiement encaissé est une écriture comptable : la loi impose de le conserver 10 ans. Pour rendre l''argent, faites un remboursement.';
  end if;
  if exists (select 1 from public.remboursements r where r.paiement_id = p_paiement)
     or exists (select 1 from public.avoirs a where a.paiement_id = p_paiement) then
    raise exception 'Un remboursement ou un avoir porte sur ce paiement : il reste dans la comptabilité.';
  end if;
  select f.numero into v_facture from public.factures f
   where f.course_id = v_paiement.course_id and f.nature = v_paiement.nature and f.statut = 'emise'
   limit 1;
  if v_facture is not null then
    raise exception 'La facture % a été émise pour ce montant : elle se conserve 10 ans. Pour ne plus le réclamer, utilisez « Annuler la somme » : un avoir corrige la facture.', v_facture;
  end if;
  delete from public.paiements where id = p_paiement;
  perform prive.journaliser_action('suppression_paiement', 'paiements', p_paiement::text,
    jsonb_build_object('nature', v_paiement.nature, 'mode', v_paiement.mode, 'montant', v_paiement.montant,
                       'statut', v_paiement.statut));
  return jsonb_build_object('mode', 'efface');
end;
$$;
