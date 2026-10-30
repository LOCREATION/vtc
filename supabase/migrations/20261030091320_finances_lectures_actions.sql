-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 14c : FINANCES (3/3) — lectures et actions du module
-- -----------------------------------------------------------------------------
-- Suite des migrations 14a et 14b.
--   4. Lectures du module : synthèse, paiements, espèces des chauffeurs,
--      remises, factures et avoirs, documents imprimables, remboursements,
--      TVA mois par mois.
--   5. Actions : paiement impayé, annulation de tout ou partie d'une somme
--      due (avec avoir), remise d'espèces et son annulation.
--   Droits d'exécution de ces fonctions : utilisateurs connectés seulement.
-- Comme partout : chaque fonction vérifie elle-même l'appelant (double
-- authentification comprise), chemin de recherche vide, messages d'erreur en
-- français affichables tels quels.
-- =============================================================================


-- #############################################################################
-- 4. LECTURES DU MODULE FINANCES
-- #############################################################################

-- 4a. Synthèse d'une période (jours de Paris, bornes comprises) : encaissé
--     (par date d'encaissement) et par mode, remboursé et par mode ; et, à
--     l'instant : à encaisser, impayés, espèces chez les chauffeurs.
create or replace function public.admin_finances_synthese(p_debut date, p_fin date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_debut timestamptz;
  v_fin   timestamptz;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);
  v_debut := prive.debut_jour_paris(p_debut);
  v_fin   := prive.debut_jour_paris(p_fin + 1);

  return jsonb_build_object(
    'debut', p_debut, 'fin', p_fin,
    'encaisse', (select jsonb_build_object(
        'total', coalesce(sum(pa.montant), 0), 'nb', count(*),
        'especes', coalesce(sum(pa.montant) filter (where pa.mode = 'especes'), 0),
        'carte', coalesce(sum(pa.montant) filter (where pa.mode = 'carte'), 0),
        'facture_mensuelle', coalesce(sum(pa.montant) filter (where pa.mode = 'facture_mensuelle'), 0),
        'solde', coalesce(sum(pa.montant) filter (where pa.mode = 'solde'), 0),
        'pourboires', coalesce(sum(pa.montant) filter (where pa.nature = 'pourboire'), 0))
      from public.paiements pa
      where pa.statut in ('encaisse', 'rembourse') and pa.encaisse_le >= v_debut and pa.encaisse_le < v_fin),
    'rembourse', (select jsonb_build_object(
        'total', coalesce(sum(r.montant), 0), 'nb', count(*),
        'virement', coalesce(sum(r.montant) filter (where r.mode = 'virement'), 0),
        'carte', coalesce(sum(r.montant) filter (where r.mode = 'carte'), 0),
        'especes', coalesce(sum(r.montant) filter (where r.mode = 'especes'), 0))
      from public.remboursements r
      where r.cree_le >= v_debut and r.cree_le < v_fin),
    'a_encaisser', (select jsonb_build_object(
        'total', coalesce(sum(pa.montant), 0), 'nb', count(*),
        'sur_place', coalesce(sum(pa.montant) filter (where pa.mode <> 'facture_mensuelle'), 0),
        'nb_sur_place', count(*) filter (where pa.mode <> 'facture_mensuelle'),
        'plus_24h', count(*) filter (where pa.mode <> 'facture_mensuelle' and pa.cree_le < now() - interval '24 hours'),
        'releves', coalesce(sum(pa.montant) filter (where pa.mode = 'facture_mensuelle'), 0),
        'nb_releves', count(*) filter (where pa.mode = 'facture_mensuelle'))
      from public.paiements pa where pa.statut = 'a_encaisser'),
    'impayes', (select jsonb_build_object('total', coalesce(sum(pa.montant), 0), 'nb', count(*))
                from public.paiements pa where pa.statut = 'echoue'),
    'especes', (select jsonb_build_object(
        'a_remettre', coalesce(sum(e.a_remettre), 0),
        'chauffeurs', count(*) filter (where e.a_remettre > 0),
        'depuis_le', min(e.depuis_le))
      from prive.especes_chauffeurs() e),
    'factures', (select jsonb_build_object('nb', count(*), 'ht', coalesce(sum(f.montant_ht), 0),
                                           'tva', coalesce(sum(f.montant_tva), 0), 'ttc', coalesce(sum(f.montant_ttc), 0))
                 from public.factures f where f.date_emission between p_debut and p_fin),
    'avoirs', (select jsonb_build_object('nb', count(*), 'ht', coalesce(sum(a.montant_ht), 0),
                                         'tva', coalesce(sum(a.montant_tva), 0), 'ttc', coalesce(sum(a.montant_ttc), 0))
               from public.avoirs a where a.date_emission between p_debut and p_fin)
  );
end;
$$;

-- 4b. Paiements, par vue :
--       a_encaisser  tous ceux qui attendent (les plus anciens d'abord) ;
--       impayes      ceux déclarés impayés (les plus anciens d'abord) ;
--       encaisses    encaissés pendant la période (date d'encaissement),
--                    remboursés compris (les plus récents d'abord) ;
--       annules      sommes annulées (les plus récentes d'abord).
--     Filtres : mode, nature, recherche (course, client, téléphone,
--     chauffeur, entreprise, référence, facture). Totaux et répartition par
--     mode de toute la sélection, lignes par page.
create or replace function public.admin_lister_paiements(
  p_vue       text,
  p_debut     date    default null,
  p_fin       date    default null,
  p_texte     text    default null,
  p_mode      text    default null,
  p_nature    text    default null,
  p_limite    integer default 50,
  p_decalage  integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_motif    text := prive.motif_recherche(p_texte);
  v_chiffres text := prive.chiffres_telephone(p_texte);
  v_debut    timestamptz;
  v_fin      timestamptz;
  v_resultat jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_vue is null or p_vue not in ('a_encaisser', 'impayes', 'encaisses', 'annules') then
    raise exception 'Vue inconnue.';
  end if;
  if p_mode is not null and p_mode not in ('especes', 'carte', 'solde', 'facture_mensuelle') then
    raise exception 'Mode de paiement inconnu.';
  end if;
  if p_nature is not null and p_nature not in ('course', 'pourboire', 'frais_annulation') then
    raise exception 'Nature de paiement inconnue.';
  end if;
  if p_vue = 'encaisses' then
    perform prive.controler_periode(p_debut, p_fin);
    v_debut := prive.debut_jour_paris(p_debut);
    v_fin   := prive.debut_jour_paris(p_fin + 1);
  end if;

  with choisis as (
    select pa.id, pa.mode, pa.montant, pa.cree_le, pa.encaisse_le
    from public.paiements pa
    join public.courses c on c.id = pa.course_id
    join public.profils cl on cl.id = c.client_id
    left join public.profils ch on ch.id = c.chauffeur_id
    left join public.comptes_pro cp on cp.id = c.compte_pro_id
    left join public.factures f on f.course_id = pa.course_id and f.nature = pa.nature
    where (case p_vue
             when 'a_encaisser' then pa.statut = 'a_encaisser'
             when 'impayes'     then pa.statut = 'echoue'
             when 'annules'     then pa.statut = 'annule'
             else pa.statut in ('encaisse', 'rembourse') and pa.encaisse_le >= v_debut and pa.encaisse_le < v_fin
           end)
      and (p_mode is null or pa.mode = p_mode)
      and (p_nature is null or pa.nature = p_nature)
      and (v_motif is null
           or concat_ws(' ', c.numero, cl.prenom, cl.nom, cl.email, cl.telephone, ch.prenom, ch.nom,
                        cp.raison_sociale, pa.reference_externe, f.numero) ilike v_motif
           or (v_chiffres is not null and cl.telephone like '%' || v_chiffres || '%'))
  ),
  classes as (
    select x.*, row_number() over (order by
             case when p_vue = 'encaisses' then x.encaisse_le end desc,
             case when p_vue = 'annules' then x.cree_le end desc,
             x.cree_le, x.id) as rang
    from choisis x
  ),
  page as (
    select * from classes
    order by rang
    limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from choisis),
    'totaux', (select jsonb_build_object('montant', coalesce(sum(x.montant), 0), 'rembourse', coalesce(sum(r.montant), 0))
               from choisis x
               cross join lateral (select coalesce(sum(rb.montant), 0) as montant
                                   from public.remboursements rb where rb.paiement_id = x.id) r),
    'par_mode', (select coalesce(jsonb_agg(jsonb_build_object('mode', m.mode, 'nb', m.nb, 'montant', m.montant)
                                           order by m.montant desc, m.mode), '[]'::jsonb)
                 from (select x.mode, count(*)::integer as nb, sum(x.montant) as montant from choisis x group by x.mode) m),
    'lignes', (select coalesce(jsonb_agg(prive.ligne_paiement(g.id) order by g.rang), '[]'::jsonb) from page g)
  ) into v_resultat;
  return v_resultat;
end;
$$;

-- 4c. Espèces des chauffeurs : pour chacun (chauffeurs validés, et tout
--     chauffeur qui a déjà encaissé ou remis des espèces) : encaissé, remis,
--     à remettre depuis quand, paiements en espèces de ses courses pas encore
--     confirmés, et le détail des encaissements pas encore remis.
create or replace function public.admin_especes_chauffeurs()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;

  return (
    with soldes as (select * from prive.especes_chauffeurs()),
    concernes as (
      select ch.id from public.chauffeurs ch where ch.statut = 'valide'
      union
      select s.chauffeur_id from soldes s
    ),
    lignes as (
      select ch.id as chauffeur_id, p.prenom, p.nom, p.telephone, ch.statut, ch.salarie,
             coalesce(s.encaisse, 0) as encaisse, coalesce(s.remis, 0) as remis, coalesce(s.a_remettre, 0) as a_remettre,
             s.depuis_le, s.derniere_remise_le,
             (select jsonb_build_object('nb', count(*), 'montant', coalesce(sum(pa.montant), 0))
                from public.paiements pa join public.courses c on c.id = pa.course_id
               where c.chauffeur_id = ch.id and pa.mode = 'especes' and pa.statut = 'a_encaisser'
                 and pa.nature <> 'pourboire') as non_confirmes,
             -- Encaissements pas encore couverts par les remises (le plus
             -- ancien peut l'être en partie : « reste »)
             (select coalesce(jsonb_agg(jsonb_build_object(
                       'paiement_id', e.id, 'course_id', e.course_id, 'course_numero', c.numero, 'nature', e.nature,
                       'montant', e.montant, 'reste', least(e.montant, e.cumul - coalesce(s.remis, 0)),
                       'encaisse_le', e.encaisse_le) order by e.encaisse_le, e.id), '[]'::jsonb)
                from (select pa.*, sum(pa.montant) over (order by pa.encaisse_le, pa.id) as cumul
                        from public.paiements pa
                       where pa.especes_chauffeur_id = ch.id and pa.mode = 'especes' and pa.nature <> 'pourboire'
                         and pa.statut in ('encaisse', 'rembourse')) e
                join public.courses c on c.id = e.course_id
               where e.cumul > coalesce(s.remis, 0)) as non_remis
      from concernes k
      join public.chauffeurs ch on ch.id = k.id
      join public.profils p on p.id = ch.id
      left join soldes s on s.chauffeur_id = ch.id
    )
    select jsonb_build_object(
      'total_a_remettre', coalesce((select sum(l.a_remettre) from lignes l), 0),
      'chauffeurs', coalesce((select jsonb_agg(jsonb_build_object(
          'chauffeur_id', l.chauffeur_id, 'nom', coalesce(nullif(trim(l.prenom || ' ' || l.nom), ''), 'Sans nom'),
          'telephone', l.telephone, 'statut', l.statut, 'salarie', l.salarie,
          'encaisse', l.encaisse, 'remis', l.remis, 'a_remettre', l.a_remettre,
          'depuis_le', l.depuis_le, 'derniere_remise_le', l.derniere_remise_le,
          'non_confirmes', l.non_confirmes, 'non_remis', l.non_remis)
          order by l.a_remettre desc, lower(coalesce(l.prenom, '') || ' ' || coalesce(l.nom, '')))
        from lignes l), '[]'::jsonb)
    )
  );
end;
$$;

-- 4d. Remises d'espèces d'une période (date de la remise), d'un chauffeur
--     ou de tous ; annulées comprises (elles restent visibles).
create or replace function public.admin_lister_remises(p_debut date, p_fin date, p_chauffeur uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);

  return (
    with choisies as (
      select r.* from public.remises_especes r
      where r.cree_le >= prive.debut_jour_paris(p_debut) and r.cree_le < prive.debut_jour_paris(p_fin + 1)
        and (p_chauffeur is null or r.chauffeur_id = p_chauffeur)
    )
    select jsonb_build_object(
      'total', coalesce((select sum(x.montant) from choisies x where x.annulee_le is null), 0),
      'nb', (select count(*) from choisies x where x.annulee_le is null),
      'lignes', coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object(
                  'chauffeur_nom', (select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom') from public.profils p where p.id = x.chauffeur_id),
                  'recue_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = x.recue_par),
                  'annulee_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = x.annulee_par))
                  order by x.cree_le desc, x.numero desc)
                  from choisies x), '[]'::jsonb)
    )
  );
end;
$$;

-- 4e. Registre des factures et des avoirs d'une période (date d'émission) :
--     type (tout, factures, avoirs), recherche (numéro, destinataire, client,
--     course), totaux HT, TVA, TTC des factures, des avoirs et nets, état du
--     règlement de chaque facture, et contrôle de la numérotation continue
--     de toutes les séries.
create or replace function public.admin_lister_factures(
  p_type      text    default 'tout',
  p_debut     date    default null,
  p_fin       date    default null,
  p_texte     text    default null,
  p_limite    integer default 50,
  p_decalage  integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_type  text := coalesce(p_type, 'tout');
  v_motif text := prive.motif_recherche(p_texte);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if v_type not in ('tout', 'factures', 'avoirs') then
    raise exception 'Type inconnu : tout, factures ou avoirs.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);

  return (
    with pieces as (
      select 'facture'::text as type, f.id, f.numero, f.date_emission, f.nature as detail, f.client_id, f.compte_pro_id,
             f.destinataire_nom, f.destinataire_adresse, f.course_id, f.montant_ht, f.taux_tva, f.montant_tva, f.montant_ttc,
             null::uuid as facture_id, null::text as facture_numero, null::text as motif, f.cree_le
      from public.factures f
      where v_type in ('tout', 'factures') and f.date_emission between p_debut and p_fin
      union all
      select 'avoir', a.id, a.numero, a.date_emission, a.origine, a.client_id, a.compte_pro_id,
             a.destinataire_nom, a.destinataire_adresse, a.course_id, a.montant_ht, a.taux_tva, a.montant_tva, a.montant_ttc,
             a.facture_id, fa.numero, a.motif, a.cree_le
      from public.avoirs a join public.factures fa on fa.id = a.facture_id
      where v_type in ('tout', 'avoirs') and a.date_emission between p_debut and p_fin
    ),
    choisies as (
      select pc.*, c.numero as course_numero, c.prise_en_charge_le,
             coalesce(nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email, 'Client') as client_nom
      from pieces pc
      join public.courses c on c.id = pc.course_id
      join public.profils cl on cl.id = pc.client_id
      where v_motif is null
         or concat_ws(' ', pc.numero, pc.facture_numero, pc.destinataire_nom, cl.prenom, cl.nom, cl.email, c.numero) ilike v_motif
    ),
    classees as (
      select x.*, row_number() over (order by x.date_emission desc, x.numero desc) as rang from choisies x
    ),
    page as (
      select * from classees order by rang
      limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)
    )
    select jsonb_build_object(
      'total', (select count(*) from choisies),
      'totaux', (select jsonb_build_object(
          'factures', jsonb_build_object('nb', count(*) filter (where x.type = 'facture'),
                                         'ht', coalesce(sum(x.montant_ht) filter (where x.type = 'facture'), 0),
                                         'tva', coalesce(sum(x.montant_tva) filter (where x.type = 'facture'), 0),
                                         'ttc', coalesce(sum(x.montant_ttc) filter (where x.type = 'facture'), 0)),
          'avoirs', jsonb_build_object('nb', count(*) filter (where x.type = 'avoir'),
                                       'ht', coalesce(sum(x.montant_ht) filter (where x.type = 'avoir'), 0),
                                       'tva', coalesce(sum(x.montant_tva) filter (where x.type = 'avoir'), 0),
                                       'ttc', coalesce(sum(x.montant_ttc) filter (where x.type = 'avoir'), 0)),
          'net', jsonb_build_object('ht', coalesce(sum(case when x.type = 'facture' then x.montant_ht else -x.montant_ht end), 0),
                                    'tva', coalesce(sum(case when x.type = 'facture' then x.montant_tva else -x.montant_tva end), 0),
                                    'ttc', coalesce(sum(case when x.type = 'facture' then x.montant_ttc else -x.montant_ttc end), 0)))
        from choisies x),
      'lignes', coalesce((select jsonb_agg(jsonb_build_object(
          'type', g.type, 'id', g.id, 'numero', g.numero, 'date_emission', g.date_emission, 'detail', g.detail,
          'client_id', g.client_id, 'client_nom', g.client_nom, 'compte_pro_id', g.compte_pro_id,
          'compte_pro_siret', (select cp.siret from public.comptes_pro cp where cp.id = g.compte_pro_id),
          'compte_pro_tva', (select cp.tva_intracommunautaire from public.comptes_pro cp where cp.id = g.compte_pro_id),
          'destinataire_nom', g.destinataire_nom, 'destinataire_adresse', g.destinataire_adresse,
          'course_id', g.course_id, 'course_numero', g.course_numero, 'prise_en_charge_le', g.prise_en_charge_le,
          'montant_ht', g.montant_ht, 'taux_tva', g.taux_tva, 'montant_tva', g.montant_tva, 'montant_ttc', g.montant_ttc,
          'facture_id', g.facture_id, 'facture_numero', g.facture_numero, 'motif', g.motif,
          'credite', case when g.type = 'facture'
                          then (select coalesce(sum(a.montant_ttc), 0) from public.avoirs a where a.facture_id = g.id) end,
          'paiement', case when g.type = 'facture' then (
                        select jsonb_build_object('id', pa.id, 'mode', pa.mode, 'statut', pa.statut, 'montant', pa.montant,
                                                  'encaisse_le', pa.encaisse_le,
                                                  'rembourse', (select coalesce(sum(r.montant), 0) from public.remboursements r
                                                                where r.paiement_id = pa.id))
                        from public.paiements pa
                        join public.factures f on f.course_id = pa.course_id and f.nature = pa.nature
                        where f.id = g.id) end,
          'remboursement', case when g.type = 'avoir' then (
                        select jsonb_build_object('mode', r.mode, 'cree_le', r.cree_le)
                        from public.remboursements r join public.avoirs a on a.remboursement_id = r.id
                        where a.id = g.id) end)
          order by g.rang) from page g), '[]'::jsonb),
      'continuite', prive.continuite_numeros()
    )
  );
end;
$$;

-- 4f. Facture imprimable : la facture telle qu'émise, l'identité de
--     l'entreprise, le détail de la course (prix, majoration, option,
--     remise, attente), le client ou l'entreprise, le règlement, les avoirs.
create or replace function public.admin_document_facture(p_facture uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_facture public.factures;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_facture from public.factures f where f.id = p_facture;
  if v_facture.id is null then
    raise exception 'Facture introuvable.';
  end if;

  return jsonb_build_object(
    'facture', to_jsonb(v_facture),
    'societe', (select to_jsonb(s) from public.societe s where s.id = 1),
    'course', (select jsonb_build_object(
        'id', c.id, 'numero', c.numero, 'type', c.type, 'statut', c.statut, 'cree_le', c.cree_le,
        'prise_en_charge_le', c.prise_en_charge_le, 'terminee_le', c.terminee_le, 'annulee_le', c.annulee_le,
        'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
        'distance_km', c.distance_km, 'duree_min', c.duree_min, 'duree_mad_heures', c.duree_mad_heures,
        'categorie', cat.nom_fr, 'option_chauffeuse', c.option_chauffeuse,
        'forfait', (select za.nom || ' ↔ ' || zb.nom from public.forfaits fo
                     join public.zones za on za.id = fo.zone_a_id join public.zones zb on zb.id = fo.zone_b_id
                     where fo.id = c.forfait_id),
        'prix_base', c.prix_base, 'majoration_type', c.majoration_type, 'majoration_pourcentage', c.majoration_pourcentage,
        'supplement', c.supplement, 'remise', c.remise,
        'code_promo', (select cp.code from public.codes_promo cp where cp.id = c.code_promo_id),
        'prix_total', c.prix_total, 'attente_min', c.attente_min, 'frais_attente', c.frais_attente,
        'frais_annulation', c.frais_annulation, 'pour_proche', c.pour_proche, 'beneficiaire_nom', c.beneficiaire_nom,
        'vehicule_libelle', c.vehicule_libelle, 'vehicule_immatriculation', c.vehicule_immatriculation,
        'arrets', coalesce((select jsonb_agg(a.adresse order by a.ordre) from public.course_arrets a where a.course_id = c.id), '[]'::jsonb))
      from public.courses c join public.categories cat on cat.id = c.categorie_id
      where c.id = v_facture.course_id),
    'client', (select jsonb_build_object('id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email)
               from public.profils p where p.id = v_facture.client_id),
    'compte_pro', (select to_jsonb(cp) from public.comptes_pro cp where cp.id = v_facture.compte_pro_id),
    'paiement', (select jsonb_build_object('id', pa.id, 'mode', pa.mode, 'statut', pa.statut, 'montant', pa.montant,
                                           'encaisse_le', pa.encaisse_le, 'cree_le', pa.cree_le,
                                           'echeance', case when pa.mode = 'facture_mensuelle' then
                                             prive.echeance_releve(pa.cree_le, (select cp.delai_paiement_jours from public.comptes_pro cp
                                                                                 where cp.id = v_facture.compte_pro_id)) end)
                 from public.paiements pa where pa.course_id = v_facture.course_id and pa.nature = v_facture.nature),
    'avoirs', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'numero', a.numero, 'date_emission', a.date_emission,
                                                           'origine', a.origine, 'motif', a.motif, 'montant_ttc', a.montant_ttc)
                                         order by a.numero)
                        from public.avoirs a where a.facture_id = v_facture.id), '[]'::jsonb)
  );
end;
$$;

-- 4g. Avoir imprimable : l'avoir, la facture qu'il corrige, l'entreprise,
--     la course, le client ou l'entreprise, le remboursement éventuel, et
--     ce qui a déjà été crédité sur la facture.
create or replace function public.admin_document_avoir(p_avoir uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_avoir public.avoirs;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_avoir from public.avoirs a where a.id = p_avoir;
  if v_avoir.id is null then
    raise exception 'Avoir introuvable.';
  end if;

  return jsonb_build_object(
    'avoir', to_jsonb(v_avoir),
    'facture', (select jsonb_build_object('id', f.id, 'numero', f.numero, 'nature', f.nature, 'date_emission', f.date_emission,
                                          'montant_ht', f.montant_ht, 'montant_tva', f.montant_tva, 'montant_ttc', f.montant_ttc)
                from public.factures f where f.id = v_avoir.facture_id),
    'credite_total', (select coalesce(sum(a.montant_ttc), 0) from public.avoirs a where a.facture_id = v_avoir.facture_id),
    'societe', (select to_jsonb(s) from public.societe s where s.id = 1),
    'course', (select jsonb_build_object('id', c.id, 'numero', c.numero, 'type', c.type, 'prise_en_charge_le', c.prise_en_charge_le,
                                         'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
                                         'categorie', cat.nom_fr)
               from public.courses c join public.categories cat on cat.id = c.categorie_id
               where c.id = v_avoir.course_id),
    'client', (select jsonb_build_object('id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email)
               from public.profils p where p.id = v_avoir.client_id),
    'compte_pro', (select to_jsonb(cp) from public.comptes_pro cp where cp.id = v_avoir.compte_pro_id),
    'remboursement', (select jsonb_build_object('mode', r.mode, 'montant', r.montant, 'cree_le', r.cree_le)
                      from public.remboursements r where r.id = v_avoir.remboursement_id)
  );
end;
$$;

-- 4h. Remboursements d'une période (date du remboursement) : paiement,
--     course, client, mode, motif, auteur, avoir ; totaux par mode.
create or replace function public.admin_lister_remboursements(
  p_debut     date,
  p_fin       date,
  p_texte     text    default null,
  p_limite    integer default 50,
  p_decalage  integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_motif text := prive.motif_recherche(p_texte);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  perform prive.controler_periode(p_debut, p_fin);

  return (
    with choisis as (
      select r.*, pa.nature as paiement_nature, pa.mode as paiement_mode, pa.montant as paiement_montant,
             pa.course_id, c.numero as course_numero, pa.client_id,
             coalesce(nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email, 'Client') as client_nom,
             (select cp.raison_sociale from public.comptes_pro cp where cp.id = c.compte_pro_id) as compte_pro,
             (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = r.cree_par) as cree_par_nom,
             a.id as avoir_id, a.numero as avoir_numero
      from public.remboursements r
      join public.paiements pa on pa.id = r.paiement_id
      join public.courses c on c.id = pa.course_id
      join public.profils cl on cl.id = pa.client_id
      left join public.avoirs a on a.remboursement_id = r.id
      where r.cree_le >= prive.debut_jour_paris(p_debut) and r.cree_le < prive.debut_jour_paris(p_fin + 1)
        and (v_motif is null
             or concat_ws(' ', c.numero, cl.prenom, cl.nom, cl.email, r.motif, a.numero) ilike v_motif)
    ),
    classes as (
      select x.*, row_number() over (order by x.cree_le desc, x.id) as rang from choisis x
    )
    select jsonb_build_object(
      'total', (select count(*) from choisis),
      'totaux', (select jsonb_build_object('montant', coalesce(sum(x.montant), 0),
                                           'virement', coalesce(sum(x.montant) filter (where x.mode = 'virement'), 0),
                                           'carte', coalesce(sum(x.montant) filter (where x.mode = 'carte'), 0),
                                           'especes', coalesce(sum(x.montant) filter (where x.mode = 'especes'), 0))
                 from choisis x),
      'lignes', coalesce((select jsonb_agg(jsonb_build_object(
          'id', g.id, 'cree_le', g.cree_le, 'montant', g.montant, 'mode', g.mode, 'motif', g.motif,
          'cree_par_nom', g.cree_par_nom, 'paiement_id', g.paiement_id, 'paiement_nature', g.paiement_nature,
          'paiement_mode', g.paiement_mode, 'paiement_montant', g.paiement_montant,
          'course_id', g.course_id, 'course_numero', g.course_numero, 'client_id', g.client_id, 'client_nom', g.client_nom,
          'compte_pro', g.compte_pro, 'avoir_id', g.avoir_id, 'avoir_numero', g.avoir_numero) order by g.rang)
        from (select * from classes order by rang
              limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)) g),
        '[]'::jsonb)
    )
  );
end;
$$;

-- 4i. TVA d'une année, mois par mois, par trimestre et sur l'année :
--       - TVA facturée : factures émises moins avoirs émis dans le mois ;
--       - TVA sur les encaissements : celle des sommes encaissées dans le
--         mois (courses et frais d'annulation ; TVA de la facture, moins
--         celle des annulations), moins celle des remboursements du mois.
--     Pour une prestation de services, la TVA est due à l'encaissement (sauf
--     option pour les débits) : c'est la seconde qui se déclare d'ordinaire.
--     Les pourboires sont hors TVA (reversés aux chauffeurs).
create or replace function public.admin_tva(p_annee integer default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_annee integer := coalesce(p_annee, extract(year from prive.heure_paris())::integer);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if v_annee < 2020 or v_annee > 2100 then
    raise exception 'Année invalide.';
  end if;

  return (
    with mouvements as (
      -- Factures émises
      select extract(month from f.date_emission)::integer as m, f.taux_tva as taux,
             1 as nb_factures, f.montant_ht as fact_ht, f.montant_tva as fact_tva, f.montant_ttc as fact_ttc,
             0 as nb_avoirs, 0::numeric as av_ht, 0::numeric as av_tva, 0::numeric as av_ttc,
             0 as nb_enc, 0::numeric as enc_ttc, 0::numeric as enc_tva,
             0 as nb_remb, 0::numeric as remb_ttc, 0::numeric as remb_tva, 0::numeric as pourboires
      from public.factures f where extract(year from f.date_emission) = v_annee
      union all
      -- Avoirs émis
      select extract(month from a.date_emission)::integer, a.taux_tva,
             0, 0, 0, 0, 1, a.montant_ht, a.montant_tva, a.montant_ttc, 0, 0, 0, 0, 0, 0, 0
      from public.avoirs a where extract(year from a.date_emission) = v_annee
      union all
      -- Encaissements de courses et de frais d'annulation
      select extract(month from prive.heure_paris(pa.encaisse_le))::integer, f.taux_tva,
             0, 0, 0, 0, 0, 0, 0, 0,
             1, pa.montant,
             f.montant_tva - coalesce((select sum(a.montant_tva) from public.avoirs a
                                       where a.facture_id = f.id and a.origine = 'annulation'), 0),
             0, 0, 0, 0
      from public.paiements pa
      join public.factures f on f.course_id = pa.course_id and f.nature = pa.nature
      where pa.statut in ('encaisse', 'rembourse') and pa.nature <> 'pourboire'
        and extract(year from prive.heure_paris(pa.encaisse_le)) = v_annee
      union all
      -- Remboursements (avoirs de remboursement, datés du jour du remboursement)
      select extract(month from a.date_emission)::integer, a.taux_tva,
             0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
             1, a.montant_ttc, a.montant_tva, 0
      from public.avoirs a where a.origine = 'remboursement' and extract(year from a.date_emission) = v_annee
      union all
      -- Pourboires encaissés (hors TVA)
      select extract(month from prive.heure_paris(pa.encaisse_le))::integer, null,
             0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, pa.montant
      from public.paiements pa
      where pa.nature = 'pourboire' and pa.statut in ('encaisse', 'rembourse')
        and extract(year from prive.heure_paris(pa.encaisse_le)) = v_annee
      union all
      -- Pourboires remboursés
      select extract(month from prive.heure_paris(r.cree_le))::integer, null,
             0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -r.montant
      from public.remboursements r join public.paiements pa on pa.id = r.paiement_id
      where pa.nature = 'pourboire' and extract(year from prive.heure_paris(r.cree_le)) = v_annee
    ),
    periodes as (
      select 'mois' as genre, m as rang, to_char(make_date(v_annee, m, 1), 'YYYY-MM') as code, array[m] as mois
      from generate_series(1, 12) as m
      union all
      select 'trimestre', t, v_annee || '-T' || t, array[3 * t - 2, 3 * t - 1, 3 * t]
      from generate_series(1, 4) as t
      union all
      select 'annee', 1, v_annee::text, array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    ),
    chiffres as (
      select pe.genre, pe.rang, pe.code,
             coalesce(sum(x.nb_factures), 0)::integer as nb_factures,
             coalesce(sum(x.fact_ht), 0) as fact_ht, coalesce(sum(x.fact_tva), 0) as fact_tva, coalesce(sum(x.fact_ttc), 0) as fact_ttc,
             coalesce(sum(x.nb_avoirs), 0)::integer as nb_avoirs,
             coalesce(sum(x.av_ht), 0) as av_ht, coalesce(sum(x.av_tva), 0) as av_tva, coalesce(sum(x.av_ttc), 0) as av_ttc,
             coalesce(sum(x.nb_enc), 0)::integer as nb_enc, coalesce(sum(x.enc_ttc), 0) as enc_ttc, coalesce(sum(x.enc_tva), 0) as enc_tva,
             coalesce(sum(x.nb_remb), 0)::integer as nb_remb, coalesce(sum(x.remb_ttc), 0) as remb_ttc, coalesce(sum(x.remb_tva), 0) as remb_tva,
             coalesce(sum(x.pourboires), 0) as pourboires,
             coalesce((select jsonb_agg(jsonb_build_object(
                         'taux', t.taux, 'ca_ht', t.ca_ht, 'tva_facturee', t.tva_facturee,
                         'base_exigible', t.base_exigible, 'tva_exigible', t.tva_exigible) order by t.taux)
                       from (select y.taux,
                                    sum(y.fact_ht - y.av_ht) as ca_ht, sum(y.fact_tva - y.av_tva) as tva_facturee,
                                    sum((y.enc_ttc - y.enc_tva) - (y.remb_ttc - y.remb_tva)) as base_exigible,
                                    sum(y.enc_tva - y.remb_tva) as tva_exigible
                             from mouvements y where y.taux is not null and y.m = any (pe.mois)
                             group by y.taux) t), '[]'::jsonb) as par_taux
      from periodes pe
      left join mouvements x on x.m = any (pe.mois)
      group by pe.genre, pe.rang, pe.code, pe.mois
    ),
    lignes as (
      select c.genre, c.rang, jsonb_build_object(
               'periode', c.code,
               'factures', jsonb_build_object('nb', c.nb_factures, 'ht', c.fact_ht, 'tva', c.fact_tva, 'ttc', c.fact_ttc),
               'avoirs', jsonb_build_object('nb', c.nb_avoirs, 'ht', c.av_ht, 'tva', c.av_tva, 'ttc', c.av_ttc),
               'ca_ht', c.fact_ht - c.av_ht,
               'tva_facturee', c.fact_tva - c.av_tva,
               'encaisse', jsonb_build_object('nb', c.nb_enc, 'ttc', c.enc_ttc, 'ht', c.enc_ttc - c.enc_tva, 'tva', c.enc_tva),
               'rembourse', jsonb_build_object('nb', c.nb_remb, 'ttc', c.remb_ttc, 'ht', c.remb_ttc - c.remb_tva, 'tva', c.remb_tva),
               'base_exigible', (c.enc_ttc - c.enc_tva) - (c.remb_ttc - c.remb_tva),
               'tva_exigible', c.enc_tva - c.remb_tva,
               'pourboires', c.pourboires,
               'par_taux', c.par_taux) as ligne
      from chiffres c
    )
    select jsonb_build_object(
      'annee', v_annee,
      'mois', (select jsonb_agg(l.ligne order by l.rang) from lignes l where l.genre = 'mois'),
      'trimestres', (select jsonb_agg(l.ligne order by l.rang) from lignes l where l.genre = 'trimestre'),
      'total', (select l.ligne from lignes l where l.genre = 'annee'),
      -- Années qui ont une activité (choix de l'année), plus l'année en cours
      'annees', (select jsonb_agg(a.annee order by a.annee desc) from (
                   select extract(year from f.date_emission)::integer as annee from public.factures f
                   union select extract(year from prive.heure_paris(pa.encaisse_le))::integer
                         from public.paiements pa where pa.encaisse_le is not null
                   union select extract(year from prive.heure_paris())::integer
                   union select v_annee) a)
    )
  );
end;
$$;


-- #############################################################################
-- 5. ACTIONS DE L'ADMINISTRATION
-- #############################################################################

-- 5a. Paiement sur place déclaré impayé (client injoignable, carte refusée…) :
--     motif obligatoire. Il pourra être encaissé plus tard, ou annulé par un
--     avoir. Un paiement sur facture mensuelle suit son relevé : sans
--     règlement à l'échéance, il apparaît « en retard ».
create or replace function public.admin_paiement_impaye(p_paiement uuid, p_motif text)
returns public.paiements
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement public.paiements;
  v_motif    text := nullif(left(trim(coalesce(p_motif, '')), 300), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if v_motif is null then
    raise exception 'Indiquez le motif (client injoignable, carte refusée…) : il est conservé dans le journal.';
  end if;
  select * into v_paiement from public.paiements p where p.id = p_paiement for update;
  if v_paiement.id is null then
    raise exception 'Paiement introuvable.';
  end if;
  if v_paiement.statut <> 'a_encaisser' then
    raise exception 'Seul un paiement à encaisser peut être déclaré impayé.';
  end if;
  if v_paiement.mode = 'facture_mensuelle' then
    raise exception 'Un paiement sur facture mensuelle se règle avec le relevé du compte professionnel : s''il n''est pas réglé à l''échéance, il apparaît « en retard ».';
  end if;

  update public.paiements set statut = 'echoue', motif = v_motif where id = p_paiement
  returning * into v_paiement;
  perform prive.evenement(v_paiement.course_id, 'paiement_impaye',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_paiement.montant, 'motif', v_motif));
  return v_paiement;
end;
$$;

-- 5b. Annuler tout ou partie d'une somme due (pas encore encaissée) : geste
--     commercial, frais contestés, erreur de prix. La facture est corrigée
--     par un avoir du montant annulé ; le paiement passe « annulé » (somme
--     entière) ou est réduit d'autant. Le client est prévenu.
--     Une somme déjà encaissée ne s'annule pas : elle se rembourse.
create or replace function public.admin_annuler_paiement(p_paiement uuid, p_montant numeric, p_motif text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement public.paiements;
  v_course   public.courses;
  v_facture  public.factures;
  v_avoir    public.avoirs;
  v_montant  numeric := round(p_montant, 2);
  v_motif    text := nullif(left(trim(coalesce(p_motif, '')), 300), '');
  v_libelle  text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if v_motif is null then
    raise exception 'Indiquez le motif de l''annulation : il figure sur l''avoir et dans le journal.';
  end if;
  select * into v_paiement from public.paiements p where p.id = p_paiement for update;
  if v_paiement.id is null then
    raise exception 'Paiement introuvable.';
  end if;
  if v_paiement.statut not in ('a_encaisser', 'echoue') then
    raise exception 'Seule une somme pas encore encaissée peut être annulée ; une somme encaissée se rembourse.';
  end if;
  if v_montant is null or v_montant <= 0 or v_montant > v_paiement.montant then
    raise exception 'Montant invalide : de 0,01 € à % (somme due).', prive.euros(v_paiement.montant);
  end if;
  select * into v_course from public.courses c where c.id = v_paiement.course_id;

  select * into v_facture from public.factures f where f.course_id = v_paiement.course_id and f.nature = v_paiement.nature;
  if v_facture.id is not null then
    v_avoir := prive.emettre_avoir(v_facture.id, v_montant, 'annulation', v_motif, p_paiement, null);
  end if;

  if v_montant = v_paiement.montant then
    update public.paiements set statut = 'annule', motif = v_motif where id = p_paiement
    returning * into v_paiement;
  else
    update public.paiements set montant = montant - v_montant, motif = v_motif where id = p_paiement
    returning * into v_paiement;
  end if;

  perform prive.evenement(v_paiement.course_id, 'paiement_annule',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_montant, 'motif', v_motif, 'avoir', v_avoir.numero,
                       'reste', case when v_paiement.statut = 'annule' then 0 else v_paiement.montant end));

  -- « Vous n'avez plus rien à régler pour la course C-… : 8,36 € annulés
  --   (avoir AV-…). Motif : course offerte. »
  -- « 1,11 € sont retirés de la somme due pour la course C-… ; il reste
  --   8,36 € à régler (avoir AV-…). Motif : attente au départ. »
  v_libelle := case v_paiement.nature when 'course' then 'la course ' when 'pourboire' then 'le pourboire de la course '
                                      else 'les frais d''annulation de la course ' end || v_course.numero;
  perform prive.notifier(v_paiement.client_id, 'paiement', 'Somme annulée',
    case when v_paiement.statut = 'annule'
         then 'Vous n''avez plus rien à régler pour ' || v_libelle || ' : ' || prive.euros(v_montant) || ' annulés'
         else prive.euros(v_montant) || ' sont retirés de la somme due pour ' || v_libelle
              || ' ; il reste ' || prive.euros(v_paiement.montant) || ' à régler'
    end
    || case when v_avoir.id is not null then ' (avoir ' || v_avoir.numero || ')' else '' end
    || '. Motif : ' || rtrim(v_motif, '.') || '.',
    '/client/activite/');

  return jsonb_build_object('paiement', to_jsonb(v_paiement),
                            'avoir', case when v_avoir.id is not null then to_jsonb(v_avoir) end);
end;
$$;

-- 5c. Remise d'espèces d'un chauffeur au bureau : jamais plus que ce qu'il
--     détient d'après ses encaissements (s'il remet davantage, ses paiements
--     en espèces encore « à encaisser » doivent d'abord être confirmés). La
--     fiche du chauffeur est verrouillée : deux remises simultanées ne
--     dépassent pas ce qu'il détient. Le chauffeur reçoit le numéro du reçu.
create or replace function public.admin_enregistrer_remise(p_chauffeur uuid, p_montant numeric, p_note text default null)
returns public.remises_especes
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_chauffeur public.chauffeurs;
  v_detenu    numeric;
  v_montant   numeric := round(p_montant, 2);
  v_remise    public.remises_especes;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_chauffeur from public.chauffeurs c where c.id = p_chauffeur for update;
  if v_chauffeur.id is null then
    raise exception 'Chauffeur introuvable.';
  end if;
  if v_montant is null or v_montant <= 0 then
    raise exception 'Indiquez le montant remis.';
  end if;
  v_detenu := prive.especes_a_remettre(p_chauffeur);
  if v_detenu <= 0 then
    raise exception 'Ce chauffeur n''a aucune espèce à remettre d''après ses encaissements. S''il vous en remet, confirmez d''abord ses paiements en espèces encore « à encaisser ».';
  end if;
  if v_montant > v_detenu then
    raise exception 'Ce chauffeur ne détient que % d''espèces encaissées. S''il vous remet davantage, confirmez d''abord ses paiements en espèces encore « à encaisser ».',
      prive.euros(v_detenu);
  end if;

  insert into public.remises_especes (numero, chauffeur_id, montant, note, recue_par)
  values (prive.prochain_numero('remise', 'RE'), p_chauffeur, v_montant,
          nullif(left(trim(coalesce(p_note, '')), 300), ''), auth.uid())
  returning * into v_remise;
  perform prive.notifier(p_chauffeur, 'paiement', 'Remise d''espèces enregistrée',
    prive.euros(v_montant) || ' remis au bureau (reçu ' || v_remise.numero || ').'
    || case when v_detenu - v_montant > 0 then ' Il vous reste ' || prive.euros(v_detenu - v_montant) || ' d''espèces à remettre.'
            else ' Vous n''avez plus d''espèces à remettre.' end);
  return v_remise;
end;
$$;

-- 5d. Annuler une remise enregistrée par erreur (mauvais montant, mauvais
--     chauffeur) : motif obligatoire ; la remise reste visible, annulée, et
--     les espèces redeviennent à remettre. Le chauffeur est prévenu.
create or replace function public.admin_annuler_remise(p_remise uuid, p_motif text)
returns public.remises_especes
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_remise public.remises_especes;
  v_motif  text := nullif(left(trim(coalesce(p_motif, '')), 300), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if v_motif is null then
    raise exception 'Indiquez le motif de l''annulation (erreur de montant, de chauffeur…) : il est conservé dans le journal.';
  end if;
  select * into v_remise from public.remises_especes r where r.id = p_remise for update;
  if v_remise.id is null then
    raise exception 'Remise introuvable.';
  end if;
  if v_remise.annulee_le is not null then
    raise exception 'Cette remise est déjà annulée.';
  end if;

  update public.remises_especes
     set annulee_le = now(), annulee_par = auth.uid(), motif_annulation = v_motif
   where id = p_remise
  returning * into v_remise;
  perform prive.notifier(v_remise.chauffeur_id, 'paiement', 'Remise d''espèces annulée',
    'La remise ' || v_remise.numero || ' de ' || prive.euros(v_remise.montant) || ' est annulée : ' || rtrim(v_motif, '.') || '.');
  return v_remise;
end;
$$;


-- #############################################################################
-- DROITS D'EXÉCUTION (fonctions des sections 4 et 5)
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout, puis on n'accorde que l'utile.
revoke all on function
  public.admin_finances_synthese(date, date),
  public.admin_lister_paiements(text, date, date, text, text, text, integer, integer),
  public.admin_especes_chauffeurs(),
  public.admin_lister_remises(date, date, uuid),
  public.admin_lister_factures(text, date, date, text, integer, integer),
  public.admin_document_facture(uuid),
  public.admin_document_avoir(uuid),
  public.admin_lister_remboursements(date, date, text, integer, integer),
  public.admin_tva(integer),
  public.admin_paiement_impaye(uuid, text),
  public.admin_annuler_paiement(uuid, numeric, text),
  public.admin_enregistrer_remise(uuid, numeric, text),
  public.admin_annuler_remise(uuid, text)
  from public, anon;

grant execute on function
  public.admin_finances_synthese(date, date),
  public.admin_lister_paiements(text, date, date, text, text, text, integer, integer),
  public.admin_especes_chauffeurs(),
  public.admin_lister_remises(date, date, uuid),
  public.admin_lister_factures(text, date, date, text, integer, integer),
  public.admin_document_facture(uuid),
  public.admin_document_avoir(uuid),
  public.admin_lister_remboursements(date, date, text, integer, integer),
  public.admin_tva(integer),
  public.admin_paiement_impaye(uuid, text),
  public.admin_annuler_paiement(uuid, numeric, text),
  public.admin_enregistrer_remise(uuid, numeric, text),
  public.admin_annuler_remise(uuid, text)
  to authenticated;
