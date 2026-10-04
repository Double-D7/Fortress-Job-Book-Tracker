-- ---------------------------------------------------------------------
-- Waking the error alerter.
--
-- The Edge Function in supabase/functions/error-alert does the work:
-- it reads open faults out of `error_report`, emails them to every
-- active administrator, and stamps `notified_at` so the same fault does
-- not arrive again for an hour.
--
-- WHY EVERY FIFTEEN MINUTES. Short enough that somebody hears about a
-- broken page while the person who hit it is still on the phone, long
-- enough that it is not a poll loop. The quiet window inside the
-- function, not this schedule, is what stops a repeat; running more
-- often would only make a new fault arrive sooner, not more often.
--
-- WHY NOT FOLDED INTO THE DAILY DIGEST. A fault found at 07:00 the next
-- morning has been live all day. The digest answers "what is the state
-- of the work", which is a morning question; this answers "something is
-- broken now", which is not.
--
-- WHY A SHARED SECRET, AND WHY IT IS READ AT FIRE TIME: same reasons as
-- the digest in 0026 and the backup in 0035. An Edge Function is a
-- public URL with no user session to present a JWT for, and inlining the
-- secret here would write it in clear text into `cron.job`, which anyone
-- with database access can read. Vault holds it; the job looks it up
-- when it fires.
--
-- Idempotent and safe to re-run. It does NOT create the secret, because
-- `vault.create_secret` would mint a second one and the function would
-- start refusing the cron.
-- ---------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
declare
  v_url text;
begin
  -- Derived rather than hardcoded, so a restore into a different project
  -- does not quietly post this project's alerts at the one it was copied
  -- from. Falls back to the known project when Supabase does not expose
  -- those settings, rather than scheduling a post to 'https://'.
  select coalesce(
    nullif(current_setting('app.settings.functions_url', true), ''),
    'https://' || nullif(current_setting('app.settings.project_ref', true), '')
      || '.supabase.co/functions/v1'
  ) into v_url;

  if v_url is null or v_url like 'https://.%' or v_url = 'https://' then
    v_url := 'https://vuggctigvwgaxsmwdhxt.supabase.co/functions/v1';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets where name = 'alert_secret'
  ) then
    raise warning
      'No `alert_secret` in Vault - the error alert schedule is NOT being '
      'created. Create it once, then re-run this migration.';
    return;
  end if;

  -- cron.schedule replaces a job of the same name, so re-running this
  -- updates the schedule rather than stacking a second alerter on top.
  perform cron.schedule(
    'error-alert',
    '*/15 * * * *',
    format($job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-alert-secret',
          (select decrypted_secret from vault.decrypted_secrets
            where name = 'alert_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $job$, v_url || '/error-alert')
  );
end $$;

-- ---------------------------------------------------------------------
-- To stop it:        select cron.unschedule('error-alert');
-- To see its runs:
--   select * from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname='error-alert')
--    order by start_time desc limit 10;
-- To see what it would send right now:
--   select reference, error_name, occurrences, last_seen_at
--     from error_report where resolved_at is null
--      and (notified_at is null or notified_at < now() - interval '60 minutes')
--    order by last_seen_at desc;
-- ---------------------------------------------------------------------
