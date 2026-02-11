#!/usr/bin/env sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required"
  exit 1
fi

export AI_EMBED_DIM="${AI_EMBED_DIM:-4096}"

processed_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${processed_dir}"
}
trap cleanup EXIT INT TERM

for file in /app/migrations/*.sql; do
  [ -f "${file}" ] || continue
  envsubst '$AI_EMBED_DIM' < "${file}" > "${processed_dir}/$(basename "${file}")"
done

echo "Waiting for database to be reachable..."
until pg_isready -d "${DATABASE_URL}" >/dev/null 2>&1; do
  sleep 2
done

echo "Applying migrations..."
migrate -path "${processed_dir}" -database "${DATABASE_URL}" up
echo "Migrations applied successfully."
