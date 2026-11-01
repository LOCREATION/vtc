-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 17d : SUPPORT — la fiche d'une course montre son support
-- -----------------------------------------------------------------------------
-- La fiche d'une course (module Courses, migration 14b) reçoit les demandes
-- au support qui la concernent, les objets trouvés après elle et la
-- conversation entre le client et le chauffeur (lecture). Le reste de la
-- fonction est repris tel quel ; ses droits d'exécution sont conservés
-- (create or replace).
-- =============================================================================

create or replace function public.admin_fiche_course(p_course uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
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
                                'auteur_nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Compte supprimé'),
                                'auteur_role', case when m.auteur_id = v_course.client_id then 'client'
                                                    when m.auteur_id = v_course.chauffeur_id then 'chauffeur' else 'administration' end,
                                'contenu', m.contenu, 'piece_jointe', m.piece_jointe_chemin is not null, 'cree_le', m.cree_le)
                                order by m.cree_le, m.id)
                              from public.messages m left join public.profils p on p.id = m.auteur_id
                              where m.course_id = v_course.id), '[]'::jsonb)
  );
end;
$$;
