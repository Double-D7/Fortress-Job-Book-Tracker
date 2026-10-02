-- ---------------------------------------------------------------------
-- Running the backup: 11:59 PM Mountain, every night.
--
-- The Edge Function in supabase/functions/backup does the work. This is
-- what wakes it up, and it is wired exactly like the digest in 0026 and
-- for the same reasons: the function needs the service role, DEPLOY.md
-- says the web deployment must not hold that key, and waking it from
-- inside Postgres keeps both true.
--
-- WHY THE SCHEDULE LOOKS WRONG. It reads `59 5,6 * * *` — two firings a
-- night — for a job that must run once, at 11:59 PM Mountain.
--
-- pg_cron 1.6 has no per-job time zone. Every schedule is read in the
-- server's zone, which on Supabase is UTC. Mountain time is not a fixed
-- offset: 11:59 PM is 05:59 UTC through the summer (MDT, UTC-6) and
-- 06:59 UTC through the winter (MST, UTC-7). A single hardcoded UTC hour
-- is therefore correct for about half the year and an hour out for the
-- rest, and the half it is wrong for changes twice a year without anyone
-- touching it.
--
-- So the job is scheduled at both candidate hours and the POST is gated
-- on the local hour actually being 23. Postgres knows the Mountain DST
-- rules, so exactly one of the two firings passes the gate on any given
-- date, including the two days a year when the clocks move. The other
-- firing evaluates one cheap comparison and sends nothing: `select f()
-- where false` returns no rows, and the function in the target list is
-- never called.
--
-- WHY A SHARED SECRET. An Edge Function is a public URL and `verify_jwt`
-- is off, because pg_cron has no user session to present a JWT for.
-- Without the secret, anyone who learned the URL could drive a tenant's
-- whole archive into SharePoint on demand. The function refuses a
-- request without the header, and refuses to run at all when the secret
-- is unset rather than treating "unconfigured" as "open".
--
-- WHY THE SECRET IS READ AT FIRE TIME. Inlining it would store it in
-- clear text in `cron.job`, which anyone with database access can read.
-- Vault holds it; the job looks it up when it fires.
--
-- This migration is idempotent and safe to re-run. It does NOT create
-- the secret — `vault.create_secret` would mint a second one and the
-- function would start refusing the cron. See DEPLOY.md.
-- ---------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- `cron.schedule` replaces a job of the same name, so re-running this
-- updates the schedule rather than stacking a second backup on top.
--
-- Guarded rather than wrapped in a DO block: with no secret there is
-- nothing for the function to authenticate against, and scheduling a job
-- that can only ever be refused would turn a missing secret into a
-- nightly 403 instead of an obvious absence.
select cron.schedule(
  'nightly-backup',
  '59 5,6 * * *',
  format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-backup-secret',
        (select decrypted_secret from vault.decrypted_secrets
          where name = 'backup_secret')
      ),
      body := '{}'::jsonb,
      -- Generous: a run that is uploading large files is working, not
      -- hung, and cutting it off mid-chunk wastes the whole upload.
      timeout_milliseconds := 600000
    )
    where date_part('hour', now() at time zone 'America/Denver') = 23;
  $job$,
  coalesce(
    nullif(current_setting('app.settings.functions_url', true), ''),
    'https://vuggctigvwgaxsmwdhxt.supabase.co/functions/v1'
  ) || '/backup')
)
where exists (
  select 1 from vault.decrypted_secrets where name = 'backup_secret'
);

-- ---------------------------------------------------------------------
-- Checking on it.
--
--   select * from backup_run order by started_at desc limit 10;
--
-- An absence of recent rows is the failure worth alarming on: it means
-- the backup stopped and nobody noticed, which is how the discovery
-- happens on the day it is needed. `backup_health` answers that in one
-- row for the admin screen and the digest.
--
-- To confirm the next firing lands where it should:
--
--   select jobname, schedule from cron.job where jobname = 'nightly-backup';
--
-- To stop it entirely:
--
--   select cron.unschedule('nightly-backup');
--
-- NOTE ON CATCH-UP. A run is bounded (roughly 150 files or 400MB) so it
-- cannot be killed partway by an Edge Function's wall clock. Once a book
-- is loaded, the first night will not copy all of it. Either invoke the
-- function by hand a few times to catch up, or raise BACKUP_MAX_FILES
-- temporarily. After the archive has caught up, a nightly run with no
-- changed hashes writes nothing and finishes in seconds.
-- ---------------------------------------------------------------------
