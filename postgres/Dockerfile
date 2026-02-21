ARG PG_MAJOR=18

FROM postgres:${PG_MAJOR}-bookworm AS builder
ARG PG_MAJOR

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d /etc/apt/keyrings; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential \
        git \
        make \
        pkg-config \
        libssl-dev \
        libclang-dev \
        clang \
        jq \
        postgresql-server-dev-${PG_MAJOR}; \
    # Install pgvector
    if ! apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-pgvector; then \
        git clone --depth 1 --branch v0.8.1 https://github.com/pgvector/pgvector.git /tmp/pgvector; \
        make -C /tmp/pgvector; \
        make -C /tmp/pgvector install; \
        rm -rf /tmp/pgvector; \
    fi; \
    # Install pgvectorscale (requires Rust)
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; \
    export PATH="/root/.cargo/bin:$PATH"; \
    git clone --depth 1 --branch 0.9.0 https://github.com/timescale/pgvectorscale.git /tmp/pgvectorscale; \
    cd /tmp/pgvectorscale/pgvectorscale; \
    cargo install --locked cargo-pgrx --version $(cargo metadata --format-version 1 | jq -r '.packages[] | select(.name == "pgrx") | .version'); \
    cargo pgrx init --pg${PG_MAJOR} pg_config; \
    cargo pgrx install --release; \
    # Cleanup
    cd /; \
    rm -rf /tmp/pgvectorscale /root/.cargo /root/.rustup; \
    apt-get purge -y --auto-remove build-essential git make pkg-config libssl-dev libclang-dev clang jq postgresql-server-dev-${PG_MAJOR}; \
    rm -rf /var/lib/apt/lists/*

FROM postgres:${PG_MAJOR}-bookworm
ARG PG_MAJOR

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d /etc/apt/keyrings; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        postgresql-contrib \
        postgresql-${PG_MAJOR}-postgis-3 \
        postgresql-${PG_MAJOR}-postgis-3-scripts \
        postgresql-${PG_MAJOR}-pgrouting \
        postgresql-${PG_MAJOR}-cron; \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/lib/postgresql/${PG_MAJOR}/lib/ /usr/lib/postgresql/${PG_MAJOR}/lib/
COPY --from=builder /usr/share/postgresql/${PG_MAJOR}/extension/ /usr/share/postgresql/${PG_MAJOR}/extension/
COPY db-init/ /docker-entrypoint-initdb.d/
