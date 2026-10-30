-- =============================================================================
-- LOC RÉACTION S.A.S — Tests de la base v2
-- Outils de test (schéma « test », jamais créé en ligne)
-- -----------------------------------------------------------------------------
--   call test.connexion(id[, aal]) : agit comme l'utilisateur connecté « id »
--                                  (rôle authenticated + jeton, comme l'API ;
--                                  aal2 = double authentification confirmée)
--   call test.visiteur()         : agit comme un visiteur sans compte (anon)
--   call test.systeme()          : agit comme la base elle-même (planification,
--                                  migrations) : aucun utilisateur connecté
--   select test.verifier(cond, l)       : échoue si la condition n'est pas vraie
--   select test.doit_echouer(sql, motif) : exécute « sql » avec les droits de
--                                  l'utilisateur courant et exige une erreur
--                                  contenant « motif »
-- (verifier et doit_echouer sont des fonctions et non des procédures : un
--  appel de procédure n'accepte pas de sous-requête en argument.)
-- =============================================================================
\set ON_ERROR_STOP on

create schema test;
grant usage on schema test to anon, authenticated;

create procedure test.systeme()
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', false);
  execute 'reset role';
end;
$$;

-- p_aal : niveau d'authentification du jeton, comme Supabase l'écrit.
--   « aal1 » = connexion par code e-mail ou mot de passe (cas général) ;
--   « aal2 » = confirmée par l'application d'authentification (exigé pour
--   les droits d'administration depuis la migration 10).
create procedure test.connexion(p_id uuid, p_aal text default 'aal1')
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id, 'role', 'authenticated', 'aal', p_aal)::text, false);
  execute 'set role authenticated';
end;
$$;

create procedure test.visiteur()
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, false);
  execute 'set role anon';
end;
$$;

create function test.verifier(p_condition boolean, p_libelle text)
returns void
language plpgsql
as $$
begin
  if p_condition is not true then
    raise exception 'ÉCHEC : %', p_libelle;
  end if;
  raise notice 'ok · %', p_libelle;
end;
$$;

create function test.doit_echouer(p_sql text, p_motif text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_motif) in lower(sqlerrm)) = 0 then
      raise exception 'ÉCHEC : refusé pour une autre raison que « % » : %', p_motif, sqlerrm;
    end if;
    raise notice 'ok · refusé comme prévu (%)', p_motif;
    return;
  end;
  raise exception 'ÉCHEC : aurait dû être refusé (« % ») : %', p_motif, p_sql;
end;
$$;

grant execute on procedure test.connexion(uuid, text), test.visiteur(), test.systeme() to anon, authenticated;
grant execute on function test.verifier(boolean, text), test.doit_echouer(text, text) to anon, authenticated;
