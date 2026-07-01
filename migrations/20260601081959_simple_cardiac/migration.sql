-- Custom SQL migration file, put your code below! --
CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.cleanup_old_worker_runs()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public.process_runs
    WHERE status IN ('completed', 'failed')
      AND COALESCE(completed_at, updated_at, created_at) < NOW() - INTERVAL '1 week';

    IF to_regclass('public.workflow_runs') IS NOT NULL THEN
        IF to_regclass('public.workflow_step_attempts') IS NOT NULL
           AND to_regclass('public.workflow_signals') IS NOT NULL THEN
            DELETE FROM public.workflow_signals signal
            WHERE EXISTS (
                    SELECT 1
                    FROM public.workflow_runs run
                    WHERE run.namespace_id = signal.namespace_id
                      AND run.id = signal.workflow_run_id
                      AND run.status IN ('completed', 'succeeded', 'failed', 'canceled')
                      AND COALESCE(run.finished_at, run.updated_at, run.created_at) < NOW() - INTERVAL '1 week'
                )
               OR EXISTS (
                    SELECT 1
                    FROM public.workflow_step_attempts attempt
                    INNER JOIN public.workflow_runs run
                        ON run.namespace_id = attempt.namespace_id
                       AND run.id = attempt.workflow_run_id
                    WHERE attempt.namespace_id = signal.namespace_id
                      AND attempt.id = signal.step_attempt_id
                      AND run.status IN ('completed', 'succeeded', 'failed', 'canceled')
                      AND COALESCE(run.finished_at, run.updated_at, run.created_at) < NOW() - INTERVAL '1 week'
                );
        END IF;

        DELETE FROM public.workflow_runs
        WHERE status IN ('completed', 'succeeded', 'failed', 'canceled')
          AND COALESCE(finished_at, updated_at, created_at) < NOW() - INTERVAL '1 week';
    END IF;
END;
$$;
--> statement-breakpoint
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'cleanup_old_worker_runs';
--> statement-breakpoint
SELECT cron.schedule(
    'cleanup_old_worker_runs',
    '59 23 * * 0',
    $$SELECT public.cleanup_old_worker_runs();$$
);
