-- =============================================================================
-- LOC RÉACTION S.A.S — Version 2 — migration 30 (portefeuille, partie 1 sur 3)
-- Portefeuille du client : recharges par Mollie, portefeuille, administration
-- -----------------------------------------------------------------------------
-- Demande de l'administrateur (9 novembre 2026) :
--   - le client recharge son portefeuille sur la page de paiement sécurisée
--     de Mollie ; le portefeuille est crédité dès que Mollie confirme ;
--   - une course se paie en espèces, par carte dans le véhicule, par le
--     portefeuille (prélevé à la fin de la course) ou par virement bancaire ;
--   - le client voit son solde, le chauffeur ses gains, l'administration les
--     portefeuilles et les recharges.
--
-- Trois migrations, appliquées dans l'ordre :
--   30. (ce fichier) modes de paiement, table des recharges, portefeuille,
--       fonctions du client, de Mollie et de l'administration, et leurs droits ;
--   31. commande, fin de course, annulation, pourboire, encaissement,
--       remboursement, finances (20261030093000_portefeuille_courses.sql) ;
--   32. compte supprimé et export des données personnelles
--       (20261030093100_portefeuille_comptes.sql).
--
-- RECHARGE. La base ne parle jamais à Mollie : la fonction du serveur
-- « mollie » (Edge Function, dossier supabase/functions/mollie) garde la clé
-- Mollie (secret Supabase MOLLIE_API_KEY, jamais dans le site) :
--   1. recharge_demander, appelée AVEC LES DROITS DU CLIENT : la recharge
--      R-AAAA-000001 est enregistrée à son nom, de 5 € à 500 € ;
--   2. recharge_mollie_ouverte (clé de service seulement) : le paiement
--      Mollie (tr_…) créé pour elle lui est rattaché ;
--   3. recharge_mollie_etat (clé de service seulement) : l'état LU CHEZ
--      MOLLIE avec la clé (jamais ce qu'annonce un appel extérieur) ; « paid »
--      crédite le portefeuille une seule fois, au montant exact de la
--      recharge, puis prélève ce qui restait dû.
--
-- PORTEFEUILLE ET COURSES.
--   - À la commande : le disponible (solde − courses à venir payées par le
--     portefeuille − reste dû) doit couvrir le prix ; le solde est verrouillé
--     le temps du contrôle (deux commandes simultanées ne comptent pas deux
--     fois le même argent).
--   - À la fin de la course : le total est prélevé. Si le solde ne suffit
--     plus (frais d'attente), ce qu'il couvre est prélevé et le reste est dû :
--     il part à la recharge suivante (le client est prévenu).
--   - Pourboire et frais d'annulation : prélevés de même ; remboursement d'un
--     paiement fait par le portefeuille : recrédité au portefeuille.
--
-- VIREMENT. Proposé dès que l'IBAN et le BIC de l'entreprise sont saisis
-- (Paramètres) : la somme reste « à encaisser » jusqu'à ce que
-- l'administration enregistre le virement reçu (Finances). Le chauffeur n'a
-- rien à encaisser, ni pour le portefeuille ni pour le virement.
-- =============================================================================


-- #############################################################################
-- 1. MODES DE PAIEMENT : « virement » pour les courses et les paiements,
--    « solde » (portefeuille) pour les remboursements
-- #############################################################################

alter table public.courses drop constraint courses_mode_paiement_check,
  add constraint courses_mode_paiement_check
  check (mode_paiement in ('especes', 'carte', 'solde', 'virement', 'facture_mensuelle'));

alter table public.paiements drop constraint paiements_mode_check,
  add constraint paiements_mode_check
  check (mode in ('especes', 'carte', 'solde', 'virement', 'facture_mensuelle'));

alter table public.remboursements drop constraint remboursements_mode_check,
  add constraint remboursements_mode_check
  check (mode in ('virement', 'carte', 'especes', 'solde'));


-- #############################################################################
-- 2. RECHARGES DU PORTEFEUILLE
-- #############################################################################

create table public.recharges (
  id           uuid primary key default gen_random_uuid(),
  numero       text not null unique,                       -- R-2026-000001
  client_id    uuid not null references public.profils (id),
  montant      numeric(10,2) not null check (montant >= 5 and montant <= 500),
  statut       text not null default 'creee'
               check (statut in ('creee', 'ouverte', 'payee', 'echouee', 'annulee', 'expiree')),
  mollie_id    text unique check (mollie_id ~ '^tr_[A-Za-z0-9]{4,40}$'),
  mollie_mode  text check (mollie_mode in ('test', 'live')),
  methode      text check (char_length(methode) <= 40),     -- creditcard, applepay, bancontact…
  cree_le      timestamptz not null default now(),
  maj_le       timestamptz not null default now(),
  payee_le     timestamptz,
  constraint recharges_payee_datee check ((statut = 'payee') = (payee_le is not null))
);
comment on table public.recharges is
  'Recharges du portefeuille par Mollie : créée (client), ouverte (paiement Mollie rattaché), puis payée, échouée, '
  'annulée ou expirée selon l''état lu chez Mollie. Une recharge payée est une pièce comptable : gardée 10 ans.';
create index recharges_client_idx on public.recharges (client_id, cree_le desc);
create index recharges_statut_idx on public.recharges (statut, cree_le desc);

-- Lecture : le client les siennes, l'administration toutes. Aucune écriture
-- directe : tout passe par les fonctions ci-dessous.
alter table public.recharges enable row level security;
revoke all on public.recharges from anon, authenticated;
grant select on public.recharges to authenticated;
create policy recharges_lecture on public.recharges for select to authenticated
  using (client_id = (select auth.uid()) or (select public.est_admin()));

create trigger journal after insert or update or delete on public.recharges
  for each row execute function prive.journaliser();


-- #############################################################################
-- 3. PORTEFEUILLE : réservé, dû, disponible ; paiement et reste dû
-- #############################################################################

-- Réservé : prix des courses à venir ou en cours payées par le portefeuille
create or replace function prive.portefeuille_engage(p_client uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(c.prix_total), 0)
    from public.courses c
   where c.client_id = p_client and c.mode_paiement = 'solde'
     and c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')
$$;

-- Reste dû : ce que le solde ne couvrait plus à la fin d'une course
create or replace function prive.portefeuille_du(p_client uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(pa.montant), 0)
    from public.paiements pa
   where pa.client_id = p_client and pa.mode = 'solde' and pa.statut = 'a_encaisser'
$$;

-- Disponible pour une nouvelle course ou un pourboire (jamais négatif)
create or replace function prive.portefeuille_disponible(p_client uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select greatest(coalesce((select s.montant from public.soldes s where s.profil_id = p_client), 0)
                  - prive.portefeuille_engage(p_client) - prive.portefeuille_du(p_client), 0)
$$;

-- Libellé d'un mouvement du portefeuille pour une somme liée à une course
create or replace function prive.motif_portefeuille(p_nature text, p_numero text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_nature when 'pourboire' then 'Pourboire ' when 'frais_annulation' then 'Frais d''annulation '
                       else 'Course ' end || coalesce(p_numero, '')
$$;

-- Paiement par le portefeuille (fin de course, pourboire, frais
-- d'annulation) : prélevé tout de suite, paiement « encaissé ». Si le solde
-- ne suffit pas, ce qu'il couvre est prélevé et le reste devient un paiement
-- « à encaisser » (reste dû), prélevé à la recharge suivante. Renvoie le
-- reste dû (0 si tout est payé).
create or replace function prive.payer_par_portefeuille(p_course public.courses, p_nature text, p_montant numeric)
returns numeric
language plpgsql security definer set search_path = ''
as $$
declare
  v_solde   numeric;
  v_preleve numeric;
  v_reste   numeric;
begin
  insert into public.soldes (profil_id) values (p_course.client_id) on conflict (profil_id) do nothing;
  select s.montant into v_solde from public.soldes s where s.profil_id = p_course.client_id for update;
  v_preleve := least(greatest(v_solde, 0), p_montant);
  v_reste := p_montant - v_preleve;
  if v_preleve > 0 then
    perform prive.ecrire_solde(p_course.client_id, -v_preleve, prive.motif_portefeuille(p_nature, p_course.numero), p_course.id);
    insert into public.paiements (course_id, client_id, nature, mode, montant, statut, encaisse_le)
    values (p_course.id, p_course.client_id, p_nature, 'solde', v_preleve, 'encaisse', now());
  end if;
  if v_reste > 0 then
    insert into public.paiements (course_id, client_id, nature, mode, montant)
    values (p_course.id, p_course.client_id, p_nature, 'solde', v_reste);
    perform prive.notifier(p_course.client_id, 'paiement', 'Portefeuille insuffisant',
      'Il manque ' || prive.euros(v_reste) || ' sur votre portefeuille pour la course ' || p_course.numero
      || ' : rechargez-le, la somme sera prélevée aussitôt.', '/client/compte/#compte-solde');
  end if;
  return v_reste;
end;
$$;

-- Reste dû : prélevé, du plus ancien au plus récent, tant que le solde le
-- permet (après une recharge). Renvoie le nombre de sommes réglées.
create or replace function prive.regler_dettes_portefeuille(p_client uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_dette   record;
  v_solde   numeric;
  v_reglees integer := 0;
begin
  for v_dette in
    select pa.id, pa.montant, pa.nature, c.id as course_id, c.numero
      from public.paiements pa
      join public.courses c on c.id = pa.course_id
     where pa.client_id = p_client and pa.mode = 'solde' and pa.statut = 'a_encaisser'
     order by pa.cree_le, pa.id
     for update of pa
  loop
    select s.montant into v_solde from public.soldes s where s.profil_id = p_client for update;
    exit when coalesce(v_solde, 0) < v_dette.montant;
    perform prive.ecrire_solde(p_client, -v_dette.montant,
      prive.motif_portefeuille(v_dette.nature, v_dette.numero) || ' (reste dû)', v_dette.course_id);
    update public.paiements set statut = 'encaisse', encaisse_le = now() where id = v_dette.id;
    perform prive.evenement(v_dette.course_id, 'paiement_encaisse',
      jsonb_build_object('paiement_id', v_dette.id, 'montant', v_dette.montant, 'mode', 'solde'));
    v_reglees := v_reglees + 1;
  end loop;
  return v_reglees;
end;
$$;


-- #############################################################################
-- 4. CÔTÉ CLIENT : portefeuille, demande de recharge, résultat
-- #############################################################################

-- Mon portefeuille : solde, réservé, dû, disponible, 10 dernières recharges
-- (sauf celles restées sans paiement Mollie), virement proposé ou non.
create or replace function public.mon_portefeuille()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_moi uuid := auth.uid();
begin
  if v_moi is null then
    raise exception 'Connectez-vous pour voir votre portefeuille.';
  end if;
  return jsonb_build_object(
    'solde', coalesce((select s.montant from public.soldes s where s.profil_id = v_moi), 0),
    'engage', prive.portefeuille_engage(v_moi),
    'du', prive.portefeuille_du(v_moi),
    'disponible', prive.portefeuille_disponible(v_moi),
    'recharge_min', 5,
    'recharge_max', 500,
    'virement_possible', coalesce((select s.iban is not null and s.bic is not null from public.societe s where s.id = 1), false),
    'recharges', coalesce((select jsonb_agg(jsonb_build_object(
                   'id', r.id, 'numero', r.numero, 'montant', r.montant, 'statut', r.statut, 'methode', r.methode,
                   'cree_le', r.cree_le, 'payee_le', r.payee_le) order by r.cree_le desc)
                 from (select x.* from public.recharges x
                        where x.client_id = v_moi and x.statut <> 'creee'
                        order by x.cree_le desc limit 10) r), '[]'::jsonb));
end;
$$;

-- Demande de recharge, avec les droits du client (appelée par la fonction du
-- serveur « mollie », qui crée ensuite le paiement chez Mollie).
create or replace function public.recharge_demander(p_montant numeric)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_moi      uuid := auth.uid();
  v_profil   public.profils;
  v_montant  numeric := round(p_montant, 2);
  v_recharge public.recharges;
begin
  select * into v_profil from public.profils p where p.id = v_moi;
  if v_profil.id is null then
    raise exception 'Connectez-vous pour recharger votre portefeuille.';
  end if;
  if v_profil.statut <> 'actif' then
    raise exception 'Votre compte est suspendu : contactez LOC RÉACTION.';
  end if;
  if v_montant is null or v_montant < 5 or v_montant > 500 then
    raise exception 'Une recharge va de 5 € à 500 €.';
  end if;
  -- Garde-fou : pas plus de 5 paiements Mollie en attente par heure
  if (select count(*) from public.recharges r
       where r.client_id = v_moi and r.statut in ('creee', 'ouverte') and r.cree_le > now() - interval '1 hour') >= 5 then
    raise exception 'Vous avez déjà 5 recharges en attente de paiement : terminez-en une, ou réessayez dans une heure.';
  end if;
  insert into public.recharges (numero, client_id, montant)
  values (prive.prochain_numero('recharge', 'R'), v_moi, v_montant)
  returning * into v_recharge;
  return jsonb_build_object('id', v_recharge.id, 'numero', v_recharge.numero, 'montant', v_recharge.montant);
end;
$$;

-- Une recharge du client (page de retour après Mollie) : état et solde
create or replace function public.ma_recharge(p_recharge uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_recharge public.recharges;
begin
  select * into v_recharge from public.recharges r where r.id = p_recharge;
  if v_recharge.id is null or v_recharge.client_id is distinct from auth.uid() then
    raise exception 'Recharge introuvable.';
  end if;
  return jsonb_build_object(
    'id', v_recharge.id, 'numero', v_recharge.numero, 'montant', v_recharge.montant, 'statut', v_recharge.statut,
    'methode', v_recharge.methode, 'mollie_id', v_recharge.mollie_id, 'payee_le', v_recharge.payee_le,
    'solde', coalesce((select s.montant from public.soldes s where s.profil_id = v_recharge.client_id), 0));
end;
$$;


-- #############################################################################
-- 5. CÔTÉ SERVEUR (clé de service seulement) : paiement Mollie rattaché,
--    état rapporté
-- #############################################################################

create or replace function public.recharge_mollie_ouverte(p_recharge uuid, p_mollie_id text, p_mode text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_mollie_id is null or p_mollie_id !~ '^tr_[A-Za-z0-9]{4,40}$' or p_mode is null or p_mode not in ('test', 'live') then
    raise exception 'Paiement Mollie invalide.';
  end if;
  update public.recharges
     set mollie_id = p_mollie_id, mollie_mode = p_mode, statut = 'ouverte', maj_le = now()
   where id = p_recharge and statut = 'creee' and mollie_id is null;
  if not found then
    raise exception 'Recharge introuvable ou déjà rattachée à un paiement.';
  end if;
end;
$$;

-- État d'un paiement Mollie, LU CHEZ MOLLIE par la fonction du serveur.
-- Plusieurs avis pour le même paiement : sans effet après le premier
-- « paid ». Un montant ou une devise qui ne correspondent pas : refusé, rien
-- n'est crédité.
create or replace function public.recharge_mollie_etat(
  p_recharge  uuid,
  p_mollie_id text,
  p_statut    text,
  p_mode      text,
  p_montant   numeric,
  p_devise    text,
  p_methode   text default null
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_recharge public.recharges;
  v_statut   text;
  v_solde    numeric;
begin
  select * into v_recharge from public.recharges r where r.id = p_recharge for update;
  if v_recharge.id is null then
    raise exception 'Recharge introuvable.';
  end if;
  -- Paiement créé chez Mollie mais lien pas encore enregistré (coupure juste
  -- après la création) : le premier avis le rattache
  if v_recharge.mollie_id is null and v_recharge.statut = 'creee'
     and p_mollie_id ~ '^tr_[A-Za-z0-9]{4,40}$' and p_mode in ('test', 'live') then
    update public.recharges set mollie_id = p_mollie_id, mollie_mode = p_mode, statut = 'ouverte', maj_le = now()
     where id = p_recharge
    returning * into v_recharge;
  end if;
  if v_recharge.mollie_id is distinct from p_mollie_id or v_recharge.mollie_mode is distinct from p_mode then
    raise exception 'Ce paiement Mollie n''est pas celui de la recharge %.', v_recharge.numero;
  end if;

  v_statut := case p_statut
                when 'paid' then 'payee'
                when 'failed' then 'echouee'
                when 'canceled' then 'annulee'
                when 'expired' then 'expiree'
                when 'open' then 'ouverte'
                when 'pending' then 'ouverte'
                when 'authorized' then 'ouverte'
              end;
  if v_statut is null then
    raise exception 'État Mollie inconnu : %.', p_statut;
  end if;

  if v_recharge.statut = 'payee' then
    null;                                   -- déjà créditée : rien ne change
  elsif v_statut = 'payee' then
    if p_devise is distinct from 'EUR' or p_montant is distinct from v_recharge.montant then
      raise exception 'Montant payé (% %) différent de la recharge % (%) : rien n''est crédité.',
        p_montant, p_devise, v_recharge.numero, prive.euros(v_recharge.montant);
    end if;
    perform prive.ecrire_solde(v_recharge.client_id, v_recharge.montant, 'Recharge ' || v_recharge.numero, null);
    update public.recharges
       set statut = 'payee', payee_le = now(), maj_le = now(), methode = coalesce(left(p_methode, 40), methode)
     where id = p_recharge
    returning * into v_recharge;
    perform prive.regler_dettes_portefeuille(v_recharge.client_id);
    v_solde := coalesce((select s.montant from public.soldes s where s.profil_id = v_recharge.client_id), 0);
    perform prive.notifier(v_recharge.client_id, 'paiement', 'Portefeuille rechargé',
      prive.euros(v_recharge.montant) || ' ajoutés à votre portefeuille (recharge ' || v_recharge.numero
      || '). Solde : ' || prive.euros(v_solde) || '.', '/client/compte/#compte-solde');
  elsif v_statut <> v_recharge.statut then
    update public.recharges
       set statut = v_statut, maj_le = now(), methode = coalesce(left(p_methode, 40), methode)
     where id = p_recharge
    returning * into v_recharge;
  end if;

  return jsonb_build_object(
    'id', v_recharge.id, 'numero', v_recharge.numero, 'montant', v_recharge.montant, 'statut', v_recharge.statut,
    'methode', v_recharge.methode, 'payee_le', v_recharge.payee_le,
    'solde', coalesce((select s.montant from public.soldes s where s.profil_id = v_recharge.client_id), 0));
end;
$$;


-- #############################################################################
-- 6. ADMINISTRATION : tableau de bord, Finances > Portefeuilles, suppression
-- #############################################################################

-- Tableau de bord : portefeuilles, recharges, payé ce mois-ci par mode, à
-- recevoir (virements, reste dû au portefeuille, sur place)
create or replace function public.admin_paiements_resume()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_jour        date := prive.heure_paris(now())::date;
  v_debut_jour  timestamptz;
  v_debut_mois  timestamptz;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  v_debut_jour := prive.debut_jour_paris(v_jour);
  v_debut_mois := prive.debut_jour_paris(date_trunc('month', v_jour)::date);
  return jsonb_build_object(
    'portefeuilles', (select jsonb_build_object('total', coalesce(sum(s.montant), 0),
                                                'comptes', count(*) filter (where s.montant > 0))
                      from public.soldes s),
    'recharges', (select jsonb_build_object(
        'jour', coalesce(sum(r.montant) filter (where r.payee_le >= v_debut_jour), 0),
        'nb_jour', count(*) filter (where r.payee_le >= v_debut_jour),
        'mois', coalesce(sum(r.montant), 0),
        'nb_mois', count(*))
      from public.recharges r where r.statut = 'payee' and r.payee_le >= v_debut_mois),
    'mode_test', coalesce((select r.mollie_mode = 'test' from public.recharges r
                            where r.mollie_mode is not null order by r.cree_le desc limit 1), false),
    'paye_mois', (select jsonb_build_object(
        'total', coalesce(sum(pa.montant), 0),
        'especes', coalesce(sum(pa.montant) filter (where pa.mode = 'especes'), 0),
        'carte', coalesce(sum(pa.montant) filter (where pa.mode = 'carte'), 0),
        'solde', coalesce(sum(pa.montant) filter (where pa.mode = 'solde'), 0),
        'virement', coalesce(sum(pa.montant) filter (where pa.mode = 'virement'), 0),
        'facture_mensuelle', coalesce(sum(pa.montant) filter (where pa.mode = 'facture_mensuelle'), 0))
      from public.paiements pa
      where pa.statut in ('encaisse', 'rembourse') and pa.encaisse_le >= v_debut_mois),
    'a_recevoir', (select jsonb_build_object(
        'virements', coalesce(sum(pa.montant) filter (where pa.mode = 'virement'), 0),
        'nb_virements', count(*) filter (where pa.mode = 'virement'),
        'virements_7_jours', count(*) filter (where pa.mode = 'virement' and pa.cree_le < now() - interval '7 days'),
        'portefeuille', coalesce(sum(pa.montant) filter (where pa.mode = 'solde'), 0),
        'nb_portefeuille', count(*) filter (where pa.mode = 'solde'),
        'sur_place', coalesce(sum(pa.montant) filter (where pa.mode in ('especes', 'carte')), 0),
        'nb_sur_place', count(*) filter (where pa.mode in ('especes', 'carte')))
      from public.paiements pa where pa.statut = 'a_encaisser'));
end;
$$;

-- Finances > Portefeuilles : soldes des clients (les 100 plus élevés), reste
-- dû, recharges d'une période (jours de Paris, bornes comprises)
create or replace function public.admin_portefeuilles(p_debut date, p_fin date)
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
    'soldes', (select jsonb_build_object('total', coalesce(sum(s.montant), 0), 'comptes', count(*))
               from public.soldes s where s.montant > 0),
    'clients', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', p.id, 'nom', nullif(concat_ws(' ', p.prenom, p.nom), ''), 'email', p.email, 'statut', p.statut,
                 'solde', s.montant, 'maj_le', s.maj_le) order by s.montant desc, p.id)
               from (select x.* from public.soldes x where x.montant > 0 order by x.montant desc limit 100) s
               join public.profils p on p.id = s.profil_id), '[]'::jsonb),
    'dettes', coalesce((select jsonb_agg(jsonb_build_object(
                 'paiement_id', pa.id, 'montant', pa.montant, 'nature', pa.nature, 'cree_le', pa.cree_le,
                 'course_id', c.id, 'course_numero', c.numero,
                 'client_id', p.id, 'client_nom', nullif(concat_ws(' ', p.prenom, p.nom), ''), 'client_email', p.email)
                 order by pa.cree_le)
               from public.paiements pa
               join public.courses c on c.id = pa.course_id
               join public.profils p on p.id = pa.client_id
               where pa.mode = 'solde' and pa.statut = 'a_encaisser'), '[]'::jsonb),
    'recharges', (select jsonb_build_object(
        'payees', coalesce(sum(r.montant) filter (where r.statut = 'payee'), 0),
        'nb_payees', count(*) filter (where r.statut = 'payee'),
        'nb_ouvertes', count(*) filter (where r.statut = 'ouverte'),
        'nb_sans_suite', count(*) filter (where r.statut in ('creee', 'echouee', 'annulee', 'expiree')))
      from public.recharges r where r.cree_le >= v_debut and r.cree_le < v_fin),
    'lignes', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', r.id, 'numero', r.numero, 'montant', r.montant, 'statut', r.statut, 'methode', r.methode,
                 'mollie_id', r.mollie_id, 'mollie_mode', r.mollie_mode, 'cree_le', r.cree_le, 'payee_le', r.payee_le,
                 'client_id', p.id, 'client_nom', nullif(concat_ws(' ', p.prenom, p.nom), ''), 'client_email', p.email)
                 order by r.cree_le desc, r.id)
               from (select x.* from public.recharges x
                      where x.cree_le >= v_debut and x.cree_le < v_fin
                      order by x.cree_le desc limit 200) r
               join public.profils p on p.id = r.client_id), '[]'::jsonb));
end;
$$;

-- Supprimer une recharge sans suite. Payée : pièce comptable, gardée 10 ans.
-- En attente chez Mollie : son résultat peut encore arriver.
create or replace function public.admin_supprimer_recharge(p_recharge uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_recharge public.recharges;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v_recharge from public.recharges r where r.id = p_recharge for update;
  if v_recharge.id is null then
    raise exception 'Recharge introuvable.';
  end if;
  if v_recharge.statut = 'payee' then
    raise exception 'La recharge % a été payée : c''est une pièce comptable, la loi impose de la garder 10 ans (Code de commerce, article L123-22).',
      v_recharge.numero;
  end if;
  if v_recharge.statut = 'ouverte' then
    raise exception 'La recharge % attend la réponse de Mollie : son paiement peut encore aboutir. Attendez qu''elle soit payée, échouée, annulée ou expirée.',
      v_recharge.numero;
  end if;
  delete from public.recharges where id = p_recharge;
  perform prive.journaliser_action('suppression_recharge', 'recharges', p_recharge::text,
    jsonb_build_object('numero', v_recharge.numero, 'statut', v_recharge.statut, 'montant', v_recharge.montant));
  return jsonb_build_object('numero', v_recharge.numero);
end;
$$;


-- #############################################################################
-- 7. DROITS
-- #############################################################################

-- Fonctions internes : jamais appelées directement
revoke all on function prive.portefeuille_engage(uuid) from public, anon, authenticated;
revoke all on function prive.portefeuille_du(uuid) from public, anon, authenticated;
revoke all on function prive.portefeuille_disponible(uuid) from public, anon, authenticated;
revoke all on function prive.motif_portefeuille(text, text) from public, anon, authenticated;
revoke all on function prive.payer_par_portefeuille(public.courses, text, numeric) from public, anon, authenticated;
revoke all on function prive.regler_dettes_portefeuille(uuid) from public, anon, authenticated;

-- Client et administration (chaque fonction vérifie qui appelle)
revoke all on function public.mon_portefeuille() from public, anon;
revoke all on function public.recharge_demander(numeric) from public, anon;
revoke all on function public.ma_recharge(uuid) from public, anon;
revoke all on function public.admin_paiements_resume() from public, anon;
revoke all on function public.admin_portefeuilles(date, date) from public, anon;
revoke all on function public.admin_supprimer_recharge(uuid) from public, anon;
grant execute on function public.mon_portefeuille() to authenticated;
grant execute on function public.recharge_demander(numeric) to authenticated;
grant execute on function public.ma_recharge(uuid) to authenticated;
grant execute on function public.admin_paiements_resume() to authenticated;
grant execute on function public.admin_portefeuilles(date, date) to authenticated;
grant execute on function public.admin_supprimer_recharge(uuid) to authenticated;

-- Fonctions du serveur (Mollie) : clé de service seulement, jamais un client
revoke all on function public.recharge_mollie_ouverte(uuid, text, text) from public, anon, authenticated;
revoke all on function public.recharge_mollie_etat(uuid, text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.recharge_mollie_ouverte(uuid, text, text) to service_role;
grant execute on function public.recharge_mollie_etat(uuid, text, text, text, numeric, text, text) to service_role;
