-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 26 : POURBOIRE EN FIN DE COURSE (ESPACE CLIENT)
-- -----------------------------------------------------------------------------
-- Le client laisse un pourboire depuis le suivi de sa course terminée
-- (client/course/). Il se règle comme la course :
--   - espèces : le client le remet à son chauffeur ;
--   - carte bancaire au terminal : le chauffeur l'encaisse sur son terminal ;
--   - facture mensuelle : il s'ajoute au relevé du mois de l'entreprise.
-- Règles ajoutées à ajouter_pourboire (le reste ne change pas : une seule
-- fois par course, de 0,50 € à 100 €, facture déjà émise inchangée, paiement
-- à part « pourboire » à encaisser) :
--   1. délai selon le mode de paiement de la course :
--        - espèces ou carte au terminal : 30 minutes après la fin de la
--          course (le chauffeur est encore là pour le recevoir ; plus tard,
--          il serait annoncé sans jamais pouvoir être encaissé) ;
--        - facture mensuelle : 24 heures, comme les messages de la course ;
--   2. course payée par le solde : refusé (ce mode n'existe pas encore à la
--      commande, même message que commander_course) ;
--   3. chauffeur prévenu selon le mode :
--        - espèces : « Pourboire en espèces », à recevoir du client ;
--        - carte : « Pourboire par carte », à encaisser sur le terminal ;
--          dans ces deux cas, le lien ouvre la course, où il confirme
--          l'encaissement (« Pourboire reçu ») ;
--        - facture mensuelle : « Pourboire reçu », lien vers ses revenus.
-- Signature, droits et lectures inchangés (le client lit déjà ses paiements,
-- le chauffeur ceux de ses courses).
-- =============================================================================


-- #############################################################################
-- 1. LAISSER UN POURBOIRE
-- #############################################################################
create or replace function public.ajouter_pourboire(p_course uuid, p_montant numeric)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course     public.courses;
  v_montant    numeric := round(p_montant, 2);
  -- Espèces ou carte au terminal : le pourboire se règle en personne
  v_sur_place  boolean;
begin
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null or v_course.client_id <> auth.uid() then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut <> 'terminee' then
    raise exception 'Le pourboire se donne une fois la course terminée.';
  end if;
  if v_course.pourboire > 0 then
    raise exception 'Vous avez déjà laissé un pourboire pour cette course.';
  end if;
  if v_course.mode_paiement = 'solde' then
    raise exception 'Le paiement par le solde arrive dans une prochaine version.';
  end if;

  -- Délai : 30 minutes en personne, 24 heures sur facture mensuelle. Une
  -- course terminée sans heure de fin (reprise d'une ancienne base) est
  -- traitée comme ancienne.
  v_sur_place := v_course.mode_paiement in ('especes', 'carte');
  if v_sur_place and coalesce(v_course.terminee_le, '-infinity'::timestamptz) < now() - interval '30 minutes' then
    raise exception 'Un pourboire en espèces ou par carte se donne à votre chauffeur dans les 30 minutes qui suivent la course.';
  end if;
  if not v_sur_place and coalesce(v_course.terminee_le, '-infinity'::timestamptz) < now() - interval '24 hours' then
    raise exception 'Le pourboire se donne dans les 24 heures qui suivent la course.';
  end if;

  if p_montant is null or p_montant < 0.5 or p_montant > 100 then
    raise exception 'Le pourboire va de 0,50 € à 100 €.';
  end if;

  update public.courses set pourboire = v_montant where id = p_course returning * into v_course;
  insert into public.paiements (course_id, client_id, nature, mode, montant)
  values (p_course, v_course.client_id, 'pourboire', v_course.mode_paiement, v_montant);
  -- La facture déjà émise ne change pas : le pourboire (hors TVA, reversé au
  -- chauffeur) figure sur son propre reçu, établi à partir de ce paiement.
  perform prive.evenement(p_course, 'pourboire', jsonb_build_object('montant', v_montant));

  -- Chauffeur prévenu : ce qu'il doit faire dépend du mode de paiement
  if v_course.mode_paiement = 'especes' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire en espèces',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ' : le client vous le remet en espèces. Confirmez-le dans la course une fois reçu.',
      '/chauffeur/course/?id=' || v_course.id::text);
  elsif v_course.mode_paiement = 'carte' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire par carte',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ' : à encaisser sur votre terminal. Confirmez-le dans la course une fois encaissé.',
      '/chauffeur/course/?id=' || v_course.id::text);
  else
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire reçu',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ', sur la facture mensuelle de l''entreprise. Merci !', '/chauffeur/revenus/');
  end if;
  return v_course;
end;
$$;

comment on function public.ajouter_pourboire(uuid, numeric) is
  'Pourboire du client sur sa course terminée : une fois, de 0,50 € à 100 €, réglé comme la course '
  '(espèces ou carte au terminal dans les 30 minutes, facture mensuelle dans les 24 heures).';
