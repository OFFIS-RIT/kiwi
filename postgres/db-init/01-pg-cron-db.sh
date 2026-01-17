#!/usr/bin/env sh
set -eu

if [ -n "${POSTGRES_DB:-}" ]; then
  pgdata_dir="${PGDATA:-/var/lib/postgresql/data}"
  echo "cron.database_name = '${POSTGRES_DB}'" >> "${pgdata_dir}/postgresql.conf"
  echo "shared_preload_libraries = 'pg_cron'" >> "${pgdata_dir}/postgresql.conf"
fi
