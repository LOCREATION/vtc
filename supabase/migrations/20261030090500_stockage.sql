-- =============================================================================
-- LOC RÉACTION S.A.S — Base de données de la version 2
-- Migration 6/8 : STOCKAGE DES FICHIERS
-- -----------------------------------------------------------------------------
-- Sept dossiers (« buckets »), chacun avec sa taille maximale, ses formats
-- acceptés et ses règles d'accès. Le premier niveau du chemin d'un fichier
-- désigne toujours son propriétaire, ce qui permet des règles simples :
--   documents       {profil}/…       pièces des chauffeurs et candidats (privé)
--                   vehicules/{id}/… pièces des véhicules (administration)
--   photos          {profil}/…       photo de profil (public : affichée au client)
--                   vehicules/{id}/… photos des véhicules (administration)
--   courses         {course}/…       feuille de route, pièces jointes de la messagerie
--   factures        {client}/…       factures archivées en PDF
--   paie            {salarié}/…      bulletins et contrats
--   support         {demande}/…      pièces jointes des demandes au support
--   administration  …                relevés des plateformes, comptabilité
-- Les dossiers privés ne se lisent qu'avec une session valide et selon ces
-- règles ; le dossier « photos » est lisible par lien direct.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Dossiers (tailles en octets : 5 Mo = 5 242 880 ; 10 Mo = 10 485 760)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('documents',      'documents',      false, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']),
  ('photos',         'photos',         true,   5242880,
     array['image/jpeg', 'image/png', 'image/webp']),
  ('courses',        'courses',        false, 10485760,
     array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  ('factures',       'factures',       false,  5242880,
     array['application/pdf']),
  ('paie',           'paie',           false, 10485760,
     array['application/pdf']),
  ('support',        'support',        false, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']),
  ('administration', 'administration', false, 20971520,
     array['application/pdf', 'text/csv', 'image/jpeg', 'image/png', 'image/webp',
           'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ---------------------------------------------------------------------------
-- 2. Règles d'accès (table storage.objects)
-- ---------------------------------------------------------------------------
-- Rappels : storage.foldername(name)[1] = premier dossier du chemin ;
-- « objects.name » = chemin complet du fichier.

-- DOCUMENTS : chacun dépose et lit ses pièces ; il ne peut supprimer une pièce
-- que tant qu'elle n'a pas été validée. L'administration a tous les droits.
create policy documents_lecture on storage.objects for select to authenticated
  using (bucket_id = 'documents'
         and ((select public.est_admin()) or (storage.foldername(name))[1] = (select auth.uid())::text));
create policy documents_depot on storage.objects for insert to authenticated
  with check (bucket_id = 'documents'
              and ((select public.est_admin()) or (storage.foldername(name))[1] = (select auth.uid())::text));
create policy documents_remplacement on storage.objects for update to authenticated
  using (bucket_id = 'documents' and (select public.est_admin()))
  with check (bucket_id = 'documents' and (select public.est_admin()));
create policy documents_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'documents'
         and ((select public.est_admin())
              or ((storage.foldername(name))[1] = (select auth.uid())::text
                  and not exists (select 1 from public.documents d
                                  where d.fichier_chemin = objects.name and d.statut = 'valide'))));

-- PHOTOS : chacun gère la sienne (remplacement compris) ; véhicules par
-- l'administration. Lecture publique par lien direct.
create policy photos_lecture on storage.objects for select to authenticated
  using (bucket_id = 'photos'
         and ((select public.est_admin()) or (storage.foldername(name))[1] = (select auth.uid())::text));
create policy photos_depot on storage.objects for insert to authenticated
  with check (bucket_id = 'photos'
              and ((select public.est_admin()) or (storage.foldername(name))[1] = (select auth.uid())::text));
create policy photos_remplacement on storage.objects for update to authenticated
  using (bucket_id = 'photos'
         and ((select public.est_admin()) or (storage.foldername(name))[1] = (select auth.uid())::text))
  with check (bucket_id = 'photos'
              and ((select public.est_admin()) or (storage.foldername(name))[1] = (select auth.uid())::text));
create policy photos_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'photos'
         and ((select public.est_admin()) or (storage.foldername(name))[1] = (select auth.uid())::text));

-- COURSES : lisibles et alimentés par ceux qui voient la course en entier
-- (client, chauffeur attribué, gestionnaire du compte pro, administration).
-- Le « case » évite toute erreur si le premier dossier n'est pas un identifiant.
create policy courses_lecture on storage.objects for select to authenticated
  using (bucket_id = 'courses'
         and case when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then public.peut_voir_course(((storage.foldername(name))[1])::uuid)
                  else false end);
create policy courses_depot on storage.objects for insert to authenticated
  with check (bucket_id = 'courses'
              and case when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       then public.peut_voir_course(((storage.foldername(name))[1])::uuid)
                       else false end);
create policy courses_admin_remplacement on storage.objects for update to authenticated
  using (bucket_id = 'courses' and (select public.est_admin()))
  with check (bucket_id = 'courses' and (select public.est_admin()));
create policy courses_admin_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'courses' and (select public.est_admin()));

-- FACTURES : lisibles par qui peut voir la facture correspondante (client,
-- gestionnaire du compte pro, administration) ; écrites par l'administration.
create policy factures_lecture on storage.objects for select to authenticated
  using (bucket_id = 'factures'
         and ((select public.est_admin())
              or exists (select 1 from public.factures f where f.pdf_chemin = objects.name)));
create policy factures_admin_depot on storage.objects for insert to authenticated
  with check (bucket_id = 'factures' and (select public.est_admin()));
create policy factures_admin_remplacement on storage.objects for update to authenticated
  using (bucket_id = 'factures' and (select public.est_admin()))
  with check (bucket_id = 'factures' and (select public.est_admin()));
create policy factures_admin_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'factures' and (select public.est_admin()));

-- PAIE : le salarié lit ses propres documents ; l'administration gère.
create policy paie_lecture on storage.objects for select to authenticated
  using (bucket_id = 'paie'
         and ((select public.est_admin())
              or exists (select 1 from public.salaries s
                         where s.id::text = (storage.foldername(name))[1] and s.profil_id = (select auth.uid()))));
create policy paie_admin_depot on storage.objects for insert to authenticated
  with check (bucket_id = 'paie' and (select public.est_admin()));
create policy paie_admin_remplacement on storage.objects for update to authenticated
  using (bucket_id = 'paie' and (select public.est_admin()))
  with check (bucket_id = 'paie' and (select public.est_admin()));
create policy paie_admin_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'paie' and (select public.est_admin()));

-- SUPPORT : l'auteur de la demande et l'administration ; dépôt tant que la
-- demande est ouverte.
create policy support_lecture on storage.objects for select to authenticated
  using (bucket_id = 'support'
         and ((select public.est_admin())
              or exists (select 1 from public.demandes d
                         where d.id::text = (storage.foldername(name))[1] and d.auteur_id = (select auth.uid()))));
create policy support_depot on storage.objects for insert to authenticated
  with check (bucket_id = 'support'
              and ((select public.est_admin())
                   or exists (select 1 from public.demandes d
                              where d.id::text = (storage.foldername(name))[1] and d.auteur_id = (select auth.uid())
                                and d.statut in ('ouverte', 'en_cours'))));
create policy support_admin_remplacement on storage.objects for update to authenticated
  using (bucket_id = 'support' and (select public.est_admin()))
  with check (bucket_id = 'support' and (select public.est_admin()));
create policy support_admin_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'support' and (select public.est_admin()));

-- ADMINISTRATION : réservé à l'administration.
create policy administration_admin on storage.objects for all to authenticated
  using (bucket_id = 'administration' and (select public.est_admin()))
  with check (bucket_id = 'administration' and (select public.est_admin()));
