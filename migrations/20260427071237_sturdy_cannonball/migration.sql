-- Custom SQL migration file, put your code below! --
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'cleanup_stale_graph_processing_state';
--> statement-breakpoint
SELECT cron.schedule(
    'cleanup_stale_graph_processing_state',
    '0 * * * *',
    $$
        WITH stale_graphs AS (
            UPDATE graphs
            SET state = 'ready',
                updated_at = NOW()
            WHERE state = 'updating'
              AND updated_at < NOW() - INTERVAL '24 hours'
            RETURNING id
        )
        UPDATE process_runs
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW()
        WHERE status <> 'completed'
          AND graph_id IN (SELECT id FROM stale_graphs);
    $$
);
