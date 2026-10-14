# Putting this into service

Two things have to exist before anyone can use this for real work: a
Supabase project to hold the data, and a deployment to run the app. Neither
needs anything from this repository beyond what is already here.

Everything below is done once.

---

> **Already done for the Fortress org.** The project
> `Fortress Job Book Tracker` (`vuggctigvwgaxsmwdhxt`, us-west-2) exists,
> all twelve migrations are applied, the bucket is private, and
> david.devitt@fortressds.com is the first admin. Steps 1–3 and 5 below are
> a record of what was done, and what to repeat for a second environment.
> **What is left is step 4 (sign-in) and step 6 (deploy).**

## 1. Create the Supabase project

<https://supabase.com/dashboard> → **New project**. Pick a region near the
crews — `us-east-1` or `us-west-1` for Colorado work. Save the database
password it generates; you will not be shown it again.

## 2. Apply the schema

**SQL Editor → New query.** Paste the whole of
[`supabase/setup.sql`](supabase/setup.sql) and run it once.

That one file is all eleven migrations in order, generated from
`supabase/migrations/` by `npm run build:setup`. Use it rather than pasting
the migrations yourself: later files alter tables earlier ones create, so a
run in the wrong order fails halfway and leaves a half-built schema, which
is worse than none.

It takes a few seconds. The same statements are applied to a throwaway
Postgres by `npm run verify:db`, which then asserts the guarantees hold, so
this is not the first time they have been run.

What you should see afterwards, in **Table Editor**: 32 tables, each with
RLS enabled.

## 3. Create the storage bucket

Migration 0010 creates `job-book-documents` and its access policies. Check
**Storage** — the bucket should be listed and marked **private**. If your
project blocks bucket creation from SQL, create it by hand with exactly
that name, public **off**, and re-run 0010 for the policies.

Nothing in this system serves a document from a permanent URL. Downloads go
through a two-minute signed URL, and an audit row is written before the URL
is handed over, so a file that was accessed is a file whose access was
recorded.

## 4. Turn on sign-in

**Authentication → Providers.** Either works:

- **Email magic link** — nothing to configure, works immediately. Start here.
- **Azure (Entra ID)** for Fortress staff on their existing Microsoft
  accounts. Needs the tenant's client ID and secret from Azure. Once it is
  actually enabled, set `NEXT_PUBLIC_MICROSOFT_SIGNIN=on` on the deployment
  to show the button — it stays hidden otherwise, because
  `signInWithOAuth` navigates the browser away before it can report an
  unconfigured provider, so the button would land a person on a raw JSON
  error page.

**Leave "Allow new users to sign up" ON.** The allowlist is enforced in the
database — migration 0013 puts a trigger on `auth.users` that refuses an
address with no `app_user` invitation. Switching signups off as well
deadlocks the first sign-in: creating an account is exactly what a first
sign-in does, so nobody can ever get in, including the admin who set the
system up.

Then **Authentication → URL Configuration**: set the Site URL to your
deployed address and add `https://<your-app>/auth/callback` to the redirect
allowlist. Sign-in fails silently without that.

## 5. Create the first admin

Nobody can invite anyone until one admin exists, and the admin function is
admin-only — so the first one is made directly. **SQL Editor:**

```sql
insert into app_user (email, full_name, role)
values ('david.devitt@fortressds.com', 'David Devitt', 'fortress_admin');
```

You do not need to have signed in first. The row is an invitation; it links
to the account by email whenever the other half appears, in either order.

Everyone after that is invited from inside the application, or with:

```sql
select invite_user('tech@fortressds.com', 'A Tech', 'qaqc_tech');
select invite_user('ops@chevron.com', 'Chevron Ops', 'client_user',
                   (select id from client_org where name = 'Chevron'));
```

**Authenticating with an address nobody has invited grants nothing.** There
is no self-service sign-up, deliberately: this holds one operator's records
next to another's, and sign-up would let a visitor answer "who are you".

## 6. Deploy

<https://vercel.com/new> → import `Double-D7/Fortress-Job-Book-Tracker` →
set the branch to `claude/fortress-job-book-tracker-qtzjr1`.

Environment variables, from **Supabase → Project Settings → API**:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / publishable key |
| `DATA_PROVIDER` | `supabase` |
| `CANONICAL_HOST` | `app.fortressqc.com` (production only) |

Four, not five. **The service-role key is not one of them.** Nothing in
the application reads it — only `npm run verify:live` does, from a local
shell. It bypasses every RLS policy in the database, so the less it travels
the better, and a deployment that never holds it cannot leak it.

`DATA_PROVIDER` is the switch. Leave it unset and the app runs the
in-memory demo book instead — which is the right default for a missing
variable, but means a production deploy that forgets it will appear to
accept uploads and lose every one of them. Set it.

If a `SUPABASE_SERVICE_ROLE_KEY` is already set on the deployment from an
earlier setup, clear it. An unused secret is still a secret sitting
somewhere it is not needed.

`CANONICAL_HOST` names the one hostname the app is served from. Vercel also
answers on a `*.vercel.app` alias, and a session cookie belongs to a single
origin — so without this, signing in on one hostname and opening the other
means signing in again, on an app where the first session is still perfectly
alive. Set it on **production only**; preview deployments are meant to be
separate origins, and the redirect deliberately skips them. Give it a bare
hostname with no scheme and no trailing slash — anything else is ignored
rather than obeyed, because a malformed value here would break every page
including sign-in.

---

## Checking the project before you deploy

From the repository, with the two values from **Project Settings → API**:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
npm run verify:live
```

It checks the tables exist, both checklist templates loaded, the bucket
exists and is **private**, and at least one admin has been invited — and
tells you which step to go back to for anything that failed.

## Checking it worked

1. Open the deployed URL. You should be sent to sign-in, not to a dashboard.
2. Sign in as the admin you created.
3. **New job book**, fill in a job number and operator, declare a few
   quantities, create it.
4. Open a section, upload a PDF, and upload the same PDF again — the second
   one should be refused as byte-identical.
5. Reload. The document is still there. That is the thing that was not true
   before.
6. **Supabase → Storage → job-book-documents**: the file is in a folder
   named for the job book id.

If step 5 fails, `DATA_PROVIDER` is not set to `supabase`.

---

## What is enforced where

Worth knowing when something is refused, because the answer is usually
"the database said no" rather than a bug in a screen.

| Guarantee | Enforced by |
|---|---|
| A client sees only their operator's books and files | RLS policies, `0003` and `0010` |
| The audit trail cannot be edited or deleted | Privilege revocation + `DO INSTEAD NOTHING` rules, `0002` |
| A section cannot be approved by whoever submitted it | `approve_section()`, `0002` |
| A resolved flag must carry a note | Table constraint, `0001` |
| Only an admin may grant access | `invite_user()`, `0011` |

`npm run verify:db` asserts all of these against a throwaway Postgres. It
is worth running before any migration reaches production.

## Backups

Supabase takes daily backups on paid plans. On the free plan it does not —
and a turnover package is a legal record, so check **Settings → Database →
Backups** and know which you are on before a real job book goes in.

---

## The custom domain

The app is at `app.fortressqc.com`. Nothing in the code knows that —
sign-in redirects are built from `window.location.origin`, so moving the
app is DNS and two dashboard settings, never a deploy.

**Cloudflare DNS**

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `app` | `cname.vercel-dns.com` | **DNS only (grey cloud)** |

The proxy setting is the one that catches people. Leave the orange cloud
on and you have two CDNs terminating TLS in front of each other, which
surfaces as a certificate error or a redirect loop rather than as
anything that says "turn the proxy off". Check the value against what
Vercel shows for the domain — it hands out more than one CNAME target.

**Supabase, or sign-in breaks.** Authentication → URL Configuration:

- Site URL: `https://app.fortressqc.com`
- Redirect URLs: add `https://app.fortressqc.com/auth/callback`

Keep the `.vercel.app` entries until the new address is confirmed
working. Supabase rejects a `redirectTo` that is not on that list, and
the failure looks like a broken magic link rather than a missing setting.

---

## Email

Two different things send mail, and only one of them is Supabase's.

**Sign-in links** go through Supabase Auth. Out of the box that is a
shared demo mailer capped at a handful of messages an hour — fine for
one test, useless for a crew starting their day, since every magic-link
sign-in is an email. Fix it at Project Settings → Authentication → SMTP
with a real provider and a sender on `fortressqc.com`.

Enabling Microsoft SSO removes this dependency altogether: an OAuth
sign-in sends no email, so the cap stops mattering for anyone who signs
in that way.

**The daily digest** does not touch Supabase's mailer, or Vercel. See
below.

---

## The daily digest

An inspector's note is worth nothing as a row nobody reads. `0024` tells
the Custodian and the assigned crew in the app; this sends the same
thing once a day to people who are not in the app every hour.

**Where it runs, and why not in Vercel.** The digest reads every
recipient's unread notes so it can send each of them their own, which no
signed-in session may do — it needs the service role. This file says, a
few sections up, that the web deployment must not hold that key. So the
digest is a Supabase Edge Function on a `pg_cron` schedule: Supabase
injects the service role into its own functions, Vercel never sees it,
and that rule stays true.

```
pg_cron (0 13 * * *)
  └─ net.http_post  ──→  Edge Function `daily-digest`
                           ├─ digest_rows()      what is unread and un-emailed
                           ├─ buildDigests()     grouping and wording, shared
                           │                     with the app's own screens
                           ├─ Resend             one message per person
                           └─ mark_digested()    per recipient, after sending
```

**Sending then marking, one person at a time**, is deliberate. A run
that dies halfway re-sends nobody and drops nobody: whoever was sent is
marked, whoever was not goes tomorrow. Marking the batch first and then
sending loses somebody's mail the first time the provider has a bad
minute, and loses it silently.

### Setting it up

**1. Resend.** Add `fortressqc.com` and use their Cloudflare integration,
which writes the SPF/DKIM/DMARC records rather than you copying three
long strings by hand. Create an API key.

**2. The trigger secret.** The function's URL is public and `verify_jwt`
is off, because `pg_cron` has no user session to present a JWT for. A
shared secret is what stops anyone who learns the URL sending everyone's
digest at 3am. Create it once, in the SQL editor:

```sql
select vault.create_secret(
  encode(gen_random_bytes(32), 'hex'), 'digest_secret',
  'Shared secret pg_cron presents to the daily-digest Edge Function.');
```

Then read it back to paste into the dashboard:

```sql
select decrypted_secret from vault.decrypted_secrets
 where name = 'digest_secret';
```

Generating it in the database means the value never passes through a
terminal history or a chat window.

**3. Edge Function secrets.** Supabase Dashboard → Edge Functions →
Secrets:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | from step 1 |
| `DIGEST_SECRET` | the value from step 2 |
| `APP_URL` | `https://app.fortressqc.com` |
| `DIGEST_FROM` | `Fortress Job Book Tracker <noreply@fortressqc.com>` |

The function refuses to run at all while `DIGEST_SECRET` is unset — it
returns 503 rather than treating "unconfigured" as "open to anyone".

**4. The schedule** is created by `0026`. It reads the secret from Vault
when it fires rather than storing it in `cron.job`, where anyone with
database access could read the schedule and learn it.

### Checking it

```sql
-- Did the job fire?
select status, start_time, return_message from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname='daily-digest')
 order by start_time desc limit 5;

-- What did the run do?
select * from digest_run order by ran_at desc limit 5;
```

`digest_run` records every run including the failures, so "did anybody
get Tuesday's digest" has an answer that is not "ask people".

To send one now rather than waiting for the morning, run the job by hand:

```sql
select cron.schedule('digest-now', '* * * * *', (
  select command from cron.job where jobname='daily-digest'));
-- wait a minute, then:
select cron.unschedule('digest-now');
```

### Changing the timing

`0 13 * * *` is 07:00 Mountain Daylight and 06:00 Mountain Standard —
cron is UTC and does not follow daylight saving.

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname='daily-digest'),
  schedule => '0 14 * * *');
```

`DIGEST_MIN_AGE_MINUTES` (default 60) is how old a note must be before
it is emailed, so somebody reading a note in the app right now does not
also get a message about it. A note already read in the app is never
emailed at all.

### If the digest lands in junk

The first one did. Resend accepted it, delivered it, and Microsoft filed
it as spam — which is the ordinary fate of a first message from a domain
that has never sent one.

Check the authentication result in the message headers before assuming
anything is misconfigured. In Outlook: File → Properties, and look for
`Authentication-Results`. `spf=pass dkim=pass dmarc=pass` means nothing
is broken and the rest is reputation.

**Publish a DMARC record.** Resend requires only DKIM and SPF, so a
domain set up purely by following their checklist has no DMARC policy at
all — and Microsoft 365 treats a domain that publishes no policy as
weaker than one that publishes a permissive one. In Cloudflare:

| Type | Name | Content | Proxy |
|---|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none;` | n/a |

`p=none` asks receivers to enforce nothing; it only states that the
domain participates. That is the right first posture — it improves
placement without risking legitimate mail being rejected while you find
out what else sends as this domain. Tighten to `p=quarantine` and then
`p=reject` later, once you are sure everything that sends as
`fortressqc.com` aligns.

Adding `rua=mailto:...` turns on aggregate reports, which are worth
having eventually. Note that reporting to an address on a *different*
domain needs an authorisation record on that other domain, so it is not
a one-liner — leave it off until somebody wants the reports.

**Then tell the tenant, not each person.** Marking one message "not
junk" trains one mailbox. A mail flow rule in the Exchange admin centre
allowlisting the sender, or adding the domain to the tenant safe-sender
list, means the next person hired does not rediscover the junk folder on
their first morning.

---

## When something breaks

The app records every failure it meets in `error_report`, one row per
distinct fault with a count, and shows the person who hit it a short
reference they can read out over the phone. `0039` creates that table.

That is half of it. The other half is somebody being told, because a
record nobody opens is only slightly better than no record. The Edge
Function in `supabase/functions/error-alert` runs once a day at 13:30
UTC, half an hour after the digest, collects the open faults that are
due, and emails them to every active `fortress_admin`. Nobody is on a configured recipient list: the function
reads the directory, so an administrator added next month starts
receiving these without anybody remembering to wire them in.

### Setting it up

**1. The shared secret.** Same reasoning as the digest: an Edge Function
is a public URL and `pg_cron` has no session to present a JWT for.
Create it once, in the SQL editor:

```sql
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'), 'alert_secret',
  'Shared secret so only pg_cron can trigger the error alerter.');
```

Read it back to paste into the dashboard:

```sql
select decrypted_secret from vault.decrypted_secrets
 where name = 'alert_secret';
```

**2. Edge Function secret.** Supabase Dashboard → Edge Functions →
Secrets: add `ALERT_SECRET` with that value. `RESEND_API_KEY`, `APP_URL`
and `DIGEST_FROM` are already set by the digest and are reused.

Until `ALERT_SECRET` is set the function returns 503 on every run and
sends nothing. That is deliberate: an unset secret must not mean "open
to anyone", and a run that fails loudly is easier to notice than one
that quietly succeeds at nothing.

**3. The schedule** is created by `0040`. It reads the secret from Vault
when it fires rather than storing it in `cron.job`.

### Checking it

```sql
-- Did the job fire, and what did it get back?
select status, start_time, return_message from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname='error-alert')
 order by start_time desc limit 5;

-- What would it send right now?
select reference, error_name, occurrences, last_seen_at
  from error_report
 where resolved_at is null
   and (notified_at is null or notified_at < now() - interval '60 minutes')
 order by last_seen_at desc;
```

An empty second query is the normal state and means nothing is broken.

### Changing the cadence

It ran every fifteen minutes to begin with. That is a pager, and this
system has no on-call rota: a notification arriving four times an hour
stops being read long before it stops being sent. Daily, beside the
morning digest, is a list somebody works through.

The schedule is the only thing to change. The quiet window inside the
function is what stops a fault repeating, and at sixty minutes it is
well under any sensible interval:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'error-alert'),
  schedule => '*/15 * * * *');
```

One consequence of the daily run: a backlog drains one batch of 50 per
day rather than one per quarter hour, so the email says how many faults
are due as well as how many it is showing. A subject reading "50 errors"
when there are 300 would be the only thing most people saw.

### Why it does not email on every throw

A broken page throws for everybody who opens it. One email per
occurrence would be a hundred messages for one bug, and a hundred
messages are read as often as none. Each fault is mentioned once per daily run while it
stays open, and closing it is what stops that. Closing it on the admin screen records that it
was dealt with; it reopens by itself if it happens again, so a bug that
comes back cannot sit closed and unnoticed.

The email is sent before `notified_at` is stamped, not after, so a
Resend outage cannot silence a live fault until tomorrow.

---

## Inviting somebody

"Invite" used to be a permission check and one `INSERT`. It added the
person to `app_user` and sent nothing, so an administrator added Rodney
Ring, told him to expect an email, and both of them waited for a message
no code path produced.

The row is still what grants access. Signing in is a one-time code the
person asks for themselves, and `app_user` is the allow-list that decides
whether that gets them anywhere. What was missing was anybody telling
them so.

Inviting now sends them that, from the web deployment rather than from an
Edge Function, because an invitation is a reply to something an
administrator just did and they should be told then and there whether it
went.

**This needs one variable on the Vercel deployment:**

| Name | Value |
|---|---|
| `RESEND_API_KEY` | the same key the Edge Functions use |

Optionally `APP_URL` (defaults to `https://app.fortressqc.com`) and
`DIGEST_FROM` (defaults to the same sender the digest uses).

Without the key nothing breaks and nobody is left guessing: the person is
still invited, and the administrator is told on screen that the email did
not send and that they will have to pass the message on. That is the one
case where the screen shows a warning rather than the usual confirmation.

**A failed email never fails the invitation.** The access is granted
before the message is attempted, and returning a failure would invite a
retry that is then refused as a duplicate — leaving an administrator
certain it had not worked when it had.

### Sending it again

Inviting the same address twice is refused, so the user list carries a
**Send sign-in link** button against anybody who has not signed in yet.
That is the way to reach people added before this existed, and anybody
whose copy went to junk. It disappears once they have signed in, because
somebody who is already in does not need instructions and getting them
reads as something having gone wrong.

### If it lands in junk

Same as the digest: check `Authentication-Results` in the headers before
assuming anything is misconfigured, and see the DMARC note above. A first
message to a person who has never been written to before is the most
likely of all of these to be filed as spam.
