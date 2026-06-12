# Mon Freight CDP

A small customer-data app to replace the manual two-Excel workflow.
You record each shipment in a form. The app stores everything, and a
**Print Label** button on every row prints the customs label directly.
You can also download the same Air Cargo `.xlsx` you used to share with
PPW — but you never have to *type* into Excel again.

## What it gives you

- One web page with a date picker and an "Add shipment" form (same
  fields as the Air Cargo Excel).
- A list of all shipments for the selected day.
- Per-row buttons:
  - **Print** — opens a one-page customs label (CP72/CN23 layout) in a
    new tab and triggers your browser's print dialog automatically.
  - **Delete** — removes the shipment.
- Top-right buttons:
  - **Air Cargo .xlsx** — downloads today's batch as the Air Cargo
    workbook in your existing format (for sending to PPW or partners).
  - **Labels .xlsx** — downloads today's batch as the multi-page label
    workbook (the same format you already print from Excel).
  - **Print all labels** — opens every label in one tab, ready to print
    in one go.
- An "Other batches" panel listing previous days so you can re-export
  or re-print at any time.
- Auto-generated MF numbers in `MFYYMMDDNNN` format — never typed by hand.

## Run it on your computer (5 minutes)

You need Python 3.10 or newer. On macOS it's already there. On Windows,
install from python.org and tick "Add Python to PATH".

```bash
# 1. Open this folder in a terminal
cd monfreight_cdp

# 2. Install dependencies (one time)
pip install -r requirements.txt

# 3. Run the app
uvicorn app:app --reload
```

Open http://127.0.0.1:8000 in your browser. That's it.

Your data lives in `data/monfreight.db`. Back it up by copying that one
file. To start fresh, delete it.

### Importing your existing Air Cargo Excel

If you want to start with the shipments already in
`Air Cargo 26_04_2026.xlsx`, you can bulk-import them with one curl call:

```bash
curl -X POST \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"Air Cargo 26_04_2026.xlsx" \
  "http://127.0.0.1:8000/api/batches/2026-04-26/import-aircargo"
```

(Replace the date and filename for your batch.)

## Deploy to the cloud — Render.com (free tier)

Render gives you a public URL anyone on your team can use, hosts the
database for you, and auto-deploys when you push code. Free tier costs
nothing for low traffic. Steps:

### 1. Put the code on GitHub
1. Make a free GitHub account if you don't have one.
2. Create a new private repository called `monfreight-cdp`.
3. From this folder run:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/monfreight-cdp.git
   git branch -M main
   git push -u origin main
   ```

### 2. Connect Render
1. Sign up at https://render.com (free, supports GitHub login).
2. From the Render dashboard click **New** → **Blueprint**.
3. Connect your GitHub account and pick the `monfreight-cdp` repo.
4. Render reads `render.yaml` and shows what it will create:
   - one Web Service (the Python app)
   - one PostgreSQL database (free tier, 1 GB)
   - one persistent disk for label templates
5. Click **Apply**. First build takes ~3 minutes.

After deploy, Render gives you a URL like
`https://monfreight-cdp.onrender.com`. Bookmark it. That's your app.

### Notes on the Render free tier
- Web service spins down after 15 minutes of no traffic and takes
  ~30 seconds to wake up on the next request. Fine for daily use.
- Free PostgreSQL DBs are deleted after 90 days unless you upgrade.
  Either back up regularly (use the Air Cargo export) or pay $7/month
  for a permanent DB.
- Render rebuilds the app every time you push to `main`.

### Alternative: Railway, Fly.io, Heroku
The included `Procfile` works on any standard Python host. Push the
code, set the start command to
`uvicorn app:app --host 0.0.0.0 --port $PORT`, point `DATABASE_URL`
at a Postgres instance, and you're set.

## Project layout

```
monfreight_cdp/
├── app.py               # FastAPI backend (routes, DB models)
├── label_excel.py       # Air Cargo + Label .xlsx generators
├── templates/
│   ├── index.html       # Main page (form + table)
│   ├── label.html       # Single-label print view
│   ├── label_body.html  # Reusable label markup
│   └── labels_all.html  # All-labels print view
├── static/
│   ├── style.css
│   └── app.js
├── data/
│   ├── label_template.xlsx   # Bundled clean label workbook
│   └── monfreight.db         # Created on first run (gitignored)
├── requirements.txt
├── Procfile             # For Render/Railway/Heroku
├── render.yaml          # One-click Render deploy
└── README.md
```

## Column mapping

The form fields and database columns mirror the Air Cargo workbook
exactly:

| Form field         | DB column          | Air Cargo column |
|--------------------|--------------------|------------------|
| Sender name        | sender_name        | C                |
| Sender phone       | sender_phone       | D                |
| Sender address     | sender_address     | E                |
| Sender city        | sender_city        | F                |
| Sender country     | sender_country     | G                |
| Sender postal      | sender_postal      | H                |
| Receiver name      | receiver_name      | I                |
| Receiver phone     | receiver_phone     | J                |
| Receiver address   | receiver_address   | K                |
| Receiver city      | receiver_city      | L                |
| Receiver country   | receiver_country   | M                |
| Description        | description        | N                |
| Declared value     | declared_value     | O                |
| Weight             | weight             | P                |
| Price AU$          | price_aud          | Q                |
| Delivery note      | delivery_note      | R                |

## Things to add when you're ready

- Edit existing shipment (today: just delete + re-add).
- Login / staff accounts (today: anyone with the URL has access).
- Search across all batches.
- Photo attachment for each box.
- Direct-to-printer over USB (today: opens browser print dialog).
- Recipient SMS via Twilio when label is generated.

The codebase is intentionally small (about 600 lines of Python) so any
developer can pick it up in an afternoon and add what you need.
