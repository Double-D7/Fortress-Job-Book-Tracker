-- ---------------------------------------------------------------------
-- Running the digest every morning.
--
-- The Edge Function in supabase/functions/daily-digest does the work.
-- This is what wakes it up, and why it is wired the way it is.
--
-- WHY pg_cron AND NOT A VERCEL CRON. The digest needs the service role,
-- and DEPLOY.md says the web deployment must not hold that key. Waking
-- the function from inside Postgres keeps both true: Supabase injects
-- the service role into its own functions, and Vercel never sees it.
--
-- WHY A SHARED SECRET. An Edge Function is a public URL. `verify_jwt`
-- is off because pg_cron has no user session to present a JWT for, so
-- without a secret anyone who learned the URL could make everybody's
-- digest go out at three in the morning — or drain the Resend quota.
-- The function refuses a request without the header, and refuses to run
-- at all when the secret is unset, rather than treating "unconfigured"
-- as "open".
--
-- WHY THE SECRET IS READ AT FIRE TIME. Inlining it would store it in
-- clear text in `cron.job`, which anyone with database access can read.
-- Vault holds it; the job looks it up when it fires.
--
-- This migration is idempotent and safe to re-run. It does NOT create
-- the secret — `vault.create_secret` would mint a second one and the
-- function would start refusing the cron. See DEPLOY.md for the one
-- command that creates it, which is run once per project.
-- ---------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
declare
  v_url  text;
  v_has_secret boolean;
begin
  -- The project's own function URL, derived rather than hardcoded so a
  -- restore into a different project does not silently post digests at
  -- the project it was copied from.
  select coalesce(
    current_setting('app.settings.functions_url', true),
    'https://' || current_setting('app.settings.project_ref', true)
      || '.supabase.co/functions/v1'
  ) into v_url;

  -- On Supabase those settings are not always present. Fall back to the
  -- known project rather than scheduling a job that posts to 'https://.
  if v_url is null or v_url like 'https://.%' or v_url = 'https://' then
    v_url := 'https://vuggctigvwgaxsmwdhxt.supabase.co/functions/v1';
  end if;

  select exists (
    select 1 from vault.decrypted_secrets where name = 'digest_secret'
  ) into v_has_secret;

  if not v_has_secret then
    raise warning
      'No `digest_secret` in Vault — the digest schedule is NOT being created. '
      'Create it once with the command in DEPLOY.md, then re-run this migration.';
    return;
  end if;

  -- cron.schedule replaces a job of the same name, so re-running this
  -- updates the schedule rather than stacking a second digest on top.
  perform cron.schedule(
    'daily-digest',
    '0 13 * * *',   -- 07:00 Mountain Daylight, 06:00 Mountain Standard
    format($job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-digest-secret',
          (select decrypted_secret from vault.decrypted_secrets
            where name = 'digest_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$, v_url || '/daily-digest')
  );
end $$;

-- ---------------------------------------------------------------------
-- Cron is UTC and does not follow daylight saving, so the 13:00 above
-- lands an hour later in winter. That is fine for a morning digest and
-- is the one line to change if it is not:
--
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'daily-digest'),
--     schedule => '0 14 * * *');
--
-- To stop it entirely:
--
--   select cron.unschedule('daily-digest');
--
-- To see whether it has been firing, and what it did:
--
--   select * from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname='daily-digest')
--    order by start_time desc limit 10;
--   select * from digest_run order by ran_at desc limit 10;
-- ---------------------------------------------------------------------
