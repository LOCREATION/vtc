-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 20 : ESPACE CHAUFFEUR — demandes d'absence et dépôt de documents
-- contrôlés par la base
-- -----------------------------------------------------------------------------
-- L'onglet Compte de l'espace chauffeur écrit directement deux choses, dans
-- la limite des règles d'accès (migration 03) :
--   1. la demande d'absence du salarié (congés payés, congé sans solde, autre
--      absence). La base la contrôle maintenant comme une saisie de
--      l'administration : période comprise dans le contrat, aucune autre
--      absence (acceptée ou en attente) sur ces jours, mois dont le bulletin
--      n'est pas encore validé. Elle compte elle-même les jours (congés payés :
--      jours ouvrables, hors jours fériés). La réponse (décision, note,
--      auteur, date) appartient à l'administration : elle reste vide à la
--      demande. Un arrêt maladie ou un accident du travail se transmet à
--      l'administration avec l'avis d'arrêt (elle le saisit elle-même) ;
--   2. le dépôt d'un document du chauffeur (ou du candidat) : seulement ses
--      pièces (permis, carte VTC, pièce d'identité, justificatif de domicile,
--      attestation d'inscription au registre VTC, autre document), le fichier
--      rangé dans son propre dossier ; le commentaire de vérification reste
--      vide (il est écrit par l'administration).
-- Une écriture que les règles d'accès refusent de toute façon (autre compte,
-- statut imposé) n'est pas examinée ici : le refus reste celui des règles.
-- Les saisies de l'administration ne sont pas concernées (ses fonctions les
-- contrôlent déjà).
-- Les deux contrôles s'exécutent avant l'enregistrement de la ligne :
-- « controler_demande_absence » passe avant « jours_absence » (ordre
-- alphabétique des déclencheurs), qui compte alors les jours.
-- =============================================================================


-- #############################################################################
-- 1. DEMANDE D'ABSENCE DU SALARIÉ
-- #############################################################################
create or replace function prive.controler_demande_absence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s        public.salaries;
  v_autre  public.absences;
  v_mois   date;
begin
  if public.est_admin() then
    return new;
  end if;
  select * into s from public.salaries x where x.id = new.salarie_id and x.profil_id = auth.uid();
  if not found or new.statut is distinct from 'demandee' then
    return new;                                   -- refusée par les règles d'accès
  end if;

  -- Ce que décide l'administration, et les jours (comptés par la base)
  new.jours := null;
  new.decide_par := null;
  new.decide_le := null;
  new.decision_note := null;
  new.cree_le := now();
  new.commentaire := nullif(left(trim(coalesce(new.commentaire, '')), 500), '');

  if new.type is null or new.type not in ('conges_payes', 'sans_solde', 'autre') then
    raise exception 'Un arrêt maladie ou un accident du travail se transmet à LOC RÉACTION avec l''avis d''arrêt.';
  end if;
  if new.debut is null or new.fin is null or new.fin < new.debut then
    raise exception 'Indiquez le premier et le dernier jour (le dernier après le premier).';
  end if;
  if new.fin - new.debut > 366 then
    raise exception 'Une demande couvre au plus un an.';
  end if;
  if new.debut < s.date_entree or (s.date_sortie is not null and new.fin > s.date_sortie) then
    raise exception 'La période sort de votre contrat (entrée le %).', to_char(s.date_entree, 'DD/MM/YYYY')
      || coalesce(', sortie le ' || to_char(s.date_sortie, 'DD/MM/YYYY'), '');
  end if;
  select * into v_autre from public.absences x
   where x.salarie_id = s.id and x.statut <> 'refusee' and x.debut <= new.fin and x.fin >= new.debut
   order by x.debut limit 1;
  if v_autre.id is not null then
    raise exception 'Une absence est déjà enregistrée du % au % : choisissez d''autres jours.',
      to_char(v_autre.debut, 'DD/MM/YYYY'), to_char(v_autre.fin, 'DD/MM/YYYY');
  end if;
  v_mois := prive.mois_valide(s.id, new.debut, new.fin);
  if v_mois is not null then
    raise exception 'Le bulletin % est déjà validé : contactez LOC RÉACTION.', prive.de_mois(v_mois);
  end if;
  return new;
end;
$$;

create trigger controler_demande_absence
  before insert on public.absences
  for each row execute function prive.controler_demande_absence();


-- #############################################################################
-- 2. DÉPÔT D'UN DOCUMENT PAR LE CHAUFFEUR
-- #############################################################################
create or replace function prive.controler_depot_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.est_admin() then
    return new;
  end if;
  if new.chauffeur_id is distinct from auth.uid() or new.vehicule_id is not null
     or new.statut is distinct from 'en_attente' then
    return new;                                   -- refusée par les règles d'accès
  end if;
  if new.type not in ('permis', 'carte_vtc', 'registre_vtc', 'piece_identite', 'justificatif_domicile', 'autre') then
    raise exception 'Les pièces du véhicule sont déposées par LOC RÉACTION.';
  end if;
  if new.fichier_chemin is null or split_part(new.fichier_chemin, '/', 1) <> new.chauffeur_id::text
     or new.fichier_chemin like '%..%' or new.fichier_chemin !~ '^[0-9a-f-]{36}/[^/]+$' then
    raise exception 'Fichier invalide : déposez le document depuis votre espace.';
  end if;
  new.commentaire := null;
  new.numero := nullif(left(trim(coalesce(new.numero, '')), 60), '');
  new.cree_le := now();
  return new;
end;
$$;

create trigger controler_depot_document
  before insert on public.documents
  for each row execute function prive.controler_depot_document();


-- #############################################################################
-- 3. DROITS D'EXÉCUTION
-- #############################################################################
-- Fonctions de déclencheur : jamais appelées directement
revoke all on function prive.controler_demande_absence(), prive.controler_depot_document()
  from public, anon, authenticated;
