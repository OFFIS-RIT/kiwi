DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'session'
          AND column_name = 'imposonatedBy'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'session'
          AND column_name = 'impersonatedBy'
    ) THEN
        ALTER TABLE "session" RENAME COLUMN "imposonatedBy" TO "impersonatedBy";
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'session_imposonatedBy_user_id_fkey'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'session_impersonatedBy_user_id_fkey'
    ) THEN
        ALTER TABLE "session"
            RENAME CONSTRAINT "session_imposonatedBy_user_id_fkey" TO "session_impersonatedBy_user_id_fkey";
    END IF;
END $$;
