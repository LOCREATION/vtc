-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 25 : PARRAINAGE DANS L'ESPACE CLIENT
-- -----------------------------------------------------------------------------
-- Le client partage son code depuis son espace (onglet Compte) ; la personne
-- invitée s'inscrit avec le lien (« /connexion/?parrain=CODE », code repris
-- à la création du compte, prive.creer_profil) ou saisit le code plus tard :
--   1. appliquer_code_parrain : un client inscrit sans le lien saisit le code
--      de son parrain, tant qu'il n'a ni parrain ni course terminée ;
--      contrôles lisibles (format, code inconnu, son propre code, parrainage
--      croisé) ;
--   2. parrainage validé (première course terminée du filleul, récompenses
--      versées sur les soldes) : le parrain et le filleul sont prévenus du
--      montant crédité, avec le lien de leur solde.
-- Lectures de l'espace client, sans fonction nouvelle (règles d'accès déjà
-- en place) : son code (profils), ses parrainages, son solde et ses
-- écritures, les montants des récompenses (parametres).
-- =============================================================================


-- #############################################################################
-- 1. SAISIR LE CODE DE SON PARRAIN APRÈS L'INSCRIPTION
-- #############################################################################
create or replace function public.appliquer_code_parrain(p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_code     text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_parrain  public.profils;
  v_id       uuid;
begin
  if public.mon_role() is distinct from 'client' then
    raise exception 'Le parrainage est réservé aux comptes clients.';
  end if;
  -- Codes de la version 2 : 8 lettres et chiffres ; tolérance pour d'autres
  -- longueurs (codes repris d'une ancienne base), seul le code connu compte
  if v_code !~ '^[A-Z0-9]{4,20}$' then
    raise exception 'Code de parrainage invalide : des lettres et des chiffres seulement (ex. K7M2Q9XA).';
  end if;
  if exists (select 1 from public.parrainages pa where pa.filleul_id = auth.uid()) then
    raise exception 'Vous avez déjà un parrain.';
  end if;
  if exists (select 1 from public.courses c where c.client_id = auth.uid() and c.statut = 'terminee') then
    raise exception 'Le code de parrainage se saisit avant votre première course terminée.';
  end if;
  select * into v_parrain from public.profils p where p.code_parrainage = v_code;
  if not found then
    raise exception 'Code de parrainage introuvable : vérifiez-le auprès de la personne qui vous l''a donné.';
  end if;
  if v_parrain.id = auth.uid() then
    raise exception 'C''est votre propre code : partagez-le pour parrainer vos proches.';
  end if;
  if exists (select 1 from public.parrainages pa where pa.parrain_id = auth.uid() and pa.filleul_id = v_parrain.id) then
    raise exception 'Cette personne est déjà votre filleul : elle ne peut pas être aussi votre parrain.';
  end if;

  insert into public.parrainages (parrain_id, filleul_id) values (v_parrain.id, auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'statut', 'en_attente',
    'recompense_filleul', (select pr.recompense_filleul from public.parametres pr where pr.id = 1));
end;
$$;

comment on function public.appliquer_code_parrain(text) is
  'Le client connecté saisit le code de son parrain (une seule fois, avant sa première course terminée). '
  'Les récompenses sont versées à la première course terminée du filleul.';

revoke all on function public.appliquer_code_parrain(text) from public, anon;
grant execute on function public.appliquer_code_parrain(text) to authenticated;


-- #############################################################################
-- 2. PARRAINAGE VALIDÉ : LE PARRAIN ET LE FILLEUL SONT PRÉVENUS
-- #############################################################################
-- Lien vers le solde de l'espace client ; aucun lien pour un autre rôle
-- (l'espace chauffeur n'a pas de solde).
create or replace function prive.notifier_parrainage_valide()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_lien_parrain  text;
  v_lien_filleul  text;
begin
  if new.statut <> 'valide' or old.statut = 'valide' then
    return new;
  end if;
  select case when p.role = 'client' then '/client/compte/#compte-solde' end into v_lien_parrain
    from public.profils p where p.id = new.parrain_id;
  select case when p.role = 'client' then '/client/compte/#compte-solde' end into v_lien_filleul
    from public.profils p where p.id = new.filleul_id;

  if new.recompense_parrain > 0 then
    perform prive.notifier(new.parrain_id, 'paiement', 'Parrainage validé',
      'Votre filleul a terminé sa première course : ' || prive.euros(new.recompense_parrain)
      || ' crédités sur votre solde. Merci de faire connaître LOC RÉACTION.', v_lien_parrain);
  end if;
  if new.recompense_filleul > 0 then
    perform prive.notifier(new.filleul_id, 'paiement', 'Bienvenue chez LOC RÉACTION',
      'Votre première course est terminée : ' || prive.euros(new.recompense_filleul)
      || ' crédités sur votre solde grâce à votre parrain.', v_lien_filleul);
  end if;
  return new;
end;
$$;

revoke all on function prive.notifier_parrainage_valide() from public, anon, authenticated;

create trigger notifier_parrainage_valide
  after update of statut on public.parrainages
  for each row execute function prive.notifier_parrainage_valide();
