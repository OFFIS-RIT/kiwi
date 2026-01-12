-- Drop auth tables
DROP TABLE IF EXISTS jwks;
DROP TABLE IF EXISTS verification;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS session;

-- Remove auth columns from user
ALTER TABLE "users"
    DROP COLUMN IF EXISTS "updatedAt",
    DROP COLUMN IF EXISTS "createdAt",
    DROP COLUMN IF EXISTS image,
    DROP COLUMN IF EXISTS "emailVerified",
    DROP COLUMN IF EXISTS email;
    DROP COLUMN IF EXISTS "role";
    DROP COLUMN IF EXISTS "banned";
    DROP COLUMN IF EXISTS "banReason";
    DROP COLUMN IF EXISTS "banExpires";
