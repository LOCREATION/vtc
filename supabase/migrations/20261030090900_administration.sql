-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 10 : ESPACE D'ADMINISTRATION
-- -----------------------------------------------------------------------------
--   1. Double authentification obligatoire : les droits d'administration ne
--      s'ouvrent qu'à une session confirmée par l'application d'authentification
--      du téléphone (niveau « aal2 » du jeton de connexion), comme prévu dans la
--      proposition. Un administrateur connecté par simple code e-mail n'a que
--      les droits d'un client tant qu'il n'a pas saisi le code de l'application.
--   2. Lectures de l'administration en une seule demande chacune : tableau de
--      bord, dispatch, liste et fiche des courses, chauffeurs, activité,
--      recherche de comptes.
--   3. Actions de l'administration : relancer la recherche automatique,
--      retirer une course à un chauffeur, suspendre ou réactiver un chauffeur.
-- Comme partout : chaque fonction vérifie elle-même l'appelant, chemin de
-- recherche vide, messages d'erreur en français affichables tels quels.
-- =============================================================================


-- #############################################################################
-- 1. DOUBLE AUTHENTIFICATION
-- #############################################################################
-- Le niveau « aal2 » est écrit par Supabase dans le jeton signé, après la
-- vérification du code à 6 chiffres de l'application d'authentification : il
-- ne peut pas être imité depuis le navigateur. Toutes les règles d'accès et
-- toutes les fonctions réservées à l'administration passent par celle-ci.
create or replace function public.est_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from public.profils p
                 where p.id = auth.uid() and p.role = 'admin' and p.statut = 'actif')
$$;
comment on function public.est_admin() is
  'Vrai pour un administrateur actif dont la session est confirmée par la double authentification (aal2).';


-- #############################################################################
-- 2. LECTURES DE L'ADMINISTRATION
-- #############################################################################

-- Chiffres d'une période [début, fin[ : courses terminées, chiffre d'affaires
-- TTC (prix + attente des courses terminées, frais d'annulation facturés),
-- pourboires (reversés aux chauffeurs, hors chiffre d'affaires), annulations.
create or replace function prive.chiffres_periode(
  p_debut timestamptz, p_fin timestamptz,
  out courses_terminees integer, out chiffre_affaires numeric, out pourboires numeric,
  out annulations integer, out frais_annulation numeric
)
language sql stable security definer set search_path = ''
as $$
  select
    count(*) filter (where c.statut = 'terminee')::integer,
    coalesce(sum(c.prix_total + c.frais_attente) filter (where c.statut = 'terminee'), 0)
      + coalesce(sum(c.frais_annulation) filter (where c.statut = 'annulee'), 0),
    coalesce(sum(c.pourboire) filter (where c.statut = 'terminee'), 0),
    count(*) filter (where c.statut = 'annulee')::integer,
    coalesce(sum(c.frais_annulation) filter (where c.statut = 'annulee'), 0)
  from public.courses c
  where (c.statut = 'terminee' and c.terminee_le >= p_debut and c.terminee_le < p_fin)
     or (c.statut = 'annulee'  and c.annulee_le  >= p_debut and c.annulee_le  < p_fin)
$$;

-- Début d'une journée de Paris, en instant exact (gère l'heure d'été)
create or replace function prive.debut_jour_paris(p_jour date)
returns timestamptz
language sql immutable set search_path = ''
as $$
  select p_jour::timestamp at time zone 'Europe/Paris'
$$;

-- Tableau de bord : chiffres, courses par statut, chauffeurs, série de
-- 14 jours et alertes classées (urgent, attention, info).
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

  -- 3. Paiements en attente d'encaissement depuis plus de 24 heures
  select count(*) into v_n from public.paiements p
   where p.statut = 'a_encaisser' and p.cree_le < now() - interval '24 hours';
  if v_n > 0 then
    v_alertes := v_alertes || jsonb_build_object('niveau', 'attention', 'module', 'courses',
      'titre', case when v_n = 1 then '1 paiement à encaisser depuis plus de 24 h'
                    else v_n || ' paiements à encaisser depuis plus de 24 h' end,
      'detail', 'Vérifiez avec le chauffeur, puis confirmez l''encaissement dans la fiche de la course.');
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

-- Dispatch : toutes les courses actives et à venir, avec le client, le
-- chauffeur et la demande en attente ; tous les chauffeurs validés avec leur
-- position. Rechargé à chaque changement (temps réel).
create or replace function public.admin_dispatch()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  return jsonb_build_object(
    'maintenant', now(),
    'recherche_avant_min', (select p.recherche_planifiee_avant_min from public.parametres p where p.id = 1),
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'numero', c.numero, 'statut', c.statut, 'type', c.type,
        'prise_en_charge_le', c.prise_en_charge_le, 'cree_le', c.cree_le,
        'depart_adresse', c.depart_adresse, 'depart_precision', c.depart_precision,
        'depart_lat', c.depart_lat, 'depart_lng', c.depart_lng,
        'arrivee_adresse', c.arrivee_adresse, 'arrivee_lat', c.arrivee_lat, 'arrivee_lng', c.arrivee_lng,
        'nb_arrets', (select count(*) from public.course_arrets a where a.course_id = c.id),
        'distance_km', c.distance_km, 'duree_min', c.duree_min, 'duree_mad_heures', c.duree_mad_heures,
        'prix_total', c.prix_total, 'mode_paiement', c.mode_paiement,
        'option_chauffeuse', c.option_chauffeuse, 'numero_vol', c.numero_vol, 'terminal', c.terminal,
        'pour_proche', c.pour_proche, 'beneficiaire_nom', c.beneficiaire_nom,
        'beneficiaire_telephone', c.beneficiaire_telephone,
        'client_nom', nullif(trim(cl.prenom || ' ' || cl.nom), ''), 'client_telephone', cl.telephone,
        'client_email', cl.email,
        'chauffeur_id', c.chauffeur_id, 'chauffeur_nom', nullif(trim(ch.prenom || ' ' || ch.nom), ''),
        'chauffeur_telephone', ch.telephone, 'vehicule_immatriculation', c.vehicule_immatriculation,
        'attribution', c.attribution, 'acceptee_le', c.acceptee_le, 'arrivee_le', c.arrivee_le,
        'demarree_le', c.demarree_le,
        'demande', (select jsonb_build_object('chauffeur_nom', nullif(trim(pp.prenom || ' ' || pp.nom), ''),
                                              'envoyee_le', pr.envoyee_le, 'expire_le', pr.expire_le,
                                              'distance_km', pr.distance_km)
                    from public.propositions pr join public.profils pp on pp.id = pr.chauffeur_id
                    where pr.course_id = c.id and pr.statut = 'envoyee'
                    order by pr.envoyee_le desc limit 1),
        'nb_demandes', (select count(*) from public.propositions pr where pr.course_id = c.id),
        'nb_sans_reponse', (select count(*) from public.propositions pr
                            where pr.course_id = c.id and pr.statut in ('refusee', 'expiree'))
      ) order by case c.statut when 'a_attribuer' then 0 when 'recherche' then 1 when 'arrivee' then 2
                               when 'acceptee' then 3 when 'en_cours' then 4 else 5 end,
                 c.prise_en_charge_le)
      from public.courses c
      join public.profils cl on cl.id = c.client_id
      left join public.profils ch on ch.id = c.chauffeur_id
      where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')
    ), '[]'::jsonb),
    'chauffeurs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'nom', nullif(trim(p.prenom || ' ' || p.nom), ''), 'telephone', p.telephone,
        'chauffeuse', c.chauffeuse,
        'en_ligne', coalesce(po.en_ligne, false),
        'signal_recent', coalesce(po.maj_le > now() - interval '3 minutes', false),
        'latitude', po.latitude, 'longitude', po.longitude, 'position_le', po.maj_le,
        'vehicule', case when v.id is not null then v.marque || ' ' || v.modele || ' · ' || v.immatriculation end,
        'course_active', (select jsonb_build_object('id', x.id, 'numero', x.numero, 'statut', x.statut)
                          from public.courses x
                          where x.chauffeur_id = c.id and x.statut in ('acceptee', 'arrivee', 'en_cours')
                          order by x.acceptee_le limit 1),
        'demande_en_attente', exists (select 1 from public.propositions pr
                                      where pr.chauffeur_id = c.id and pr.statut = 'envoyee' and pr.expire_le > now())
      ) order by coalesce(po.en_ligne, false) desc, p.prenom, p.nom)
      from public.chauffeurs c
      join public.profils p on p.id = c.id and p.statut = 'actif'
      left join public.positions po on po.chauffeur_id = c.id
      left join public.vehicules v on v.id = c.vehicule_id
      where c.statut = 'valide'
    ), '[]'::jsonb)
  );
end;
$$;

-- Chauffeurs pour une attribution à la main : tous les chauffeurs validés,
-- les attribuables d'abord (en ligne, puis du plus proche au plus loin).
-- « motif » : ce qui empêche l'attribution (mêmes règles que attribuer_course).
-- « avertissements » : l'attribution reste possible, l'administration décide.
create or replace function public.admin_chauffeurs_pour_course(p_course uuid)
returns table (
  chauffeur_id    uuid,
  nom             text,
  telephone       text,
  chauffeuse      boolean,
  vehicule        text,
  en_ligne        boolean,
  distance_km     numeric,
  position_le     timestamptz,
  occupe          boolean,
  conflit         text,
  note_moyenne    numeric,
  attribuable     boolean,
  motif           text,
  avertissements  text[]
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_course public.courses;
  v_jour   date;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  v_jour := prive.heure_paris(v_course.prise_en_charge_le)::date;

  return query
  select
    c.id,
    nullif(trim(p.prenom || ' ' || p.nom), ''),
    p.telephone,
    c.chauffeuse,
    case when v.id is not null then v.marque || ' ' || v.modele || ' · ' || v.immatriculation end,
    coalesce(po.en_ligne and po.maj_le > now() - interval '3 minutes', false),
    case when po.latitude is not null
         then round(prive.distance_km(po.latitude, po.longitude, v_course.depart_lat, v_course.depart_lng), 1) end,
    po.maj_le,
    exists (select 1 from public.courses x
            where x.chauffeur_id = c.id and x.id <> v_course.id and x.statut in ('acceptee', 'arrivee', 'en_cours')),
    (select x.numero || ' à ' || to_char(prive.heure_paris(x.prise_en_charge_le), 'HH24:MI')
       from public.courses x
      where x.chauffeur_id = c.id and x.id <> v_course.id
        and x.statut in ('planifiee', 'acceptee', 'arrivee', 'en_cours')
        and abs(extract(epoch from (x.prise_en_charge_le - v_course.prise_en_charge_le))) < 5400
      order by x.prise_en_charge_le limit 1),
    c.note_moyenne,
    (v.id is not null and v.actif and (not v_course.option_chauffeuse or c.chauffeuse)),
    case when v.id is null then 'Aucun véhicule affecté'
         when not v.actif then 'Véhicule désactivé'
         when v_course.option_chauffeuse and not c.chauffeuse then 'La cliente a demandé une chauffeuse'
    end,
    array_remove(array[
      case when c.carte_vtc_expiration is null then 'Carte VTC non renseignée'
           when c.carte_vtc_expiration < v_jour then 'Carte VTC expirée le ' || to_char(c.carte_vtc_expiration, 'DD/MM/YYYY') end,
      case when c.permis_expiration < v_jour then 'Permis expiré le ' || to_char(c.permis_expiration, 'DD/MM/YYYY') end,
      case when v.id is not null and (v.assurance_expiration is null or v.assurance_expiration < v_jour)
           then 'Assurance du véhicule manquante ou expirée' end,
      case when v.id is not null and v.controle_technique_expiration < v_jour then 'Contrôle technique expiré' end,
      case when v.id is not null and v.categorie_id <> v_course.categorie_id then 'Véhicule d''une autre catégorie' end
    ], null)
  from public.chauffeurs c
  join public.profils p on p.id = c.id and p.role = 'chauffeur' and p.statut = 'actif'
  left join public.vehicules v on v.id = c.vehicule_id
  left join public.positions po on po.chauffeur_id = c.id
  where c.statut = 'valide'
  order by 12 desc, 6 desc, 7 nulls last, 2;
end;
$$;

-- Liste des courses : filtres (statuts, période de prise en charge à l'heure
-- de Paris, texte libre) et pagination. Le texte cherche dans le numéro, les
-- adresses, le client, le chauffeur, la plaque et la personne transportée.
create or replace function public.admin_lister_courses(
  p_statuts   text[]  default null,
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
  -- « % » et « _ » saisis sont cherchés tels quels
  v_motif  text := case when nullif(trim(coalesce(p_texte, '')), '') is null then null
                        else '%' || replace(replace(replace(trim(p_texte), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_total  integer;
  v_lignes jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;

  with selection as (
    select c.*, cl.prenom as cl_prenom, cl.nom as cl_nom, cl.email as cl_email, cl.telephone as cl_telephone,
           ch.prenom as ch_prenom, ch.nom as ch_nom
    from public.courses c
    join public.profils cl on cl.id = c.client_id
    left join public.profils ch on ch.id = c.chauffeur_id
    where (p_statuts is null or cardinality(p_statuts) = 0 or c.statut = any (p_statuts))
      and (p_debut is null or c.prise_en_charge_le >= prive.debut_jour_paris(p_debut))
      and (p_fin is null or c.prise_en_charge_le < prive.debut_jour_paris(p_fin + 1))
      and (v_motif is null or concat_ws(' ', c.numero, c.depart_adresse, c.arrivee_adresse, cl.prenom, cl.nom,
                                         cl.email, cl.telephone, ch.prenom, ch.nom, c.vehicule_immatriculation,
                                         c.beneficiaire_nom) ilike v_motif)
  ),
  page as (
    select * from selection s
    order by s.prise_en_charge_le desc, s.numero desc
    limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)
  )
  select (select count(*) from selection),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'numero', g.numero, 'statut', g.statut, 'type', g.type,
           'prise_en_charge_le', g.prise_en_charge_le, 'cree_le', g.cree_le,
           'terminee_le', g.terminee_le, 'annulee_le', g.annulee_le, 'annulee_par', g.annulee_par,
           'depart_adresse', g.depart_adresse, 'arrivee_adresse', g.arrivee_adresse,
           'distance_km', g.distance_km, 'duree_min', g.duree_min,
           'prix_total', g.prix_total, 'frais_attente', g.frais_attente, 'frais_annulation', g.frais_annulation,
           'pourboire', g.pourboire, 'remise', g.remise, 'mode_paiement', g.mode_paiement,
           'option_chauffeuse', g.option_chauffeuse, 'numero_vol', g.numero_vol,
           'pour_proche', g.pour_proche, 'beneficiaire_nom', g.beneficiaire_nom,
           'client_nom', nullif(trim(g.cl_prenom || ' ' || g.cl_nom), ''), 'client_email', g.cl_email,
           'client_telephone', g.cl_telephone,
           'chauffeur_nom', nullif(trim(coalesce(g.ch_prenom, '') || ' ' || coalesce(g.ch_nom, '')), ''),
           'vehicule_immatriculation', g.vehicule_immatriculation, 'attribution', g.attribution
         ) order by g.prise_en_charge_le desc, g.numero desc), '[]'::jsonb)
    into v_total, v_lignes
  from page g;

  return jsonb_build_object('total', v_total, 'lignes', v_lignes);
end;
$$;

-- Fiche complète d'une course : tout ce qu'il faut pour la suivre, la
-- corriger ou répondre à une réclamation, en une seule lecture.
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
    'paiements', coalesce((select jsonb_agg(jsonb_build_object(
                             'id', pa.id, 'nature', pa.nature, 'mode', pa.mode, 'montant', pa.montant, 'statut', pa.statut,
                             'cree_le', pa.cree_le, 'encaisse_le', pa.encaisse_le,
                             'encaisse_par', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = pa.encaisse_par),
                             'rembourse', (select coalesce(sum(r.montant), 0) from public.remboursements r where r.paiement_id = pa.id))
                           order by pa.cree_le)
                           from public.paiements pa where pa.course_id = v_course.id), '[]'::jsonb),
    'remboursements', coalesce((select jsonb_agg(jsonb_build_object('paiement_id', r.paiement_id, 'montant', r.montant,
                                                                   'motif', r.motif, 'cree_le', r.cree_le,
                                                                   'cree_par', nullif(trim(p.prenom || ' ' || p.nom), ''))
                                                 order by r.cree_le)
                                from public.remboursements r
                                join public.paiements pa on pa.id = r.paiement_id
                                left join public.profils p on p.id = r.cree_par
                                where pa.course_id = v_course.id), '[]'::jsonb),
    'factures', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'numero', f.numero, 'nature', f.nature,
                                                             'date_emission', f.date_emission, 'montant_ht', f.montant_ht,
                                                             'taux_tva', f.taux_tva, 'montant_tva', f.montant_tva,
                                                             'montant_ttc', f.montant_ttc, 'pourboire', f.pourboire,
                                                             'statut', f.statut, 'pdf_chemin', f.pdf_chemin) order by f.numero)
                          from public.factures f where f.course_id = v_course.id), '[]'::jsonb),
    'evaluations', coalesce((select jsonb_agg(jsonb_build_object('sens', e.sens, 'note', e.note,
                                                                'commentaire', e.commentaire, 'cree_le', e.cree_le) order by e.cree_le)
                             from public.evaluations e where e.course_id = v_course.id), '[]'::jsonb)
  );
end;
$$;

-- Chauffeurs et candidats : fiche, compte, véhicule, candidature, documents,
-- activité des 30 derniers jours. Candidats d'abord, puis validés, suspendus,
-- refusés.
create or replace function public.admin_lister_chauffeurs()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'statut', c.statut, 'salarie', c.salarie, 'chauffeuse', c.chauffeuse,
      'prenom', p.prenom, 'nom', p.nom, 'email', p.email, 'telephone', p.telephone,
      'compte_statut', p.statut, 'role', p.role,
      'vehicule_id', c.vehicule_id,
      'vehicule', case when v.id is not null then v.marque || ' ' || v.modele || ' · ' || v.immatriculation end,
      'carte_vtc_numero', c.carte_vtc_numero, 'carte_vtc_expiration', c.carte_vtc_expiration,
      'permis_numero', c.permis_numero, 'permis_expiration', c.permis_expiration,
      'note_moyenne', c.note_moyenne, 'nb_notes', c.nb_notes,
      'courses_proposees', c.courses_proposees, 'courses_acceptees', c.courses_acceptees,
      'valide_le', c.valide_le, 'cree_le', c.cree_le,
      'en_ligne', coalesce(po.en_ligne and po.maj_le > now() - interval '3 minutes', false),
      'courses_30_jours', (select count(*) from public.courses x
                           where x.chauffeur_id = c.id and x.statut = 'terminee' and x.terminee_le > now() - interval '30 days'),
      'candidature', (select jsonb_build_object('statut', ca.statut, 'ville', ca.ville, 'experience', ca.experience,
                                                'a_carte_vtc', ca.a_carte_vtc, 'message', ca.message,
                                                'motif_refus', ca.motif_refus, 'cree_le', ca.cree_le, 'traitee_le', ca.traitee_le)
                      from public.candidatures ca where ca.profil_id = c.id),
      'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'type', d.type, 'statut', d.statut,
                                                                'numero', d.numero, 'expire_le', d.expire_le,
                                                                'fichier_chemin', d.fichier_chemin, 'commentaire', d.commentaire,
                                                                'cree_le', d.cree_le, 'verifie_le', d.verifie_le)
                                              order by d.cree_le desc)
                             from public.documents d where d.chauffeur_id = c.id), '[]'::jsonb)
    ) order by case c.statut when 'candidat' then 0 when 'valide' then 1 when 'suspendu' then 2 else 3 end,
               p.prenom, p.nom)
    from public.chauffeurs c
    join public.profils p on p.id = c.id
    left join public.vehicules v on v.id = c.vehicule_id
    left join public.positions po on po.chauffeur_id = c.id
  ), '[]'::jsonb);
end;
$$;

-- Activité des chauffeurs sur une période (jours de Paris, bornes comprises).
create or replace function public.admin_activite_chauffeurs(p_debut date, p_fin date)
returns table (
  chauffeur_id        uuid,
  nom                 text,
  statut              text,
  courses_terminees   integer,
  chiffre_affaires    numeric,
  pourboires          numeric,
  minutes_en_course   integer,
  kilometres          numeric,
  desistements        integer,
  demandes_recues     integer,
  demandes_acceptees  integer,
  demandes_refusees   integer,
  demandes_expirees   integer,
  note_periode        numeric,
  notes_periode       integer
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_debut timestamptz := prive.debut_jour_paris(p_debut);
  v_fin   timestamptz := prive.debut_jour_paris(p_fin + 1);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_debut is null or p_fin is null or p_fin < p_debut then
    raise exception 'Période invalide.';
  end if;
  return query
  select
    c.id,
    nullif(trim(p.prenom || ' ' || p.nom), ''),
    c.statut,
    (select count(*)::integer from public.courses x
      where x.chauffeur_id = c.id and x.statut = 'terminee' and x.terminee_le >= v_debut and x.terminee_le < v_fin),
    (select coalesce(sum(x.prix_total + x.frais_attente), 0) from public.courses x
      where x.chauffeur_id = c.id and x.statut = 'terminee' and x.terminee_le >= v_debut and x.terminee_le < v_fin),
    (select coalesce(sum(x.pourboire), 0) from public.courses x
      where x.chauffeur_id = c.id and x.statut = 'terminee' and x.terminee_le >= v_debut and x.terminee_le < v_fin),
    (select coalesce(sum(extract(epoch from (x.terminee_le - x.demarree_le)) / 60), 0)::integer from public.courses x
      where x.chauffeur_id = c.id and x.statut = 'terminee' and x.terminee_le >= v_debut and x.terminee_le < v_fin),
    (select coalesce(sum(x.distance_km), 0) from public.courses x
      where x.chauffeur_id = c.id and x.statut = 'terminee' and x.terminee_le >= v_debut and x.terminee_le < v_fin),
    (select count(*)::integer from public.evenements_course e
      where e.type = 'desistement_chauffeur' and e.acteur_id = c.id and e.cree_le >= v_debut and e.cree_le < v_fin),
    (select count(*)::integer from public.propositions pr
      where pr.chauffeur_id = c.id and pr.envoyee_le >= v_debut and pr.envoyee_le < v_fin),
    (select count(*)::integer from public.propositions pr
      where pr.chauffeur_id = c.id and pr.statut = 'acceptee' and pr.envoyee_le >= v_debut and pr.envoyee_le < v_fin),
    (select count(*)::integer from public.propositions pr
      where pr.chauffeur_id = c.id and pr.statut = 'refusee' and pr.envoyee_le >= v_debut and pr.envoyee_le < v_fin),
    (select count(*)::integer from public.propositions pr
      where pr.chauffeur_id = c.id and pr.statut = 'expiree' and pr.envoyee_le >= v_debut and pr.envoyee_le < v_fin),
    (select round(avg(e.note)::numeric, 2) from public.evaluations e
      where e.cible_id = c.id and e.sens = 'client_vers_chauffeur' and e.cree_le >= v_debut and e.cree_le < v_fin),
    (select count(*)::integer from public.evaluations e
      where e.cible_id = c.id and e.sens = 'client_vers_chauffeur' and e.cree_le >= v_debut and e.cree_le < v_fin)
  from public.chauffeurs c
  join public.profils p on p.id = c.id
  where c.statut in ('valide', 'suspendu')
  order by 4 desc, 2;
end;
$$;

-- Recherche d'un compte (nommer un administrateur, enregistrer un chauffeur
-- embauché directement) : nom, e-mail ou téléphone, 2 caractères au moins.
create or replace function public.admin_rechercher_comptes(p_texte text)
returns table (
  id               uuid,
  prenom           text,
  nom              text,
  email            text,
  telephone        text,
  role             text,
  statut           text,
  cree_le          timestamptz,
  chauffeur_statut text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_texte text := trim(coalesce(p_texte, ''));
  v_motif text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if char_length(v_texte) < 2 then
    raise exception 'Saisissez au moins 2 caractères.';
  end if;
  v_motif := '%' || replace(replace(replace(v_texte, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
  select p.id, p.prenom, p.nom, p.email, p.telephone, p.role, p.statut, p.cree_le, ch.statut
  from public.profils p
  left join public.chauffeurs ch on ch.id = p.id
  where concat_ws(' ', p.prenom, p.nom, p.email, p.telephone) ilike v_motif
  order by p.prenom, p.nom, p.email
  limit 20;
end;
$$;


-- #############################################################################
-- 3. ACTIONS DE L'ADMINISTRATION
-- #############################################################################

-- Course « à attribuer » : nouvel essai immédiat de la recherche automatique
-- (utile surtout plus de 30 minutes après l'heure prévue, quand la relance
-- automatique s'arrête). Si personne n'est disponible, rien ne change.
create or replace function public.admin_lancer_recherche(p_course uuid)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course public.courses;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut <> 'a_attribuer' then
    raise exception 'La recherche automatique ne se relance que pour une course « à attribuer ».';
  end if;
  if prive.proposer_course(p_course) is null then
    raise exception 'Aucun chauffeur en ligne ne peut prendre cette course pour le moment : attribuez-la à la main.';
  end if;
  perform prive.journaliser_action('relance_recherche', 'courses', p_course::text, null);
  select * into v_course from public.courses c where c.id = p_course;
  return v_course;
end;
$$;

-- Retirer la course à son chauffeur (avant que le client soit à bord) : elle
-- redevient une réservation sans chauffeur, ou repart aussitôt en recherche si
-- l'heure est proche. Le chauffeur et le client sont prévenus.
create or replace function public.admin_retirer_chauffeur(p_course uuid, p_motif text default null)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course     public.courses;
  v_param      public.parametres;
  v_chauffeur  uuid;
  v_motif      text := nullif(left(trim(coalesce(p_motif, '')), 500), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.chauffeur_id is null or v_course.statut not in ('planifiee', 'acceptee', 'arrivee') then
    raise exception 'Aucun chauffeur à retirer : la course n''est pas attribuée, ou le client est déjà à bord.';
  end if;
  v_chauffeur := v_course.chauffeur_id;
  select * into v_param from public.parametres where id = 1;

  update public.courses
     set chauffeur_id = null, vehicule_id = null, chauffeur_prenom = null, chauffeur_telephone = null,
         chauffeur_photo = null, vehicule_libelle = null, vehicule_couleur = null, vehicule_immatriculation = null,
         client_prenom = null, client_telephone = null, attribution = null, attribuee_par = null,
         acceptee_le = null, arrivee_le = null,
         statut = case when prise_en_charge_le > now() + make_interval(mins => v_param.recherche_planifiee_avant_min)
                       then 'planifiee' else 'recherche' end
   where id = p_course
  returning * into v_course;

  perform prive.evenement(p_course, 'chauffeur_retire', jsonb_build_object('chauffeur_id', v_chauffeur, 'motif', v_motif));
  perform prive.journaliser_action('retrait_chauffeur', 'courses', p_course::text,
    jsonb_build_object('chauffeur_id', v_chauffeur, 'motif', v_motif));
  perform prive.notifier(v_chauffeur, 'course', 'Course retirée',
    'L''administration a retiré la course ' || v_course.numero || coalesce(' : ' || v_motif, '') || '.', '/chauffeur/');
  perform prive.notifier(v_course.client_id, 'course', 'Changement de chauffeur',
    'Nous vous attribuons un autre chauffeur pour la course ' || v_course.numero || '.',
    '/client/course/?id=' || p_course);

  if v_course.statut = 'recherche' then
    perform prive.proposer_course(p_course);
  end if;
  select * into v_course from public.courses c where c.id = p_course;
  return v_course;
end;
$$;

-- Suspendre un chauffeur validé (il passe hors ligne, ses réservations à venir
-- lui sont retirées) ou réactiver un chauffeur suspendu.
create or replace function public.admin_statut_chauffeur(p_chauffeur uuid, p_statut text, p_motif text default null)
returns public.chauffeurs
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_chauffeur public.chauffeurs;
  v_motif     text := nullif(left(trim(coalesce(p_motif, '')), 500), '');
  r           record;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut not in ('valide', 'suspendu') then
    raise exception 'Statut inconnu.';
  end if;
  select * into v_chauffeur from public.chauffeurs c where c.id = p_chauffeur for update;
  if v_chauffeur.id is null then
    raise exception 'Chauffeur introuvable.';
  end if;
  if p_statut = 'suspendu' and v_chauffeur.statut <> 'valide' then
    raise exception 'Seul un chauffeur validé peut être suspendu.';
  end if;
  if p_statut = 'valide' and v_chauffeur.statut <> 'suspendu' then
    raise exception 'Seul un chauffeur suspendu peut être réactivé ; une candidature se valide depuis l''onglet Candidatures.';
  end if;
  if p_statut = 'suspendu' and exists (select 1 from public.courses x
                                       where x.chauffeur_id = p_chauffeur and x.statut in ('acceptee', 'arrivee', 'en_cours')) then
    raise exception 'Ce chauffeur a une course en cours : attendez la fin de la course, ou retirez-la-lui d''abord.';
  end if;

  update public.chauffeurs set statut = p_statut where id = p_chauffeur returning * into v_chauffeur;

  -- Réservations à venir d'un chauffeur suspendu : rendues au dispatch
  if p_statut = 'suspendu' then
    for r in select x.id from public.courses x where x.chauffeur_id = p_chauffeur and x.statut = 'planifiee' loop
      perform public.admin_retirer_chauffeur(r.id, 'chauffeur indisponible');
    end loop;
  end if;

  perform prive.journaliser_action(case when p_statut = 'suspendu' then 'suspension_chauffeur' else 'reactivation_chauffeur' end,
    'chauffeurs', p_chauffeur::text, jsonb_build_object('motif', v_motif));
  perform prive.notifier(p_chauffeur, 'alerte',
    case when p_statut = 'suspendu' then 'Compte chauffeur suspendu' else 'Compte chauffeur réactivé' end,
    case when p_statut = 'suspendu'
         then 'Vous ne recevez plus de courses' || coalesce(' : ' || v_motif, '') || '. Contactez LOC RÉACTION.'
         else 'Vous pouvez de nouveau passer en ligne et recevoir des courses.' end,
    '/chauffeur/');
  return v_chauffeur;
end;
$$;


-- #############################################################################
-- 4. DROITS D'EXÉCUTION
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout, puis on n'accorde que l'utile. Les fonctions
-- d'administration vérifient en plus elles-mêmes la double authentification.
revoke all on function
  prive.chiffres_periode(timestamptz, timestamptz),
  prive.debut_jour_paris(date)
  from public, anon, authenticated;

revoke all on function
  public.admin_tableau_de_bord(),
  public.admin_dispatch(),
  public.admin_chauffeurs_pour_course(uuid),
  public.admin_lister_courses(text[], date, date, text, integer, integer),
  public.admin_fiche_course(uuid),
  public.admin_lister_chauffeurs(),
  public.admin_activite_chauffeurs(date, date),
  public.admin_rechercher_comptes(text),
  public.admin_lancer_recherche(uuid),
  public.admin_retirer_chauffeur(uuid, text),
  public.admin_statut_chauffeur(uuid, text, text)
  from public, anon;

grant execute on function
  public.admin_tableau_de_bord(),
  public.admin_dispatch(),
  public.admin_chauffeurs_pour_course(uuid),
  public.admin_lister_courses(text[], date, date, text, integer, integer),
  public.admin_fiche_course(uuid),
  public.admin_lister_chauffeurs(),
  public.admin_activite_chauffeurs(date, date),
  public.admin_rechercher_comptes(text),
  public.admin_lancer_recherche(uuid),
  public.admin_retirer_chauffeur(uuid, text),
  public.admin_statut_chauffeur(uuid, text, text)
  to authenticated;
