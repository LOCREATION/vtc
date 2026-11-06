-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 23 : MES DEMANDES AU SUPPORT (espace chauffeur)
-- -----------------------------------------------------------------------------
-- Le chauffeur suit ses demandes au support depuis l'application (onglet
-- Compte, fiche d'une course, notifications) :
--   1. prive.lien_demande : lien d'une demande pour son auteur, ouvert par
--      les notifications du support (« /chauffeur/demandes/?id=… ») ; pour un
--      client, le lien viendra avec son espace ;
--   2. mes_demandes() : ses demandes, la plus récemment active d'abord, avec
--      la course concernée et le nombre de réponses non lues ;
--   3. ouvrir_demande : contrôles lisibles (type, sujet de 3 à 200
--      caractères, message de 2 000 caractères au plus) ; la notification de
--      l'administration ouvre directement la demande ;
--   4. réponse, statut (résolue, fermée), demande enregistrée par LOC
--      RÉACTION : la notification de l'auteur porte le lien de la demande ;
--   5. un message de l'auteur sur sa demande prévient LOC RÉACTION
--      (l'administrateur à qui elle est attribuée, sinon toute
--      l'administration) ;
--   6. une pièce jointe de message reste dans le dossier de sa demande
--      (« <id de la demande>/… ») ; un message de course n'en a pas.
-- =============================================================================


-- #############################################################################
-- 1. LIEN D'UNE DEMANDE POUR SON AUTEUR
-- #############################################################################
create or replace function prive.lien_demande(p_demande uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case when p.role = 'chauffeur' then '/chauffeur/demandes/?id=' || d.id::text end
  from public.demandes d join public.profils p on p.id = d.auteur_id
  where d.id = p_demande;
$$;

revoke all on function prive.lien_demande(uuid) from public, anon, authenticated;


-- #############################################################################
-- 2. MES DEMANDES
-- #############################################################################
-- Règles d'accès de la personne connectée (sécurité de l'appelant) : ses
-- demandes, leurs messages, ses courses.
create or replace function public.mes_demandes()
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.activite desc), '[]'::jsonb)
  from (
    select d.id, d.numero, d.type, d.sujet, d.statut, d.cree_le, d.course_id,
           c.numero as course_numero,
           coalesce((select max(m.cree_le) from public.messages m where m.demande_id = d.id), d.cree_le) as activite,
           (select count(*) from public.messages m
             where m.demande_id = d.id and m.auteur_id <> (select auth.uid()) and m.lu_le is null)::int as non_lus
    from public.demandes d
    left join public.courses c on c.id = d.course_id
    where d.auteur_id = (select auth.uid())
  ) x;
$$;

comment on function public.mes_demandes() is
  'Demandes au support de la personne connectée, la plus récemment active d''abord : '
  'numéro, type, sujet, statut, course concernée, dernière activité, réponses non lues.';

revoke all on function public.mes_demandes() from public, anon;
grant execute on function public.mes_demandes() to authenticated;


-- #############################################################################
-- 3. OUVRIR UNE DEMANDE : CONTRÔLES LISIBLES, LIEN DIRECT POUR L'ADMINISTRATION
-- #############################################################################
create or replace function public.ouvrir_demande(
  p_type text, p_sujet text, p_message text, p_course uuid default null
)
returns public.demandes
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_demande public.demandes;
begin
  if public.mon_role() is null then
    raise exception 'Connectez-vous pour contacter le support.';
  end if;
  if p_course is not null and not exists (
       select 1 from public.courses c where c.id = p_course
       and (c.client_id = auth.uid() or c.chauffeur_id = auth.uid())) then
    raise exception 'Course introuvable.';
  end if;
  if nullif(trim(coalesce(p_message, '')), '') is null then
    raise exception 'Décrivez votre demande.';
  end if;
  if p_type is null or p_type not in ('course', 'paiement', 'objet_perdu', 'compte', 'autre') then
    raise exception 'Type de demande inconnu.';
  end if;
  if char_length(trim(coalesce(p_sujet, ''))) not between 3 and 200 then
    raise exception 'Sujet : de 3 à 200 caractères.';
  end if;
  if char_length(trim(p_message)) > 2000 then
    raise exception 'Message trop long : 2 000 caractères au plus.';
  end if;

  insert into public.demandes (numero, auteur_id, course_id, type, sujet)
  values (prive.prochain_numero('demande', 'S'), auth.uid(), p_course, p_type, left(trim(p_sujet), 200))
  returning * into v_demande;
  insert into public.messages (demande_id, auteur_id, contenu)
  values (v_demande.id, auth.uid(), left(trim(p_message), 2000));

  perform prive.notifier_admins('alerte', 'Nouvelle demande au support', v_demande.numero || ' · ' || v_demande.sujet,
    '/admin/support/?demande=' || v_demande.id);
  return v_demande;
end;
$$;


-- #############################################################################
-- 4. NOTIFICATIONS DE L'AUTEUR : LIEN DE LA DEMANDE
-- #############################################################################
-- 4a. Réponse de LOC RÉACTION
create or replace function public.admin_repondre_demande(
  p_demande uuid, p_message text, p_cloturer boolean default false, p_piece_jointe text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d          public.demandes;
  v_message  text := nullif(trim(coalesce(p_message, '')), '');
  v_piece    text := nullif(trim(coalesce(p_piece_jointe, '')), '');
  v_id       uuid;
  v_statut   text := case when coalesce(p_cloturer, false) then 'resolue' else 'en_cours' end;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into d from public.demandes x where x.id = p_demande for update;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  if v_message is null and v_piece is null then
    raise exception 'Écrivez la réponse (ou joignez un fichier).';
  end if;
  if char_length(v_message) > 2000 then
    raise exception 'Réponse trop longue : 2 000 caractères au plus.';
  end if;
  if v_piece is not null and (v_piece not like d.id::text || '/%' or v_piece like '%..%') then
    raise exception 'Chemin de la pièce jointe invalide.';
  end if;

  insert into public.messages (demande_id, auteur_id, contenu, piece_jointe_chemin)
  values (d.id, auth.uid(), v_message, v_piece)
  returning id into v_id;
  update public.demandes set statut = v_statut, assignee_a = coalesce(assignee_a, auth.uid()) where id = d.id;

  perform prive.notifier(d.auteur_id, 'info', 'Réponse du support',
    d.numero || ' · ' || d.sujet || ' : ' || coalesce(left(v_message, 600), 'pièce jointe')
    || case when v_statut = 'resolue' then ' (demande résolue)' else '' end, prive.lien_demande(d.id));
  return jsonb_build_object('message_id', v_id, 'statut', v_statut);
end;
$$;

-- 4b. Statut changé (résolue, fermée sans suite)
create or replace function public.admin_statut_demande(p_demande uuid, p_statut text, p_motif text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d        public.demandes;
  v_motif  text := nullif(trim(coalesce(p_motif, '')), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into d from public.demandes x where x.id = p_demande for update;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  if p_statut is null or p_statut not in ('ouverte', 'en_cours', 'resolue', 'fermee') then
    raise exception 'Statut inconnu.';
  end if;
  if p_statut = d.statut then
    raise exception 'La demande a déjà ce statut.';
  end if;
  if p_statut = 'fermee' and v_motif is null then
    raise exception 'Indiquez pourquoi la demande est fermée sans suite : le motif est envoyé à son auteur.';
  end if;
  if char_length(v_motif) > 2000 then
    raise exception 'Motif trop long : 2 000 caractères au plus.';
  end if;

  if v_motif is not null then
    insert into public.messages (demande_id, auteur_id, contenu) values (d.id, auth.uid(), v_motif);
  end if;
  update public.demandes set statut = p_statut where id = d.id;

  if p_statut in ('resolue', 'fermee') then
    perform prive.notifier(d.auteur_id, 'info',
      case when p_statut = 'resolue' then 'Demande résolue' else 'Demande fermée' end,
      d.numero || ' · ' || d.sujet || coalesce(' : ' || left(v_motif, 600), ''), prive.lien_demande(d.id));
  end if;
  return jsonb_build_object('statut', p_statut);
end;
$$;

-- 4c. Demande enregistrée par LOC RÉACTION pour le compte d'un client ou d'un
--     chauffeur
create or replace function public.admin_creer_demande(
  p_auteur uuid, p_type text, p_sujet text, p_message text, p_course text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a          public.profils;
  c          public.courses;
  v_numero   text := upper(nullif(regexp_replace(coalesce(p_course, ''), '\s', '', 'g'), ''));
  v_sujet    text := nullif(trim(coalesce(p_sujet, '')), '');
  v_message  text := nullif(trim(coalesce(p_message, '')), '');
  d          public.demandes;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into a from public.profils p where p.id = p_auteur;
  if not found or a.role not in ('client', 'chauffeur') then
    raise exception 'Choisissez le client ou le chauffeur concerné.';
  end if;
  if p_type is null or p_type not in ('course', 'paiement', 'objet_perdu', 'compte', 'autre') then
    raise exception 'Type de demande inconnu.';
  end if;
  if v_sujet is null or char_length(v_sujet) < 3 or char_length(v_sujet) > 200 then
    raise exception 'Sujet : de 3 à 200 caractères.';
  end if;
  if v_message is null or char_length(v_message) > 2000 then
    raise exception 'Décrivez la demande (2 000 caractères au plus).';
  end if;
  if v_numero is not null then
    select * into c from public.courses x where x.numero = v_numero;
    if not found then
      raise exception 'Course % introuvable : vérifiez le numéro (ex. C-2026-000014).', v_numero;
    end if;
    if c.client_id is distinct from a.id and c.chauffeur_id is distinct from a.id then
      raise exception 'La course % n''est pas une course de %.', c.numero, coalesce(nullif(trim(a.prenom || ' ' || a.nom), ''), a.email);
    end if;
  end if;

  insert into public.demandes (numero, auteur_id, course_id, type, sujet, statut, assignee_a)
  values (prive.prochain_numero('demande', 'S'), a.id, c.id, p_type, v_sujet, 'en_cours', auth.uid())
  returning * into d;
  insert into public.messages (demande_id, auteur_id, contenu) values (d.id, auth.uid(), v_message);

  perform prive.notifier(a.id, 'info', 'Demande enregistrée',
    'Nous avons enregistré votre demande ' || d.numero || ' : « ' || d.sujet || ' ». Nous revenons vers vous.', prive.lien_demande(d.id));
  return jsonb_build_object('id', d.id, 'numero', d.numero);
end;
$$;


-- #############################################################################
-- 5. MESSAGE DE L'AUTEUR : LOC RÉACTION PRÉVENUE
-- #############################################################################
create or replace function prive.notifier_message_demande()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  d          public.demandes;
  v_extrait  text;
  v_texte    text;
begin
  if new.demande_id is null then
    return new;
  end if;
  select * into d from public.demandes x where x.id = new.demande_id;
  -- Réponse de l'administration : notifiée par admin_repondre_demande
  if not found or new.auteur_id is distinct from d.auteur_id then
    return new;
  end if;
  -- Premier message : la demande vient d'être ouverte (ouvrir_demande prévient)
  if not exists (select 1 from public.messages m where m.demande_id = d.id and m.id <> new.id) then
    return new;
  end if;
  v_extrait := coalesce(nullif(left(regexp_replace(btrim(coalesce(new.contenu, '')), '\s+', ' ', 'g'), 300), ''), 'Pièce jointe');
  v_texte := d.numero || ' · ' || d.sujet || ' : ' || v_extrait;
  if d.assignee_a is not null then
    perform prive.notifier(d.assignee_a, 'alerte', 'Nouveau message sur une demande', v_texte, '/admin/support/?demande=' || d.id);
  else
    perform prive.notifier_admins('alerte', 'Nouveau message sur une demande', v_texte, '/admin/support/?demande=' || d.id);
  end if;
  return new;
end;
$$;

revoke all on function prive.notifier_message_demande() from public, anon, authenticated;

create trigger notifier_message_demande
  after insert on public.messages
  for each row execute function prive.notifier_message_demande();


-- #############################################################################
-- 6. PIÈCE JOINTE : DANS LE DOSSIER DE SA DEMANDE
-- #############################################################################
create or replace function prive.controler_piece_jointe_message()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.piece_jointe_chemin is not null and (
       new.demande_id is null
       or new.piece_jointe_chemin not like new.demande_id::text || '/%'
       or new.piece_jointe_chemin like '%..%') then
    raise exception 'Pièce jointe refusée : elle doit être déposée avec la demande.';
  end if;
  return new;
end;
$$;

revoke all on function prive.controler_piece_jointe_message() from public, anon, authenticated;

create trigger controler_piece_jointe_message
  before insert or update of piece_jointe_chemin on public.messages
  for each row execute function prive.controler_piece_jointe_message();
