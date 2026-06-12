# Mon Freight CDP — Go-Live, Security & Backup Guide

This guide covers everything added for online deployment: secure login,
SMS verification, automatic backups, and disaster recovery.

---

## 1. What was added

| Feature | How it works |
|---|---|
| Secure login | Username + password. Passwords hashed with PBKDF2-SHA256 (600,000 iterations, unique salt per user) — never stored in plain text. |
| SMS verification | After a correct password, a 6-digit code is sent by SMS (Twilio) to the user's registered mobile. Codes expire after **5 minutes**, max 5 wrong attempts per code, 60s resend cooldown, max 5 codes/hour per user. |
| Brute-force protection | Account locks for 15 minutes after 5 wrong passwords. Per-IP limits on code requests. |
| Sessions | Signed, HttpOnly, Secure cookies. 12-hour lifetime (configurable with `SESSION_HOURS`). Logout button in the top bar. |
| Route protection | Every page and API (Dashboard, Shipments, Labels, Reports, Settings) requires login. Only `/login` and `/api/health` are public. |
| User management | Admins add/disable/delete staff users in **Settings → Security & Users**. No public sign-up. |
| Daily backups | Database (all tables) + data files zipped with SHA-256 checksums, daily at `BACKUP_TIME_UTC` (default 17:00 UTC ≈ 3am Sydney). Catch-up backup at startup if the last one is >25h old. |
| Cloud storage | Every backup is uploaded to a Google Drive folder. Local + Drive copies kept **30 days**. |
| Manual backup | **Settings → Backup & Restore → Run Backup Now**, plus per-backup Download buttons. |
| Restore | Pick any backup → confirmation screen → one-click restore. Integrity checksums verified first; a *safety snapshot* of the current state is taken automatically, so a restore can itself be undone. The database reload runs in a single transaction (all-or-nothing). |

---

## 2. First run — default admin account

On the very first start (empty user table) the system creates an admin user:

* Username: `admin` (or `ADMIN_USERNAME`)
* Password: value of `ADMIN_PASSWORD`, or a **random password printed once in
  the server log** — check the Render log on first deploy and save it.
* Mobile: `ADMIN_PHONE` (E.164, e.g. `+61400123456`)

Sign in, then add your staff in **Settings → Security & Users**.

**Multiple mobiles per account:** a user can have several registered numbers
(comma-separated, e.g. `+61450193389,+61452493389`). At login, after the
password step, the person picks which number receives the 6-digit code.

> Your local database already has the admin account set up
> (username `admin`, two mobiles). For the Render deployment, set
> `ADMIN_PASSWORD` to the same password and
> `ADMIN_PHONE` to `+61450193389,+61452493389` — it's applied on first run.

> **Dev mode:** until the Twilio variables are set, the 6-digit code is shown
> directly on the login page (yellow banner) so you can't be locked out.
> Set up Twilio **before** real go-live.

---

## 3. Twilio setup (SMS codes)

1. Create an account at twilio.com and buy an SMS-capable number.
2. In Render → Environment, set:
   * `TWILIO_ACCOUNT_SID` — from the Twilio console
   * `TWILIO_AUTH_TOKEN` — from the Twilio console
   * `TWILIO_FROM` — your Twilio number, e.g. `+61480012345`
3. Make sure each user's mobile is saved in E.164 format
   (`+61…` Australia, `+976…` Mongolia).

Cost is roughly US$0.05–0.10 per SMS. Trial accounts can only text verified
numbers — upgrade before go-live.

## 4. Google Drive setup (cloud backups)

1. In [Google Cloud Console](https://console.cloud.google.com): create a
   project → enable the **Google Drive API** → create a **service account** →
   create a **JSON key** for it.
2. Create a folder in Google Drive (e.g. "MonFreight Backups") and **share it
   with the service account's email** (…@…iam.gserviceaccount.com) as Editor.
3. In Render → Environment, set:
   * `GDRIVE_SERVICE_ACCOUNT_JSON` — paste the entire JSON key file contents
   * `GDRIVE_FOLDER_ID` — the long ID in the folder's URL
     (`https://drive.google.com/drive/folders/<THIS PART>`)

If Drive is not configured, backups still run daily and are kept on the
server's persistent disk — you'll see "Local disk only" in Settings.
*Note:* if Drive uploads ever fail due to Google service-account storage
policy on personal accounts, use a Google Workspace **Shared Drive** folder,
or switch to downloading backups manually — local backups always work.

## 5a. Deploying on Railway (recommended if you have a paid plan)

1. Push the repo to GitHub, then Railway → **New Project → Deploy from
   GitHub repo**. Railway detects Python and uses the `Procfile`
   start command automatically.
2. **Add a Volume** to the service (right-click the service → Attach Volume)
   with mount path **`/app/data`** — this keeps the database, label template
   and local backups across deploys. Without it, data is lost on every deploy.
3. **Variables** — add:
   * `ADMIN_USERNAME` = `admin`, `ADMIN_PASSWORD`, `ADMIN_PHONE`
     (e.g. `+61450193389,+61452493389`)
   * `SECRET_KEY` = any long random string
   * `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (section 3)
   * `GDRIVE_SERVICE_ACCOUNT_JSON`, `GDRIVE_FOLDER_ID` (section 4)
   * `BACKUP_TIME_UTC` = `17:00`
4. Settings → Networking → **Generate Domain** to test, then
   **+ Custom Domain** to add `monfreight.online` — Railway shows the
   CNAME record to add in VentraIP's DNS panel. HTTPS is automatic.
5. Paid Railway plans don't sleep, so the daily backup scheduler runs
   reliably — no extra setup needed.

(SQLite on the volume is fine for a small team. If you later want
PostgreSQL, add Railway's Postgres plugin — the app switches automatically
when `DATABASE_URL` is set, and backups/restore work the same.)

## 5b. Deploying on Render

```bash
git add . && git commit -m "Auth, SMS verification, backups & restore"
git push
```

Render builds from `render.yaml`. After the first deploy:

1. Open the service **Logs** — copy the generated admin password
   (or set `ADMIN_PASSWORD` beforehand).
2. Set the Twilio and Google Drive environment variables (sections 3–4).
3. Sign in at `https://<your-app>.onrender.com/login`.

**Important:** the free Render plan spins the service down when idle, which
also pauses the backup scheduler (a catch-up backup runs on wake-up). For a
production system handling real customer data, the **Starter plan** is
strongly recommended — it keeps the service (and nightly backups) always on.

---

## 6. Disaster recovery

### Scenario A — bad data / accidental deletion (most common)
1. Settings → Backup & Restore.
2. Pick the backup from before the problem → **Restore** → confirm.
3. Done. **Expected recovery time: 1–5 minutes.**
   A safety snapshot of the pre-restore state is created automatically, so the
   restore itself can be undone.

### Scenario B — server lost / app must be redeployed
1. Redeploy the repo to Render (`git push` / "Manual Deploy").
2. Sign in (first run recreates the admin account — check logs for password).
3. Download the latest backup zip from Google Drive.
4. There is no upload button (deliberately, for safety) — place the zip in the
   server's `data/backups/` folder via Render's shell, **or** restore locally
   and re-import. Simplest path: run the app locally with the zip in
   `data/backups/`, restore via Settings, then push the data.
   **Expected recovery time: 15–30 minutes.**

### Scenario C — total loss including Google Drive
Only as good as your last manually downloaded backup — admins should download
a backup to a separate location (e.g. office computer) **once a week**.

### Recovery time summary

| Event | Expected recovery time |
|---|---|
| Accidental deletion / bad import | **1–5 min** (one-click restore) |
| App crash (Render restarts automatically) | 1–3 min, no data loss |
| Full server rebuild from backup | 15–30 min |
| Maximum data loss window | Up to 24 h (since last nightly backup) — run a manual backup before risky operations to reduce this to zero |

---

## 7. Environment variables reference

| Variable | Required | Purpose |
|---|---|---|
| `SECRET_KEY` | auto | Cookie signing (auto-generated on Render) |
| `SESSION_HOURS` | no | Session lifetime, default 12 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_PHONE` | first run | Default admin account |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | go-live | SMS verification codes |
| `GDRIVE_SERVICE_ACCOUNT_JSON` / `GDRIVE_FOLDER_ID` | recommended | Cloud backup storage |
| `BACKUP_TIME_UTC` | no | Daily backup time, default `17:00` |
| `BACKUP_RETENTION_DAYS` | no | Default `30` |
| `OTP_TTL_SECONDS` | no | Code lifetime, default `300` (5 min) |
