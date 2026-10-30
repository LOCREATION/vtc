-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 14a : FINANCES (1/3) — structure et outils
-- -----------------------------------------------------------------------------
-- Module « Finances » de l'administration : encaissements, remboursements,
-- factures numérotées, TVA collectée, export pour l'expert-comptable.
-- Il s'installe en trois migrations, à appliquer dans l'ordre :
--   14a (ce fichier) : sections 1 et 2, structure et outils ;
--   14b : section 3, fonctions existantes complétées ;
--   14c : sections 4 et 5, lectures et actions du module.
-- Chacune se termine par les droits d'exécution de ses propres fonctions.
-- Ce fichier :
--   1. Structure :
--        - avoirs : une facture émise ne se modifie jamais ; un remboursement
--          ou l'annulation d'une somme due la corrige par un avoir numéroté
--          (AV-2026-000001), qui reprend la facture et ses montants HT, TVA,
--          TTC ;
--        - mode de chaque remboursement (virement, carte, espèces) ;
--        - paiements : motif (impayé, annulation) et chauffeur qui garde les
--          espèces encaissées jusqu'à leur remise au bureau ;
--        - remises d'espèces des chauffeurs au bureau, numérotées
--          (RE-2026-000001), annulables avec motif ;
--        - IBAN et BIC de l'entreprise : plus lisibles par un visiteur
--          anonyme (ils restent imprimés sur les relevés).
--   2. Outils : avoir au centime près, espèces détenues par chaque chauffeur,
--      contrôle de la numérotation continue, recherche.
-- Comme partout : chaque fonction vérifie elle-même l'appelant (double
-- authentification comprise), chemin de recherche vide, messages d'erreur en
-- français affichables tels quels.
-- =============================================================================

-- #############################################################################
-- 1. STRUCTURE
-- #############################################################################

-- 1a. Avoirs. Ils suivent les mêmes règles qu'une facture : numéro continu
--     (série distincte « AV »), coordonnées du destinataire recopiées,
--     jamais modifiés ni supprimés. Un avoir se rapporte toujours à une
--     facture, et le total de ses avoirs ne dépasse jamais la facture.
--     origine : « remboursement » (somme rendue au client) ou « annulation »
--     (somme due, pas encore encaissée, à laquelle on renonce en tout ou partie).
create table public.avoirs (
  id                    uuid primary key default gen_random_uuid(),
  numero                text not null unique,                          -- AV-2026-000001
  facture_id            uuid not null references public.factures (id),
  course_id             uuid not null references public.courses (id),
  client_id             uuid not null references public.profils (id),
  compte_pro_id         uuid references public.comptes_pro (id),
  destinataire_nom      text not null,
  destinataire_adresse  text,
  date_emission         date not null,
  origine               text not null check (origine in ('remboursement', 'annulation')),
  motif                 text not null check (char_length(trim(motif)) between 1 and 500),
  paiement_id           uuid references public.paiements (id),
  remboursement_id      uuid unique references public.remboursements (id),
  montant_ht            numeric(10,2) not null check (montant_ht >= 0),
  taux_tva              numeric(4,2)  not null,
  montant_tva           numeric(10,2) not null check (montant_tva >= 0),
  montant_ttc           numeric(10,2) not null check (montant_ttc > 0),
  cree_par              uuid references public.profils (id),
  cree_le               timestamptz not null default now(),
  constraint avoirs_totaux check (montant_ht + montant_tva = montant_ttc),
  constraint avoirs_origine check ((origine = 'remboursement') = (remboursement_id is not null))
);
create index avoirs_facture_idx    on public.avoirs (facture_id);
create index avoirs_course_idx     on public.avoirs (course_id);
create index avoirs_client_idx     on public.avoirs (client_id, date_emission desc);
create index avoirs_compte_pro_idx on public.avoirs (compte_pro_id) where compte_pro_id is not null;
create index avoirs_paiement_idx   on public.avoirs (paiement_id);
create index avoirs_date_idx       on public.avoirs (date_emission);
create index avoirs_cree_par_idx   on public.avoirs (cree_par);
comment on table public.avoirs is
  'Avoirs : corrigent une facture émise (remboursement, annulation d''une somme due). Numérotation continue, jamais modifiés.';

-- Un avoir émis ne bouge plus (comme une facture)
create or replace function prive.proteger_avoir()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Un avoir émis ne peut pas être supprimé.' using errcode = '42501';
  end if;
  raise exception 'Un avoir émis ne peut plus être modifié.' using errcode = '42501';
end;
$$;

create trigger proteger_avoir
  before update or delete on public.avoirs
  for each row execute function prive.proteger_avoir();

create trigger journal
  after insert or update or delete on public.avoirs
  for each row execute function prive.journaliser();

-- Lecture : le client concerné, les gestionnaires de son compte pro,
-- l'administration. Aucune écriture directe : tout passe par les fonctions.
alter table public.avoirs enable row level security;
revoke all on public.avoirs from public, anon, authenticated;
grant select on public.avoirs to authenticated;
create policy avoirs_lecture on public.avoirs for select to authenticated
  using (
    client_id = (select auth.uid())
    or (select public.est_admin())
    or (compte_pro_id is not null and exists (
          select 1 from public.comptes_pro_membres m
          where m.compte_pro_id = avoirs.compte_pro_id and m.profil_id = (select auth.uid()) and m.role = 'gestionnaire'))
  );

-- 1b. Mode de chaque remboursement : il dit à l'expert-comptable d'où sort
--     l'argent (banque ou caisse). Une carte se rembourse sur la carte.
alter table public.remboursements
  add column mode text not null default 'virement' check (mode in ('virement', 'carte', 'especes'));
comment on column public.remboursements.mode is
  'Moyen par lequel la somme est rendue : virement, carte (paiement par carte seulement) ou espèces (caisse du bureau).';
create index remboursements_date_idx on public.remboursements (cree_le);
create index remboursements_cree_par_idx on public.remboursements (cree_par);

-- 1c. Paiements :
--     - motif : raison d'un impayé ou d'une annulation (aussi au journal) ;
--     - especes_chauffeur_id : chauffeur qui a reçu les espèces et les garde
--       jusqu'à leur remise au bureau (vide : espèces reçues au bureau, ou
--       paiement qui n'est pas en espèces).
alter table public.paiements
  add column motif text check (char_length(motif) <= 300),
  add column especes_chauffeur_id uuid references public.chauffeurs (id);
comment on column public.paiements.especes_chauffeur_id is
  'Chauffeur qui détient les espèces encaissées (à remettre au bureau). Vide : reçues au bureau, ou autre mode.';
create index paiements_especes_idx on public.paiements (especes_chauffeur_id) where especes_chauffeur_id is not null;
create index paiements_encaisse_le_idx on public.paiements (encaisse_le) where encaisse_le is not null;
create index paiements_encaisse_par_idx on public.paiements (encaisse_par);

-- Paiements en espèces déjà confirmés par le chauffeur de la course : il garde l'argent
update public.paiements p
   set especes_chauffeur_id = c.chauffeur_id
  from public.courses c
 where c.id = p.course_id and p.mode = 'especes' and p.statut in ('encaisse', 'rembourse')
   and p.encaisse_par = c.chauffeur_id and p.especes_chauffeur_id is null;

create index factures_date_idx on public.factures (date_emission);

-- 1d. Remises d'espèces : le chauffeur remet au bureau les espèces reçues des
--     clients. Chaque remise porte un numéro de reçu ; une erreur se corrige
--     en l'annulant avec un motif (elle reste visible, barrée).
create table public.remises_especes (
  id                uuid primary key default gen_random_uuid(),
  numero            text not null unique,                                -- RE-2026-000001
  chauffeur_id      uuid not null references public.chauffeurs (id),
  montant           numeric(10,2) not null check (montant > 0),
  note              text check (char_length(note) <= 300),
  recue_par         uuid references public.profils (id),
  cree_le           timestamptz not null default now(),
  annulee_le        timestamptz,
  annulee_par       uuid references public.profils (id),
  motif_annulation  text check (char_length(motif_annulation) <= 300),
  constraint remises_especes_annulation check ((annulee_le is null) = (motif_annulation is null))
);
create index remises_especes_chauffeur_idx on public.remises_especes (chauffeur_id, cree_le desc);
create index remises_especes_date_idx on public.remises_especes (cree_le);
create index remises_especes_recue_par_idx on public.remises_especes (recue_par);
create index remises_especes_annulee_par_idx on public.remises_especes (annulee_par);
comment on table public.remises_especes is
  'Espèces remises au bureau par les chauffeurs (reçu numéroté). Annulation motivée, jamais de suppression.';

create trigger journal
  after insert or update or delete on public.remises_especes
  for each row execute function prive.journaliser();

-- Lecture : l'administration, et chaque chauffeur pour ses propres remises.
alter table public.remises_especes enable row level security;
revoke all on public.remises_especes from public, anon, authenticated;
grant select on public.remises_especes to authenticated;
create policy remises_especes_lecture on public.remises_especes for select to authenticated
  using (chauffeur_id = (select auth.uid()) or (select public.est_admin()));

-- 1e. Coordonnées bancaires : un visiteur anonyme lit l'identité légale
--     (pied de page, mentions) mais plus l'IBAN ni le BIC. Toute nouvelle
--     colonne reste fermée aux visiteurs tant qu'on ne l'ouvre pas ici.
revoke select on public.societe from anon;
grant select (id, raison_sociale, forme_juridique, capital, siren, siret, rcs, code_ape, tva_intracommunautaire,
              numero_urssaf, registre_vtc_numero, adresse, code_postal, ville, pays, representant_nom,
              representant_qualite, telephone, whatsapp, email, site_web, mentions_factures, maj_le)
  on public.societe to anon;


-- #############################################################################
-- 2. OUTILS
-- #############################################################################

-- 2a. Motif de recherche « contient », insensible à la casse : « % » et « _ »
--     saisis sont cherchés tels quels.
create or replace function prive.motif_recherche(p_texte text)
returns text
language sql immutable set search_path = ''
as $$
  select case when nullif(trim(coalesce(p_texte, '')), '') is null then null
              else '%' || replace(replace(replace(trim(p_texte), '\', '\\'), '%', '\%'), '_', '\_') || '%' end
$$;

-- Chiffres d'un téléphone saisi comme on le dit (« 06 12 34 56 78 » retrouve
-- +33612345678) ; rien en dessous de 6 chiffres.
create or replace function prive.chiffres_telephone(p_texte text)
returns text
language sql immutable set search_path = ''
as $$
  select case when char_length(x.c) >= 6 then x.c end
  from (select case when y.d ~ '^0[1-9][0-9]{8}$' then substr(y.d, 2) else y.d end as c
        from (select regexp_replace(coalesce(p_texte, ''), '[^0-9]', '', 'g') as d) y) x
$$;

-- Période saisie (jours de Paris, bornes comprises)
create or replace function prive.controler_periode(p_debut date, p_fin date)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_debut is null or p_fin is null then
    raise exception 'Indiquez le début et la fin de la période.';
  end if;
  if p_fin < p_debut then
    raise exception 'La date de fin est avant la date de début.';
  end if;
  if p_fin - p_debut > 1830 then
    raise exception 'Période trop longue : cinq ans au plus.';
  end if;
end;
$$;

-- 2b. Avoir sur une facture, au centime près. Le HT d'un avoir est la
--     différence entre le HT du cumul des avoirs après et avant lui, calculé
--     comme celui de la facture : la somme des avoirs d'une facture
--     intégralement créditée redonne exactement son HT et sa TVA.
--     La facture est verrouillée : deux avoirs simultanés se calculent l'un
--     après l'autre, et leur total ne peut pas dépasser la facture.
create or replace function prive.emettre_avoir(
  p_facture uuid, p_ttc numeric, p_origine text, p_motif text,
  p_paiement uuid default null, p_remboursement uuid default null
)
returns public.avoirs
language plpgsql security definer set search_path = ''
as $$
declare
  v_facture   public.factures;
  v_ttc       numeric := round(p_ttc, 2);
  v_deja_ttc  numeric;
  v_deja_ht   numeric;
  v_ht        numeric;
  v_avoir     public.avoirs;
begin
  select * into v_facture from public.factures f where f.id = p_facture for update;
  if v_facture.id is null then
    raise exception 'Facture introuvable.';
  end if;
  select coalesce(sum(a.montant_ttc), 0), coalesce(sum(a.montant_ht), 0) into v_deja_ttc, v_deja_ht
    from public.avoirs a where a.facture_id = p_facture;
  if v_ttc is null or v_ttc <= 0 or v_deja_ttc + v_ttc > v_facture.montant_ttc then
    raise exception 'Avoir impossible : il reste % à créditer sur la facture %.',
      prive.euros(v_facture.montant_ttc - v_deja_ttc), v_facture.numero;
  end if;

  if v_deja_ttc + v_ttc = v_facture.montant_ttc then
    v_ht := v_facture.montant_ht - v_deja_ht;                       -- dernier avoir : solde exact
  else
    v_ht := round((v_deja_ttc + v_ttc) / (1 + v_facture.taux_tva / 100), 2) - v_deja_ht;
  end if;
  v_ht := least(greatest(v_ht, 0), v_ttc);

  insert into public.avoirs (
    numero, facture_id, course_id, client_id, compte_pro_id, destinataire_nom, destinataire_adresse,
    date_emission, origine, motif, paiement_id, remboursement_id,
    montant_ht, taux_tva, montant_tva, montant_ttc, cree_par
  ) values (
    prive.prochain_numero('avoir', 'AV'), v_facture.id, v_facture.course_id, v_facture.client_id, v_facture.compte_pro_id,
    v_facture.destinataire_nom, v_facture.destinataire_adresse,
    prive.heure_paris()::date, p_origine, left(trim(p_motif), 500), p_paiement, p_remboursement,
    v_ht, v_facture.taux_tva, v_ttc - v_ht, v_ttc, auth.uid()
  )
  returning * into v_avoir;
  return v_avoir;
end;
$$;

-- 2c. Espèces détenues par les chauffeurs : les paiements en espèces qu'ils
--     ont reçus (courses et frais d'annulation ; un pourboire en espèces
--     revient au chauffeur), moins leurs remises au bureau. « depuis_le » :
--     date du plus ancien encaissement pas encore couvert par les remises
--     (les remises couvrent les encaissements dans l'ordre où ils ont eu lieu).
create or replace function prive.especes_chauffeurs()
returns table (
  chauffeur_id        uuid,
  encaisse            numeric,
  remis               numeric,
  a_remettre          numeric,
  depuis_le           timestamptz,
  derniere_remise_le  timestamptz
)
language sql stable security definer set search_path = ''
as $$
  with especes as (
    select p.especes_chauffeur_id as chauffeur_id, p.montant, p.encaisse_le,
           sum(p.montant) over (partition by p.especes_chauffeur_id order by p.encaisse_le, p.id) as cumul
    from public.paiements p
    where p.especes_chauffeur_id is not null and p.mode = 'especes' and p.nature <> 'pourboire'
      and p.statut in ('encaisse', 'rembourse')
  ),
  remises as (
    select r.chauffeur_id, sum(r.montant) as remis, max(r.cree_le) as derniere
    from public.remises_especes r
    where r.annulee_le is null
    group by r.chauffeur_id
  ),
  totaux as (
    select e.chauffeur_id, sum(e.montant) as encaisse from especes e group by e.chauffeur_id
  ),
  chauffeurs as (
    select t.chauffeur_id from totaux t
    union
    select r.chauffeur_id from remises r
  )
  select ch.chauffeur_id,
         coalesce(t.encaisse, 0),
         coalesce(r.remis, 0),
         coalesce(t.encaisse, 0) - coalesce(r.remis, 0),
         (select min(e.encaisse_le) from especes e
           where e.chauffeur_id = ch.chauffeur_id and e.cumul > coalesce(r.remis, 0)),
         r.derniere
  from chauffeurs ch
  left join totaux t on t.chauffeur_id = ch.chauffeur_id
  left join remises r on r.chauffeur_id = ch.chauffeur_id
$$;

create or replace function prive.especes_a_remettre(p_chauffeur uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce((select e.a_remettre from prive.especes_chauffeurs() e where e.chauffeur_id = p_chauffeur), 0)
$$;

-- 2d. Numérotation continue : pour chaque série (factures, avoirs) et chaque
--     année, tous les numéros de 1 au dernier attribué doivent exister.
--     Le compteur avance dans la même transaction que la création du
--     document : un trou signalerait une anomalie grave.
create or replace function prive.continuite_numeros()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x.ligne order by x.nom desc, x.annee desc), '[]'::jsonb)
  from (
    select k.nom, k.annee, jsonb_build_object(
             'serie', k.nom, 'prefixe', case k.nom when 'facture' then 'FA' else 'AV' end,
             'annee', k.annee, 'dernier', k.valeur, 'nombre', n.nombre,
             'nb_manquants', m.nb, 'manquants', m.liste) as ligne
    from prive.compteurs k
    cross join lateral (
      select coalesce(array_agg(right(d.numero, 6)::integer), '{}') as nums, count(*)::integer as nombre
      from (select f.numero from public.factures f
             where k.nom = 'facture' and f.numero like 'FA-' || k.annee || '-%'
            union all
            select a.numero from public.avoirs a
             where k.nom = 'avoir' and a.numero like 'AV-' || k.annee || '-%') d
    ) n
    cross join lateral (
      select count(*)::integer as nb,
             coalesce(jsonb_agg(g.i order by g.i) filter (where g.rang <= 20), '[]'::jsonb) as liste
      from (select s.i, row_number() over (order by s.i) as rang
            from generate_series(1, k.valeur) as s(i)
            where not (s.i = any (n.nums))) g
    ) m
    where k.nom in ('facture', 'avoir')
  ) x
$$;

-- 2e. Ligne d'un paiement pour l'administration : course, client, chauffeur,
--     compte pro, facture, qui a encaissé, qui garde les espèces, montants
--     remboursés et annulés, échéance et mois du relevé (facture mensuelle).
create or replace function prive.ligne_paiement(p_paiement uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select to_jsonb(pa) || jsonb_build_object(
    'course_numero', c.numero, 'course_statut', c.statut, 'prise_en_charge_le', c.prise_en_charge_le,
    'client_nom', coalesce(nullif(trim(cl.prenom || ' ' || cl.nom), ''), cl.email, 'Client'),
    'client_telephone', cl.telephone,
    'chauffeur_id', c.chauffeur_id,
    'chauffeur_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.chauffeur_id),
    'compte_pro_id', c.compte_pro_id, 'compte_pro', cp.raison_sociale,
    'encaisse_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = pa.encaisse_par),
    'especes_chez', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = pa.especes_chauffeur_id),
    'rembourse', (select coalesce(sum(r.montant), 0) from public.remboursements r where r.paiement_id = pa.id),
    'annule', (select coalesce(sum(a.montant_ttc), 0) from public.avoirs a where a.paiement_id = pa.id and a.origine = 'annulation'),
    'facture_id', f.id, 'facture_numero', f.numero,
    'releve_mois', case when pa.mode = 'facture_mensuelle'
                        then coalesce(to_char(f.date_emission, 'YYYY-MM'), to_char(prive.heure_paris(pa.cree_le), 'YYYY-MM')) end,
    'echeance', case when pa.mode = 'facture_mensuelle' then prive.echeance_releve(pa.cree_le, cp.delai_paiement_jours) end)
  from public.paiements pa
  join public.courses c on c.id = pa.course_id
  join public.profils cl on cl.id = c.client_id
  left join public.comptes_pro cp on cp.id = c.compte_pro_id
  left join public.factures f on f.course_id = pa.course_id and f.nature = pa.nature
  where pa.id = p_paiement
$$;


-- #############################################################################
-- DROITS D'EXÉCUTION (fonctions des sections 1 et 2)
-- #############################################################################
-- Supabase accorde par défaut l'exécution de toute nouvelle fonction à tout le
-- monde : on retire tout. Ces outils ne servent qu'aux fonctions de la base.
revoke all on function
  prive.proteger_avoir(),
  prive.motif_recherche(text),
  prive.chiffres_telephone(text),
  prive.controler_periode(date, date),
  prive.emettre_avoir(uuid, numeric, text, text, uuid, uuid),
  prive.especes_chauffeurs(),
  prive.especes_a_remettre(uuid),
  prive.continuite_numeros(),
  prive.ligne_paiement(uuid)
  from public, anon, authenticated;
