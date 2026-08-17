# SQLite → Postgres Migration Runbook

**Mon Freight Platform · Railway**

Goal: eliminate the total-data-loss risk of running SQLite on Railway's
ephemeral filesystem, by moving to managed Postgres.

Estimated time: 30–40 minutes. Pick a quiet window — **all users get logged
out** and the platform is read-only-ish during the restore.

---

## Why this is safe

We are not writing a custom migration script. `backup.py` already contains a
Postgres-aware restore path:

- `_load_database()` runs inside `with _engine.begin()` — a single
  transaction, all-or-nothing. A failure rolls back cleanly.
- `_coerce()` converts each JSON value back to the target column's Python
  type, so SQLite's loose typing is normalised on the way in.
- After inserting rows with explicit primary keys, it resets Postgres
  sequences via `setval(pg_get_serial_sequence(...))`. Without this, the
  next insert would collide with an existing ID. This is already handled.

So the migration is: stand up an empty Postgres schema, then use the app's
own restore against a backup taken minutes earlier.

---

## Pre-flight

### 1. Push the driver fix (required — the app will not boot without it)

Railway hands out `DATABASE_URL` as `postgresql://...`. The old code only
rewrote `postgres://`, so SQLAlchemy would fall back to the **psycopg2**
dialect, which is not in `requirements.txt` (you have psycopg v3). The app
would die at import with `ModuleNotFoundError: No module named 'psycopg2'`.

The fix normalises both prefixes onto `postgresql+psycopg://` and adds
`pool_pre_ping` / `pool_recycle=300`, so the first request after an idle
spell doesn't fail on a recycled connection.

```bash
cd ~/Documents/"MON FREIGHT PTY LTD"/IT/monfreight-platform
git add app.py
git commit -m "Normalise Postgres URL onto psycopg v3; add pool pre-ping"
git push
```

Wait for Railway to finish deploying. Confirm the site still works —
you are still on SQLite at this point, nothing has changed functionally.

### 2. Take a fresh backup AND download it

In the platform: **Backups → Run backup now**. Then **download** the archive
to your Mac. Do not rely only on the OneDrive copy for this — see the known
issue about rotated refresh tokens.

This file is your rollback. Do not skip it.

### 3. Note your current row counts

From the shipments list and admin pages, write down:

- total shipments: ____
- most recent batch date: ____
- number of users: ____
- number of packages / packing lists: ____

You will check these again after the restore.

---

## Migration

### 4. Create the Postgres service

Railway dashboard → **+ New** → **Database** → **PostgreSQL**.

Let it finish provisioning. Do not set any variables yet.

### 5. Point the app at Postgres

In your **web service** → Variables, add:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

Use Railway's variable-reference syntax exactly as above so it tracks the
database service automatically. Save — Railway redeploys.

### 6. Verify the empty schema came up

Watch the deploy logs. You want to see the app start cleanly with no
`ModuleNotFoundError` and no SQLAlchemy errors.

On boot, `create_all()` builds every table from the models, and the admin
bootstrap creates an admin user from `ADMIN_USERNAME` / `ADMIN_PASSWORD` /
`ADMIN_PHONE`.

Log in with those admin credentials. The platform will look **empty** — no
shipments. That is expected. Do not panic.

### 7. Restore

**Backups → Restore**, and select the backup from step 2.

Everything lands in Postgres inside one transaction, with sequences reset.

### 8. Verify against step 3

- [ ] Total shipment count matches
- [ ] Most recent batch date matches
- [ ] All users present, with phone numbers intact
- [ ] Packages / packing lists match
- [ ] Activity log has history
- [ ] Open the latest batch and download the **Air Cargo .xlsx** — confirms
      the DB, the export, and the control-character fix all work together
- [ ] Log out, log back in — confirms SMS OTP works against Postgres
- [ ] Trigger one more manual backup — confirms backups now dump *from*
      Postgres correctly

---

## Post-migration

### Keep the volume for two weeks

Do **not** delete the Railway Volume or the SQLite file yet. It costs
almost nothing and it is your instant fallback. Remove it once you have had
a couple of weeks of clean Postgres operation.

### Rollback, if needed

Delete the `DATABASE_URL` variable and redeploy. The app falls straight back
to SQLite on the volume, with data as of the moment you switched. This is
why step 2 and the two-week retention matter.

---

## Two things that change permanently after this

### 1. The lightweight ALTER-based migrations stop running

These functions all begin with an early return for non-SQLite engines:

- `app.py` → `_ensure_columns()`
- `shipment_prep.py` → `_ensure_package_id_column()`
- `shipment_prep.py` → `_ensure_package_columns()`

On SQLite they quietly added new columns to old databases. On Postgres they
are no-ops. `create_all()` only creates **missing tables** — it never adds a
column to an existing table.

**Consequence:** from now on, adding a column to a model is not enough. You
need a real migration (Alembic, or a hand-written `ALTER TABLE` run once).
If you add a field and it appears to do nothing, this is why.

Worth adding Alembic before the next schema change.

### 2. `total_override` disappears

`app.py` adds a `total_override` column on SQLite, but it is **not declared
on the `Shipment` model** and nothing in the codebase reads or writes it —
verified by grep across all `.py` and `.html` files. It will not be created
in Postgres.

This is dead weight being dropped, not data loss. Noted here only so it
doesn't surprise you if you go comparing schemas.

---

## Still outstanding after this (from the security review)

Ranked:

1. **In-memory rate limits** — `_pw_fails` and `_otp_sends` are Python dicts.
   They reset on every redeploy and don't work across replicas, so
   brute-force protection is softer than it looks. Now that you have a real
   database, these can be moved into it properly.
2. **No bot protection on `/login`** — CP72 has Turnstile; the platform
   doesn't. This plus item 1 is the realistic attack path.
3. **`REQUIRE_SMS` not set** — until it is, any user with a blank or
   non-E.164 phone still gets the OTP shown on screen.
4. **OneDrive refresh-token rotation is memory-only** (`backup.py:119`) —
   when Microsoft rotates the token, the new value is lost on restart and
   reverts to the stale Railway variable. Backups then stop, silently.
   Needs persistence plus failure alerting.
5. **Backups are unencrypted zips** containing customer names, addresses and
   phone numbers.
6. **`/api/health` is public** and reports `db_url_kind`.
