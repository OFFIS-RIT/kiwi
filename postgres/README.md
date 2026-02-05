# Postgres

KIWI ships a custom Postgres image (see `postgres/Dockerfile`) that extends the
official `postgres` image and includes extensions used by KIWI:

- PostGIS
- pgRouting
- pg_cron
- pgvector
- vectorscale

## Data Directory / Volume Mount

The upstream `postgres` Docker image changed its data directory layout in
PostgreSQL 18 and above:

- `PGDATA` is now version specific (for 18: `/var/lib/postgresql/18/docker`)
- the image declares `VOLUME /var/lib/postgresql`

Because of this, `compose.yml` mounts the database volume at:

```text
/var/lib/postgresql
```

Important notes:

- PostgreSQL 17 and below use `PGDATA=/var/lib/postgresql/data` and declare
  `VOLUME /var/lib/postgresql/data`. If you mount at `/var/lib/postgresql` on 17
  without setting `PGDATA`, data can end up in an anonymous volume and will not
  persist across container re-creates.
- Users who want the new layout on PostgreSQL 17 can opt in by setting
  `PGDATA=/var/lib/postgresql/17/docker` and mounting the volume at
  `/var/lib/postgresql`.

## Upgrade: PostgreSQL 17 -> 18 (Existing Production Data)

If you are upgrading an existing production deployment that already has a
PostgreSQL 17 data volume, you must migrate the data before starting the new
PostgreSQL 18 container. Otherwise PostgreSQL 18 will initialize an empty
cluster in `/var/lib/postgresql/18/docker` and your existing 17 cluster will not
be used.

### Recommended (Safe): Dump + Restore

```bash
# 1) While still running the old stack, create a backup
make db-dump

# 2) Stop the stack
make stop

# 3) Remove ONLY the Postgres volume (after verifying your backup)
#    Find it first (usually something like "kiwi_postgres_data")
docker volume ls | grep postgres_data

#    Then remove it
docker volume rm <your_postgres_volume>

# 4) Build (or pull) the upgraded images
make build

# 5) Start the upgraded stack (creates a fresh Postgres 18 cluster)
make start

# 6) Restore the dump
make db-restore DUMP_FILE=.backup/<your_dump_file>.dump

# 7) Apply migrations
make migrate
```

### Advanced: pg_upgrade (Large Datasets)

If you prefer `pg_upgrade`, mount the volume at `/var/lib/postgresql` and move
the old PostgreSQL 17 cluster into `/var/lib/postgresql/17/docker` before
running `pg_upgrade`.

You need an environment that has both PostgreSQL 17 and 18 binaries available
and includes all extensions used by KIWI (PostGIS, pgRouting, pg_cron, pgvector,
vectorscale).
