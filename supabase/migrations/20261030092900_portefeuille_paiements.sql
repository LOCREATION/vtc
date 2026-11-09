-- =============================================================================
-- LOC RÉACTION S.A.S — Version 2 — migration 30
-- Portefeuille du client : recharge par Mollie, courses payées par le
-- portefeuille, et virement bancaire
-- -----------------------------------------------------------------------------
-- Demande de l'administrateur (9 novembre 2026) :
--   - le client recharge son portefeuille sur la page de paiement sécurisée
--     de Mollie ; le portefeuille est crédité dès que Mollie confirme ;
--   - une course se paie en espèces, par carte dans le véhicule, par le
--     portefeuille (prélevé à la fin de la course) ou par virement bancaire ;
--   - le client voit son solde, le chauffeur ses gains, l'administration les
--     portefeuilles et les recharges.
--
-- RECHARGE. La base ne parle jamais à Mollie : deux fonctions du serveur
-- (Edge Functions « mollie-recharge » et « mollie-webhook ») gardent la clé
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
-- serveur « mollie-recharge », qui crée ensuite le paiement chez Mollie).
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
-- 7. COMMANDE, FIN DE COURSE, ANNULATION, POURBOIRE : portefeuille et virement
-- #############################################################################

-- 7a. Commande : portefeuille (le disponible couvre le prix) et virement
--     (coordonnées bancaires de l'entreprise saisies)
-- (reprise de 20261030090200_fonctions.sql, modifiée)
create or replace function public.commander_course(
  p_categorie                text,
  p_depart_adresse           text,
  p_depart_lat               numeric,
  p_depart_lng               numeric,
  p_arrivee_adresse          text,
  p_arrivee_lat              numeric,
  p_arrivee_lng              numeric,
  p_arrets                   jsonb       default '[]'::jsonb,   -- [{ "adresse", "lat", "lng" }]
  p_type                     text        default 'immediate',
  p_quand                    timestamptz default null,          -- date et heure de prise en charge (planifiée)
  p_duree_mad                numeric     default null,
  p_depart_precision         text        default null,          -- terminal, porte, sortie
  p_numero_vol               text        default null,
  p_terminal                 text        default null,
  p_pour_proche              boolean     default false,
  p_beneficiaire_nom         text        default null,
  p_beneficiaire_telephone   text        default null,
  p_option_chauffeuse        boolean     default false,
  p_mode_paiement            text        default 'especes',
  p_code_promo               text        default null,
  p_compte_pro               uuid        default null,
  p_prix_annonce             numeric     default null           -- prix affiché : doit correspondre au recalcul
)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_client     public.profils;
  v_param      public.parametres;
  v_categorie  uuid;
  v_quand      timestamptz;
  v_prix       jsonb;
  v_course     public.courses;
  v_arret      jsonb;
  v_ordre      integer := 0;
  v_vol        text := nullif(upper(regexp_replace(coalesce(p_numero_vol, ''), '\s', '', 'g')), '');
begin
  -- Qui commande ?
  select * into v_client from public.profils p where p.id = auth.uid();
  if v_client.id is null then
    raise exception 'Connectez-vous pour commander une course.';
  end if;
  if v_client.statut <> 'actif' then
    raise exception 'Votre compte est suspendu : contactez LOC RÉACTION.';
  end if;
  if v_client.telephone is null then
    raise exception 'Ajoutez votre numéro de téléphone dans votre compte avant de commander : le chauffeur doit pouvoir vous joindre.';
  end if;

  -- Une seule course immédiate à la fois
  if p_type in ('immediate', 'mise_a_disposition') and exists (
       select 1 from public.courses c
       where c.client_id = v_client.id and c.type <> 'planifiee'
         and c.statut in ('recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')) then
    raise exception 'Vous avez déjà une course en cours.';
  end if;

  select * into v_param from public.parametres where id = 1;
  select c.id into v_categorie from public.categories c where c.code = p_categorie and c.active;
  if v_categorie is null then
    raise exception 'Catégorie de véhicule inconnue ou indisponible.';
  end if;

  -- Quand ?
  if p_type = 'planifiee' then
    if p_quand is null then
      raise exception 'Indiquez la date et l''heure de prise en charge.';
    end if;
    if p_quand < now() + make_interval(mins => v_param.delai_min_planification_min) then
      raise exception 'Une réservation doit être faite au moins % minutes à l''avance.', v_param.delai_min_planification_min;
    end if;
    if p_quand > now() + interval '90 days' then
      raise exception 'Les réservations sont ouvertes jusqu''à 90 jours à l''avance.';
    end if;
    v_quand := p_quand;
  elsif p_type = 'mise_a_disposition' then
    v_quand := greatest(coalesce(p_quand, now()), now());
    if v_quand > now() + interval '90 days' then
      raise exception 'Les réservations sont ouvertes jusqu''à 90 jours à l''avance.';
    end if;
  elsif p_type = 'immediate' then
    v_quand := now();
  else
    raise exception 'Type de course inconnu.';
  end if;

  -- Paiement : espèces, carte dans le véhicule, portefeuille, virement, ou
  -- facture mensuelle (comptes professionnels)
  if p_mode_paiement is null or p_mode_paiement not in ('especes', 'carte', 'solde', 'virement', 'facture_mensuelle') then
    raise exception 'Mode de paiement inconnu.';
  end if;
  if p_mode_paiement = 'virement' and not exists (
       select 1 from public.societe s where s.id = 1 and s.iban is not null and s.bic is not null) then
    raise exception 'Le paiement par virement n''est pas encore proposé : choisissez un autre moyen de paiement.';
  end if;
  if p_mode_paiement = 'facture_mensuelle' or p_compte_pro is not null then
    if p_compte_pro is null or not exists (
         select 1 from public.comptes_pro_membres m
         join public.comptes_pro cp on cp.id = m.compte_pro_id and cp.statut = 'actif'
         where m.compte_pro_id = p_compte_pro and m.profil_id = v_client.id) then
      raise exception 'La facturation mensuelle est réservée aux membres d''un compte professionnel actif.';
    end if;
  end if;

  -- Pour un proche
  if coalesce(p_pour_proche, false) and (nullif(trim(coalesce(p_beneficiaire_nom, '')), '') is null
                                         or coalesce(p_beneficiaire_telephone, '') !~ '^\+[1-9][0-9]{6,14}$') then
    raise exception 'Indiquez le nom et le numéro (format international, ex. +33…) de la personne transportée.';
  end if;

  -- Prix (recalculé ici : le navigateur ne fixe jamais le prix)
  v_prix := prive.calculer_prix(v_categorie, p_depart_lat, p_depart_lng, p_arrivee_lat, p_arrivee_lng,
                                coalesce(p_arrets, '[]'::jsonb), v_quand, p_type, p_duree_mad,
                                p_option_chauffeuse, p_code_promo, v_client.id);
  if (v_prix ->> 'hors_zone')::boolean then
    raise exception 'Ce trajet sort de notre zone ou dépasse la distance maximale : demandez un devis.';
  end if;
  if nullif(trim(coalesce(p_code_promo, '')), '') is not null and (v_prix ->> 'code_promo_id') is null then
    raise exception '%', coalesce(v_prix ->> 'message_promo', 'Ce code promo n''est pas valable.');
  end if;
  if p_prix_annonce is not null and abs(p_prix_annonce - (v_prix ->> 'prix_total')::numeric) > 0.009 then
    raise exception 'Le prix a changé depuis l''affichage (nouveau prix : %). Vérifiez avant de commander.',
      prive.euros((v_prix ->> 'prix_total')::numeric);
  end if;

  -- Portefeuille : le prix doit tenir dans le disponible (solde, moins les
  -- courses à venir déjà payées avec lui et le reste dû). Le solde est
  -- verrouillé le temps du contrôle : deux commandes simultanées ne peuvent
  -- pas compter deux fois le même argent.
  if p_mode_paiement = 'solde' then
    insert into public.soldes (profil_id) values (v_client.id) on conflict (profil_id) do nothing;
    perform 1 from public.soldes s where s.profil_id = v_client.id for update;
    if prive.portefeuille_disponible(v_client.id) < (v_prix ->> 'prix_total')::numeric then
      raise exception 'Solde insuffisant : la course coûte %, votre portefeuille en a % de disponibles. Rechargez-le ou choisissez un autre moyen de paiement.',
        prive.euros((v_prix ->> 'prix_total')::numeric), prive.euros(prive.portefeuille_disponible(v_client.id));
    end if;
  end if;

  insert into public.courses (
    numero, client_id, compte_pro_id, pour_proche, beneficiaire_nom, beneficiaire_telephone,
    categorie_id, option_chauffeuse, type, statut,
    depart_adresse, depart_lat, depart_lng, depart_precision,
    arrivee_adresse, arrivee_lat, arrivee_lng,
    prise_en_charge_le, numero_vol, terminal, duree_mad_heures,
    distance_km, duree_min, tarif_id, forfait_id, prix_base, majoration_type, majoration_pourcentage,
    supplement, code_promo_id, remise, prix_total, mode_paiement
  ) values (
    prive.prochain_numero('course', 'C'), v_client.id, p_compte_pro, coalesce(p_pour_proche, false),
    case when p_pour_proche then trim(p_beneficiaire_nom) end,
    case when p_pour_proche then p_beneficiaire_telephone end,
    v_categorie, coalesce(p_option_chauffeuse, false), p_type,
    case when v_quand > now() + interval '15 minutes' then 'planifiee' else 'recherche' end,
    left(trim(p_depart_adresse), 300), p_depart_lat, p_depart_lng, nullif(left(trim(coalesce(p_depart_precision, '')), 200), ''),
    left(trim(p_arrivee_adresse), 300), p_arrivee_lat, p_arrivee_lng,
    v_quand, v_vol, nullif(left(trim(coalesce(p_terminal, '')), 40), ''),
    case when p_type = 'mise_a_disposition' then p_duree_mad end,
    (v_prix ->> 'distance_km')::numeric, (v_prix ->> 'duree_min')::integer,
    (v_prix ->> 'tarif_id')::uuid, (v_prix ->> 'forfait_id')::uuid,
    (v_prix ->> 'prix_base')::numeric, v_prix ->> 'majoration_type', (v_prix ->> 'majoration_pourcentage')::numeric,
    (v_prix ->> 'supplement')::numeric, (v_prix ->> 'code_promo_id')::uuid, (v_prix ->> 'remise')::numeric,
    (v_prix ->> 'prix_total')::numeric, p_mode_paiement
  )
  returning * into v_course;

  -- Arrêts
  if p_arrets is not null and jsonb_typeof(p_arrets) = 'array' then
    for v_arret in select value from jsonb_array_elements(p_arrets) loop
      v_ordre := v_ordre + 1;
      insert into public.course_arrets (course_id, ordre, adresse, latitude, longitude)
      values (v_course.id, v_ordre, left(coalesce(v_arret ->> 'adresse', 'Arrêt ' || v_ordre), 300),
              (v_arret ->> 'lat')::numeric, (v_arret ->> 'lng')::numeric);
    end loop;
  end if;

  -- Code promo consommé
  if v_course.code_promo_id is not null then
    insert into public.utilisations_promo (code_promo_id, client_id, course_id, remise)
    values (v_course.code_promo_id, v_client.id, v_course.id, v_course.remise);
  end if;

  perform prive.evenement(v_course.id, 'commande',
    jsonb_build_object('prix_total', v_course.prix_total, 'type', v_course.type));

  -- Recherche d'un chauffeur tout de suite (sinon : réservation à venir)
  if v_course.statut = 'recherche' then
    perform prive.proposer_course(v_course.id);
  else
    perform prive.notifier_admins('course', 'Nouvelle réservation',
      'Réservation ' || v_course.numero || ' le ' || to_char(prive.heure_paris(v_course.prise_en_charge_le), 'DD/MM/YYYY à HH24:MI') || '.',
      '/admin/dispatch/');
  end if;

  select * into v_course from public.courses c where c.id = v_course.id;
  return v_course;
end;
$$;
-- 7b. Fin de course : portefeuille prélevé (reste dû si le solde ne suffit
--     plus), message de fin selon le paiement
-- (reprise de 20261030090200_fonctions.sql, modifiée)
create or replace function prive.cloturer_course(p_course uuid)
returns public.courses
language plpgsql security definer set search_path = ''
as $$
declare
  v_course     public.courses;
  v_parrainage public.parrainages;
begin
  update public.courses set statut = 'terminee', terminee_le = now()
   where id = p_course
  returning * into v_course;

  -- Paiement de la course : à encaisser (espèces, carte dans le véhicule,
  -- virement, facture mensuelle) ou prélevé tout de suite sur le portefeuille
  if v_course.prix_total + v_course.frais_attente > 0 then
    if v_course.mode_paiement = 'solde' then
      perform prive.payer_par_portefeuille(v_course, 'course', v_course.prix_total + v_course.frais_attente);
    else
      insert into public.paiements (course_id, client_id, nature, mode, montant)
      values (v_course.id, v_course.client_id, 'course', v_course.mode_paiement,
              v_course.prix_total + v_course.frais_attente);
    end if;
  end if;

  perform prive.emettre_facture(v_course.id, 'course');

  -- Parrainage : récompenses à la première course terminée du filleul
  select * into v_parrainage from public.parrainages p
   where p.filleul_id = v_course.client_id and p.statut = 'en_attente' for update;
  if v_parrainage.id is not null
     and not exists (select 1 from public.courses c
                     where c.client_id = v_course.client_id and c.statut = 'terminee' and c.id <> v_course.id) then
    update public.parrainages p
       set statut = 'valide', valide_le = now(),
           recompense_parrain = (select recompense_parrain from public.parametres where id = 1),
           recompense_filleul = (select recompense_filleul from public.parametres where id = 1)
     where p.id = v_parrainage.id
    returning * into v_parrainage;
    if v_parrainage.recompense_parrain > 0 then
      perform prive.ecrire_solde(v_parrainage.parrain_id, v_parrainage.recompense_parrain, 'Parrainage validé', v_course.id);
    end if;
    if v_parrainage.recompense_filleul > 0 then
      perform prive.ecrire_solde(v_parrainage.filleul_id, v_parrainage.recompense_filleul, 'Bienvenue : parrainage', v_course.id);
    end if;
  end if;

  perform prive.notifier(v_course.client_id, 'course', 'Course terminée',
    'Merci d''avoir voyagé avec LOC RÉACTION. Total : ' || prive.euros(v_course.prix_total + v_course.frais_attente)
    || case v_course.mode_paiement
         when 'solde' then ', payé avec votre portefeuille (solde : '
           || prive.euros(coalesce((select s.montant from public.soldes s where s.profil_id = v_course.client_id), 0)) || ')'
         when 'virement' then ', à régler par virement : coordonnées bancaires sur la page de la course'
         else '' end
    || '. Notez votre chauffeur et retrouvez votre facture.', '/client/course/?id=' || v_course.id);
  return v_course;
end;
$$;
-- 7c. Annulation par le client avec frais : prélevés sur le portefeuille
--     quand la course devait être payée avec lui
-- (reprise de 20261030090200_fonctions.sql, modifiée)
create or replace function public.annuler_course(p_course uuid, p_motif text default null)
returns public.courses
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_course  public.courses;
  v_param   public.parametres;
  v_tarif   public.tarifs;
  v_frais   numeric := 0;
  v_motif   text := nullif(left(trim(coalesce(p_motif, '')), 500), '');
begin
  select * into v_course from public.courses c where c.id = p_course for update;
  if v_course.id is null then
    raise exception 'Course introuvable.';
  end if;
  if v_course.statut in ('en_cours', 'terminee', 'annulee') then
    raise exception 'Cette course ne peut plus être annulée.';
  end if;
  select * into v_param from public.parametres where id = 1;

  -- 1. Le client annule
  if v_course.client_id = auth.uid() then
    select * into v_tarif from public.tarifs t where t.id = v_course.tarif_id;
    -- Gratuit tant qu'aucun chauffeur n'a accepté ; réservation gratuite
    -- jusqu'au délai prévu avant l'heure de prise en charge.
    if v_course.statut in ('acceptee', 'arrivee') then
      v_frais := coalesce(v_tarif.frais_annulation, 0);
    elsif v_course.statut = 'planifiee' and v_course.chauffeur_id is not null
          and v_course.prise_en_charge_le < now() + make_interval(mins => v_param.annulation_gratuite_planifiee_min) then
      v_frais := coalesce(v_tarif.frais_annulation, 0);
    end if;

    update public.courses
       set statut = 'annulee', annulee_par = 'client', annulee_le = now(),
           motif_annulation = v_motif, frais_annulation = v_frais
     where id = p_course
    returning * into v_course;

    if v_frais > 0 then
      if v_course.mode_paiement = 'solde' then
        perform prive.payer_par_portefeuille(v_course, 'frais_annulation', v_frais);
      else
        insert into public.paiements (course_id, client_id, nature, mode, montant)
        values (v_course.id, v_course.client_id, 'frais_annulation', v_course.mode_paiement, v_frais);
      end if;
      perform prive.emettre_facture(v_course.id, 'frais_annulation');
    else
      delete from public.utilisations_promo where course_id = v_course.id;   -- le code promo est rendu
    end if;
    perform prive.notifier(v_course.chauffeur_id, 'course', 'Course annulée par le client',
      v_course.numero || coalesce(' · ' || v_motif, ''), '/chauffeur/');

  -- 2. Le chauffeur se désiste : la course repart en recherche
  elsif v_course.chauffeur_id = auth.uid() then
    if v_course.statut not in ('planifiee', 'acceptee', 'arrivee') then
      raise exception 'Cette course ne peut plus être rendue.';
    end if;
    update public.courses
       set chauffeur_id = null, vehicule_id = null, chauffeur_prenom = null, chauffeur_telephone = null,
           chauffeur_photo = null, vehicule_libelle = null, vehicule_couleur = null, vehicule_immatriculation = null,
           client_prenom = null, client_telephone = null, attribution = null, attribuee_par = null,
           acceptee_le = null, arrivee_le = null,
           statut = case when prise_en_charge_le > now() + make_interval(mins => v_param.recherche_planifiee_avant_min)
                         then 'planifiee' else 'recherche' end
     where id = p_course
    returning * into v_course;
    perform prive.evenement(p_course, 'desistement_chauffeur', jsonb_build_object('chauffeur_id', auth.uid(), 'motif', v_motif));
    perform prive.notifier(v_course.client_id, 'course', 'Changement de chauffeur',
      'Votre chauffeur a dû se désister : nous vous en attribuons un autre.', '/client/course/?id=' || p_course);
    perform prive.notifier_admins('alerte', 'Désistement d''un chauffeur', v_course.numero || coalesce(' · ' || v_motif, ''), '/admin/dispatch/');
    if v_course.statut = 'recherche' then
      perform prive.proposer_course(p_course);
    end if;
    select * into v_course from public.courses c where c.id = p_course;
    return v_course;

  -- 3. L'administration annule (sans frais ; frais éventuels ajoutés à part)
  elsif public.est_admin() then
    update public.courses
       set statut = 'annulee', annulee_par = 'admin', annulee_le = now(), motif_annulation = v_motif
     where id = p_course
    returning * into v_course;
    delete from public.utilisations_promo where course_id = v_course.id;
    perform prive.journaliser_action('annulation_admin', 'courses', p_course::text, jsonb_build_object('motif', v_motif));
    perform prive.notifier(v_course.client_id, 'course', 'Course annulée',
      'LOC RÉACTION a annulé la course ' || v_course.numero || coalesce(' : ' || v_motif, '.'), '/client/activite/');
    perform prive.notifier(v_course.chauffeur_id, 'course', 'Course annulée', v_course.numero, '/chauffeur/');

  else
    raise exception 'Vous ne pouvez pas annuler cette course.';
  end if;

  -- Demandes encore en attente : closes
  update public.propositions set statut = 'annulee', repondue_le = now()
   where course_id = p_course and statut = 'envoyee';
  perform prive.evenement(p_course, 'annulee', jsonb_build_object('par', v_course.annulee_par, 'frais', v_frais));
  return v_course;
end;
$$;
-- 7d. Pourboire : par le portefeuille (dans le disponible) ou par virement,
--     dans les 24 heures
-- (reprise de 20261030092500_pourboire_client.sql, modifiée)
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

  -- Portefeuille : le pourboire doit tenir dans le disponible
  if v_course.mode_paiement = 'solde' then
    insert into public.soldes (profil_id) values (v_course.client_id) on conflict (profil_id) do nothing;
    perform 1 from public.soldes s where s.profil_id = v_course.client_id for update;
    if prive.portefeuille_disponible(v_course.client_id) < v_montant then
      raise exception 'Solde insuffisant pour ce pourboire : votre portefeuille a % de disponibles. Rechargez-le d''abord.',
        prive.euros(prive.portefeuille_disponible(v_course.client_id));
    end if;
  end if;

  update public.courses set pourboire = v_montant where id = p_course returning * into v_course;
  if v_course.mode_paiement = 'solde' then
    perform prive.payer_par_portefeuille(v_course, 'pourboire', v_montant);
  else
    insert into public.paiements (course_id, client_id, nature, mode, montant)
    values (p_course, v_course.client_id, 'pourboire', v_course.mode_paiement, v_montant);
  end if;
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
  elsif v_course.mode_paiement = 'solde' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire reçu',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ', payé avec le portefeuille du client. Merci !', '/chauffeur/revenus/');
  elsif v_course.mode_paiement = 'virement' then
    perform prive.notifier(v_course.chauffeur_id, 'paiement', 'Pourboire reçu',
      prive.euros(v_montant) || ' pour la course ' || v_course.numero
      || ', réglé par virement avec la course. Merci !', '/chauffeur/revenus/');
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
  '(espèces ou carte dans le véhicule dans les 30 minutes ; portefeuille, virement ou facture mensuelle dans les 24 heures).';


-- #############################################################################
-- 8. ENCAISSEMENT ET REMBOURSEMENT
-- #############################################################################

-- 8a. Encaissement : portefeuille et virement ne passent jamais par le
--     chauffeur ; l'administration enregistre le virement reçu, ou prélève
--     sur le portefeuille un reste dû (solde suffisant)
-- (reprise de 20261030091310_finances_fonctions_completees.sql, modifiée)
create or replace function public.confirmer_encaissement(p_paiement uuid, p_especes_au_bureau boolean default false)
returns public.paiements
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement public.paiements;
  v_course   public.courses;
  v_admin    boolean := public.est_admin();
  v_bureau   boolean := coalesce(p_especes_au_bureau, false);
begin
  select * into v_paiement from public.paiements p where p.id = p_paiement for update;
  if v_paiement.id is null then
    raise exception 'Paiement introuvable.';
  end if;
  select * into v_course from public.courses c where c.id = v_paiement.course_id;
  if v_course.chauffeur_id is distinct from auth.uid() and not v_admin then
    raise exception 'Paiement introuvable.';
  end if;
  if v_bureau and not v_admin then
    raise exception 'Seule l''administration enregistre des espèces reçues au bureau.';
  end if;
  if not (v_paiement.statut = 'a_encaisser' or (v_paiement.statut = 'echoue' and v_admin)) then
    raise exception 'Ce paiement a déjà été traité.';
  end if;
  if v_paiement.mode = 'facture_mensuelle' and not v_admin then
    raise exception 'Les paiements sur facture mensuelle sont encaissés par l''administration.';
  end if;
  if v_paiement.mode = 'solde' and not v_admin then
    raise exception 'Ce paiement passe par le portefeuille du client : rien à encaisser.';
  end if;
  if v_paiement.mode = 'virement' and not v_admin then
    raise exception 'Le client règle par virement : l''administration l''enregistre à réception.';
  end if;
  -- Reste dû au portefeuille : prélevé maintenant (refusé si le solde ne
  -- suffit pas)
  if v_paiement.mode = 'solde' then
    perform prive.ecrire_solde(v_paiement.client_id, -v_paiement.montant,
      prive.motif_portefeuille(v_paiement.nature, v_course.numero) || ' (reste dû)', v_course.id);
  end if;
  if v_bureau and v_paiement.mode <> 'especes' then
    raise exception 'Ce paiement n''est pas en espèces.';
  end if;

  update public.paiements
     set statut = 'encaisse', encaisse_par = auth.uid(), encaisse_le = now(),
         especes_chauffeur_id = case when v_paiement.mode = 'especes' and not v_bureau then v_course.chauffeur_id end,
         motif = case when v_paiement.statut = 'echoue' then null else motif end
   where id = p_paiement
  returning * into v_paiement;
  perform prive.evenement(v_course.id, 'paiement_encaisse',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_paiement.montant, 'mode', v_paiement.mode)
    || case when v_paiement.mode = 'especes' then jsonb_build_object('au_bureau', v_bureau) else '{}'::jsonb end);
  return v_paiement;
end;
$$;
-- 8b. Remboursement : un paiement fait par le portefeuille est recrédité au
--     portefeuille
-- (reprise de 20261030091310_finances_fonctions_completees.sql, modifiée)
create or replace function public.rembourser(p_paiement uuid, p_montant numeric, p_motif text, p_mode text default null)
returns public.remboursements
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_paiement      public.paiements;
  v_deja          numeric;
  v_montant       numeric := round(p_montant, 2);
  v_mode          text;
  v_remboursement public.remboursements;
  v_facture       public.factures;
  v_avoir         public.avoirs;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if nullif(trim(coalesce(p_motif, '')), '') is null then
    raise exception 'Indiquez le motif du remboursement.';
  end if;
  select * into v_paiement from public.paiements p where p.id = p_paiement for update;
  if v_paiement.id is null or v_paiement.statut not in ('encaisse', 'rembourse') then
    raise exception 'Seul un paiement encaissé peut être remboursé.';
  end if;
  -- Par défaut : le moyen du paiement (carte → carte, espèces → espèces,
  -- facture mensuelle → virement)
  v_mode := coalesce(nullif(p_mode, ''), case v_paiement.mode when 'carte' then 'carte' when 'especes' then 'especes'
                                                              when 'solde' then 'solde' else 'virement' end);
  if v_mode not in ('virement', 'carte', 'especes', 'solde') then
    raise exception 'Mode de remboursement inconnu : virement, carte, espèces ou portefeuille.';
  end if;
  if v_mode = 'solde' and v_paiement.mode <> 'solde' then
    raise exception 'Le remboursement sur le portefeuille n''est possible que pour un paiement fait avec lui : choisissez le virement, la carte ou les espèces.';
  end if;
  if v_mode = 'carte' and v_paiement.mode <> 'carte' then
    raise exception 'Le remboursement sur la carte n''est possible que pour un paiement par carte : choisissez le virement ou les espèces.';
  end if;
  select coalesce(sum(r.montant), 0) into v_deja from public.remboursements r where r.paiement_id = p_paiement;
  if v_montant is null or v_montant <= 0 or v_deja + v_montant > v_paiement.montant then
    raise exception 'Montant invalide : il reste % à rembourser au maximum.', prive.euros(v_paiement.montant - v_deja);
  end if;

  insert into public.remboursements (paiement_id, montant, motif, mode, cree_par)
  values (p_paiement, v_montant, left(trim(p_motif), 500), v_mode, auth.uid())
  returning * into v_remboursement;
  if v_deja + v_montant = v_paiement.montant then
    update public.paiements set statut = 'rembourse' where id = p_paiement;
  end if;
  if v_mode = 'solde' then
    perform prive.ecrire_solde(v_paiement.client_id, v_montant,
      'Remboursement ' || (select c.numero from public.courses c where c.id = v_paiement.course_id), v_paiement.course_id);
  end if;

  select * into v_facture from public.factures f where f.course_id = v_paiement.course_id and f.nature = v_paiement.nature;
  if v_facture.id is not null then
    v_avoir := prive.emettre_avoir(v_facture.id, v_montant, 'remboursement', p_motif, p_paiement, v_remboursement.id);
  end if;

  perform prive.evenement(v_paiement.course_id, 'remboursement',
    jsonb_build_object('paiement_id', p_paiement, 'montant', v_montant, 'mode', v_mode, 'avoir', v_avoir.numero));
  perform prive.notifier(v_paiement.client_id, 'paiement', 'Remboursement',
    prive.euros(v_montant) || ' vous sont remboursés'
    || case v_mode when 'carte' then ' sur votre carte' when 'virement' then ' par virement'
                   when 'solde' then ' sur votre portefeuille' else ' en espèces' end
    || ' : ' || rtrim(left(trim(p_motif), 200), '.')
    || case when v_avoir.id is not null then ' (avoir ' || v_avoir.numero || ').' else '.' end,
    '/client/activite/');
  return v_remboursement;
end;
$$;

-- #############################################################################
-- 9. FINANCES : virement et portefeuille dans les synthèses et les listes
-- #############################################################################
-- (reprise de 20261030091320_finances_lectures_actions.sql, modifiée)
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
        'virement', coalesce(sum(pa.montant) filter (where pa.mode = 'virement'), 0),
        'pourboires', coalesce(sum(pa.montant) filter (where pa.nature = 'pourboire'), 0))
      from public.paiements pa
      where pa.statut in ('encaisse', 'rembourse') and pa.encaisse_le >= v_debut and pa.encaisse_le < v_fin),
    'rembourse', (select jsonb_build_object(
        'total', coalesce(sum(r.montant), 0), 'nb', count(*),
        'virement', coalesce(sum(r.montant) filter (where r.mode = 'virement'), 0),
        'carte', coalesce(sum(r.montant) filter (where r.mode = 'carte'), 0),
        'especes', coalesce(sum(r.montant) filter (where r.mode = 'especes'), 0),
        'solde', coalesce(sum(r.montant) filter (where r.mode = 'solde'), 0))
      from public.remboursements r
      where r.cree_le >= v_debut and r.cree_le < v_fin),
    'a_encaisser', (select jsonb_build_object(
        'total', coalesce(sum(pa.montant), 0), 'nb', count(*),
        'sur_place', coalesce(sum(pa.montant) filter (where pa.mode in ('especes', 'carte')), 0),
        'nb_sur_place', count(*) filter (where pa.mode in ('especes', 'carte')),
        'plus_24h', count(*) filter (where pa.mode in ('especes', 'carte') and pa.cree_le < now() - interval '24 hours'),
        'releves', coalesce(sum(pa.montant) filter (where pa.mode = 'facture_mensuelle'), 0),
        'nb_releves', count(*) filter (where pa.mode = 'facture_mensuelle'),
        'virements', coalesce(sum(pa.montant) filter (where pa.mode = 'virement'), 0),
        'nb_virements', count(*) filter (where pa.mode = 'virement'),
        'portefeuille', coalesce(sum(pa.montant) filter (where pa.mode = 'solde'), 0),
        'nb_portefeuille', count(*) filter (where pa.mode = 'solde'))
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
-- (reprise de 20261030091320_finances_lectures_actions.sql, modifiée)
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
  if p_mode is not null and p_mode not in ('especes', 'carte', 'solde', 'virement', 'facture_mensuelle') then
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
-- (reprise de 20261030091320_finances_lectures_actions.sql, modifiée)
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
                                           'especes', coalesce(sum(x.montant) filter (where x.mode = 'especes'), 0),
                                           'solde', coalesce(sum(x.montant) filter (where x.mode = 'solde'), 0))
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

-- #############################################################################
-- 10. COMPTE SUPPRIMÉ ET DONNÉES PERSONNELLES : recharges gardées et exportées
-- #############################################################################

-- 10a. Suppression par l'administration : une recharge est une pièce
--      comptable (le compte est archivé, sans ses coordonnées)
-- (reprise de 20261030092700_suppressions_admin.sql, modifiée)
create or replace function prive.supprimer_compte(p_profil uuid, p_par text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_profil    public.profils;
  v_numero    text;
  v_garder    boolean;
  v_mode      text := 'efface';
  v_courses   integer := 0;
  v_solde     numeric := 0;
  v_salarie   boolean;
  v_dossier   boolean;
  v_ids       text[];
  v_candidatures text[];
  v_cles_profil      constant text[] := array['prenom', 'nom', 'email', 'telephone', 'photo_chemin'];
  v_cles_client      constant text[] := array['client_prenom', 'client_telephone', 'depart_precision',
                                              'beneficiaire_nom', 'beneficiaire_telephone'];
  v_cles_chauffeur   constant text[] := array['chauffeur_prenom', 'chauffeur_telephone', 'chauffeur_photo'];
  v_cles_fiche       constant text[] := array['carte_vtc_numero', 'permis_numero', 'filtre_destination_lat', 'filtre_destination_lng'];
  v_cles_document    constant text[] := array['numero', 'commentaire', 'fichier_chemin'];
  v_cles_candidature constant text[] := array['ville', 'experience', 'message', 'motif_refus'];
begin
  select * into v_profil from public.profils p where p.id = p_profil for update;
  if v_profil.id is null or v_profil.statut = 'supprime' then
    raise exception 'Compte introuvable.';
  end if;

  -- 1. Course en cours ou à venir : à annuler ou à retirer d'abord
  select c.numero into v_numero from public.courses c
   where c.client_id = p_profil and c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')
   order by c.cree_le limit 1;
  if v_numero is not null then
    raise exception 'La course % de ce compte est en cours ou à venir : annulez-la d''abord (module Courses).', v_numero;
  end if;
  select c.numero into v_numero from public.courses c
   where c.chauffeur_id = p_profil and c.statut in ('planifiee', 'acceptee', 'arrivee', 'en_cours')
   order by c.cree_le limit 1;
  if v_numero is not null then
    raise exception 'La course % est confiée à ce chauffeur : retirez-la-lui d''abord (module Courses).', v_numero;
  end if;

  -- 2. Pièces que la loi impose de garder
  v_salarie := exists (select 1 from public.salaries s where s.profil_id = p_profil);
  v_garder := exists (select 1 from public.courses c where c.client_id = p_profil or c.chauffeur_id = p_profil)
           or exists (select 1 from public.paiements pa
                       where pa.client_id = p_profil or pa.especes_chauffeur_id = p_profil or pa.encaisse_par = p_profil)
           or exists (select 1 from public.factures f where f.client_id = p_profil)
           or exists (select 1 from public.avoirs a where a.client_id = p_profil)
           or exists (select 1 from public.demandes d where d.auteur_id = p_profil)
           or exists (select 1 from public.remises_especes r where r.chauffeur_id = p_profil)
           or exists (select 1 from public.releves_plateformes r where r.chauffeur_id = p_profil)
           or exists (select 1 from public.recharges rc where rc.client_id = p_profil)
           or v_salarie;
  select count(*) into v_courses from public.courses c where c.client_id = p_profil or c.chauffeur_id = p_profil;
  v_solde := coalesce((select s.montant from public.soldes s where s.profil_id = p_profil), 0);

  -- Lignes dont le journal perd les coordonnées et numéros (avant effacement)
  v_ids := array(select d.id::text from public.documents d where d.chauffeur_id = p_profil);
  v_candidatures := array(select ca.id::text from public.candidatures ca where ca.profil_id = p_profil);

  -- 3. Effacé dans tous les cas. L'adhésion aux comptes pro part en premier :
  --    son retrait écrit une notification, effacée juste après.
  delete from public.comptes_pro_membres where profil_id = p_profil;
  delete from public.lieux where client_id = p_profil;
  delete from public.proches where client_id = p_profil;
  delete from public.appareils where profil_id = p_profil;
  delete from public.notes_internes where profil_id = p_profil;
  delete from public.evaluations e where e.cible_id = p_profil;
  delete from public.messages m using public.courses c
   where m.course_id = c.id and (c.client_id = p_profil or c.chauffeur_id = p_profil);
  delete from public.notifications where destinataire_id = p_profil;
  delete from public.propositions where chauffeur_id = p_profil;
  delete from public.positions where chauffeur_id = p_profil;
  delete from public.documents where chauffeur_id = p_profil;          -- fichiers mis en file
  delete from public.candidatures where profil_id = p_profil;
  delete from public.parrainages where parrain_id = p_profil or filleul_id = p_profil;
  update public.objets_trouves set declare_par = null where declare_par = p_profil;
  perform prive.journal_sans('documents', v_ids, v_cles_document);
  perform prive.journal_sans('candidatures', v_candidatures, v_cles_candidature);

  -- 4. Rien à garder : le compte entier part (profil, dossier chauffeur,
  --    solde et écritures en cascade). Encore cité ailleurs (ancien
  --    administrateur, par exemple) : fiche vidée, comme ci-dessous.
  if not v_garder then
    begin
      delete from auth.users where id = p_profil;
    exception when foreign_key_violation then
      v_mode := 'archive';
    end;
  else
    v_mode := 'archive';
  end if;

  if v_mode = 'archive' then
    -- Courses : coordonnées effacées, trajets et montants gardés
    update public.courses c
       set client_prenom = null, client_telephone = null, depart_precision = null,
           beneficiaire_nom = case when c.pour_proche then 'Proche' end, beneficiaire_telephone = null
     where c.client_id = p_profil;
    update public.courses c
       set chauffeur_prenom = null, chauffeur_telephone = null, chauffeur_photo = null
     where c.chauffeur_id = p_profil;

    -- Dossier chauffeur : jamais validé et sans course, il part ; sinon vidé
    -- et « supprimé » (il tient l'historique de ses courses)
    v_dossier := exists (select 1 from public.chauffeurs ch where ch.id = p_profil);
    if v_dossier then
      if exists (select 1 from public.chauffeurs ch where ch.id = p_profil and ch.statut in ('candidat', 'refuse'))
         and not exists (select 1 from public.courses c where c.chauffeur_id = p_profil)
         and not exists (select 1 from public.paiements pa where pa.especes_chauffeur_id = p_profil)
         and not exists (select 1 from public.remises_especes r where r.chauffeur_id = p_profil)
         and not exists (select 1 from public.releves_plateformes r where r.chauffeur_id = p_profil) then
        delete from public.chauffeurs where id = p_profil;
      else
        update public.chauffeurs
           set statut = 'supprime', vehicule_id = null,
               carte_vtc_numero = null, carte_vtc_expiration = null,
               permis_numero = null, permis_expiration = null,
               filtre_destination_actif = false, filtre_destination_lat = null, filtre_destination_lng = null,
               note_moyenne = null, nb_notes = 0
         where id = p_profil;
      end if;
    end if;

    -- Solde restant : abandonné, avec son écriture
    if v_solde > 0 then
      perform prive.ecrire_solde(p_profil, -v_solde, 'Compte supprimé : solde abandonné', null);
    end if;

    -- Profil vidé, puis « supprimé » (le journal des statuts ne garde ainsi
    -- aucune coordonnée)
    update public.profils
       set prenom = '', nom = '', email = null, telephone = null, photo_chemin = null,
           notif_email = false, notif_whatsapp = false, notif_push = false,
           code_parrainage = prive.nouveau_code_parrainage()
     where id = p_profil;
    update public.profils set statut = 'supprime' where id = p_profil;

    -- Connexion : sessions fermées partout, identifiants effacés, accès
    -- bloqué (une date lointaine : le service de connexion ne lit pas
    -- « infinity »)
    delete from auth.sessions where user_id = p_profil;
    delete from auth.refresh_tokens where user_id = p_profil::text;
    delete from auth.one_time_tokens where user_id = p_profil;
    delete from auth.mfa_factors where user_id = p_profil;
    delete from auth.identities where user_id = p_profil;
    update auth.users
       set email = null, phone = null, encrypted_password = null,
           email_change = '', email_change_token_new = '', email_change_token_current = '',
           phone_change = '', phone_change_token = '', confirmation_token = '', recovery_token = '',
           reauthentication_token = '', raw_user_meta_data = '{}'::jsonb,
           banned_until = '2999-12-31 00:00:00+00', deleted_at = now()
     where id = p_profil;

    -- Journal : coordonnées des courses effacées aussi
    perform prive.journal_sans('courses',
      array(select c.id::text from public.courses c where c.client_id = p_profil), v_cles_client);
    perform prive.journal_sans('courses',
      array(select c.id::text from public.courses c where c.chauffeur_id = p_profil), v_cles_chauffeur);
  end if;

  -- 5. Journal : coordonnées du profil et numéros du dossier chauffeur
  perform prive.journal_sans('profils', array[p_profil::text], v_cles_profil);
  perform prive.journal_sans('chauffeurs', array[p_profil::text], v_cles_fiche);

  -- 6. Trace de la suppression, sans coordonnées
  perform prive.journaliser_action('suppression_compte', 'profils', p_profil::text,
    jsonb_build_object('par', p_par, 'mode', v_mode, 'role', v_profil.role,
                       'courses_gardees', case when v_mode = 'archive' then v_courses else 0 end,
                       'solde_abandonne', case when v_mode = 'archive' then v_solde else 0 end,
                       'dossier_paie_garde', v_salarie));
  return jsonb_build_object('mode', v_mode, 'courses_gardees', case when v_mode = 'archive' then v_courses else 0 end,
                            'solde_abandonne', case when v_mode = 'archive' then v_solde else 0 end,
                            'dossier_paie_garde', v_salarie);
end;
$$;
-- 10b. Suppression par le client : pas tant qu'une somme reste à régler par
--      le portefeuille ou par virement, ni pendant une recharge en cours
-- (reprise de 20261030092600_donnees_personnelles.sql, modifiée)
create or replace function public.supprimer_mon_compte(p_confirmation text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_moi      uuid := auth.uid();
  v_profil   public.profils;
  v_solde    numeric := 0;
  v_courses  integer := 0;
begin
  select * into v_profil from public.profils p where p.id = v_moi for update;
  if v_profil.id is null or v_profil.statut = 'supprime' then
    raise exception 'Compte introuvable.';
  end if;
  if v_profil.role <> 'client' then
    raise exception 'La suppression en ligne est réservée aux comptes clients : écrivez à LOC RÉACTION pour fermer ce compte.';
  end if;
  if upper(trim(coalesce(p_confirmation, ''))) not in ('SUPPRIMER', 'DELETE') then
    raise exception 'Pour confirmer, écrivez SUPPRIMER.';
  end if;
  if exists (select 1 from public.courses c
             where c.client_id = v_moi and c.statut in ('planifiee', 'recherche', 'a_attribuer', 'acceptee', 'arrivee', 'en_cours')) then
    raise exception 'Une course est en cours ou à venir : annulez-la, ou attendez qu''elle soit terminée, avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.paiements pa where pa.client_id = v_moi and pa.statut = 'echoue') then
    raise exception 'Un paiement est signalé non réglé : écrivez à LOC RÉACTION avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.paiements pa
             where pa.client_id = v_moi and pa.statut = 'a_encaisser' and pa.mode in ('solde', 'virement')) then
    raise exception 'Une somme reste à régler (portefeuille ou virement) : réglez-la avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.recharges r
             where r.client_id = v_moi and r.statut = 'ouverte' and r.cree_le > now() - interval '24 hours') then
    raise exception 'Une recharge de votre portefeuille attend la réponse de Mollie : attendez son résultat avant de supprimer votre compte.';
  end if;
  if exists (select 1 from public.chauffeurs ch where ch.id = v_moi)
     or exists (select 1 from public.candidatures ca where ca.profil_id = v_moi) then
    raise exception 'Un dossier chauffeur est ouvert à votre nom : écrivez à LOC RÉACTION, qui le fermera avec votre compte et vos documents.';
  end if;

  v_solde := coalesce((select s.montant from public.soldes s where s.profil_id = v_moi), 0);
  select count(*) into v_courses from public.courses c where c.client_id = v_moi;

  -- 1. Données effacées. L'adhésion aux comptes professionnels part en
  --    premier : son retrait écrit une notification, effacée juste après.
  delete from public.comptes_pro_membres where profil_id = v_moi;
  delete from public.lieux where client_id = v_moi;
  delete from public.proches where client_id = v_moi;
  delete from public.appareils where profil_id = v_moi;
  delete from public.notes_internes where profil_id = v_moi;
  delete from public.evaluations e where e.cible_id = v_moi;
  delete from public.messages m using public.courses c where m.course_id = c.id and c.client_id = v_moi;
  delete from public.notifications where destinataire_id = v_moi;

  -- 2. Courses : les coordonnées s'effacent, le trajet et les montants restent
  update public.courses c
     set client_prenom = null, client_telephone = null, depart_precision = null,
         beneficiaire_nom = case when c.pour_proche then 'Proche' end, beneficiaire_telephone = null
   where c.client_id = v_moi;

  -- 3. Solde restant : abandonné, avec son écriture
  if v_solde > 0 then
    perform prive.ecrire_solde(v_moi, -v_solde, 'Compte supprimé : solde abandonné', null);
  end if;

  -- 4. Profil anonymisé, puis marqué « supprimé » : le journal des statuts ne
  --    garde ainsi aucune coordonnée
  update public.profils
     set prenom = '', nom = '', email = null, telephone = null, photo_chemin = null,
         notif_email = false, notif_whatsapp = false, notif_push = false,
         code_parrainage = prive.nouveau_code_parrainage()
   where id = v_moi;
  update public.profils set statut = 'supprime' where id = v_moi;

  -- 5. Journal des modifications : les coordonnées déjà inscrites s'effacent
  --    (corrections de l'administration sur le profil et sur les courses)
  update prive.journal j
     set avant = j.avant - array['prenom', 'nom', 'email', 'telephone'],
         apres = j.apres - array['prenom', 'nom', 'email', 'telephone']
   where j.table_cible = 'profils' and j.ligne_id = v_moi::text;
  update prive.journal j
     set avant = j.avant - array['client_prenom', 'client_telephone', 'depart_precision', 'beneficiaire_nom', 'beneficiaire_telephone'],
         apres = j.apres - array['client_prenom', 'client_telephone', 'depart_precision', 'beneficiaire_nom', 'beneficiaire_telephone']
   where j.table_cible = 'courses'
     and j.ligne_id in (select c.id::text from public.courses c where c.client_id = v_moi);

  -- 6. Connexion : sessions fermées partout, identifiants effacés, accès
  --    bloqué. Une date lointaine plutôt que « infinity », que le service de
  --    connexion ne sait pas lire.
  delete from auth.sessions where user_id = v_moi;
  delete from auth.refresh_tokens where user_id = v_moi::text;
  delete from auth.one_time_tokens where user_id = v_moi;
  delete from auth.mfa_factors where user_id = v_moi;
  delete from auth.identities where user_id = v_moi;
  update auth.users
     set email = null, phone = null, encrypted_password = null,
         email_change = '', email_change_token_new = '', email_change_token_current = '',
         phone_change = '', phone_change_token = '', confirmation_token = '', recovery_token = '',
         reauthentication_token = '', raw_user_meta_data = '{}'::jsonb,
         banned_until = '2999-12-31 00:00:00+00', deleted_at = now()
   where id = v_moi;

  -- 7. Trace de la suppression, sans coordonnées
  perform prive.journaliser_action('suppression_compte', 'profils', v_moi::text,
    jsonb_build_object('par', 'client', 'courses_gardees', v_courses, 'solde_abandonne', v_solde));
  return jsonb_build_object('supprime', true, 'courses_gardees', v_courses, 'solde_abandonne', v_solde);
end;
$$;
-- 10c. Export des données : les recharges du portefeuille en plus
-- (reprise de 20261030092600_donnees_personnelles.sql, modifiée)
create or replace function public.mes_donnees()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_moi    uuid := auth.uid();
  v_profil public.profils;
begin
  select * into v_profil from public.profils p where p.id = v_moi;
  if v_profil.id is null or v_profil.statut = 'supprime' then
    raise exception 'Compte introuvable.';
  end if;
  if v_profil.role <> 'client' then
    raise exception 'Le téléchargement en ligne est réservé aux comptes clients : écrivez à LOC RÉACTION pour recevoir vos données.';
  end if;

  return jsonb_build_object(
    'a_propos', jsonb_build_object(
      'document', 'Données personnelles d''un compte client LOC RÉACTION',
      'genere_le', now(),
      'responsable_du_traitement', (select jsonb_strip_nulls(jsonb_build_object(
                                      'raison_sociale', s.raison_sociale,
                                      'adresse', nullif(concat_ws(' ', s.adresse, s.code_postal, s.ville), ''),
                                      'email', s.email, 'telephone', s.telephone))
                                    from public.societe s where s.id = 1),
      'contenu', 'Profil, connexion, lieux, proches, courses (arrêts compris), paiements, remboursements, factures, avoirs, '
                 || 'notes données et reçues, conversations des courses, demandes au support, notifications, solde, écritures et recharges du portefeuille, '
                 || 'parrainages, codes promo utilisés, comptes professionnels, appareils, notes de LOC RÉACTION.'),

    'profil', jsonb_build_object(
      'prenom', v_profil.prenom, 'nom', v_profil.nom, 'email', v_profil.email, 'telephone', v_profil.telephone,
      'langue', v_profil.langue, 'code_parrainage', v_profil.code_parrainage, 'statut', v_profil.statut,
      'notifications', jsonb_build_object('email', v_profil.notif_email, 'whatsapp', v_profil.notif_whatsapp,
                                          'application', v_profil.notif_push),
      'cree_le', v_profil.cree_le, 'maj_le', v_profil.maj_le),

    'connexion', (select jsonb_build_object('email', u.email, 'telephone', u.phone, 'email_confirme_le', u.email_confirmed_at,
                                            'derniere_connexion', u.last_sign_in_at, 'cree_le', u.created_at)
                  from auth.users u where u.id = v_moi),

    'lieux', coalesce((select jsonb_agg(jsonb_build_object(
               'type', l.type, 'libelle', l.libelle, 'adresse', l.adresse, 'latitude', l.latitude, 'longitude', l.longitude,
               'precision', l.precision, 'cree_le', l.cree_le) order by l.cree_le)
             from public.lieux l where l.client_id = v_moi), '[]'::jsonb),

    'proches', coalesce((select jsonb_agg(jsonb_build_object(
                 'nom', pr.nom, 'telephone', pr.telephone, 'relation', pr.relation, 'cree_le', pr.cree_le) order by pr.cree_le)
               from public.proches pr where pr.client_id = v_moi), '[]'::jsonb),

    'courses', coalesce((select jsonb_agg(jsonb_build_object(
                 'numero', c.numero, 'type', c.type, 'statut', c.statut, 'categorie', cat.nom_fr,
                 'chauffeuse_demandee', c.option_chauffeuse,
                 'pour_un_proche', c.pour_proche, 'proche_nom', c.beneficiaire_nom, 'proche_telephone', c.beneficiaire_telephone,
                 'depart', c.depart_adresse, 'depart_precision', c.depart_precision, 'arrivee', c.arrivee_adresse,
                 'arrets', coalesce((select jsonb_agg(a.adresse order by a.ordre) from public.course_arrets a where a.course_id = c.id),
                                    '[]'::jsonb),
                 'prise_en_charge_le', c.prise_en_charge_le, 'numero_vol', c.numero_vol, 'terminal', c.terminal,
                 'mise_a_disposition_heures', c.duree_mad_heures, 'distance_km', c.distance_km, 'duree_min', c.duree_min,
                 'prix_total', c.prix_total, 'remise', c.remise, 'attente_min', c.attente_min, 'frais_attente', c.frais_attente,
                 'frais_annulation', c.frais_annulation, 'pourboire', c.pourboire, 'mode_paiement', c.mode_paiement,
                 'compte_professionnel', cp.raison_sociale,
                 'chauffeur_prenom', c.chauffeur_prenom,
                 'vehicule', nullif(concat_ws(' ', c.vehicule_libelle, c.vehicule_couleur), ''),
                 'immatriculation', c.vehicule_immatriculation,
                 'commandee_le', c.cree_le, 'acceptee_le', c.acceptee_le, 'terminee_le', c.terminee_le,
                 'annulee_le', c.annulee_le, 'annulee_par', c.annulee_par, 'motif_annulation', c.motif_annulation)
               order by c.cree_le)
               from public.courses c
               left join public.categories cat on cat.id = c.categorie_id
               left join public.comptes_pro cp on cp.id = c.compte_pro_id
               where c.client_id = v_moi), '[]'::jsonb),

    'paiements', coalesce((select jsonb_agg(jsonb_build_object(
                   'course', c.numero, 'nature', pa.nature, 'mode', pa.mode, 'montant', pa.montant, 'statut', pa.statut,
                   'encaisse_le', pa.encaisse_le, 'cree_le', pa.cree_le) order by pa.cree_le)
                 from public.paiements pa join public.courses c on c.id = pa.course_id
                 where pa.client_id = v_moi), '[]'::jsonb),

    'remboursements', coalesce((select jsonb_agg(jsonb_build_object(
                        'course', c.numero, 'montant', r.montant, 'mode', r.mode, 'motif', r.motif, 'cree_le', r.cree_le)
                      order by r.cree_le)
                      from public.remboursements r
                      join public.paiements pa on pa.id = r.paiement_id
                      join public.courses c on c.id = pa.course_id
                      where pa.client_id = v_moi), '[]'::jsonb),

    'factures', coalesce((select jsonb_agg(jsonb_build_object(
                  'numero', f.numero, 'nature', f.nature, 'course', c.numero, 'date_emission', f.date_emission,
                  'destinataire_nom', f.destinataire_nom, 'destinataire_adresse', f.destinataire_adresse,
                  'montant_ht', f.montant_ht, 'taux_tva', f.taux_tva, 'montant_tva', f.montant_tva, 'montant_ttc', f.montant_ttc,
                  'pourboire', f.pourboire, 'statut', f.statut) order by f.numero)
                from public.factures f join public.courses c on c.id = f.course_id
                where f.client_id = v_moi), '[]'::jsonb),

    'avoirs', coalesce((select jsonb_agg(jsonb_build_object(
                'numero', av.numero, 'facture', f.numero, 'date_emission', av.date_emission, 'motif', av.motif,
                'montant_ht', av.montant_ht, 'montant_tva', av.montant_tva, 'montant_ttc', av.montant_ttc) order by av.numero)
              from public.avoirs av join public.factures f on f.id = av.facture_id
              where av.client_id = v_moi), '[]'::jsonb),

    'notes_donnees', coalesce((select jsonb_agg(jsonb_build_object(
                       'course', c.numero, 'note', e.note, 'commentaire', e.commentaire, 'cree_le', e.cree_le) order by e.cree_le)
                     from public.evaluations e join public.courses c on c.id = e.course_id
                     where e.auteur_id = v_moi), '[]'::jsonb),

    'notes_recues', coalesce((select jsonb_agg(jsonb_build_object(
                      'course', c.numero, 'note', e.note, 'cree_le', e.cree_le) order by e.cree_le)
                    from public.evaluations e join public.courses c on c.id = e.course_id
                    where e.cible_id = v_moi), '[]'::jsonb),

    'conversations_courses', coalesce((select jsonb_agg(jsonb_build_object(
                               'course', c.numero, 'de', case when m.auteur_id = v_moi then 'vous' else 'chauffeur' end,
                               'message', m.contenu, 'cree_le', m.cree_le) order by m.cree_le)
                             from public.messages m join public.courses c on c.id = m.course_id
                             where c.client_id = v_moi), '[]'::jsonb),

    'demandes_support', coalesce((select jsonb_agg(jsonb_build_object(
                          'numero', d.numero, 'type', d.type, 'sujet', d.sujet, 'statut', d.statut,
                          'course', (select c.numero from public.courses c where c.id = d.course_id),
                          'cree_le', d.cree_le, 'cloturee_le', d.cloturee_le,
                          'messages', coalesce((select jsonb_agg(jsonb_build_object(
                                        'de', case when m.auteur_id = v_moi then 'vous' else 'LOC RÉACTION' end,
                                        'message', m.contenu,
                                        'piece_jointe', substring(m.piece_jointe_chemin from '[^/]+$'),
                                        'cree_le', m.cree_le) order by m.cree_le)
                                      from public.messages m where m.demande_id = d.id), '[]'::jsonb))
                        order by d.cree_le)
                        from public.demandes d where d.auteur_id = v_moi), '[]'::jsonb),

    'notifications', coalesce((select jsonb_agg(jsonb_build_object(
                       'titre', n.titre, 'message', n.message, 'lue_le', n.lu_le, 'cree_le', n.cree_le) order by n.cree_le)
                     from public.notifications n where n.destinataire_id = v_moi), '[]'::jsonb),

    'solde', jsonb_build_object(
      'montant', coalesce((select so.montant from public.soldes so where so.profil_id = v_moi), 0),
      'ecritures', coalesce((select jsonb_agg(jsonb_build_object(
                     'montant', es.montant, 'motif', es.motif,
                     'course', (select c.numero from public.courses c where c.id = es.course_id),
                     'cree_le', es.cree_le) order by es.cree_le)
                   from public.ecritures_solde es where es.profil_id = v_moi), '[]'::jsonb),
      'recharges', coalesce((select jsonb_agg(jsonb_build_object(
                     'numero', r.numero, 'montant', r.montant, 'statut', r.statut, 'moyen', r.methode,
                     'cree_le', r.cree_le, 'payee_le', r.payee_le) order by r.cree_le)
                   from public.recharges r where r.client_id = v_moi), '[]'::jsonb)),

    'parrainages', coalesce((select jsonb_agg(jsonb_build_object(
                     'vous_etes', case when pa.parrain_id = v_moi then 'parrain' else 'filleul' end,
                     'statut', pa.statut,
                     'recompense', case when pa.parrain_id = v_moi then pa.recompense_parrain else pa.recompense_filleul end,
                     'cree_le', pa.cree_le, 'valide_le', pa.valide_le) order by pa.cree_le)
                   from public.parrainages pa where v_moi in (pa.parrain_id, pa.filleul_id)), '[]'::jsonb),

    'codes_promo_utilises', coalesce((select jsonb_agg(jsonb_build_object(
                              'code', cpr.code, 'remise', u.remise,
                              'course', (select c.numero from public.courses c where c.id = u.course_id),
                              'cree_le', u.cree_le) order by u.cree_le)
                            from public.utilisations_promo u join public.codes_promo cpr on cpr.id = u.code_promo_id
                            where u.client_id = v_moi), '[]'::jsonb),

    'comptes_professionnels', coalesce((select jsonb_agg(jsonb_build_object(
                                'raison_sociale', cp.raison_sociale, 'role', m.role, 'depuis', m.cree_le) order by m.cree_le)
                              from public.comptes_pro_membres m join public.comptes_pro cp on cp.id = m.compte_pro_id
                              where m.profil_id = v_moi), '[]'::jsonb),

    'appareils', coalesce((select jsonb_agg(jsonb_build_object(
                   'appareil', ap.agent, 'ajoute_le', ap.cree_le, 'vu_le', ap.vu_le) order by ap.cree_le)
                 from public.appareils ap where ap.profil_id = v_moi), '[]'::jsonb),

    'notes_de_loc_reaction', coalesce((select jsonb_agg(jsonb_build_object(
                               'note', ni.texte, 'cree_le', ni.cree_le) order by ni.cree_le)
                             from public.notes_internes ni where ni.profil_id = v_moi), '[]'::jsonb)
  );
end;
$$;

-- #############################################################################
-- 11. DROITS
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
