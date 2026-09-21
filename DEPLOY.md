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

Three, not four. **The service-role key is not one of them.** Nothing in
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
