-- Revert users/auth ids from SERIAL to BIGSERIAL

-- Drop foreign keys referencing users
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_userId_fkey;
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_impersonatedBy_fkey;
ALTER TABLE account DROP CONSTRAINT IF EXISTS account_userId_fkey;

-- Users table
ALTER TABLE users ALTER COLUMN id TYPE BIGINT USING id::bigint;
ALTER SEQUENCE IF EXISTS users_id_seq AS BIGINT;

-- Auth table primary keys
ALTER TABLE session ALTER COLUMN id TYPE BIGINT USING id::bigint;
ALTER SEQUENCE IF EXISTS session_id_seq AS BIGINT;
ALTER TABLE account ALTER COLUMN id TYPE BIGINT USING id::bigint;
ALTER SEQUENCE IF EXISTS account_id_seq AS BIGINT;
ALTER TABLE verification ALTER COLUMN id TYPE BIGINT USING id::bigint;
ALTER SEQUENCE IF EXISTS verification_id_seq AS BIGINT;

-- Foreign key columns referencing users
ALTER TABLE session ALTER COLUMN "userId" TYPE BIGINT USING "userId"::bigint;
ALTER TABLE session ALTER COLUMN "impersonatedBy" TYPE BIGINT USING "impersonatedBy"::bigint;
ALTER TABLE account ALTER COLUMN "userId" TYPE BIGINT USING "userId"::bigint;
ALTER TABLE group_users ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;
ALTER TABLE user_chats ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;

-- Restore foreign keys
ALTER TABLE session
    ADD CONSTRAINT session_userId_fkey FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE,
    ADD CONSTRAINT session_impersonatedBy_fkey FOREIGN KEY ("impersonatedBy") REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE account
    ADD CONSTRAINT account_userId_fkey FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
