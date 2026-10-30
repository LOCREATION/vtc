-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 13 : TABLEAU DE BORD ET RELEVÉS MENSUELS
-- -----------------------------------------------------------------------------
-- Le tableau de bord tient compte de la facturation mensuelle des comptes
-- professionnels (migration 12) :
--   - un paiement sur facture mensuelle attend normalement le relevé du mois :
--     il n'est plus signalé comme « à encaisser depuis plus de 24 h » ;
--   - un relevé échu et non réglé fait l'objet d'une alerte « compte
--     professionnel en retard de paiement », qui mène au module Clients et
--     entreprises ;
--   - IBAN et BIC de l'entreprise à saisir, dès qu'un compte pro est actif
--     (ils sont imprimés sur les relevés).
-- La fonction garde ses droits d'exécution (migration 10) : « create or
-- replace » ne les change pas.
-- =============================================================================


-- #############################################################################
-- TABLEAU DE BORD (remplace la version de la migration 10)
-- #############################################################################
-- Seuls changements : les paiements sur facture mensuelle attendent le
-- relevé (ils ne sont plus signalés au bout de 24 h), et les relevés échus
-- non réglés font l'objet d'une alerte qui mène au module Clients et
-- entreprises.
create or replace function public.admin_tableau_de_bord()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_jour      date := prive.heure_paris()::date;
  v_mois      date;
  v_param     public.parametres;
  v_societe   public.societe;
  v_alertes   jsonb := '[]'::jsonb;
  v_n         integer;
  v_montant   numeric;
  r           record;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  v_mois := v_jour - (extract(day from v_jour)::integer - 1);        -- 1er jour du mois
  select * into v_param from public.parametres where id = 1;
  select * into v_societe from public.societe where id = 1;

  -- 1. Courses sans chauffeur : personne n'a accepté
  select count(*) into v_n from public.courses c where c.statut = 'a_attribuer';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'urgent', 'module', 'dispatch',
      'titre', case when v_n = 1 then '1 course à attribuer' else v_n || ' courses à attribuer' end,
      'detail', 'Aucun chauffeur n''a accepté : attribuez-la à la main depuis le dispatch.');
  end if;

  -- 2. Réservations des prochaines 24 heures encore sans chauffeur
  select count(*) into v_n from public.courses c
   where c.statut = 'planifiee' and c.chauffeur_id is null and c.prise_en_charge_le < now() + interval '24 hours';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'dispatch',
      'titre', case when v_n = 1 then '1 réservation sans chauffeur dans les 24 h'
                    else v_n || ' réservations sans chauffeur dans les 24 h' end,
      'detail', 'La recherche automatique démarre ' || v_param.recherche_planifiee_avant_min
                || ' min avant l''heure prévue ; vous pouvez attribuer dès maintenant.');
  end if;

  -- 3. Paiements sur place en attente d'encaissement depuis plus de 24 heures
  --    (ceux sur facture mensuelle attendent le relevé : voir 3 bis)
  select count(*) into v_n from public.paiements p
   where p.statut = 'a_encaisser' and p.mode <> 'facture_mensuelle' and p.cree_le < now() - interval '24 hours';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'courses',
      'titre', case when v_n = 1 then '1 paiement à encaisser depuis plus de 24 h'
                    else v_n || ' paiements à encaisser depuis plus de 24 h' end,
      'detail', 'Vérifiez avec le chauffeur, puis confirmez l''encaissement dans la fiche de la course.');
  end if;

  -- 3 bis. Comptes professionnels en retard de paiement (relevé échu)
  select count(distinct c.compte_pro_id), coalesce(sum(p.montant), 0) into v_n, v_montant
    from public.paiements p
    join public.courses c on c.id = p.course_id
    join public.comptes_pro cp on cp.id = c.compte_pro_id
   where p.statut = 'a_encaisser' and p.mode = 'facture_mensuelle'
     and prive.echeance_releve(p.cree_le, cp.delai_paiement_jours) < v_jour;
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'clients',
      'titre', case when v_n = 1 then '1 compte professionnel en retard de paiement'
                    else v_n || ' comptes professionnels en retard de paiement' end,
      'detail', prive.euros(v_montant) || ' de relevés échus non réglés : relancez l''entreprise, puis encaissez le relevé dans sa fiche.');
  end if;

  -- 4. Candidatures et documents à examiner
  select count(*) into v_n from public.candidatures c where c.statut in ('nouvelle', 'en_cours');
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'chauffeurs',
      'titre', case when v_n = 1 then '1 candidature à examiner' else v_n || ' candidatures à examiner' end,
      'detail', 'Vérifiez les pièces, puis validez ou refusez.');
  end if;
  select count(*) into v_n from public.documents d where d.statut = 'en_attente';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'chauffeurs',
      'titre', case when v_n = 1 then '1 document à vérifier' else v_n || ' documents à vérifier' end,
      'detail', 'Un document validé met à jour les dates d''expiration de la fiche.');
  end if;

  -- 5. Échéances : documents expirés ou expirant dans les 30 jours
  for r in
    select 'chauffeurs' as module, nullif(trim(p.prenom || ' ' || p.nom), '') as qui, 'Carte VTC' as quoi, c.carte_vtc_expiration as fin
      from public.chauffeurs c join public.profils p on p.id = c.id
     where c.statut = 'valide' and c.carte_vtc_expiration <= v_jour + 30
    union all
    select 'chauffeurs', nullif(trim(p.prenom || ' ' || p.nom), ''), 'Permis de conduire', c.permis_expiration
      from public.chauffeurs c join public.profils p on p.id = c.id
     where c.statut = 'valide' and c.permis_expiration <= v_jour + 30
    union all
    select 'flotte', v.immatriculation, 'Assurance', v.assurance_expiration
      from public.vehicules v where v.actif and v.assurance_expiration <= v_jour + 30
    union all
    select 'flotte', v.immatriculation, 'Contrôle technique', v.controle_technique_expiration
      from public.vehicules v where v.actif and v.controle_technique_expiration <= v_jour + 30
    union all
    select 'flotte', v.immatriculation, 'Vignette VTC', v.vignette_vtc_expiration
      from public.vehicules v where v.actif and v.vignette_vtc_expiration <= v_jour + 30
    order by 4
  loop
    v_alertes := v_alertes || jsonb_build_object(
      'niveau', case when r.fin < v_jour then 'urgent' else 'attention' end,
      'module', r.module,
      'titre', r.quoi || ' · ' || coalesce(r.qui, 'sans nom'),
      'detail', case when r.fin < v_jour then 'Expiré depuis le ' || to_char(r.fin, 'DD/MM/YYYY') || '.'
                     else 'Expire le ' || to_char(r.fin, 'DD/MM/YYYY') || '.' end);
  end loop;

  -- 6. Fiches incomplètes qui empêchent de travailler
  for r in
    select nullif(trim(p.prenom || ' ' || p.nom), '') as qui, c.vehicule_id, c.carte_vtc_expiration
      from public.chauffeurs c join public.profils p on p.id = c.id and p.statut = 'actif'
     where c.statut = 'valide' and (c.vehicule_id is null or c.carte_vtc_expiration is null)
     order by p.prenom, p.nom
  loop
    if r.vehicule_id is null then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'chauffeurs',
        'titre', 'Aucun véhicule affecté · ' || coalesce(r.qui, 'sans nom'),
        'detail', 'Sans véhicule, ce chauffeur ne peut ni passer en ligne ni recevoir de course.');
    end if;
    if r.carte_vtc_expiration is null then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'chauffeurs',
        'titre', 'Carte VTC non renseignée · ' || coalesce(r.qui, 'sans nom'),
        'detail', 'Sans carte VTC valide, ce chauffeur ne peut pas passer en ligne.');
    end if;
  end loop;
  for r in select v.immatriculation from public.vehicules v where v.actif and v.assurance_expiration is null order by 1 loop
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'flotte',
      'titre', 'Assurance non renseignée · ' || r.immatriculation,
      'detail', 'Aucun chauffeur ne peut passer en ligne avec ce véhicule.');
  end loop;

  -- 7. Identité de l'entreprise (reprise sur les feuilles de route, factures, bulletins)
  if v_societe.registre_vtc_numero is null then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'parametres',
      'titre', 'Numéro d''inscription au registre VTC manquant',
      'detail', 'Il doit figurer sur chaque feuille de route.');
  end if;
  if v_societe.siret is null or v_societe.code_ape is null or v_societe.tva_intracommunautaire is null
     or v_societe.numero_urssaf is null then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'parametres',
      'titre', 'Identité de l''entreprise à compléter',
      'detail', concat_ws(', ',
                  case when v_societe.siret is null then 'SIRET' end,
                  case when v_societe.code_ape is null then 'code APE' end,
                  case when v_societe.tva_intracommunautaire is null then 'TVA intracommunautaire' end,
                  case when v_societe.numero_urssaf is null then 'n° URSSAF' end)
                || ' : repris sur les factures et les bulletins de paie.');
  end if;
  -- Coordonnées bancaires : imprimées sur les relevés, dès qu'un compte pro existe
  if (v_societe.iban is null or v_societe.bic is null)
     and exists (select 1 from public.comptes_pro cp where cp.statut = 'actif') then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'parametres',
      'titre', 'IBAN et BIC de l''entreprise à saisir',
      'detail', 'Ils figurent sur les relevés mensuels des comptes professionnels, pour le règlement par virement.');
  end if;

  -- 8. Montants encore à fixer dans le tarif en vigueur
  for r in
    select cat.nom_fr, t.frais_annulation, t.prix_heure_mad
      from public.categories cat
      cross join lateral prive.tarif_en_vigueur(cat.id, v_jour) t
     where cat.active and t.id is not null
     order by cat.ordre, cat.nom_fr
  loop
    if r.frais_annulation = 0 then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'tarifs',
        'titre', 'Frais d''annulation à 0 € · ' || r.nom_fr,
        'detail', 'Fixez le montant prévu par vos conditions de vente (après acceptation du chauffeur).');
    end if;
    if r.prix_heure_mad is null then
      v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'tarifs',
        'titre', 'Mise à disposition non tarifée · ' || r.nom_fr,
        'detail', 'Fixez le prix de l''heure pour la proposer aux clients.');
    end if;
  end loop;

  -- 9. Messages reçus : support, formulaire de contact, demandes de devis
  select count(*) into v_n from public.demandes d where d.statut in ('ouverte', 'en_cours');
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'support',
      'titre', case when v_n = 1 then '1 demande au support en attente' else v_n || ' demandes au support en attente' end,
      'detail', 'Clients ou chauffeurs attendent une réponse.');
  end if;
  select count(*) into v_n from public.messages_contact m where not m.traite;
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'support',
      'titre', case when v_n = 1 then '1 message du formulaire de contact' else v_n || ' messages du formulaire de contact' end,
      'detail', 'Envoyés depuis le site, à traiter.');
  end if;
  select count(*) into v_n from public.demandes_devis d where d.statut = 'nouvelle';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'info', 'module', 'support',
      'titre', case when v_n = 1 then '1 demande de devis' else v_n || ' demandes de devis' end,
      'detail', 'Longues distances, mise à disposition et autres services.');
  end if;

  return jsonb_build_object(
    'maintenant', now(),
    'jour',       (select to_jsonb(x) from prive.chiffres_periode(prive.debut_jour_paris(v_jour), prive.debut_jour_paris(v_jour + 1)) x),
    'sept_jours', (select to_jsonb(x) from prive.chiffres_periode(prive.debut_jour_paris(v_jour - 6), prive.debut_jour_paris(v_jour + 1)) x),
    'mois',       (select to_jsonb(x) from prive.chiffres_periode(prive.debut_jour_paris(v_mois), prive.debut_jour_paris(v_jour + 1)) x),
    'statuts',    (select coalesce(jsonb_object_agg(s.statut, s.n), '{}'::jsonb)
                   from (select c.statut, count(*)::integer as n from public.courses c
                         where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')
                         group by c.statut) s),
    'chauffeurs', jsonb_build_object(
                    'valides',  (select count(*) from public.chauffeurs c
                                 join public.profils p on p.id = c.id and p.statut = 'actif'
                                 where c.statut = 'valide'),
                    'en_ligne', (select count(*) from public.positions po
                                 join public.chauffeurs c on c.id = po.chauffeur_id and c.statut = 'valide'
                                 where po.en_ligne and po.maj_le > now() - interval '3 minutes'),
                    'occupes',  (select count(distinct x.chauffeur_id) from public.courses x
                                 where x.statut in ('acceptee', 'arrivee', 'en_cours'))),
    'serie',      (select jsonb_agg(jsonb_build_object('jour', s.jour, 'courses', x.courses_terminees,
                                                       'chiffre_affaires', x.chiffre_affaires) order by s.jour)
                   from (select v_jour - k as jour from generate_series(0, 13) as k) s
                   cross join lateral prive.chiffres_periode(prive.debut_jour_paris(s.jour), prive.debut_jour_paris(s.jour + 1)) x),
    'alertes',    v_alertes
  );
end;
$$;
