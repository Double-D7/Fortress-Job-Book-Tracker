-- ---------------------------------------------------------------------
-- Running the backup.
--
-- The Edge Function in supabase/functions/backup does the work. This is
-- what wakes it up, and it is wired exactly like the digest in 0026 and
-- for the same reasons: the function needs the service role, DEPLOY.md
-- says the web deployment must not hold that key, and waking it from
-- inside Postgres keeps both true.
--
-- WHY IT RUNS MORE THAN ONCE A NIGHT. A run is bounded — roughly 150
-- files or 400MB — because one facility book is around 850MB and an Edge
-- Function has minutes rather than hours. A single nightly invocation
-- would be killed partway through the first catch-up and never
-- converge. Running hourly lets the archive catch up over a night or
-- two and then cost almost nothing: once everything is written, a run
-- that finds no changed hashes writes nothing and finishes in seconds.
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

do $$
declare
  v_url text;
  v_has_secret boolean;
begin
  -- Derived rather than hardcoded so a restore into a different project
  -- does not silently drive the backup of the project it was copied from.
  select coalesce(
    current_setting('app.settings.functions_url', true),
    'https://' || current_setting('app.settings.project_ref', true)
      || '.supabase.co/functions/v1'
  ) into v_url;

  if v_url is null or v_url like 'https://.%' or v_url = 'https://' then
    v_url := 'https://vuggctigvwgaxsmwdhxt.supabase.co/functions/v1';
  end if;

  select exists (
    select 1 from vault.decrypted_secrets where name = 'backup_secret'
  ) into v_has_secret;

  if not v_has_secret then
    raise warning
      'No `backup_secret` in Vault — the backup schedule is NOT being created. '
      'Create it once with the command in DEPLOY.md, then re-run this migration.';
    return;
  end if;

  -- cron.schedule replaces a job of the same name, so re-running this
  -- updates the schedule rather than stacking a second backup on top.
  perform cron.schedule(
    'nightly-backup',
    '17 * * * *',   -- hourly, off the hour so it does not queue behind
                    -- everything else that runs at :00
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
      );
    $job$, v_url || '/backup')
  );
end $$;

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
-- To slow it down once the archive has caught up:
--
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'nightly-backup'),
--     schedule => '17 6 * * *');
--
-- To stop it entirely:
--
--   select cron.unschedule('nightly-backup');
-- ---------------------------------------------------------------------
