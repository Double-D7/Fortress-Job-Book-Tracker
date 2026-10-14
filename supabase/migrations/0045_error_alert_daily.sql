-- ---------------------------------------------------------------------
-- The error alerter moves to once a day.
--
-- It ran every fifteen minutes, on the reasoning that somebody should
-- hear about a broken page while the person who hit it is still on the
-- phone. That is a pager, and this system has no on-call rota: a
-- notification arriving four times an hour stops being read long before
-- it stops being sent, and an alert nobody reads is the thing the
-- alerter exists to prevent.
--
-- Once a day it is a list somebody works through. A fault urgent enough
-- to need faster than that is one somebody is already ringing about.
--
-- 13:30 UTC is half an hour after the digest, so the morning mail reads
-- in the order it should: what broke, then where the work stands. Fixed
-- UTC rather than pinned to Mountain, which the backup needs because
-- "before midnight" is a real deadline and this is not — an hour's drift
-- across daylight saving changes nothing about a daily list.
--
-- `cron.schedule` replaces a job of the same name, so this re-points the
-- existing job rather than adding a second one. Safe to re-run.
-- ---------------------------------------------------------------------

do $$
declare
  v_url text;
begin
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
      'changed. Create it once, then re-run this migration.';
    return;
  end if;

  perform cron.schedule(
    'error-alert',
    '30 13 * * *',
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
-- To send one now rather than waiting for the morning:
--
--   select net.http_post(
--     url := 'https://vuggctigvwgaxsmwdhxt.supabase.co/functions/v1/error-alert',
--     headers := jsonb_build_object('Content-Type','application/json',
--       'x-alert-secret', (select decrypted_secret from vault.decrypted_secrets
--                           where name='alert_secret')),
--     body := '{}'::jsonb, timeout_milliseconds := 60000);
--
-- To go back to a tighter cadence, change the schedule and nothing else;
-- the quiet window inside the function is what stops a fault repeating,
-- and it is well under a day either way:
--
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'error-alert'),
--     schedule => '*/15 * * * *');
-- ---------------------------------------------------------------------
