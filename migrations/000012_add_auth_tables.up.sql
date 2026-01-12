-- Rename users to user and add auth columns
ALTER TABLE "users"
    ADD COLUMN email TEXT NOT NULL,
    ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN image TEXT,
    ADD COLUMN "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN "role" TEXT,
    ADD COLUMN "banned" BOOLEAN,
    ADD COLUMN "banReason" TEXT,
    ADD COLUMN "banExpires" TIMESTAMPTZ;

-- Session table
CREATE TABLE session (
    id BIGSERIAL PRIMARY KEY,
    "userId" BIGINT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "impersonatedBy" BIGINT REFERENCES "users"(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX session_token_idx ON session(token);

-- Account table
CREATE TABLE account (
    id BIGSERIAL PRIMARY KEY,
    "userId" BIGINT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    scope TEXT,
    "idToken" TEXT,
    password TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Verification table
CREATE TABLE verification (
    id BIGSERIAL PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- JWKS table
CREATE TABLE jwks (
    id TEXT PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt" TIMESTAMPTZ
);
