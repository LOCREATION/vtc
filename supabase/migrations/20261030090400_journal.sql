-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 5/8 : JOURNAL ET PROTECTIONS AUTOMATIQUES
-- -----------------------------------------------------------------------------
--   1. date de dernière modification (« maj_le ») tenue à jour partout ;
--   2. protections qui s'appliquent quoi qu'il arrive :
--        - un chauffeur ne règle, sur sa fiche, que son filtre de destination ;
--        - une facture émise ne change plus et ne se supprime pas ;
--        - un chauffeur suspendu ou refusé est mis hors ligne ;
--   3. journal des modifications sur les tables sensibles (tarifs, argent,
--      paie, identité de la société, rôles, corrections de l'administration).
-- Repère utilisé plus bas : « current_user » vaut « authenticated » quand la
-- modification vient directement de l'application ; à l'intérieur d'une
-- fonction serveur, il vaut le propriétaire de la fonction. On distingue ainsi
-- une correction faite à la main d'une étape normale de la course.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Date de dernière modification
-- ---------------------------------------------------------------------------
-- Toutes les tables qui ont une colonne « maj_le » reçoivent le déclencheur.
do $$
declare
  t record;
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'maj_le'
    order by c.table_name
  loop
    execute format(
      'create trigger maj_horodatage before update on public.%I for each row execute function prive.maj_horodatage()',
      t.table_name);
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Protections
-- ---------------------------------------------------------------------------

-- 2a. Fiche chauffeur : depuis l'application, le chauffeur ne modifie que son
--     filtre de destination. Statut, véhicule, documents, notes et compteurs
--     ne changent que par l'administration ou les fonctions serveur.
--     (Fonction volontairement sans « security definer » : elle doit voir le
--     rôle réel de celui qui modifie.)
create or replace function prive.proteger_fiche_chauffeur()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_libres constant text[] := array['filtre_destination_actif', 'filtre_destination_lat', 'filtre_destination_lng', 'maj_le'];
begin
  if current_user = 'authenticated' and not public.est_admin()
     and (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Seule l''administration peut modifier ces informations.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger proteger_fiche_chauffeur
  before update on public.chauffeurs
  for each row execute function prive.proteger_fiche_chauffeur();

-- 2b. Facture émise : montants, numéro, destinataire et date ne changent plus,
--     y compris par les fonctions serveur. Seuls changent le statut (annulée,
--     définitivement) et le chemin du PDF archivé. Aucune suppression.
create or replace function prive.proteger_facture()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_libres constant text[] := array['statut', 'pdf_chemin'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Une facture émise ne peut pas être supprimée.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_libres) is distinct from (to_jsonb(old) - v_libres) then
    raise exception 'Une facture émise ne peut plus être modifiée.' using errcode = '42501';
  end if;
  if old.statut = 'annulee' and new.statut <> 'annulee' then
    raise exception 'Une facture annulée le reste.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger proteger_facture
  before update or delete on public.factures
  for each row execute function prive.proteger_facture();

-- 2c. Chauffeur suspendu ou refusé : hors ligne tout de suite, et ses demandes
--     en attente sont retirées (la course repart vers un autre chauffeur à la
--     relance suivante).
create or replace function prive.chauffeur_hors_service()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.positions set en_ligne = false where chauffeur_id = new.id and en_ligne;
  update public.propositions set statut = 'annulee', repondue_le = now()
   where chauffeur_id = new.id and statut = 'envoyee';
  return new;
end;
$$;

create trigger chauffeur_hors_service
  after update of statut on public.chauffeurs
  for each row when (old.statut is distinct from new.statut and new.statut <> 'valide')
  execute function prive.chauffeur_hors_service();

-- Même chose pour un compte bloqué (quel que soit le chemin du blocage).
create trigger compte_bloque_hors_service
  after update of statut on public.profils
  for each row when (old.statut is distinct from new.statut and new.statut = 'bloque')
  execute function prive.chauffeur_hors_service();


-- ---------------------------------------------------------------------------
-- 3. Journal des modifications
-- ---------------------------------------------------------------------------

-- 3a. Toutes les opérations : catalogue et prix, identité et réglages, flotte,
--     comptes professionnels, argent, paie, comptabilité des plateformes.
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'tarifs', 'majorations', 'jours_feries', 'zones', 'forfaits', 'codes_promo',
    'societe', 'parametres',
    'vehicules', 'entretiens',
    'comptes_pro', 'comptes_pro_membres',
    'paiements', 'remboursements', 'factures',
    'salaries', 'contrats', 'constantes_paie', 'parametres_paie', 'bulletins', 'absences', 'temps_travail',
    'releves_plateformes', 'campagnes'
  ] loop
    execute format(
      'create trigger journal after insert or update or delete on public.%I for each row execute function prive.journaliser()',
      t);
  end loop;
end $$;

-- 3b. Comptes : changement de rôle ou blocage.
create trigger journal
  after update of role, statut on public.profils
  for each row when (old.role is distinct from new.role or old.statut is distinct from new.statut)
  execute function prive.journaliser();

-- 3c. Courses : corrections faites à la main par l'administration. Les étapes
--     normales (commande, attribution, arrivée, fin, annulation) sont déjà
--     tracées pas à pas dans « evenements_course ».
create trigger journal
  after update or delete on public.courses
  for each row when (current_user = 'authenticated')
  execute function prive.journaliser();

-- 3d. Fiche chauffeur : statut, véhicule, contrat, option chauffeuse,
--     carte VTC et permis (pas les compteurs, qui bougent à chaque course).
create trigger journal
  after update on public.chauffeurs
  for each row when (
       old.statut               is distinct from new.statut
    or old.vehicule_id          is distinct from new.vehicule_id
    or old.salarie              is distinct from new.salarie
    or old.chauffeuse           is distinct from new.chauffeuse
    or old.carte_vtc_numero     is distinct from new.carte_vtc_numero
    or old.carte_vtc_expiration is distinct from new.carte_vtc_expiration
    or old.permis_numero        is distinct from new.permis_numero
    or old.permis_expiration    is distinct from new.permis_expiration
    or current_user = 'authenticated')
  execute function prive.journaliser();
create trigger journal_suppression
  after delete on public.chauffeurs
  for each row execute function prive.journaliser();

-- 3e. Documents et candidatures : décisions de l'administration.
create trigger journal
  after update of statut on public.documents
  for each row when (old.statut is distinct from new.statut)
  execute function prive.journaliser();
create trigger journal_suppression
  after delete on public.documents
  for each row execute function prive.journaliser();
create trigger journal
  after update of statut on public.candidatures
  for each row when (old.statut is distinct from new.statut)
  execute function prive.journaliser();

-- (Le solde n'a pas besoin du journal : chaque mouvement a déjà son écriture
--  datée et signée dans « ecritures_solde », et l'application n'a aucun droit
--  d'écriture directe sur les soldes.)
