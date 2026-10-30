-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 4/8 : SÉCURITÉ — droits et règles d'accès ligne par ligne
-- -----------------------------------------------------------------------------
-- Trois niveaux de protection, du plus large au plus fin :
--   1. DROITS : par défaut, plus personne n'a accès à rien ; chaque table reçoit
--      ensuite exactement les droits utiles (lecture, écriture de colonnes
--      précises). Les visiteurs sans compte (« anon ») ne voient que le
--      catalogue public et peuvent seulement envoyer le contact et les devis.
--   2. RÈGLES LIGNE PAR LIGNE (RLS) : chacun ne voit que ses propres lignes,
--      l'administration voit tout.
--   3. FONCTIONS SERVEUR : l'argent, les statuts et les rôles ne bougent que
--      par elles (migration 3) ; elles vérifient elles-mêmes l'appelant.
-- Rôles Supabase : anon = visiteur sans compte, authenticated = connecté
-- (client, chauffeur ou admin selon public.profils.role).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. On part de zéro
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Fonctions appelables
-- ---------------------------------------------------------------------------
-- Utilisées par les règles d'accès : nécessaires à tous.
grant execute on function public.mon_role(), public.est_admin(), public.est_chauffeur_actif(),
                          public.peut_voir_course(uuid)
  to anon, authenticated;

-- Catalogue public : estimation du prix et voitures autour de soi.
grant execute on function
  public.estimer_course(text, numeric, numeric, numeric, numeric, jsonb, timestamptz, text, numeric, boolean, text),
  public.vehicules_a_proximite(numeric, numeric)
  to anon, authenticated;

-- Réservé aux utilisateurs connectés (chaque fonction vérifie ensuite le rôle).
grant execute on function
  public.verifier_code_promo(text, numeric),
  public.commander_course(text, text, numeric, numeric, text, numeric, numeric, jsonb, text, timestamptz, numeric,
                          text, text, text, boolean, text, text, boolean, text, text, uuid, numeric),
  public.relancer_dispatch(),
  public.accepter_proposition(uuid),
  public.refuser_proposition(uuid),
  public.demande_recue(uuid),
  public.reservations_disponibles(),
  public.prendre_course_planifiee(uuid),
  public.attribuer_course(uuid, uuid),
  public.avancer_course(uuid, text),
  public.annuler_course(uuid, text),
  public.noter_course(uuid, integer, text),
  public.ajouter_pourboire(uuid, numeric),
  public.confirmer_encaissement(uuid),
  public.rembourser(uuid, numeric, text),
  public.ajuster_solde(uuid, numeric, text),
  public.mettre_en_ligne(boolean, numeric, numeric),
  public.revenus_chauffeur(date, date),
  public.deposer_candidature(text, text, boolean, text, text, date, text, date),
  public.valider_candidature(uuid, uuid, boolean),
  public.refuser_candidature(uuid, text),
  public.verifier_document(uuid, text, text),
  public.affecter_vehicule(uuid, uuid),
  public.admin_definir_role(uuid, text),
  public.admin_definir_statut(uuid, text),
  public.journal_lister(text, text, integer, timestamptz),
  public.ouvrir_demande(text, text, text, uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Module COMPTES
-- ---------------------------------------------------------------------------
-- Profils : on lit le sien ; on ne modifie que ses coordonnées et préférences.
-- Rôle et statut : uniquement par admin_definir_role / admin_definir_statut.
grant select on public.profils to authenticated;
grant update (prenom, nom, telephone, langue, photo_chemin, notif_email, notif_whatsapp, notif_push)
  on public.profils to authenticated;
create policy profils_lecture on public.profils for select to authenticated
  using (id = (select auth.uid()) or (select public.est_admin()));
create policy profils_modification on public.profils for update to authenticated
  using (id = (select auth.uid()) or (select public.est_admin()))
  with check (id = (select auth.uid()) or (select public.est_admin()));

-- Proches, lieux, appareils : chacun gère les siens.
grant select, insert, update, delete on public.proches, public.lieux, public.appareils to authenticated;
create policy proches_les_miens on public.proches for all to authenticated
  using (client_id = (select auth.uid()) or (select public.est_admin()))
  with check (client_id = (select auth.uid()));
create policy lieux_les_miens on public.lieux for all to authenticated
  using (client_id = (select auth.uid()) or (select public.est_admin()))
  with check (client_id = (select auth.uid()));
create policy appareils_les_miens on public.appareils for all to authenticated
  using (profil_id = (select auth.uid()))
  with check (profil_id = (select auth.uid()));

-- Notifications : lecture, marquage « lu » et suppression des siennes.
grant select, delete on public.notifications to authenticated;
grant update (lu_le) on public.notifications to authenticated;
create policy notifications_les_miennes on public.notifications for all to authenticated
  using (destinataire_id = (select auth.uid()))
  with check (destinataire_id = (select auth.uid()));

-- Comptes professionnels : visibles des membres, gérés par l'administration.
grant select, insert, update, delete on public.comptes_pro, public.comptes_pro_membres to authenticated;
create policy comptes_pro_lecture on public.comptes_pro for select to authenticated
  using ((select public.est_admin()) or exists (
    select 1 from public.comptes_pro_membres m where m.compte_pro_id = comptes_pro.id and m.profil_id = (select auth.uid())));
create policy comptes_pro_admin on public.comptes_pro for insert to authenticated
  with check ((select public.est_admin()));
create policy comptes_pro_admin_maj on public.comptes_pro for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy comptes_pro_admin_suppr on public.comptes_pro for delete to authenticated
  using ((select public.est_admin()));
create policy membres_lecture on public.comptes_pro_membres for select to authenticated
  using (profil_id = (select auth.uid()) or (select public.est_admin()));
create policy membres_admin on public.comptes_pro_membres for insert to authenticated
  with check ((select public.est_admin()));
create policy membres_admin_maj on public.comptes_pro_membres for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy membres_admin_suppr on public.comptes_pro_membres for delete to authenticated
  using ((select public.est_admin()));


-- ---------------------------------------------------------------------------
-- 4. Module OFFRE : catalogue lisible par tous, modifiable par l'administration
-- ---------------------------------------------------------------------------
grant select on public.categories, public.tarifs, public.majorations, public.jours_feries,
                public.zones, public.forfaits
  to anon, authenticated;
grant insert, update, delete on public.categories, public.tarifs, public.majorations, public.jours_feries,
                                public.zones, public.forfaits
  to authenticated;

do $$
declare t text;
begin
  foreach t in array array['categories', 'tarifs', 'majorations', 'jours_feries', 'zones', 'forfaits'] loop
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_lecture', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.est_admin()))', t || '_admin_ajout', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.est_admin())) with check ((select public.est_admin()))', t || '_admin_maj', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.est_admin()))', t || '_admin_suppr', t);
  end loop;
end $$;

-- Codes promo : jamais listés publiquement (vérification par fonction serveur).
grant select, insert, update, delete on public.codes_promo to authenticated;
create policy codes_promo_admin on public.codes_promo for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));

grant select on public.utilisations_promo, public.parrainages to authenticated;
create policy utilisations_promo_les_miennes on public.utilisations_promo for select to authenticated
  using (client_id = (select auth.uid()) or (select public.est_admin()));
create policy parrainages_les_miens on public.parrainages for select to authenticated
  using (parrain_id = (select auth.uid()) or filleul_id = (select auth.uid()) or (select public.est_admin()));


-- ---------------------------------------------------------------------------
-- 5. Module FLOTTE
-- ---------------------------------------------------------------------------
-- Véhicules : l'administration gère ; le chauffeur voit le véhicule qui lui est confié.
grant select, insert, update, delete on public.vehicules to authenticated;
create policy vehicules_lecture on public.vehicules for select to authenticated
  using ((select public.est_admin())
         or exists (select 1 from public.chauffeurs c where c.id = (select auth.uid()) and c.vehicule_id = vehicules.id));
create policy vehicules_admin_ajout on public.vehicules for insert to authenticated with check ((select public.est_admin()));
create policy vehicules_admin_maj on public.vehicules for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy vehicules_admin_suppr on public.vehicules for delete to authenticated using ((select public.est_admin()));

grant select, insert, update, delete on public.entretiens to authenticated;
create policy entretiens_admin on public.entretiens for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));

-- Fiche chauffeur : le chauffeur lit la sienne et règle son filtre de
-- destination ; le statut, les notes et le véhicule sont protégés par un
-- déclencheur (migration 5) et ne changent que par l'administration.
grant select, update on public.chauffeurs to authenticated;
create policy chauffeurs_lecture on public.chauffeurs for select to authenticated
  using (id = (select auth.uid()) or (select public.est_admin()));
create policy chauffeurs_modification on public.chauffeurs for update to authenticated
  using (id = (select auth.uid()) or (select public.est_admin()))
  with check (id = (select auth.uid()) or (select public.est_admin()));

-- Documents : le chauffeur (ou candidat) dépose les siens, « en attente » ;
-- seule l'administration les valide (fonction verifier_document).
grant select, insert, delete on public.documents to authenticated;
grant update (commentaire) on public.documents to authenticated;
create policy documents_lecture on public.documents for select to authenticated
  using (chauffeur_id = (select auth.uid()) or (select public.est_admin()));
create policy documents_depot on public.documents for insert to authenticated
  with check (
    (chauffeur_id = (select auth.uid()) and vehicule_id is null and statut = 'en_attente'
     and verifie_par is null and verifie_le is null)
    or (select public.est_admin()));
create policy documents_suppression on public.documents for delete to authenticated
  using ((chauffeur_id = (select auth.uid()) and statut = 'en_attente') or (select public.est_admin()));
create policy documents_admin_maj on public.documents for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));

-- Candidatures : déposées par la fonction deposer_candidature.
grant select on public.candidatures to authenticated;
grant update (statut, motif_refus) on public.candidatures to authenticated;
create policy candidatures_lecture on public.candidatures for select to authenticated
  using (profil_id = (select auth.uid()) or (select public.est_admin()));
create policy candidatures_admin_maj on public.candidatures for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));


-- ---------------------------------------------------------------------------
-- 6. Module COURSES
-- ---------------------------------------------------------------------------
-- Les courses ne se créent et n'avancent que par les fonctions serveur.
-- Lecture complète : le client, le chauffeur attribué, le gestionnaire du
-- compte pro, l'administration. Un chauffeur sollicité ou qui parcourt les
-- réservations libres passe par demande_recue / reservations_disponibles
-- (résumé sans les coordonnées du client). Correction directe : administration.
grant select, update on public.courses to authenticated;
create policy courses_lecture on public.courses for select to authenticated
  using (
    client_id = (select auth.uid())
    or chauffeur_id = (select auth.uid())
    or (select public.est_admin())
    or (compte_pro_id is not null and exists (
          select 1 from public.comptes_pro_membres m
          where m.compte_pro_id = courses.compte_pro_id and m.profil_id = (select auth.uid()) and m.role = 'gestionnaire'))
  );
create policy courses_admin_maj on public.courses for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));

grant select on public.course_arrets, public.evenements_course to authenticated;
create policy course_arrets_lecture on public.course_arrets for select to authenticated
  using (public.peut_voir_course(course_id));
create policy evenements_course_lecture on public.evenements_course for select to authenticated
  using (public.peut_voir_course(course_id));

-- Demandes envoyées aux chauffeurs : chacun voit les siennes.
grant select on public.propositions to authenticated;
create policy propositions_les_miennes on public.propositions for select to authenticated
  using (chauffeur_id = (select auth.uid()) or (select public.est_admin()));

-- Positions en direct : le chauffeur met à jour la sienne (mais pas « en ligne »,
-- qui passe par mettre_en_ligne ; l'heure de mise à jour est posée par un
-- déclencheur) ; le client voit son chauffeur pendant la course.
grant select on public.positions to authenticated;
grant update (latitude, longitude, cap, vitesse_kmh) on public.positions to authenticated;
create policy positions_lecture on public.positions for select to authenticated
  using (
    chauffeur_id = (select auth.uid())
    or (select public.est_admin())
    or exists (select 1 from public.courses c
               where c.chauffeur_id = positions.chauffeur_id and c.client_id = (select auth.uid())
                 and c.statut in ('acceptee', 'arrivee', 'en_cours'))
  );
create policy positions_la_mienne on public.positions for update to authenticated
  using (chauffeur_id = (select auth.uid()))
  with check (chauffeur_id = (select auth.uid()));

-- Notes : l'auteur voit la sienne ; le chauffeur voit les notes reçues des
-- clients ; la note donnée à un client n'est visible que de l'administration.
grant select on public.evaluations to authenticated;
create policy evaluations_lecture on public.evaluations for select to authenticated
  using (
    auteur_id = (select auth.uid())
    or (cible_id = (select auth.uid()) and sens = 'client_vers_chauffeur')
    or (select public.est_admin())
  );


-- ---------------------------------------------------------------------------
-- 7. Module PAIEMENTS (lecture seule : tout passe par les fonctions serveur)
-- ---------------------------------------------------------------------------
grant select on public.paiements, public.remboursements, public.factures,
                public.soldes, public.ecritures_solde
  to authenticated;
create policy paiements_lecture on public.paiements for select to authenticated
  using (
    client_id = (select auth.uid())
    or (select public.est_admin())
    or exists (select 1 from public.courses c where c.id = paiements.course_id and c.chauffeur_id = (select auth.uid()))
  );
create policy remboursements_lecture on public.remboursements for select to authenticated
  using ((select public.est_admin())
         or exists (select 1 from public.paiements p where p.id = remboursements.paiement_id and p.client_id = (select auth.uid())));
create policy factures_lecture on public.factures for select to authenticated
  using (
    client_id = (select auth.uid())
    or (select public.est_admin())
    or (compte_pro_id is not null and exists (
          select 1 from public.comptes_pro_membres m
          where m.compte_pro_id = factures.compte_pro_id and m.profil_id = (select auth.uid()) and m.role = 'gestionnaire'))
  );
grant update (pdf_chemin) on public.factures to authenticated;
create policy factures_admin_pdf on public.factures for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy soldes_le_mien on public.soldes for select to authenticated
  using (profil_id = (select auth.uid()) or (select public.est_admin()));
create policy ecritures_les_miennes on public.ecritures_solde for select to authenticated
  using (profil_id = (select auth.uid()) or (select public.est_admin()));


-- ---------------------------------------------------------------------------
-- 8. Module RH ET PAIE : le salarié lit ses propres documents, l'administration gère
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.salaries, public.contrats, public.constantes_paie,
                                        public.parametres_paie, public.bulletins, public.bulletin_lignes,
                                        public.temps_travail
  to authenticated;
create policy salaries_lecture on public.salaries for select to authenticated
  using (profil_id = (select auth.uid()) or (select public.est_admin()));
create policy salaries_admin_ajout on public.salaries for insert to authenticated with check ((select public.est_admin()));
create policy salaries_admin_maj on public.salaries for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy salaries_admin_suppr on public.salaries for delete to authenticated using ((select public.est_admin()));

create policy contrats_lecture on public.contrats for select to authenticated
  using ((select public.est_admin())
         or (statut <> 'brouillon' and exists (select 1 from public.salaries s where s.id = contrats.salarie_id and s.profil_id = (select auth.uid()))));
create policy contrats_admin_ajout on public.contrats for insert to authenticated with check ((select public.est_admin()));
create policy contrats_admin_maj on public.contrats for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy contrats_admin_suppr on public.contrats for delete to authenticated using ((select public.est_admin()));

create policy constantes_paie_admin on public.constantes_paie for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy parametres_paie_admin on public.parametres_paie for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));

-- Bulletins : le salarié ne voit que les bulletins validés.
create policy bulletins_lecture on public.bulletins for select to authenticated
  using ((select public.est_admin())
         or (statut <> 'brouillon' and exists (select 1 from public.salaries s where s.id = bulletins.salarie_id and s.profil_id = (select auth.uid()))));
create policy bulletins_admin_ajout on public.bulletins for insert to authenticated with check ((select public.est_admin()));
create policy bulletins_admin_maj on public.bulletins for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy bulletins_admin_suppr on public.bulletins for delete to authenticated using ((select public.est_admin()));

create policy bulletin_lignes_lecture on public.bulletin_lignes for select to authenticated
  using ((select public.est_admin())
         or exists (select 1 from public.bulletins b join public.salaries s on s.id = b.salarie_id
                    where b.id = bulletin_lignes.bulletin_id and b.statut <> 'brouillon' and s.profil_id = (select auth.uid())));
create policy bulletin_lignes_admin_ajout on public.bulletin_lignes for insert to authenticated with check ((select public.est_admin()));
create policy bulletin_lignes_admin_maj on public.bulletin_lignes for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy bulletin_lignes_admin_suppr on public.bulletin_lignes for delete to authenticated using ((select public.est_admin()));

create policy temps_travail_lecture on public.temps_travail for select to authenticated
  using ((select public.est_admin())
         or exists (select 1 from public.salaries s where s.id = temps_travail.salarie_id and s.profil_id = (select auth.uid())));
create policy temps_travail_admin_ajout on public.temps_travail for insert to authenticated with check ((select public.est_admin()));
create policy temps_travail_admin_maj on public.temps_travail for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy temps_travail_admin_suppr on public.temps_travail for delete to authenticated using ((select public.est_admin()));

-- Absences : le salarié demande ses congés ; l'administration valide.
grant select, insert, delete on public.absences to authenticated;
grant update on public.absences to authenticated;
create policy absences_lecture on public.absences for select to authenticated
  using ((select public.est_admin())
         or exists (select 1 from public.salaries s where s.id = absences.salarie_id and s.profil_id = (select auth.uid())));
create policy absences_demande on public.absences for insert to authenticated
  with check ((select public.est_admin())
              or (statut = 'demandee' and exists (select 1 from public.salaries s where s.id = absences.salarie_id and s.profil_id = (select auth.uid()))));
create policy absences_retrait on public.absences for delete to authenticated
  using ((select public.est_admin())
         or (statut = 'demandee' and exists (select 1 from public.salaries s where s.id = absences.salarie_id and s.profil_id = (select auth.uid()))));
create policy absences_admin_maj on public.absences for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));


-- ---------------------------------------------------------------------------
-- 9. Module SUPPORT
-- ---------------------------------------------------------------------------
grant select on public.demandes to authenticated;
grant update (statut, assignee_a) on public.demandes to authenticated;
create policy demandes_lecture on public.demandes for select to authenticated
  using (auteur_id = (select auth.uid()) or (select public.est_admin()));
create policy demandes_admin_maj on public.demandes for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));

-- Messages : conversation entre le client et le chauffeur de la course, ou fil
-- d'une demande entre son auteur et l'administration.
grant select, insert on public.messages to authenticated;
grant update (lu_le) on public.messages to authenticated;
create policy messages_lecture on public.messages for select to authenticated
  using (
    (select public.est_admin())
    or (course_id is not null and exists (
          select 1 from public.courses c where c.id = messages.course_id
          and (c.client_id = (select auth.uid()) or c.chauffeur_id = (select auth.uid()))))
    or (demande_id is not null and exists (
          select 1 from public.demandes d where d.id = messages.demande_id and d.auteur_id = (select auth.uid())))
  );
create policy messages_envoi on public.messages for insert to authenticated
  with check (
    auteur_id = (select auth.uid()) and lu_le is null and (
      (select public.est_admin())
      or (course_id is not null and exists (
            select 1 from public.courses c where c.id = messages.course_id
            and (c.client_id = (select auth.uid()) or c.chauffeur_id = (select auth.uid()))))
      or (demande_id is not null and exists (
            select 1 from public.demandes d where d.id = messages.demande_id and d.auteur_id = (select auth.uid())
            and d.statut in ('ouverte', 'en_cours')))
    )
  );
-- Marquer « lu » un message reçu (pas les siens)
create policy messages_lu on public.messages for update to authenticated
  using (auteur_id <> (select auth.uid()) and (
    (select public.est_admin())
    or (course_id is not null and exists (
          select 1 from public.courses c where c.id = messages.course_id
          and (c.client_id = (select auth.uid()) or c.chauffeur_id = (select auth.uid()))))
    or (demande_id is not null and exists (
          select 1 from public.demandes d where d.id = messages.demande_id and d.auteur_id = (select auth.uid())))
  ));

grant select, insert, update, delete on public.objets_trouves to authenticated;
create policy objets_trouves_lecture on public.objets_trouves for select to authenticated
  using ((select public.est_admin())
         or exists (select 1 from public.courses c where c.id = objets_trouves.course_id and c.client_id = (select auth.uid())));
create policy objets_trouves_admin_ajout on public.objets_trouves for insert to authenticated with check ((select public.est_admin()));
create policy objets_trouves_admin_maj on public.objets_trouves for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy objets_trouves_admin_suppr on public.objets_trouves for delete to authenticated using ((select public.est_admin()));

-- Contact et devis : tout le monde peut envoyer, seule l'administration lit.
grant insert on public.messages_contact, public.demandes_devis to anon, authenticated;
grant select, update, delete on public.messages_contact, public.demandes_devis to authenticated;
create policy contact_envoi on public.messages_contact for insert to anon, authenticated
  with check (traite = false);
create policy contact_admin on public.messages_contact for select to authenticated using ((select public.est_admin()));
create policy contact_admin_maj on public.messages_contact for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy contact_admin_suppr on public.messages_contact for delete to authenticated using ((select public.est_admin()));
create policy devis_envoi on public.demandes_devis for insert to anon, authenticated
  with check (statut = 'nouvelle' and montant is null);
create policy devis_admin on public.demandes_devis for select to authenticated using ((select public.est_admin()));
create policy devis_admin_maj on public.demandes_devis for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy devis_admin_suppr on public.demandes_devis for delete to authenticated using ((select public.est_admin()));


-- ---------------------------------------------------------------------------
-- 10. Module ADMINISTRATION
-- ---------------------------------------------------------------------------
-- Identité de la société et paramètres : lisibles par tous (mentions légales,
-- délais affichés), modifiables par l'administration.
grant select on public.societe, public.parametres to anon, authenticated;
grant update on public.societe, public.parametres to authenticated;
create policy societe_lecture on public.societe for select to anon, authenticated using (true);
create policy societe_admin on public.societe for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy parametres_lecture on public.parametres for select to anon, authenticated using (true);
create policy parametres_admin on public.parametres for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));

-- Questions fréquentes : publiées pour tous, gérées par l'administration.
grant select on public.faq to anon, authenticated;
grant insert, update, delete on public.faq to authenticated;
create policy faq_lecture on public.faq for select to anon, authenticated
  using (publie or (select public.est_admin()));
create policy faq_admin_ajout on public.faq for insert to authenticated with check ((select public.est_admin()));
create policy faq_admin_maj on public.faq for update to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy faq_admin_suppr on public.faq for delete to authenticated using ((select public.est_admin()));

grant select, insert, update, delete on public.releves_plateformes, public.campagnes to authenticated;
create policy releves_admin on public.releves_plateformes for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
create policy campagnes_admin on public.campagnes for all to authenticated
  using ((select public.est_admin())) with check ((select public.est_admin()));
