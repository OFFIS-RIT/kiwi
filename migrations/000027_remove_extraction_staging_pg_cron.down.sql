CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
    'cleanup-extraction-staging',
    '0 * * * *',
    $$DELETE FROM extraction_staging WHERE created_at < NOW() - INTERVAL '24 hours'$$
)
WHERE NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'cleanup-extraction-staging'
);
