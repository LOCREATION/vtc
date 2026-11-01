-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 17a : SUPPORT (1/2) — structure
-- -----------------------------------------------------------------------------
-- Les tables du support existent depuis la migration 2 (demandes, messages,
-- objets trouvés, messages du formulaire de contact, demandes de devis).
-- Elles reçoivent ici ce qu'il faut pour les traiter depuis l'administration :
--   1. Demandes : date de clôture posée par la base ; le statut et la
--      personne chargée de la demande ne changent plus que par les fonctions
--      de l'administration (qui préviennent l'auteur et tracent l'action).
--   2. Objets trouvés : numéro (OT-2026-000001), date de découverte, demande
--      de l'auteur rattachée, client prévenu (date), restitution (comment
--      l'objet a été rendu, ou pourquoi il ne l'a pas été) ; statut changé
--      par les fonctions seulement.
--   3. Formulaire de contact et demandes de devis : qui les a traités,
--      quand, note interne ; date d'envoi du devis.
--   4. Journal des modifications (qui, quoi, quand) sur ces quatre tables.
-- =============================================================================


-- #############################################################################
-- 1. DEMANDES AU SUPPORT
-- #############################################################################

-- 1a. Date de clôture : posée quand la demande devient « résolue » ou
--     « fermée », retirée si elle est rouverte
alter table public.demandes add column cloturee_le timestamptz;
update public.demandes set cloturee_le = maj_le where statut in ('resolue', 'fermee') and cloturee_le is null;
alter table public.demandes add constraint demandes_cloture
  check ((statut in ('resolue', 'fermee')) = (cloturee_le is not null));
comment on column public.demandes.cloturee_le is 'Résolue ou fermée le (posé par la base).';

create or replace function prive.dater_cloture_demande()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.statut in ('resolue', 'fermee') then
    if tg_op = 'INSERT' or old.statut not in ('resolue', 'fermee') or new.cloturee_le is null then
      new.cloturee_le := now();
    end if;
  else
    new.cloturee_le := null;
  end if;
  return new;
end;
$$;
create trigger dater_cloture
  before insert or update on public.demandes
  for each row execute function prive.dater_cloture_demande();
revoke all on function prive.dater_cloture_demande() from public, anon, authenticated;

-- 1b. Statut et attribution : par les fonctions de l'administration seulement
revoke update (statut, assignee_a) on public.demandes from authenticated;

-- 1c. File d'attente : demandes en cours, de la plus ancienne à la plus récente
create index demandes_file_idx on public.demandes (statut, cree_le);


-- #############################################################################
-- 2. OBJETS TROUVÉS
-- #############################################################################
alter table public.objets_trouves
  add column numero            text,
  add column trouve_le         date not null default ((now() at time zone 'Europe/Paris')::date),
  add column demande_id        uuid references public.demandes (id) on delete set null,
  add column client_prevenu_le timestamptz,
  add column restitution       text;

-- Numéro des objets déjà enregistrés, dans l'ordre d'enregistrement
do $$
declare
  r record;
begin
  for r in select o.id from public.objets_trouves o where o.numero is null order by o.cree_le, o.id loop
    update public.objets_trouves set numero = prive.prochain_numero('objet', 'OT') where id = r.id;
  end loop;
end $$;

alter table public.objets_trouves alter column numero set not null;
alter table public.objets_trouves
  add constraint objets_trouves_numero_unique unique (numero),
  add constraint objets_trouves_textes check (
    char_length(trim(description)) >= 3
    and (lieu_stockage is null or char_length(lieu_stockage) <= 200)
    and (restitution is null or char_length(restitution) <= 500)),
  -- Un objet rendu ou clos sans restitution dit comment (ou pourquoi)
  add constraint objets_trouves_restitution check (statut not in ('rendu', 'detruit') or restitution is not null);
create index objets_trouves_demande_fk_idx on public.objets_trouves (demande_id);
create index objets_trouves_statut_idx on public.objets_trouves (statut, trouve_le desc);
comment on column public.objets_trouves.numero is 'OT-2026-000001 : numéro du registre des objets trouvés.';
comment on column public.objets_trouves.restitution is 'Comment l''objet a été rendu, ou pourquoi il ne l''a pas été.';

-- Saisie et statut : par les fonctions de l'administration (le client de la
-- course est prévenu) ; une erreur de saisie se supprime depuis la page
revoke insert, update on public.objets_trouves from authenticated;


-- #############################################################################
-- 3. FORMULAIRE DE CONTACT ET DEMANDES DE DEVIS
-- #############################################################################
alter table public.messages_contact
  add column traite_par uuid references public.profils (id) on delete set null,
  add column traite_le  timestamptz,
  add column note       text;
alter table public.messages_contact
  add constraint messages_contact_note check (note is null or char_length(note) <= 1000);
create index messages_contact_traite_par_fk_idx on public.messages_contact (traite_par);
create index messages_contact_file_idx on public.messages_contact (traite, cree_le desc);

alter table public.demandes_devis
  add column traite_par      uuid references public.profils (id) on delete set null,
  add column devis_envoye_le timestamptz,
  add column note            text;
alter table public.demandes_devis
  add constraint demandes_devis_note check (note is null or char_length(note) <= 2000),
  -- Un devis envoyé, accepté ou refusé a un montant
  add constraint demandes_devis_montant check (statut = 'nouvelle' or montant is not null);
create index demandes_devis_traite_par_fk_idx on public.demandes_devis (traite_par);
create index demandes_devis_file_idx on public.demandes_devis (statut, cree_le desc);

-- Traitement : par les fonctions de l'administration (qui, quand) ; un
-- message indésirable se supprime depuis la page
revoke update on public.messages_contact, public.demandes_devis from authenticated;


-- #############################################################################
-- 4. JOURNAL DES MODIFICATIONS
-- #############################################################################
-- Demandes, formulaire de contact, devis : changements et suppressions (la
-- création est déjà datée dans la table) ; objets trouvés : tout.
create trigger journal
  after update or delete on public.demandes
  for each row execute function prive.journaliser();
create trigger journal
  after update or delete on public.messages_contact
  for each row execute function prive.journaliser();
create trigger journal
  after update or delete on public.demandes_devis
  for each row execute function prive.journaliser();
create trigger journal
  after insert or update or delete on public.objets_trouves
  for each row execute function prive.journaliser();
