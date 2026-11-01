-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 17b : SUPPORT (2/3) — demandes et messagerie
-- -----------------------------------------------------------------------------
-- Les clients et les chauffeurs ouvrent une demande (public.ouvrir_demande,
-- migration 3), liée ou non à une course ; elle se poursuit en fil de
-- messages avec l'administration.
--   1. File des demandes : à traiter, attribuées à moi, non attribuées,
--      clôturées, toutes ; recherche (numéro, sujet, auteur, téléphone saisi
--      avec ou sans espaces, course) ; l'auteur qui attend une réponse passe
--      en tête, du plus ancien au plus récent.
--   2. Fil d'une demande : auteur, course (et la conversation entre le client
--      et le chauffeur, en lecture), messages (ceux de l'auteur passent
--      « lus »), objets trouvés de la course, autres demandes de l'auteur.
--   3. Réponse (pièce jointe facultative), statut, attribution à un
--      administrateur, demande enregistrée pour le compte d'un client ou d'un
--      chauffeur (appel téléphonique). L'auteur est prévenu dans l'application.
-- =============================================================================


-- #############################################################################
-- 1. FILE DES DEMANDES
-- #############################################################################
create or replace function public.admin_lister_demandes(
  p_vue      text    default 'a_traiter',   -- a_traiter, a_moi, non_attribuees, cloturees, toutes
  p_type     text    default null,          -- course, paiement, objet_perdu, compte, autre
  p_texte    text    default null,
  p_limite   integer default 50,
  p_decalage integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_moi      uuid := auth.uid();
  v_texte    text := nullif(trim(coalesce(p_texte, '')), '');
  v_motif    text;
  v_chiffres text;
  v_limite   integer := least(greatest(coalesce(p_limite, 50), 1), 200);
  v_decalage integer := greatest(coalesce(p_decalage, 0), 0);
  v_total    integer;
  v_lignes   jsonb;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_vue is null or p_vue not in ('a_traiter', 'a_moi', 'non_attribuees', 'cloturees', 'toutes') then
    raise exception 'Vue inconnue.';
  end if;
  if p_type is not null and p_type not in ('course', 'paiement', 'objet_perdu', 'compte', 'autre') then
    raise exception 'Type de demande inconnu.';
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

  with base as (
    select d.id, d.numero, d.sujet, d.type, d.statut, d.cree_le, d.cloturee_le, d.auteur_id, d.assignee_a, d.course_id,
           a.prenom, a.nom, a.role,
           c.numero as course_numero,
           m.dernier_le, m.nb, m.non_lus,
           coalesce(d.statut in ('ouverte', 'en_cours') and m.dernier_auteur = d.auteur_id, false) as attente
    from public.demandes d
    join public.profils a on a.id = d.auteur_id
    left join public.courses c on c.id = d.course_id
    cross join lateral (
      select max(ms.cree_le) as dernier_le,
             (array_agg(ms.auteur_id order by ms.cree_le desc, ms.id desc))[1] as dernier_auteur,
             count(*)::integer as nb,
             (count(*) filter (where ms.auteur_id = d.auteur_id and ms.lu_le is null))::integer as non_lus
      from public.messages ms where ms.demande_id = d.id
    ) m
    where (p_type is null or d.type = p_type)
      and (v_motif is null
           or concat_ws(' ', d.numero, d.sujet, a.prenom, a.nom, a.email, a.telephone, c.numero) ilike v_motif
           or (v_chiffres is not null and a.telephone like '%' || v_chiffres || '%'))
      and case p_vue
            when 'a_traiter' then d.statut in ('ouverte', 'en_cours')
            when 'a_moi' then d.statut in ('ouverte', 'en_cours') and d.assignee_a = v_moi
            when 'non_attribuees' then d.statut in ('ouverte', 'en_cours') and d.assignee_a is null
            when 'cloturees' then d.statut in ('resolue', 'fermee')
            else true end
  ),
  classees as (
    select b.*,
           row_number() over (order by
             -- Files ouvertes : l'auteur qui attend une réponse d'abord, du plus ancien au plus récent
             case when p_vue in ('a_traiter', 'a_moi', 'non_attribuees') and b.attente then 0 else 1 end,
             case when p_vue in ('a_traiter', 'a_moi', 'non_attribuees') then b.dernier_le end asc nulls last,
             case when p_vue = 'cloturees' then b.cloturee_le else b.cree_le end desc,
             b.numero desc) as rang
    from base b
  )
  select (select count(*) from base)::integer,
         coalesce((select jsonb_agg(jsonb_build_object(
             'id', k.id, 'numero', k.numero, 'sujet', k.sujet, 'type', k.type, 'statut', k.statut,
             'cree_le', k.cree_le, 'cloturee_le', k.cloturee_le,
             'auteur', jsonb_build_object('id', k.auteur_id, 'nom', coalesce(nullif(trim(k.prenom || ' ' || k.nom), ''), 'Sans nom'),
                                          'role', k.role),
             'course', case when k.course_id is null then null
                            else jsonb_build_object('id', k.course_id, 'numero', k.course_numero) end,
             'assignee', case when k.assignee_a is null then null
                              else jsonb_build_object('id', k.assignee_a,
                                     'nom', (select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Sans nom')
                                               from public.profils p where p.id = k.assignee_a)) end,
             'nb_messages', k.nb, 'non_lus', k.non_lus, 'dernier_le', k.dernier_le, 'attente', k.attente)
             order by k.rang)
           from classees k where k.rang > v_decalage and k.rang <= v_decalage + v_limite), '[]'::jsonb)
    into v_total, v_lignes;

  return jsonb_build_object(
    'vue', p_vue, 'total', v_total, 'lignes', v_lignes,
    'compteurs', (select jsonb_build_object(
        'a_traiter', count(*) filter (where d.statut in ('ouverte', 'en_cours')),
        'a_moi', count(*) filter (where d.statut in ('ouverte', 'en_cours') and d.assignee_a = v_moi),
        'non_attribuees', count(*) filter (where d.statut in ('ouverte', 'en_cours') and d.assignee_a is null),
        'cloturees', count(*) filter (where d.statut in ('resolue', 'fermee')),
        'toutes', count(*))
      from public.demandes d),
    'administrateurs', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id,
                                 'nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email)) order by p.prenom, p.nom), '[]'::jsonb)
                          from public.profils p where p.role = 'admin' and p.statut = 'actif'));
end;
$$;


-- #############################################################################
-- 2. FIL D'UNE DEMANDE
-- #############################################################################
-- « volatile » : les messages de l'auteur passent « lus » à l'ouverture.
create or replace function public.admin_fil_demande(p_demande uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.demandes;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into d from public.demandes x where x.id = p_demande;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  update public.messages set lu_le = now()
   where demande_id = d.id and auteur_id = d.auteur_id and lu_le is null;

  return jsonb_build_object(
    'demande', to_jsonb(d) || jsonb_build_object(
      'assignee_nom', (select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email) from public.profils p where p.id = d.assignee_a)),
    'auteur', (select jsonb_build_object('id', p.id, 'prenom', p.prenom, 'nom', p.nom, 'email', p.email, 'telephone', p.telephone,
                                         'role', p.role, 'statut', p.statut, 'cree_le', p.cree_le)
                 from public.profils p where p.id = d.auteur_id),
    'course', (select jsonb_build_object('id', c.id, 'numero', c.numero, 'statut', c.statut, 'type', c.type,
                                         'prise_en_charge_le', c.prise_en_charge_le, 'depart_adresse', c.depart_adresse,
                                         'arrivee_adresse', c.arrivee_adresse, 'prix_total', c.prix_total,
                                         'client_id', c.client_id,
                                         'client', (select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email) from public.profils p where p.id = c.client_id),
                                         'chauffeur_id', c.chauffeur_id,
                                         'chauffeur', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.chauffeur_id))
                 from public.courses c where c.id = d.course_id),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', m.id, 'auteur_id', m.auteur_id,
                            'auteur_nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email, 'Compte supprimé'),
                            'de_l_administration', m.auteur_id <> d.auteur_id,
                            'contenu', m.contenu, 'piece_jointe_chemin', m.piece_jointe_chemin, 'lu_le', m.lu_le, 'cree_le', m.cree_le)
                            order by m.cree_le, m.id)
                          from public.messages m left join public.profils p on p.id = m.auteur_id
                          where m.demande_id = d.id), '[]'::jsonb),
    -- Conversation entre le client et le chauffeur pendant la course (lecture)
    'conversation', coalesce((select jsonb_agg(jsonb_build_object(
                                'auteur_nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), 'Compte supprimé'),
                                'auteur_role', case when m.auteur_id = c.client_id then 'client'
                                                    when m.auteur_id = c.chauffeur_id then 'chauffeur' else 'administration' end,
                                'contenu', m.contenu, 'piece_jointe', m.piece_jointe_chemin is not null, 'cree_le', m.cree_le)
                                order by m.cree_le, m.id)
                              from public.messages m
                              join public.courses c on c.id = m.course_id
                              left join public.profils p on p.id = m.auteur_id
                              where d.course_id is not null and m.course_id = d.course_id), '[]'::jsonb),
    'objets', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'numero', o.numero, 'description', o.description,
                                                           'statut', o.statut, 'trouve_le', o.trouve_le,
                                                           'rattache', o.demande_id = d.id) order by o.trouve_le desc, o.numero)
                        from public.objets_trouves o
                        where o.demande_id = d.id or (d.course_id is not null and o.course_id = d.course_id)), '[]'::jsonb),
    'autres', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'numero', x.numero, 'sujet', x.sujet, 'statut', x.statut,
                                                           'cree_le', x.cree_le) order by x.cree_le desc)
                        from (select * from public.demandes y where y.auteur_id = d.auteur_id and y.id <> d.id
                              order by y.cree_le desc limit 10) x), '[]'::jsonb),
    'administrateurs', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id,
                                 'nom', coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email)) order by p.prenom, p.nom), '[]'::jsonb)
                          from public.profils p where p.role = 'admin' and p.statut = 'actif'));
end;
$$;


-- #############################################################################
-- 3. ACTIONS
-- #############################################################################

-- 3a. Répondre (texte et/ou pièce jointe déposée dans « support/{demande}/ ») ;
--     la demande passe « en cours », ou « résolue » si p_cloturer ; elle est
--     attribuée à qui répond si personne n'en est chargé. L'auteur est prévenu.
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
    || case when v_statut = 'resolue' then ' (demande résolue)' else '' end, null);
  return jsonb_build_object('message_id', v_id, 'statut', v_statut);
end;
$$;

-- 3b. Changer le statut : rouvrir (« ouverte », « en cours »), résoudre, ou
--     fermer sans suite (motif obligatoire, envoyé à l'auteur dans le fil)
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
      d.numero || ' · ' || d.sujet || coalesce(' : ' || left(v_motif, 600), ''), null);
  end if;
  return jsonb_build_object('statut', p_statut);
end;
$$;

-- 3c. Attribuer à un administrateur (ou retirer l'attribution) ; la personne
--     désignée est prévenue
create or replace function public.admin_attribuer_demande(p_demande uuid, p_admin uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d      public.demandes;
  v_nom  text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into d from public.demandes x where x.id = p_demande for update;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  if p_admin is not null then
    select coalesce(nullif(trim(p.prenom || ' ' || p.nom), ''), p.email) into v_nom
      from public.profils p where p.id = p_admin and p.role = 'admin' and p.statut = 'actif';
    if v_nom is null then
      raise exception 'Choisissez un administrateur actif.';
    end if;
  end if;
  if p_admin is not distinct from d.assignee_a then
    raise exception 'Rien à changer : la demande est déjà attribuée ainsi.';
  end if;
  update public.demandes set assignee_a = p_admin where id = d.id;
  if p_admin is not null and p_admin <> auth.uid() then
    perform prive.notifier(p_admin, 'alerte', 'Demande au support à traiter', d.numero || ' · ' || d.sujet,
                           '/admin/support/?demande=' || d.id);
  end if;
  return jsonb_build_object('assignee_a', p_admin, 'assignee_nom', v_nom);
end;
$$;

-- 3d. Enregistrer une demande pour le compte d'un client ou d'un chauffeur
--     (appel téléphonique, message reçu ailleurs) : elle est « en cours »,
--     attribuée à qui l'enregistre ; la première note est écrite par
--     l'administration ; l'auteur est prévenu. La course (facultative) se
--     donne par son numéro (C-2026-000014).
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
    'Nous avons enregistré votre demande ' || d.numero || ' : « ' || d.sujet || ' ». Nous revenons vers vous.', null);
  return jsonb_build_object('id', d.id, 'numero', d.numero);
end;
$$;


-- #############################################################################
-- 4. DROITS D'EXÉCUTION
-- #############################################################################
revoke all on function
  public.admin_lister_demandes(text, text, text, integer, integer),
  public.admin_fil_demande(uuid),
  public.admin_repondre_demande(uuid, text, boolean, text),
  public.admin_statut_demande(uuid, text, text),
  public.admin_attribuer_demande(uuid, uuid),
  public.admin_creer_demande(uuid, text, text, text, text)
  from public, anon;

grant execute on function
  public.admin_lister_demandes(text, text, text, integer, integer),
  public.admin_fil_demande(uuid),
  public.admin_repondre_demande(uuid, text, boolean, text),
  public.admin_statut_demande(uuid, text, text),
  public.admin_attribuer_demande(uuid, uuid),
  public.admin_creer_demande(uuid, text, text, text, text)
  to authenticated;
