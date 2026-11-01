-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 17c : SUPPORT (3/3) — objets trouvés, messages du site
-- -----------------------------------------------------------------------------
--   1. Objets trouvés : registre (OT-2026-000001), en cours ou clos ; saisie
--      rattachée à une course (par son numéro) et à la demande de l'auteur ;
--      le client de la course est prévenu dans l'application (et dans le fil
--      de sa demande) ; restitution ou clôture motivée. Les demandes « objet
--      perdu » encore sans objet rattaché sont listées à côté.
--   2. Messages du site : formulaire de contact (traité ou non, par qui,
--      quand, note interne) et demandes de devis (nouvelle, devis envoyé avec
--      son montant, acceptée, refusée).
-- Aucune instruction de suppression : une erreur de saisie ou un message
-- indésirable se supprime depuis la page (règles d'accès de l'administration).
-- =============================================================================


-- #############################################################################
-- 1. OBJETS TROUVÉS
-- #############################################################################

-- 1a. Registre : en cours (« trouve », « signale »), clos (« rendu »,
--     « detruit »), tous ; recherche (numéro, description, lieu, course, client)
create or replace function public.admin_lister_objets(p_vue text default 'en_cours', p_texte text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_texte text := nullif(trim(coalesce(p_texte, '')), '');
  v_motif text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_vue is null or p_vue not in ('en_cours', 'clos', 'tous') then
    raise exception 'Vue inconnue.';
  end if;
  if v_texte is not null then
    v_motif := '%' || replace(replace(replace(v_texte, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return jsonb_build_object(
    'vue', p_vue,
    'lignes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'numero', o.numero, 'description', o.description, 'lieu_stockage', o.lieu_stockage, 'statut', o.statut,
        'trouve_le', o.trouve_le, 'client_prevenu_le', o.client_prevenu_le, 'restitution', o.restitution,
        'cree_le', o.cree_le, 'maj_le', o.maj_le,
        'declare_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = o.declare_par),
        'course', case when c.id is null then null else jsonb_build_object(
          'id', c.id, 'numero', c.numero, 'date_course', coalesce(c.demarree_le, c.prise_en_charge_le),
          'client_id', c.client_id, 'client', nullif(trim(cl.prenom || ' ' || cl.nom), ''), 'client_telephone', cl.telephone,
          'client_email', cl.email,
          'chauffeur', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = c.chauffeur_id)) end,
        'demande', (select jsonb_build_object('id', x.id, 'numero', x.numero, 'statut', x.statut) from public.demandes x where x.id = o.demande_id))
        order by case when o.statut in ('trouve', 'signale') then 0 else 1 end, o.trouve_le desc, o.numero desc), '[]'::jsonb)
      from public.objets_trouves o
      left join public.courses c on c.id = o.course_id
      left join public.profils cl on cl.id = c.client_id
      where case p_vue when 'en_cours' then o.statut in ('trouve', 'signale')
                       when 'clos' then o.statut in ('rendu', 'detruit') else true end
        and (v_motif is null
             or concat_ws(' ', o.numero, o.description, o.lieu_stockage, o.restitution, c.numero, cl.prenom, cl.nom, cl.email, cl.telephone) ilike v_motif)),
    'compteurs', (select jsonb_build_object(
        'en_cours', count(*) filter (where o.statut in ('trouve', 'signale')),
        'a_prevenir', count(*) filter (where o.statut = 'trouve'),
        'clos', count(*) filter (where o.statut in ('rendu', 'detruit')),
        'tous', count(*))
      from public.objets_trouves o),
    -- Demandes « objet perdu » encore ouvertes, sans objet rattaché
    'demandes_objet_perdu', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'numero', d.numero, 'sujet', d.sujet, 'cree_le', d.cree_le,
        'auteur', coalesce(nullif(trim(a.prenom || ' ' || a.nom), ''), a.email),
        'course', case when c.id is null then null else jsonb_build_object('id', c.id, 'numero', c.numero) end)
        order by d.cree_le), '[]'::jsonb)
      from public.demandes d
      join public.profils a on a.id = d.auteur_id
      left join public.courses c on c.id = d.course_id
      where d.type = 'objet_perdu' and d.statut in ('ouverte', 'en_cours')
        and not exists (select 1 from public.objets_trouves o where o.demande_id = d.id)));
end;
$$;

-- 1b. Enregistrer ou corriger un objet trouvé ; la course se donne par son
--     numéro (C-2026-000014), facultatif ; la demande de l'auteur aussi
create or replace function public.admin_enregistrer_objet(
  p_objet uuid, p_course text, p_description text, p_lieu_stockage text,
  p_trouve_le date default null, p_demande uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o              public.objets_trouves;
  c              public.courses;
  d              public.demandes;
  v_numero       text := upper(nullif(regexp_replace(coalesce(p_course, ''), '\s', '', 'g'), ''));
  v_description  text := nullif(trim(coalesce(p_description, '')), '');
  v_lieu         text := nullif(trim(coalesce(p_lieu_stockage, '')), '');
  v_aujourdhui   date := prive.heure_paris()::date;
  v_trouve       date := coalesce(p_trouve_le, prive.heure_paris()::date);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_objet is not null then
    select * into o from public.objets_trouves x where x.id = p_objet for update;
    if not found then
      raise exception 'Objet introuvable.';
    end if;
  end if;
  if v_description is null or char_length(v_description) < 3 or char_length(v_description) > 1000 then
    raise exception 'Décrivez l''objet (de 3 à 1 000 caractères) : nature, couleur, marque, signe distinctif.';
  end if;
  if char_length(v_lieu) > 200 then
    raise exception 'Lieu de conservation : 200 caractères au plus.';
  end if;
  if v_trouve > v_aujourdhui then
    raise exception 'La date de découverte est dans le futur.';
  end if;
  if v_numero is not null then
    select * into c from public.courses x where x.numero = v_numero;
    if not found then
      raise exception 'Course % introuvable : vérifiez le numéro (ex. C-2026-000014).', v_numero;
    end if;
    -- Jour réel du trajet (montée à bord), sinon l'heure de prise en charge prévue
    if v_trouve < (coalesce(c.demarree_le, c.prise_en_charge_le) at time zone 'Europe/Paris')::date then
      raise exception 'L''objet ne peut pas avoir été trouvé avant la course (%).',
        to_char(coalesce(c.demarree_le, c.prise_en_charge_le) at time zone 'Europe/Paris', 'DD/MM/YYYY');
    end if;
  end if;
  if p_demande is not null then
    select * into d from public.demandes x where x.id = p_demande;
    if not found then
      raise exception 'Demande introuvable.';
    end if;
    if d.course_id is not null and c.id is not null and d.course_id <> c.id then
      raise exception 'La demande % concerne une autre course.', d.numero;
    end if;
    if exists (select 1 from public.objets_trouves x where x.demande_id = d.id and x.id is distinct from p_objet) then
      raise exception 'Un autre objet est déjà rattaché à la demande %.', d.numero;
    end if;
  end if;

  if p_objet is null then
    insert into public.objets_trouves (numero, course_id, description, lieu_stockage, statut, declare_par, trouve_le, demande_id)
    values (prive.prochain_numero('objet', 'OT'), c.id, v_description, v_lieu, 'trouve', auth.uid(), v_trouve, d.id)
    returning * into o;
  else
    update public.objets_trouves set course_id = c.id, description = v_description, lieu_stockage = v_lieu,
      trouve_le = v_trouve, demande_id = d.id
    where id = o.id
    returning * into o;
  end if;
  return to_jsonb(o);
end;
$$;

-- 1c. Statut : « signale » (le client de la course est prévenu, et dans le
--     fil de sa demande si elle est rattachée), « rendu » ou « detruit »
--     (restitution obligatoire : comment, ou pourquoi pas), « trouve »
--     (correction)
create or replace function public.admin_statut_objet(p_objet uuid, p_statut text, p_restitution text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o              public.objets_trouves;
  c              public.courses;
  d              public.demandes;
  v_restitution  text := nullif(trim(coalesce(p_restitution, '')), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into o from public.objets_trouves x where x.id = p_objet for update;
  if not found then
    raise exception 'Objet introuvable.';
  end if;
  if p_statut is null or p_statut not in ('trouve', 'signale', 'rendu', 'detruit') then
    raise exception 'Statut inconnu.';
  end if;
  if p_statut = o.statut then
    raise exception 'L''objet a déjà ce statut.';
  end if;
  select * into c from public.courses x where x.id = o.course_id;
  select * into d from public.demandes x where x.id = o.demande_id;

  if p_statut = 'signale' then
    if c.client_id is null and d.id is null then
      raise exception 'Aucun client à prévenir : rattachez la course ou la demande, ou passez l''objet directement « rendu ».';
    end if;
    perform prive.notifier(coalesce(d.auteur_id, c.client_id), 'info', 'Objet trouvé',
      'Un objet a été trouvé' || coalesce(' après votre course ' || c.numero || ' du '
        || to_char(coalesce(c.demarree_le, c.prise_en_charge_le) at time zone 'Europe/Paris', 'DD/MM/YYYY'), '')
      || ' : ' || o.description || '. Pour le récupérer, contactez-nous en rappelant la référence ' || o.numero || '.', null);
    if d.id is not null and d.statut in ('ouverte', 'en_cours') then
      insert into public.messages (demande_id, auteur_id, contenu)
      values (d.id, auth.uid(), 'Votre objet a été retrouvé (référence ' || o.numero || ') : ' || o.description
                                || '. Nous convenons avec vous de sa restitution.');
      update public.demandes set statut = 'en_cours', assignee_a = coalesce(assignee_a, auth.uid()) where id = d.id;
    end if;
    update public.objets_trouves set statut = 'signale', client_prevenu_le = now(), restitution = null where id = o.id
    returning * into o;
  elsif p_statut in ('rendu', 'detruit') then
    if v_restitution is null or char_length(v_restitution) < 3 or char_length(v_restitution) > 500 then
      raise exception '%', case when p_statut = 'rendu'
        then 'Indiquez comment l''objet a été rendu (en main propre, par envoi, à qui, quand).'
        else 'Indiquez pourquoi l''objet n''est pas rendu (remis au service des objets trouvés de la mairie, détruit…) et quand.' end;
    end if;
    update public.objets_trouves set statut = p_statut, restitution = v_restitution where id = o.id
    returning * into o;
  else
    update public.objets_trouves set statut = 'trouve', restitution = null where id = o.id
    returning * into o;
  end if;
  return to_jsonb(o);
end;
$$;


-- #############################################################################
-- 2. MESSAGES DU SITE : FORMULAIRE DE CONTACT ET DEMANDES DE DEVIS
-- #############################################################################

-- 2a. Lecture : à traiter (messages non traités, devis nouveaux), en attente
--     (devis envoyés), traités (messages traités, devis acceptés ou refusés),
--     tous ; recherche (nom, e-mail, téléphone, sujet, texte)
create or replace function public.admin_lister_messages_site(p_vue text default 'a_traiter', p_texte text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_texte    text := nullif(trim(coalesce(p_texte, '')), '');
  v_motif    text;
  v_chiffres text;
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  if p_vue is null or p_vue not in ('a_traiter', 'en_attente', 'traites', 'tous') then
    raise exception 'Vue inconnue.';
  end if;
  if v_texte is not null then
    v_motif := '%' || replace(replace(replace(v_texte, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_chiffres := regexp_replace(v_texte, '[^0-9]', '', 'g');
    if char_length(v_chiffres) < 6 then
      v_chiffres := null;
    end if;
  end if;

  return jsonb_build_object(
    'vue', p_vue,
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'nom', m.nom, 'email', m.email, 'telephone', m.telephone, 'sujet', m.sujet, 'message', m.message,
        'traite', m.traite, 'traite_le', m.traite_le, 'note', m.note, 'cree_le', m.cree_le,
        'traite_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = m.traite_par))
        order by m.cree_le desc), '[]'::jsonb)
      from public.messages_contact m
      where case p_vue when 'a_traiter' then not m.traite when 'en_attente' then false when 'traites' then m.traite else true end
        and (v_motif is null or concat_ws(' ', m.nom, m.email, m.telephone, m.sujet, m.message, m.note) ilike v_motif
             or (v_chiffres is not null and regexp_replace(coalesce(m.telephone, ''), '[^0-9]', '', 'g') like '%' || v_chiffres || '%'))),
    'devis', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'service', v.service, 'nom', v.nom, 'email', v.email, 'telephone', v.telephone, 'adresse', v.adresse,
        'date_souhaitee', v.date_souhaitee, 'description', v.description, 'statut', v.statut, 'montant', v.montant,
        'note', v.note, 'devis_envoye_le', v.devis_envoye_le, 'cree_le', v.cree_le, 'maj_le', v.maj_le,
        'traite_par_nom', (select nullif(trim(p.prenom || ' ' || p.nom), '') from public.profils p where p.id = v.traite_par))
        order by v.cree_le desc), '[]'::jsonb)
      from public.demandes_devis v
      where case p_vue when 'a_traiter' then v.statut = 'nouvelle' when 'en_attente' then v.statut = 'devis_envoye'
                       when 'traites' then v.statut in ('acceptee', 'refusee') else true end
        and (v_motif is null or concat_ws(' ', v.nom, v.email, v.telephone, v.adresse, v.description, v.note) ilike v_motif
             or (v_chiffres is not null and regexp_replace(coalesce(v.telephone, ''), '[^0-9]', '', 'g') like '%' || v_chiffres || '%'))),
    'compteurs', jsonb_build_object(
      'contacts_a_traiter', (select count(*) from public.messages_contact m where not m.traite),
      'devis_nouveaux', (select count(*) from public.demandes_devis v where v.statut = 'nouvelle'),
      'devis_envoyes', (select count(*) from public.demandes_devis v where v.statut = 'devis_envoye')));
end;
$$;

-- 2b. Message du formulaire de contact : traité (ou à reprendre), note interne
create or replace function public.admin_traiter_contact(p_message uuid, p_traite boolean, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m       public.messages_contact;
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into m from public.messages_contact x where x.id = p_message for update;
  if not found then
    raise exception 'Message introuvable.';
  end if;
  if p_traite is null then
    raise exception 'Indiquez si le message est traité.';
  end if;
  if char_length(v_note) > 1000 then
    raise exception 'Note trop longue : 1 000 caractères au plus.';
  end if;
  update public.messages_contact set traite = p_traite, note = case when p_note is null then note else v_note end,
    traite_par = case when p_traite then auth.uid() end, traite_le = case when p_traite then now() end
  where id = m.id
  returning * into m;
  return to_jsonb(m);
end;
$$;

-- 2c. Demande de devis : devis envoyé (montant TTC), accepté, refusé, ou
--     revenu à « nouvelle » (correction) ; note interne
create or replace function public.admin_suivre_devis(p_devis uuid, p_statut text, p_montant numeric default null, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v        public.demandes_devis;
  v_note   text := nullif(trim(coalesce(p_note, '')), '');
  v_montant numeric := round(p_montant, 2);
begin
  if not public.est_admin() then
    raise exception 'Réservé à l''administration.';
  end if;
  select * into v from public.demandes_devis x where x.id = p_devis for update;
  if not found then
    raise exception 'Demande de devis introuvable.';
  end if;
  if p_statut is null or p_statut not in ('nouvelle', 'devis_envoye', 'acceptee', 'refusee') then
    raise exception 'Statut inconnu.';
  end if;
  if char_length(v_note) > 2000 then
    raise exception 'Note trop longue : 2 000 caractères au plus.';
  end if;
  if p_statut <> 'nouvelle' then
    v_montant := coalesce(v_montant, v.montant);
    if v_montant is null or v_montant <= 0 or v_montant > 1000000 then
      raise exception 'Indiquez le montant du devis (TTC).';
    end if;
  end if;
  if p_statut in ('acceptee', 'refusee') and v.statut = 'nouvelle' and p_montant is null then
    raise exception 'Indiquez d''abord le devis envoyé et son montant.';
  end if;
  update public.demandes_devis set
    statut = p_statut,
    montant = case when p_statut = 'nouvelle' then null else v_montant end,
    note = case when p_note is null then note else v_note end,
    traite_par = auth.uid(),
    devis_envoye_le = case when p_statut = 'nouvelle' then null
                           when p_statut = 'devis_envoye' and v.statut <> 'devis_envoye' then now()
                           else coalesce(devis_envoye_le, now()) end
  where id = v.id
  returning * into v;
  return to_jsonb(v);
end;
$$;


-- #############################################################################
-- 3. DROITS D'EXÉCUTION
-- #############################################################################
revoke all on function
  public.admin_lister_objets(text, text),
  public.admin_enregistrer_objet(uuid, text, text, text, date, uuid),
  public.admin_statut_objet(uuid, text, text),
  public.admin_lister_messages_site(text, text),
  public.admin_traiter_contact(uuid, boolean, text),
  public.admin_suivre_devis(uuid, text, numeric, text)
  from public, anon;

grant execute on function
  public.admin_lister_objets(text, text),
  public.admin_enregistrer_objet(uuid, text, text, text, date, uuid),
  public.admin_statut_objet(uuid, text, text),
  public.admin_lister_messages_site(text, text),
  public.admin_traiter_contact(uuid, boolean, text),
  public.admin_suivre_devis(uuid, text, numeric, text)
  to authenticated;
