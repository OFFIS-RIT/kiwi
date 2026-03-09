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

is_blank_or_placeholder() {
  case "${1:-}" in
    ""|\<*\>)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

bootstrap_master_user() {
  master_user_id="${MASTER_USER_ID:-}"
  master_user_role="${MASTER_USER_ROLE:-admin}"
  master_user_name="${MASTER_USER_NAME:-Master User}"
  master_user_email="${MASTER_USER_EMAIL:-}"

  if is_blank_or_placeholder "${master_user_id}"; then
    echo "MASTER_USER_ID is not configured; skipping master user bootstrap."
    return 0
  fi

  if is_blank_or_placeholder "${master_user_role}"; then
    master_user_role="admin"
  fi

  if is_blank_or_placeholder "${master_user_name}"; then
    master_user_name="Master User"
  fi

  if is_blank_or_placeholder "${master_user_email}"; then
    master_user_email="${master_user_id}@local.invalid"
  fi

  echo "Bootstrapping master user ${master_user_id}..."
  psql "${DATABASE_URL}" \
    -v ON_ERROR_STOP=1 \
    -v master_user_id="${master_user_id}" \
    -v master_user_role="${master_user_role}" \
    -v master_user_name="${master_user_name}" \
    -v master_user_email="${master_user_email}" <<'SQL'
INSERT INTO users (id, name, email, "emailVerified", "role")
VALUES (:'master_user_id', :'master_user_name', :'master_user_email', TRUE, :'master_user_role')
ON CONFLICT (id) DO UPDATE
SET "role" = EXCLUDED."role",
    "updatedAt" = NOW();
SQL
}

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
bootstrap_master_user
echo "Migrations applied successfully."
