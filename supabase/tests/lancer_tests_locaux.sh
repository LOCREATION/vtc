#!/usr/bin/env bash
# =============================================================================
# LOC RÉACTION S.A.S — Tests de la base v2 sur un Postgres local
# -----------------------------------------------------------------------------
# Recrée une base vide « loc_v2 », y installe l'imitation de Supabase
# (00_environnement_local.sql), applique toutes les migrations dans l'ordre,
# puis joue les scénarios de test (fichiers 1x_*.sql).
# Au moindre échec, le script s'arrête et affiche l'erreur.
# Usage : bash supabase/tests/lancer_tests_locaux.sh
# =============================================================================
set -euo pipefail

DOSSIER="$(cd "$(dirname "$0")/.." && pwd)"
BASE="loc_v2"
PSQL=(su postgres -c)

executer() {
  # $1 = fichier SQL ; arrêt au premier échec (ON_ERROR_STOP)
  local fichier="$1"
  echo "▶ $(basename "$fichier")"
  su postgres -c "psql -X -q -v ON_ERROR_STOP=1 -d $BASE -f '$fichier'"
}

# Base neuve
su postgres -c "psql -X -q -c 'drop database if exists $BASE'"
su postgres -c "psql -X -q -c 'create database $BASE'"

# Imitation de Supabase, puis migrations dans l'ordre des noms
executer "$DOSSIER/tests/00_environnement_local.sql"
for migration in "$DOSSIER"/migrations/*.sql; do
  executer "$migration"
done

# Scénarios de test
for test in "$DOSSIER"/tests/1*_*.sql; do
  [ -e "$test" ] || continue
  executer "$test"
done

echo "✔ Toutes les migrations et tous les tests sont passés."
