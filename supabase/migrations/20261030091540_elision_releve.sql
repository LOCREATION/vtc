-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 16f : correction du français — « relevé d'octobre »
-- -----------------------------------------------------------------------------
-- L'encaissement d'un relevé mensuel (migration 13) écrivait « relevé de
-- octobre 2026 » dans son message d'erreur et dans le message envoyé aux
-- gestionnaires du compte. « de » s'élide devant une voyelle : « d'avril »,
-- « d'août », « d'octobre », mais « de novembre ». La fonction est reprise
-- telle quelle, ces deux textes passent par prive.de_mois (migration 16b).
-- Ses droits d'exécution sont conservés (create or replace). Au passage, la
-- liste vide des paiements est typée (avertissement de l'analyse statique).
-- =============================================================================

create or replace function public.admin_encaisser_releve(
  p_compte uuid, p_mois date, p_montant numeric, p_reference text default null
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_compte    public.comptes_pro;
  v_debut     date := date_trunc('month', coalesce(p_mois, prive.heure_paris()::date))::date;
  v_fin       date;
  v_reference text := nullif(left(trim(coalesce(p_reference, '')), 120), '');
  v_ids       uuid[] := '{}'::uuid[];
  v_total     numeric := 0;
  v_nb        integer := 0;
  r           record;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_compte from public.comptes_pro cp where cp.id = p_compte;
  if v_compte.id is null then
    raise exception 'Compte professionnel introuvable.';
  end if;
  v_fin := (v_debut + interval '1 month')::date - 1;

  -- Verrou sur chaque paiement ; son statut est revérifié après le verrou
  for r in
    select pa.id, pa.montant from public.paiements pa
    where pa.statut = 'a_encaisser' and pa.mode = 'facture_mensuelle'
      and pa.id in (select x.id from prive.paiements_releve(v_compte.id, v_debut, v_fin) x)
    order by pa.id
    for update
  loop
    v_ids := v_ids || r.id;
    v_total := v_total + r.montant;
    v_nb := v_nb + 1;
  end loop;

  if v_nb = 0 then
    raise exception 'Rien à encaisser sur le relevé %.', prive.de_mois(v_debut);
  end if;
  if p_montant is null or abs(p_montant - v_total) > 0.009 then
    raise exception 'Le relevé a changé depuis l''affichage (reste à payer : %) : rechargez la page avant d''encaisser.',
      prive.euros(v_total);
  end if;

  update public.paiements
     set statut = 'encaisse', encaisse_par = auth.uid(), encaisse_le = now(),
         reference_externe = coalesce(v_reference, reference_externe)
   where id = any (v_ids);

  -- Trace sur chaque course, comme un encaissement à l'unité
  insert into public.evenements_course (course_id, type, acteur_id, details)
  select pa.course_id, 'paiement_encaisse', auth.uid(),
         jsonb_build_object('paiement_id', pa.id, 'montant', pa.montant, 'mode', pa.mode, 'releve', to_char(v_debut, 'YYYY-MM'))
  from public.paiements pa where pa.id = any (v_ids);

  perform prive.journaliser_action('encaissement_releve', 'comptes_pro', v_compte.id::text,
    jsonb_build_object('mois', to_char(v_debut, 'YYYY-MM'), 'paiements', v_nb, 'montant', v_total, 'reference', v_reference));

  -- Les gestionnaires du compte sont prévenus
  perform prive.notifier(m.profil_id, 'paiement', 'Relevé réglé',
    'Le relevé ' || prive.de_mois(v_debut) || ' du compte « ' || v_compte.raison_sociale || ' » est réglé : '
    || prive.euros(v_total) || '. Merci.')
  from public.comptes_pro_membres m
  where m.compte_pro_id = v_compte.id and m.role = 'gestionnaire';

  return jsonb_build_object('paiements', v_nb, 'montant', v_total);
end;
$$;
