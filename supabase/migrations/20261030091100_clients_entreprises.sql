-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 12 : CLIENTS ET ENTREPRISES
-- -----------------------------------------------------------------------------
-- Module « Clients et entreprises » de l'administration : fiches, historique,
-- blocage, facturation mensuelle des comptes professionnels.
--   1. Structure : délai de paiement et contrôles de saisie des comptes pro,
--      coordonnées bancaires de la société (IBAN, BIC) imprimées sur les
--      relevés, notes internes de l'administration.
--   2. Protections automatiques :
--        - le plafond mensuel d'un compte pro est respecté à la commande ;
--        - une correction des coordonnées d'un client par l'administration
--          est inscrite au journal ;
--        - un membre est prévenu quand on le rattache à un compte pro, ou
--          qu'on l'en détache.
--   3. Lectures : liste et fiche des clients, liste et fiche des comptes pro,
--      relevé mensuel d'un compte pro.
--   4. Actions : bloquer ou débloquer un client (motif obligatoire pour un
--      blocage, réservations annulées si demandé), encaisser le relevé
--      mensuel d'un compte pro en une fois.
--   5. Droits d'exécution.
-- (Le tableau de bord tient compte des relevés mensuels : migration 13.)
-- Comme partout : chaque fonction vérifie elle-même l'appelant (double
-- authentification comprise), chemin de recherche vide, messages d'erreur en
-- français affichables tels quels.
-- =============================================================================


-- #############################################################################
-- 1. STRUCTURE
-- #############################################################################

-- 1a. Comptes professionnels : délai de paiement du relevé et contrôles de
--     saisie (la page vérifie aussi, avec un message précis ; la base refuse
--     de toute façon une valeur hors format).
alter table public.comptes_pro
  add column delai_paiement_jours integer not null default 30,
  add constraint comptes_pro_delai check (delai_paiement_jours between 0 and 60),
  add constraint comptes_pro_raison_sociale_saisie check (char_length(trim(raison_sociale)) >= 2),
  add constraint comptes_pro_tva check (tva_intracommunautaire is null or tva_intracommunautaire ~ '^[A-Z]{2}[0-9A-Z]{2,13}$'),
  add constraint comptes_pro_email check (email_facturation ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  add constraint comptes_pro_telephone check (telephone is null or telephone ~ '^\+[1-9][0-9]{6,14}$'),
  add constraint comptes_pro_longueurs check (
    char_length(coalesce(adresse, '')) <= 200 and char_length(coalesce(code_postal, '')) <= 10
    and char_length(coalesce(ville, '')) <= 80 and char_length(coalesce(contact_nom, '')) <= 120);
comment on column public.comptes_pro.delai_paiement_jours is
  'Délai de règlement du relevé mensuel, en jours après la fin du mois (60 au plus, comme le prévoit la loi).';
comment on column public.comptes_pro.plafond_mensuel is
  'Montant TTC maximal des courses commandées sur facture mensuelle dans le mois (vide = sans plafond).';

-- 1b. Coordonnées bancaires de LOC RÉACTION, imprimées sur les relevés
--     mensuels pour le règlement par virement (format contrôlé ici ; la clé
--     de contrôle de l'IBAN est vérifiée par la page au moment de la saisie).
alter table public.societe
  add column iban text,
  add column bic  text,
  add constraint societe_iban check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  add constraint societe_bic  check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$');
comment on column public.societe.iban is 'IBAN du compte de l''entreprise, sans espace (relevés des comptes professionnels).';
comment on column public.societe.bic  is 'BIC de la banque, 8 ou 11 caractères.';

-- 1c. Notes internes : remarques de l'administration sur un client ou un
--     compte professionnel (« règle toujours en retard », « préfère être
--     appelée »…). Jamais visibles du client ; chacun ne retire que les siennes.
create table public.notes_internes (
  id             uuid primary key default gen_random_uuid(),
  profil_id      uuid references public.profils (id) on delete cascade,
  compte_pro_id  uuid references public.comptes_pro (id) on delete cascade,
  texte          text not null check (char_length(trim(texte)) between 1 and 2000),
  auteur_id      uuid default auth.uid() references public.profils (id) on delete set null,
  cree_le        timestamptz not null default now(),
  constraint notes_internes_une_cible check ((profil_id is null) <> (compte_pro_id is null))
);
create index notes_internes_profil_idx on public.notes_internes (profil_id, cree_le desc) where profil_id is not null;
create index notes_internes_compte_idx on public.notes_internes (compte_pro_id, cree_le desc) where compte_pro_id is not null;
create index notes_internes_auteur_idx on public.notes_internes (auteur_id);
comment on table public.notes_internes is 'Remarques internes de l''administration sur un client ou un compte professionnel.';

alter table public.notes_internes enable row level security;
-- Supabase accorde tout par défaut sur une nouvelle table : on retire tout,
-- puis on n'accorde que l'utile, à l'administration seulement.
revoke all on public.notes_internes from public, anon, authenticated;
grant select, insert, delete on public.notes_internes to authenticated;
create policy notes_internes_lecture on public.notes_internes for select to authenticated
  using ((select public.est_admin()));
create policy notes_internes_ajout on public.notes_internes for insert to authenticated
  with check ((select public.est_admin()) and auteur_id = (select auth.uid()));
create policy notes_internes_suppression on public.notes_internes for delete to authenticated
  using ((select public.est_admin()) and auteur_id = (select auth.uid()));


-- #############################################################################
-- 2. OUTILS ET PROTECTIONS AUTOMATIQUES
-- #############################################################################

-- « octobre 2026 » (noms de mois en français, quel que soit le réglage du serveur)
create or replace function prive.mois_lisible(p_jour date)
returns text
language sql immutable set search_path = ''
as $$
  select (array['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                'septembre', 'octobre', 'novembre', 'décembre'])[extract(month from p_jour)::integer]
         || ' ' || extract(year from p_jour)::integer
$$;

-- Échéance du relevé qui contient un paiement : dernier jour du mois (heure
-- de Paris) du paiement, plus le délai de règlement du compte.
create or replace function prive.echeance_releve(p_instant timestamptz, p_delai integer)
returns date
language sql stable set search_path = ''
as $$
  select ((date_trunc('month', prive.heure_paris(p_instant)) + interval '1 month')::date - 1) + coalesce(p_delai, 30)
$$;

-- Début du mois en cours (heure de Paris), en instant exact
create or replace function prive.debut_mois_paris()
returns timestamptz
language sql stable set search_path = ''
as $$
  select prive.debut_jour_paris(date_trunc('month', prive.heure_paris())::date)
$$;

-- Montant engagé ce mois-ci sur facture mensuelle par un compte pro :
-- courses commandées depuis le 1er (prix annoncé et attente), annulées
-- comprises pour leurs seuls frais d'annulation.
create or replace function prive.engage_mois_pro(p_compte uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(case when c.statut = 'annulee' then c.frais_annulation else c.prix_total + c.frais_attente end), 0)
  from public.courses c
  where c.compte_pro_id = p_compte and c.mode_paiement = 'facture_mensuelle' and c.cree_le >= prive.debut_mois_paris()
$$;

-- 2a. Plafond mensuel : vérifié à chaque commande sur facture mensuelle.
--     Le compte est verrouillé le temps de la vérification : deux commandes
--     simultanées ne peuvent pas dépasser ensemble le plafond.
create or replace function prive.controler_plafond_pro()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_compte public.comptes_pro;
  v_engage numeric;
begin
  select * into v_compte from public.comptes_pro cp where cp.id = new.compte_pro_id for update;
  if v_compte.id is null or v_compte.plafond_mensuel is null then
    return new;
  end if;
  v_engage := prive.engage_mois_pro(new.compte_pro_id);
  if v_engage + new.prix_total > v_compte.plafond_mensuel then
    raise exception 'Plafond mensuel du compte « % » atteint : il reste % ce mois-ci, pour une course de %. Choisissez un autre moyen de paiement ou contactez le gestionnaire du compte.',
      v_compte.raison_sociale, prive.euros(greatest(v_compte.plafond_mensuel - v_engage, 0)), prive.euros(new.prix_total);
  end if;
  return new;
end;
$$;

create trigger controler_plafond_pro
  before insert on public.courses
  for each row when (new.compte_pro_id is not null and new.mode_paiement = 'facture_mensuelle')
  execute function prive.controler_plafond_pro();

-- 2b. Coordonnées d'un client corrigées par l'administration : inscrites au
--     journal (le client qui modifie les siennes n'y figure pas).
create trigger journal_coordonnees
  after update of prenom, nom, telephone, langue on public.profils
  for each row when (
    current_user = 'authenticated' and auth.uid() is distinct from new.id
    and (old.prenom, old.nom, old.telephone, old.langue) is distinct from (new.prenom, new.nom, new.telephone, new.langue))
  execute function prive.journaliser();

-- 2c. Membre rattaché à un compte pro, ou détaché : il est prévenu dans
--     l'application (le rattachement change ce qu'il peut choisir à la
--     commande).
create or replace function prive.notifier_membre_pro()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_raison text;
begin
  select cp.raison_sociale into v_raison
    from public.comptes_pro cp where cp.id = coalesce(new.compte_pro_id, old.compte_pro_id);
  -- Compte pro supprimé en même temps (suppression en cascade) : pas de message
  if v_raison is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    perform prive.notifier(new.profil_id, 'info', 'Compte professionnel',
      'Vous êtes rattaché(e) au compte professionnel « ' || v_raison || ' » : à la commande, choisissez « Facture mensuelle » '
      || 'pour que la course lui soit facturée.'
      || case when new.role = 'gestionnaire' then ' En tant que gestionnaire, vous voyez aussi ses courses et ses factures.' else '' end);
  else
    perform prive.notifier(old.profil_id, 'info', 'Compte professionnel',
      'Vous n''êtes plus rattaché(e) au compte professionnel « ' || v_raison || ' ».');
  end if;
  return coalesce(new, old);
end;
$$;

create trigger notifier_membre_pro
  after insert or delete on public.comptes_pro_membres
  for each row execute function prive.notifier_membre_pro();

-- 2d. Paiements d'un relevé mensuel : ceux des factures émises dans le mois
--     pour le compte (course, frais d'annulation), et les pourboires laissés
--     dans le mois sur ses courses. Base du relevé et de son encaissement.
create or replace function prive.paiements_releve(p_compte uuid, p_debut date, p_fin date)
returns setof public.paiements
language sql stable security definer set search_path = ''
as $$
  select pa.*
  from public.paiements pa
  join public.factures f on f.course_id = pa.course_id and f.nature = pa.nature
  where f.compte_pro_id = p_compte and f.statut = 'emise' and f.date_emission between p_debut and p_fin
  union all
  select pa.*
  from public.paiements pa
  join public.courses c on c.id = pa.course_id
  where pa.nature = 'pourboire' and c.compte_pro_id = p_compte
    and pa.cree_le >= prive.debut_jour_paris(p_debut) and pa.cree_le < prive.debut_jour_paris(p_fin + 1)
$$;


-- #############################################################################
-- 3. LECTURES DE L'ADMINISTRATION
-- #############################################################################

-- 3a. Liste des clients : recherche (nom, e-mail, téléphone saisi avec ou
--     sans espaces, code de parrainage), statut, tri, pagination ; résumé
--     de toute la clientèle pour les chiffres en tête de page.
create or replace function public.admin_lister_clients(
  p_texte     text    default null,
  p_statut    text    default null,          -- 'actif', 'bloque' ou null (tous)
  p_tri       text    default 'recents',     -- recents, nom, depense, courses, derniere
  p_limite    integer default 50,
  p_decalage  integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_texte    text := nullif(trim(coalesce(p_texte, '')), '');
  v_motif    text;
  v_chiffres text;
  v_tri      text := case when p_tri in ('recents', 'nom', 'depense', 'courses', 'derniere') then p_tri else 'recents' end;
  v_total    integer;
  v_lignes   jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut is not null and p_statut not in ('actif', 'bloque') then
    raise exception 'Statut inconnu.';
  end if;
  if v_texte is not null then
    -- « % » et « _ » saisis sont cherchés tels quels
    v_motif := '%' || replace(replace(replace(v_texte, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- Téléphone saisi comme on le dit : « 06 12 34 56 78 » retrouve +33612345678
    v_chiffres := regexp_replace(v_texte, '[^0-9]', '', 'g');
    if v_chiffres ~ '^0[1-9][0-9]{8}$' then
      v_chiffres := substr(v_chiffres, 2);
    end if;
    if char_length(v_chiffres) < 6 then
      v_chiffres := null;
    end if;
  end if;

  with clients as (
    select p.*
    from public.profils p
    where p.role = 'client'
      and (p_statut is null or p.statut = p_statut)
      and (v_motif is null
           or concat_ws(' ', p.prenom, p.nom, p.email, p.telephone, p.code_parrainage) ilike v_motif
           or (v_chiffres is not null and p.telephone like '%' || v_chiffres || '%'))
  ),
  stats as (
    select c.client_id,
           count(*) filter (where c.statut = 'terminee')::integer as courses_terminees,
           count(*) filter (where c.statut = 'annulee' and c.annulee_par = 'client')::integer as annulations,
           count(*) filter (where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours'))::integer as a_venir,
           coalesce(sum(c.prix_total + c.frais_attente) filter (where c.statut = 'terminee'), 0)
             + coalesce(sum(c.frais_annulation) filter (where c.statut = 'annulee'), 0) as depense,
           max(c.terminee_le) filter (where c.statut = 'terminee') as derniere_course_le
    from public.courses c
    where c.client_id in (select id from clients)
    group by c.client_id
  ),
  notes as (
    select e.cible_id, round(avg(e.note)::numeric, 2) as note_moyenne, count(*)::integer as nb_notes
    from public.evaluations e
    where e.sens = 'chauffeur_vers_client' and e.cible_id in (select id from clients)
    group by e.cible_id
  ),
  lignes as (
    select cl.id, cl.prenom, cl.nom, cl.email, cl.telephone, cl.statut, cl.langue, cl.cree_le,
           coalesce(s.courses_terminees, 0) as courses_terminees, coalesce(s.annulations, 0) as annulations,
           coalesce(s.a_venir, 0) as a_venir, coalesce(s.depense, 0) as depense, s.derniere_course_le,
           n.note_moyenne, coalesce(n.nb_notes, 0) as nb_notes, coalesce(so.montant, 0) as solde,
           (select coalesce(jsonb_agg(cp.raison_sociale order by cp.raison_sociale), '[]'::jsonb)
              from public.comptes_pro_membres m join public.comptes_pro cp on cp.id = m.compte_pro_id
             where m.profil_id = cl.id) as entreprises,
           exists (select 1 from public.chauffeurs ch where ch.id = cl.id and ch.statut = 'candidat') as candidat
    from clients cl
    left join stats s on s.client_id = cl.id
    left join notes n on n.cible_id = cl.id
    left join public.soldes so on so.profil_id = cl.id
  ),
  classees as (
    select l.*, row_number() over (order by
             case when v_tri = 'nom' then lower(nullif(trim(l.prenom || ' ' || l.nom), '')) end asc nulls last,
             case when v_tri = 'depense' then l.depense end desc nulls last,
             case when v_tri = 'courses' then l.courses_terminees end desc nulls last,
             case when v_tri = 'derniere' then l.derniere_course_le end desc nulls last,
             l.cree_le desc, l.id) as rang
    from lignes l
  ),
  page as (
    select * from classees
    order by rang
    limit least(greatest(coalesce(p_limite, 50), 1), 5000) offset greatest(coalesce(p_decalage, 0), 0)
  )
  select (select count(*) from lignes),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'prenom', g.prenom, 'nom', g.nom, 'email', g.email, 'telephone', g.telephone,
           'statut', g.statut, 'langue', g.langue, 'cree_le', g.cree_le,
           'courses_terminees', g.courses_terminees, 'annulations', g.annulations, 'a_venir', g.a_venir,
           'depense', g.depense, 'derniere_course_le', g.derniere_course_le,
           'note_moyenne', g.note_moyenne, 'nb_notes', g.nb_notes, 'solde', g.solde,
           'entreprises', g.entreprises, 'candidat', g.candidat
         ) order by g.rang), '[]'::jsonb)
    into v_total, v_lignes
  from page g;

  return jsonb_build_object(
    'total', v_total,
    'lignes', v_lignes,
    'resume', (select jsonb_build_object(
                 'clients', count(*),
                 'bloques', count(*) filter (where p.statut = 'bloque'),
                 'nouveaux_30_jours', count(*) filter (where p.cree_le > now() - interval '30 days'),
                 'actifs_30_jours', count(*) filter (where exists (
                    select 1 from public.courses c
                    where c.client_id = p.id and c.statut = 'terminee' and c.terminee_le > now() - interval '30 days')),
                 'avec_entreprise', count(*) filter (where exists (
                    select 1 from public.comptes_pro_membres m where m.profil_id = p.id)))
               from public.profils p where p.role = 'client')
  );
end;
$$;

-- 3b. Fiche complète d'un client, en une seule lecture : identité,
--     connexion, chiffres, courses, paiements à encaisser, factures, solde
--     et mouvements, notes des chauffeurs (visibles de l'administration
--     seulement), parrainage, codes promo, lieux, proches, comptes pro,
--     demandes au support, notes internes.
create or replace function public.admin_fiche_client(p_profil uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_profil public.profils;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_profil from public.profils p where p.id = p_profil;
  if v_profil.id is null then
    raise exception 'Compte introuvable.';
  end if;

  return jsonb_build_object(
    'profil', jsonb_build_object(
      'id', v_profil.id, 'role', v_profil.role, 'statut', v_profil.statut, 'prenom', v_profil.prenom, 'nom', v_profil.nom,
      'email', v_profil.email, 'telephone', v_profil.telephone, 'langue', v_profil.langue,
      'code_parrainage', v_profil.code_parrainage, 'notif_email', v_profil.notif_email,
      'notif_whatsapp', v_profil.notif_whatsapp, 'notif_push', v_profil.notif_push,
      'cree_le', v_profil.cree_le, 'maj_le', v_profil.maj_le),
    'connexion', (select jsonb_build_object('derniere_connexion', u.last_sign_in_at, 'email_confirme_le', u.email_confirmed_at,
                                            'telephone_connexion', u.phone)
                  from auth.users u where u.id = v_profil.id),
    'solde', coalesce((select s.montant from public.soldes s where s.profil_id = v_profil.id), 0),
    'chiffres', (select jsonb_build_object(
        'courses_total', count(*),
        'courses_terminees', count(*) filter (where c.statut = 'terminee'),
        'a_venir', count(*) filter (where c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')),
        'annulations_client', count(*) filter (where c.statut = 'annulee' and c.annulee_par = 'client'),
        'annulations_autres', count(*) filter (where c.statut = 'annulee' and c.annulee_par is distinct from 'client'),
        'depense', coalesce(sum(c.prix_total + c.frais_attente) filter (where c.statut = 'terminee'), 0)
                   + coalesce(sum(c.frais_annulation) filter (where c.statut = 'annulee'), 0),
        'panier_moyen', round(avg(c.prix_total + c.frais_attente) filter (where c.statut = 'terminee'), 2),
        'pourboires', coalesce(sum(c.pourboire) filter (where c.statut = 'terminee'), 0),
        'distance_km', coalesce(sum(c.distance_km) filter (where c.statut = 'terminee'), 0),
        'premiere_course_le', min(c.terminee_le) filter (where c.statut = 'terminee'),
        'derniere_course_le', max(c.terminee_le) filter (where c.statut = 'terminee'),
        'a_encaisser', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                         where pa.client_id = v_profil.id and pa.statut = 'a_encaisser'),
        'note_recue', (select round(avg(e.note)::numeric, 2) from public.evaluations e
                        where e.cible_id = v_profil.id and e.sens = 'chauffeur_vers_client'),
        'nb_notes_recues', (select count(*) from public.evaluations e
                             where e.cible_id = v_profil.id and e.sens = 'chauffeur_vers_client'),
        'note_donnee', (select round(avg(e.note)::numeric, 2) from public.evaluations e
                         where e.auteur_id = v_profil.id and e.sens = 'client_vers_chauffeur'))
      from public.courses c where c.client_id = v_profil.id),
    'courses', coalesce((select jsonb_agg(x.ligne order by x.prise_en_charge_le desc, x.numero desc) from (
        select c.prise_en_charge_le, c.numero, jsonb_build_object(
          'id', c.id, 'numero', c.numero, 'statut', c.statut, 'type', c.type, 'prise_en_charge_le', c.prise_en_charge_le,
          'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
          'prix_total', c.prix_total, 'frais_attente', c.frais_attente, 'frais_annulation', c.frais_annulation,
          'pourboire', c.pourboire, 'mode_paiement', c.mode_paiement, 'annulee_par', c.annulee_par,
          'pour_proche', c.pour_proche, 'beneficiaire_nom', c.beneficiaire_nom,
          'chauffeur_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.chauffeur_id),
          'compte_pro', (select cp.raison_sociale from public.comptes_pro cp where cp.id = c.compte_pro_id)) as ligne
        from public.courses c where c.client_id = v_profil.id
        order by c.prise_en_charge_le desc, c.numero desc limit 100) x), '[]'::jsonb),
    'paiements_a_encaisser', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pa.id, 'course_id', pa.course_id, 'course_numero', c.numero, 'nature', pa.nature, 'mode', pa.mode,
        'montant', pa.montant, 'cree_le', pa.cree_le) order by pa.cree_le)
      from public.paiements pa join public.courses c on c.id = pa.course_id
      where pa.client_id = v_profil.id and pa.statut = 'a_encaisser'), '[]'::jsonb),
    'factures', coalesce((select jsonb_agg(x.ligne order by x.numero desc) from (
        select f.numero, jsonb_build_object(
          'id', f.id, 'numero', f.numero, 'nature', f.nature, 'date_emission', f.date_emission,
          'montant_ttc', f.montant_ttc, 'statut', f.statut, 'course_id', f.course_id, 'course_numero', c.numero,
          'destinataire_nom', f.destinataire_nom, 'compte_pro_id', f.compte_pro_id) as ligne
        from public.factures f join public.courses c on c.id = f.course_id
        where f.client_id = v_profil.id
        order by f.numero desc limit 100) x), '[]'::jsonb),
    'ecritures', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select e.cree_le, jsonb_build_object(
          'montant', e.montant, 'motif', e.motif, 'cree_le', e.cree_le, 'course_id', e.course_id,
          'course_numero', (select c.numero from public.courses c where c.id = e.course_id),
          'auteur', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = e.cree_par)) as ligne
        from public.ecritures_solde e where e.profil_id = v_profil.id
        order by e.cree_le desc limit 50) x), '[]'::jsonb),
    'notes_recues', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select e.cree_le, jsonb_build_object(
          'note', e.note, 'commentaire', e.commentaire, 'cree_le', e.cree_le, 'course_id', e.course_id,
          'course_numero', c.numero, 'auteur', nullif(trim(p.prenom || ' ' || p.nom), '')) as ligne
        from public.evaluations e
        join public.courses c on c.id = e.course_id
        left join public.profils p on p.id = e.auteur_id
        where e.cible_id = v_profil.id and e.sens = 'chauffeur_vers_client'
        order by e.cree_le desc limit 50) x), '[]'::jsonb),
    'notes_donnees', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select e.cree_le, jsonb_build_object(
          'note', e.note, 'commentaire', e.commentaire, 'cree_le', e.cree_le, 'course_id', e.course_id,
          'course_numero', c.numero, 'chauffeur', nullif(trim(p.prenom || ' ' || p.nom), '')) as ligne
        from public.evaluations e
        join public.courses c on c.id = e.course_id
        left join public.profils p on p.id = e.cible_id
        where e.auteur_id = v_profil.id and e.sens = 'client_vers_chauffeur'
        order by e.cree_le desc limit 50) x), '[]'::jsonb),
    'parrain', (select jsonb_build_object('id', pp.id, 'nom', coalesce(nullif(trim(pp.prenom || ' ' || pp.nom), ''), pp.email),
                                          'statut', pa.statut, 'valide_le', pa.valide_le, 'recompense', pa.recompense_filleul,
                                          'cree_le', pa.cree_le)
                from public.parrainages pa join public.profils pp on pp.id = pa.parrain_id
                where pa.filleul_id = v_profil.id),
    'filleuls', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pf.id, 'nom', coalesce(nullif(trim(pf.prenom || ' ' || pf.nom), ''), pf.email), 'statut', pa.statut,
        'valide_le', pa.valide_le, 'recompense', pa.recompense_parrain, 'cree_le', pa.cree_le) order by pa.cree_le desc)
      from public.parrainages pa join public.profils pf on pf.id = pa.filleul_id
      where pa.parrain_id = v_profil.id), '[]'::jsonb),
    'promos', coalesce((select jsonb_agg(jsonb_build_object(
        'code', cp.code, 'remise', u.remise, 'cree_le', u.cree_le, 'course_id', u.course_id, 'course_numero', c.numero)
        order by u.cree_le desc)
      from public.utilisations_promo u
      join public.codes_promo cp on cp.id = u.code_promo_id
      join public.courses c on c.id = u.course_id
      where u.client_id = v_profil.id), '[]'::jsonb),
    'lieux', coalesce((select jsonb_agg(jsonb_build_object('type', l.type, 'libelle', l.libelle, 'adresse', l.adresse,
                                                          'precision', l.precision)
                                        order by case l.type when 'domicile' then 0 when 'travail' then 1 else 2 end, l.cree_le)
                       from public.lieux l where l.client_id = v_profil.id), '[]'::jsonb),
    'proches', coalesce((select jsonb_agg(jsonb_build_object('nom', pr.nom, 'telephone', pr.telephone, 'relation', pr.relation)
                                          order by pr.nom)
                         from public.proches pr where pr.client_id = v_profil.id), '[]'::jsonb),
    'entreprises', coalesce((select jsonb_agg(jsonb_build_object('id', cp.id, 'raison_sociale', cp.raison_sociale,
                                                                'role', m.role, 'statut', cp.statut, 'ajoute_le', m.cree_le)
                                              order by cp.raison_sociale)
                             from public.comptes_pro_membres m join public.comptes_pro cp on cp.id = m.compte_pro_id
                             where m.profil_id = v_profil.id), '[]'::jsonb),
    'chauffeur', (select jsonb_build_object('statut', ch.statut) from public.chauffeurs ch where ch.id = v_profil.id),
    'demandes', coalesce((select jsonb_agg(x.ligne order by x.cree_le desc) from (
        select d.cree_le, jsonb_build_object('id', d.id, 'numero', d.numero, 'type', d.type, 'sujet', d.sujet,
                                             'statut', d.statut, 'cree_le', d.cree_le, 'course_id', d.course_id) as ligne
        from public.demandes d where d.auteur_id = v_profil.id
        order by d.cree_le desc limit 20) x), '[]'::jsonb),
    'notes_internes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'texte', n.texte, 'cree_le', n.cree_le, 'auteur_id', n.auteur_id,
        'auteur', nullif(trim(p.prenom || ' ' || p.nom), '')) order by n.cree_le desc)
      from public.notes_internes n left join public.profils p on p.id = n.auteur_id
      where n.profil_id = v_profil.id), '[]'::jsonb)
  );
end;
$$;

-- 3c. Liste des comptes professionnels, avec l'activité du mois, ce qui
--     reste à encaisser et ce qui est en retard (relevé échu).
create or replace function public.admin_lister_comptes_pro(p_texte text default null, p_statut text default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_texte text := nullif(trim(coalesce(p_texte, '')), '');
  v_motif text;
  v_debut timestamptz := prive.debut_mois_paris();
  v_jour  date := prive.heure_paris()::date;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut is not null and p_statut not in ('actif', 'suspendu') then
    raise exception 'Statut inconnu.';
  end if;
  if v_texte is not null then
    v_motif := '%' || replace(replace(replace(v_texte, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return jsonb_build_object(
    'lignes', coalesce((
      select jsonb_agg(to_jsonb(cp) || jsonb_build_object(
               'nb_membres', (select count(*) from public.comptes_pro_membres m where m.compte_pro_id = cp.id),
               'nb_gestionnaires', (select count(*) from public.comptes_pro_membres m
                                     where m.compte_pro_id = cp.id and m.role = 'gestionnaire'),
               'courses_mois', (select count(*) from public.courses c
                                 where c.compte_pro_id = cp.id and c.cree_le >= v_debut and c.statut <> 'annulee'),
               'engage_mois', prive.engage_mois_pro(cp.id),
               'a_encaisser', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                                join public.courses c on c.id = pa.course_id
                                where c.compte_pro_id = cp.id and pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'),
               'en_retard', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                              join public.courses c on c.id = pa.course_id
                              where c.compte_pro_id = cp.id and pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'
                                and prive.echeance_releve(pa.cree_le, cp.delai_paiement_jours) < v_jour),
               'derniere_course_le', (select max(c.terminee_le) from public.courses c
                                       where c.compte_pro_id = cp.id and c.statut = 'terminee'))
             order by cp.statut, lower(cp.raison_sociale))
      from public.comptes_pro cp
      where (p_statut is null or cp.statut = p_statut)
        and (v_motif is null or concat_ws(' ', cp.raison_sociale, cp.siret, cp.tva_intracommunautaire, cp.contact_nom,
                                           cp.email_facturation, cp.telephone, cp.ville) ilike v_motif)), '[]'::jsonb),
    'resume', jsonb_build_object(
      'comptes', (select count(*) from public.comptes_pro),
      'actifs', (select count(*) from public.comptes_pro where statut = 'actif'),
      'courses_mois', (select count(*) from public.courses c
                        where c.compte_pro_id is not null and c.cree_le >= v_debut and c.statut <> 'annulee'),
      'a_encaisser', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                       join public.courses c on c.id = pa.course_id
                       where c.compte_pro_id is not null and pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'),
      'en_retard', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                     join public.courses c on c.id = pa.course_id
                     join public.comptes_pro cp on cp.id = c.compte_pro_id
                     where pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'
                       and prive.echeance_releve(pa.cree_le, cp.delai_paiement_jours) < v_jour))
  );
end;
$$;

-- 3d. Fiche d'un compte professionnel : identité, membres, chiffres,
--     courses, mois disponibles pour le relevé, notes internes.
create or replace function public.admin_fiche_compte_pro(p_compte uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_compte public.comptes_pro;
  v_debut  timestamptz := prive.debut_mois_paris();
  v_jour   date := prive.heure_paris()::date;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_compte from public.comptes_pro cp where cp.id = p_compte;
  if v_compte.id is null then
    raise exception 'Compte professionnel introuvable.';
  end if;

  return jsonb_build_object(
    'compte', to_jsonb(v_compte),
    'membres', coalesce((select jsonb_agg(jsonb_build_object(
        'profil_id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email, 'telephone', p.telephone,
        'statut', p.statut, 'role', m.role, 'ajoute_le', m.cree_le,
        'courses_mois', (select count(*) from public.courses c
                          where c.compte_pro_id = v_compte.id and c.client_id = p.id
                            and c.cree_le >= v_debut and c.statut <> 'annulee'))
        order by case m.role when 'gestionnaire' then 0 else 1 end, lower(p.prenom || ' ' || p.nom))
      from public.comptes_pro_membres m join public.profils p on p.id = m.profil_id
      where m.compte_pro_id = v_compte.id), '[]'::jsonb),
    'chiffres', jsonb_build_object(
      'courses_mois', (select count(*) from public.courses c
                        where c.compte_pro_id = v_compte.id and c.cree_le >= v_debut and c.statut <> 'annulee'),
      'engage_mois', prive.engage_mois_pro(v_compte.id),
      'courses_terminees', (select count(*) from public.courses c where c.compte_pro_id = v_compte.id and c.statut = 'terminee'),
      'total_facture', (select coalesce(sum(f.montant_ttc), 0) from public.factures f
                         where f.compte_pro_id = v_compte.id and f.statut = 'emise'),
      'a_encaisser', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                       join public.courses c on c.id = pa.course_id
                       where c.compte_pro_id = v_compte.id and pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'),
      'en_retard', (select coalesce(sum(pa.montant), 0) from public.paiements pa
                     join public.courses c on c.id = pa.course_id
                     where c.compte_pro_id = v_compte.id and pa.mode = 'facture_mensuelle' and pa.statut = 'a_encaisser'
                       and prive.echeance_releve(pa.cree_le, v_compte.delai_paiement_jours) < v_jour)),
    'courses', coalesce((select jsonb_agg(x.ligne order by x.prise_en_charge_le desc, x.numero desc) from (
        select c.prise_en_charge_le, c.numero, jsonb_build_object(
          'id', c.id, 'numero', c.numero, 'statut', c.statut, 'type', c.type, 'prise_en_charge_le', c.prise_en_charge_le,
          'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
          'prix_total', c.prix_total, 'frais_attente', c.frais_attente, 'frais_annulation', c.frais_annulation,
          'pourboire', c.pourboire, 'mode_paiement', c.mode_paiement,
          'client_id', c.client_id,
          'client_nom', (select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email) from public.profils p where p.id = c.client_id),
          'pour_proche', c.pour_proche, 'beneficiaire_nom', c.beneficiaire_nom) as ligne
        from public.courses c where c.compte_pro_id = v_compte.id
        order by c.prise_en_charge_le desc, c.numero desc limit 100) x), '[]'::jsonb),
    -- Mois qui ont un relevé (factures ou pourboires), plus le mois en cours
    'mois', (select coalesce(jsonb_agg(m.mois order by m.mois desc), '[]'::jsonb) from (
        select to_char(f.date_emission, 'YYYY-MM') as mois from public.factures f where f.compte_pro_id = v_compte.id
        union
        select to_char(prive.heure_paris(pa.cree_le), 'YYYY-MM') from public.paiements pa
          join public.courses c on c.id = pa.course_id
          where c.compte_pro_id = v_compte.id and pa.nature = 'pourboire'
        union
        select to_char(prive.heure_paris(), 'YYYY-MM')) m),
    'notes_internes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'texte', n.texte, 'cree_le', n.cree_le, 'auteur_id', n.auteur_id,
        'auteur', nullif(trim(p.prenom || ' ' || p.nom), '')) order by n.cree_le desc)
      from public.notes_internes n left join public.profils p on p.id = n.auteur_id
      where n.compte_pro_id = v_compte.id), '[]'::jsonb)
  );
end;
$$;

-- 3e. Relevé mensuel d'un compte professionnel : toutes les factures du
--     mois (une par course, plus les frais d'annulation), les pourboires,
--     les totaux HT, TVA (par taux) et TTC, ce qui est déjà réglé et ce qui
--     reste à payer, la date du relevé et l'échéance. Mois en cours : relevé
--     provisoire, daté du jour.
create or replace function public.admin_releve_compte_pro(p_compte uuid, p_mois date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_compte  public.comptes_pro;
  v_jour    date := prive.heure_paris()::date;
  v_debut   date := date_trunc('month', coalesce(p_mois, prive.heure_paris()::date))::date;
  v_fin     date;
  v_date    date;
  v_lignes  jsonb;
  v_ht      numeric;
  v_tva     numeric;
  v_ttc     numeric;
  v_tips    jsonb;
  v_pourb   numeric;
  v_reste   numeric;
  v_nb      integer;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_compte from public.comptes_pro cp where cp.id = p_compte;
  if v_compte.id is null then
    raise exception 'Compte professionnel introuvable.';
  end if;
  if v_debut > v_jour then
    raise exception 'Ce mois n''a pas encore commencé.';
  end if;
  v_fin  := (v_debut + interval '1 month')::date - 1;
  v_date := least(v_fin, v_jour);

  -- Factures du mois, avec le paiement correspondant
  select coalesce(jsonb_agg(jsonb_build_object(
           'facture_id', f.id, 'numero', f.numero, 'nature', f.nature, 'date_emission', f.date_emission,
           'montant_ht', f.montant_ht, 'taux_tva', f.taux_tva, 'montant_tva', f.montant_tva, 'montant_ttc', f.montant_ttc,
           'course_id', c.id, 'course_numero', c.numero, 'prise_en_charge_le', c.prise_en_charge_le,
           'depart_adresse', c.depart_adresse, 'arrivee_adresse', c.arrivee_adresse,
           'passager', coalesce(case when c.pour_proche then c.beneficiaire_nom end,
                                nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email),
           'commande_par', coalesce(nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email),
           'paiement_id', pa.id, 'paiement_mode', pa.mode, 'paiement_statut', pa.statut,
           'encaisse_le', pa.encaisse_le, 'reference', pa.reference_externe)
           order by f.date_emission, f.numero), '[]'::jsonb),
         coalesce(sum(f.montant_ht), 0), coalesce(sum(f.montant_tva), 0), coalesce(sum(f.montant_ttc), 0)
    into v_lignes, v_ht, v_tva, v_ttc
  from public.factures f
  join public.courses c on c.id = f.course_id
  join public.profils cl on cl.id = c.client_id
  left join public.paiements pa on pa.course_id = f.course_id and pa.nature = f.nature
  where f.compte_pro_id = v_compte.id and f.statut = 'emise' and f.date_emission between v_debut and v_fin;

  -- Pourboires du mois (hors TVA, reversés aux chauffeurs)
  select coalesce(jsonb_agg(jsonb_build_object(
           'paiement_id', pa.id, 'montant', pa.montant, 'mode', pa.mode, 'statut', pa.statut, 'cree_le', pa.cree_le,
           'course_id', c.id, 'course_numero', c.numero) order by pa.cree_le), '[]'::jsonb),
         coalesce(sum(pa.montant), 0)
    into v_tips, v_pourb
  from public.paiements pa
  join public.courses c on c.id = pa.course_id
  where pa.nature = 'pourboire' and c.compte_pro_id = v_compte.id
    and pa.cree_le >= prive.debut_jour_paris(v_debut) and pa.cree_le < prive.debut_jour_paris(v_fin + 1);

  -- Reste à payer : paiements sur facture mensuelle pas encore encaissés
  select coalesce(sum(x.montant), 0), count(*) into v_reste, v_nb
  from prive.paiements_releve(v_compte.id, v_debut, v_fin) x
  where x.mode = 'facture_mensuelle' and x.statut = 'a_encaisser';

  return jsonb_build_object(
    'compte', to_jsonb(v_compte),
    'societe', (select to_jsonb(s) from public.societe s where s.id = 1),
    'mois', to_char(v_debut, 'YYYY-MM'),
    'mois_lisible', prive.mois_lisible(v_debut),
    'debut', v_debut,
    'fin', v_fin,
    'date_releve', v_date,
    'provisoire', v_fin >= v_jour,
    'echeance', v_date + v_compte.delai_paiement_jours,
    'lignes', v_lignes,
    'pourboires', v_tips,
    'tva_par_taux', coalesce((select jsonb_agg(jsonb_build_object('taux', t.taux_tva, 'montant_ht', t.ht, 'montant_tva', t.tva)
                                               order by t.taux_tva)
                              from (select f.taux_tva, sum(f.montant_ht) as ht, sum(f.montant_tva) as tva
                                    from public.factures f
                                    where f.compte_pro_id = v_compte.id and f.statut = 'emise'
                                      and f.date_emission between v_debut and v_fin
                                    group by f.taux_tva) t), '[]'::jsonb),
    'totaux', jsonb_build_object(
      'montant_ht', v_ht, 'montant_tva', v_tva, 'montant_ttc', v_ttc, 'pourboires', v_pourb,
      'total', v_ttc + v_pourb, 'reste_a_payer', v_reste, 'deja_regle', v_ttc + v_pourb - v_reste,
      'paiements_a_encaisser', v_nb)
  );
end;
$$;


-- #############################################################################
-- 4. ACTIONS DE L'ADMINISTRATION
-- #############################################################################

-- 4a. Bloquer ou débloquer un client. Blocage : motif obligatoire (journal),
--     réservations pas encore prises en charge annulées si demandé (client
--     et chauffeur prévenus) ; le client est prévenu dans l'application.
--     Les chauffeurs se suspendent dans le module Chauffeurs, et un
--     administrateur perd d'abord son rôle.
create or replace function public.admin_statut_client(
  p_profil uuid, p_statut text, p_motif text default null, p_annuler_reservations boolean default false
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil   public.profils;
  v_motif    text := nullif(left(trim(coalesce(p_motif, '')), 500), '');
  v_course   record;
  v_annulees integer := 0;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_statut is null or p_statut not in ('actif', 'bloque') then
    raise exception 'Statut inconnu.';
  end if;
  select * into v_profil from public.profils p where p.id = p_profil for update;
  if v_profil.id is null then
    raise exception 'Compte introuvable.';
  end if;
  if v_profil.id = auth.uid() then
    raise exception 'Vous ne pouvez pas bloquer votre propre compte.';
  end if;
  if v_profil.role = 'admin' then
    raise exception 'Ce compte est administrateur : retirez d''abord son rôle (Paramètres, Administrateurs).';
  end if;
  if v_profil.role = 'chauffeur' then
    raise exception 'Ce compte est celui d''un chauffeur : suspendez-le depuis le module Chauffeurs.';
  end if;
  if v_profil.statut = p_statut then
    raise exception '%', case when p_statut = 'bloque' then 'Ce compte est déjà bloqué.' else 'Ce compte est déjà actif.' end;
  end if;
  if p_statut = 'bloque' and v_motif is null then
    raise exception 'Indiquez le motif du blocage : il est conservé dans le journal.';
  end if;

  update public.profils set statut = p_statut where id = v_profil.id;

  -- Réservations pas encore prises en charge : annulées sans frais
  if p_statut = 'bloque' and coalesce(p_annuler_reservations, false) then
    for v_course in
      select c.id from public.courses c
      where c.client_id = v_profil.id and c.statut in ('planifiee', 'recherche', 'a_attribuer')
      order by c.prise_en_charge_le
    loop
      perform public.annuler_course(v_course.id, 'Compte suspendu');
      v_annulees := v_annulees + 1;
    end loop;
  end if;

  perform prive.journaliser_action(case when p_statut = 'bloque' then 'blocage_compte' else 'deblocage_compte' end,
    'profils', v_profil.id::text, jsonb_build_object('motif', v_motif, 'reservations_annulees', v_annulees));
  perform prive.notifier(v_profil.id, 'alerte',
    case when p_statut = 'bloque' then 'Compte suspendu' else 'Compte réactivé' end,
    case when p_statut = 'bloque'
         then 'Votre compte LOC RÉACTION est suspendu : vous ne pouvez plus commander de course. Contactez-nous pour en savoir plus.'
         else 'Votre compte LOC RÉACTION est de nouveau actif : vous pouvez commander vos courses.' end);
  return jsonb_build_object('statut', p_statut, 'reservations_annulees', v_annulees);
end;
$$;

-- 4b. Encaisser le relevé mensuel d'un compte pro en une fois (virement
--     reçu) : tous ses paiements sur facture mensuelle encore à encaisser.
--     Le montant affiché à l'écran est redonné : si le relevé a changé
--     entre-temps (pourboire, course terminée), rien n'est encaissé.
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
  v_ids       uuid[] := '{}';
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
    raise exception 'Rien à encaisser sur le relevé de %.', prive.mois_lisible(v_debut);
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
    'Le relevé de ' || prive.mois_lisible(v_debut) || ' du compte « ' || v_compte.raison_sociale || ' » est réglé : '
    || prive.euros(v_total) || '. Merci.')
  from public.comptes_pro_membres m
  where m.compte_pro_id = v_compte.id and m.role = 'gestionnaire';

  return jsonb_build_object('paiements', v_nb, 'montant', v_total);
end;
$$;


-- #############################################################################
-- 5. DROITS D'EXÉCUTION
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout, puis on n'accorde que l'utile.
revoke all on function
  prive.mois_lisible(date),
  prive.echeance_releve(timestamptz, integer),
  prive.debut_mois_paris(),
  prive.engage_mois_pro(uuid),
  prive.controler_plafond_pro(),
  prive.notifier_membre_pro(),
  prive.paiements_releve(uuid, date, date)
  from public, anon, authenticated;

revoke all on function
  public.admin_lister_clients(text, text, text, integer, integer),
  public.admin_fiche_client(uuid),
  public.admin_lister_comptes_pro(text, text),
  public.admin_fiche_compte_pro(uuid),
  public.admin_releve_compte_pro(uuid, date),
  public.admin_statut_client(uuid, text, text, boolean),
  public.admin_encaisser_releve(uuid, date, numeric, text)
  from public, anon;

grant execute on function
  public.admin_lister_clients(text, text, text, integer, integer),
  public.admin_fiche_client(uuid),
  public.admin_lister_comptes_pro(text, text),
  public.admin_fiche_compte_pro(uuid),
  public.admin_releve_compte_pro(uuid, date),
  public.admin_statut_client(uuid, text, text, boolean),
  public.admin_encaisser_releve(uuid, date, numeric, text)
  to authenticated;
