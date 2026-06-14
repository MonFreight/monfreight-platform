"""
Mon Freight CDP — Automatic backup, cloud sync (OneDrive) and restore.

What gets backed up
-------------------
* Every database table (shipments, users, …) as an engine-agnostic JSON dump
  — works identically for SQLite and PostgreSQL.
* Every file in the data/ folder (label templates, uploads), excluding the
  live database file and secrets.
* Air Cargo Excel files for the 4 most recent batch dates.
* A manifest with SHA-256 checksums so integrity can be verified on restore.

Schedule & retention
--------------------
* Automatic daily backup at BACKUP_TIME_UTC (default 17:00 UTC ≈ 3am Sydney).
* A catch-up backup runs at startup if the last one is older than 25 hours.
* Local + OneDrive copies are both kept for BACKUP_RETENTION_DAYS (30).

Restore
-------
* Admin picks a backup (local or OneDrive) in Settings → confirmation screen →
  one-click restore.
* Integrity: checksums verified first; an automatic "pre-restore" safety
  snapshot is taken; the table reload runs inside a single transaction.

Environment variables
---------------------
ONEDRIVE_CLIENT_ID       Azure app (client) ID
ONEDRIVE_CLIENT_SECRET   Azure app client secret
ONEDRIVE_REFRESH_TOKEN   OAuth 2.0 refresh token (obtained once via setup flow)
ONEDRIVE_FOLDER          OneDrive folder path for backups (default "MonFreight Backups")
BACKUP_TIME_UTC          "HH:MM" daily run time (default "17:00")
BACKUP_RETENTION_DAYS    default 30
BACKUP_DIR               local folder (default data/backups)
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import io
import json
import logging
import os
import re
import shutil
import threading
import zipfile
from pathlib import Path
from typing import Optional

import requests as _requests

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import MetaData, text

log = logging.getLogger("monfreight.backup")

# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", str(DATA_DIR / "backups")))
BACKUP_DIR.mkdir(parents=True, exist_ok=True)

RETENTION_DAYS = int(os.environ.get("BACKUP_RETENTION_DAYS", "30"))
BACKUP_TIME_UTC = os.environ.get("BACKUP_TIME_UTC", "17:00")
DUMP_VERSION = 1
NAME_RE = re.compile(r"monfreight_backup_\d{4}-\d{2}-\d{2}_\d{6}(_pre-restore)?\.zip")

# files never included in (or restored from) backups
EXCLUDE_FILES = {".secret_key"}
EXCLUDE_SUFFIXES = (".db", ".db-journal", ".db-wal", ".db-shm")
SKIP_RESTORE_TABLES = {"login_codes"}      # ephemeral OTPs — never restored

_engine = None
_lock = threading.Lock()                   # one backup/restore at a time


# --------------------------------------------------------------------------
# OneDrive (Microsoft Graph API — refresh-token / delegated auth)
# --------------------------------------------------------------------------
_OD_TOKEN_URL  = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
_OD_GRAPH      = "https://graph.microsoft.com/v1.0/me/drive"
_OD_GRAPH_ITEM = "https://graph.microsoft.com/v1.0/me/drive/items"


def _od_folder() -> str:
    return os.environ.get("ONEDRIVE_FOLDER", "MonFreight Backups").strip()


def drive_configured() -> bool:
    return all(os.environ.get(k) for k in (
        "ONEDRIVE_CLIENT_ID", "ONEDRIVE_CLIENT_SECRET", "ONEDRIVE_REFRESH_TOKEN"))


def _od_access_token() -> Optional[str]:
    """Exchange the stored refresh token for a short-lived access token.
    If the server returns a new refresh token, it is stored in-memory so the
    next call succeeds without needing to re-run the setup flow."""
    try:
        resp = _requests.post(_OD_TOKEN_URL, data={
            "grant_type":    "refresh_token",
            "client_id":     os.environ["ONEDRIVE_CLIENT_ID"],
            "client_secret": os.environ["ONEDRIVE_CLIENT_SECRET"],
            "refresh_token": os.environ["ONEDRIVE_REFRESH_TOKEN"],
            "scope":         "https://graph.microsoft.com/Files.ReadWrite offline_access",
        }, timeout=30)
        if resp.status_code >= 300:
            log.error("OneDrive token refresh failed (%s): %s",
                      resp.status_code, resp.text[:200])
            return None
        data = resp.json()
        # Microsoft may rotate the refresh token — keep the latest one in memory
        if "refresh_token" in data:
            os.environ["ONEDRIVE_REFRESH_TOKEN"] = data["refresh_token"]
        return data.get("access_token")
    except Exception as e:                            # noqa: BLE001
        log.error("OneDrive token error: %s", e)
        return None


def _od_headers() -> Optional[dict]:
    token = _od_access_token()
    return {"Authorization": f"Bearer {token}"} if token else None


def _drive_upload(path: Path) -> Optional[str]:
    hdrs = _od_headers()
    if not hdrs:
        return None
    folder = _od_folder()
    # Graph simple upload (≤4 MB); backups are typically well under that
    url = f"{_OD_GRAPH}/root:/{folder}/{path.name}:/content"
    hdrs["Content-Type"] = "application/octet-stream"
    r = _requests.put(url, headers=hdrs, data=path.read_bytes(), timeout=120)
    if r.status_code >= 300:
        log.error("OneDrive upload failed (%s): %s", r.status_code, r.text[:300])
        return None
    item_id = r.json().get("id")
    log.info("Backup uploaded to OneDrive: %s (id=%s)", path.name, item_id)
    return item_id


def _drive_list() -> list[dict]:
    hdrs = _od_headers()
    if not hdrs:
        return []
    folder = _od_folder()
    url = f"{_OD_GRAPH}/root:/{folder}:/children"
    r = _requests.get(url, headers=hdrs, params={"$top": "200"}, timeout=30)
    if r.status_code == 404:
        return []   # folder doesn't exist yet — no backups uploaded
    if r.status_code >= 300:
        log.error("OneDrive list failed (%s): %s", r.status_code, r.text[:300])
        return []
    return [
        {"id": f["id"], "name": f["name"],
         "size": f.get("size", 0),
         "createdTime": f.get("createdDateTime", "")}
        for f in r.json().get("value", [])
        if "monfreight_backup_" in f.get("name", "")
    ]


def _drive_download(file_id: str, dest: Path) -> bool:
    hdrs = _od_headers()
    if not hdrs:
        return False
    # Fetch the item metadata to get the pre-authenticated download URL
    r = _requests.get(f"{_OD_GRAPH_ITEM}/{file_id}", headers=hdrs, timeout=30)
    if r.status_code >= 300:
        log.error("OneDrive item fetch failed (%s)", r.status_code)
        return False
    download_url = r.json().get("@microsoft.graph.downloadUrl")
    if not download_url:
        log.error("OneDrive: no downloadUrl in item response")
        return False
    r2 = _requests.get(download_url, timeout=300)
    if r2.status_code >= 300:
        log.error("OneDrive download failed (%s)", r2.status_code)
        return False
    dest.write_bytes(r2.content)
    return True


def _drive_prune() -> None:
    cutoff = dt.datetime.now() - dt.timedelta(days=RETENTION_DAYS)
    hdrs = _od_headers()
    if not hdrs:
        return
    for f in _drive_list():
        try:
            # OneDrive timestamps are UTC — convert to local time for comparison
            created_utc = dt.datetime.fromisoformat(
                f["createdTime"].replace("Z", "+00:00"))
            created = created_utc.astimezone().replace(tzinfo=None)
            if created < cutoff:
                _requests.delete(f"{_OD_GRAPH_ITEM}/{f['id']}",
                                 headers=hdrs, timeout=30)
                log.info("Pruned old OneDrive backup: %s", f["name"])
        except Exception as e:                        # noqa: BLE001
            log.warning("OneDrive prune skipped %s: %s", f.get("name"), e)


# --------------------------------------------------------------------------
# dump / load
# --------------------------------------------------------------------------
def _json_safe(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    return v


def _dump_database() -> dict:
    """All tables → JSON-serialisable dict (engine agnostic)."""
    meta = MetaData()
    meta.reflect(bind=_engine)
    out = {"version": DUMP_VERSION,
           "created_at": dt.datetime.utcnow().isoformat() + "Z",
           "tables": {}}
    with _engine.connect() as conn:
        for name, table in meta.tables.items():
            if name in SKIP_RESTORE_TABLES:
                continue
            cols = [c.name for c in table.columns]
            rows = [
                {c: _json_safe(v) for c, v in zip(cols, row)}
                for row in conn.execute(table.select())
            ]
            out["tables"][name] = {"columns": cols, "rows": rows}
    return out


def _coerce(value, col):
    """Convert a JSON value back to the column's python type."""
    if value is None:
        return None
    try:
        py = col.type.python_type
    except NotImplementedError:
        return value
    if py is dt.date and isinstance(value, str):
        return dt.date.fromisoformat(value)
    if py is dt.datetime and isinstance(value, str):
        return dt.datetime.fromisoformat(value)
    if py is bool:
        return bool(value)
    if py is float and value != "":
        return float(value)
    if py is int and value != "":
        return int(value)
    return value


def _load_database(dump: dict) -> dict:
    """Replace table contents from a dump. Single transaction = all-or-nothing."""
    meta = MetaData()
    meta.reflect(bind=_engine)
    counts = {}
    with _engine.begin() as conn:                    # transaction
        for name, payload in dump["tables"].items():
            if name in SKIP_RESTORE_TABLES or name not in meta.tables:
                continue
            table = meta.tables[name]
            conn.execute(table.delete())
            rows = payload["rows"]
            if rows:
                colmap = {c.name: c for c in table.columns}
                fixed = [
                    {k: _coerce(v, colmap[k]) for k, v in r.items() if k in colmap}
                    for r in rows
                ]
                conn.execute(table.insert(), fixed)
            counts[name] = len(rows)
        # keep Postgres sequences in sync after explicit-PK inserts
        if _engine.url.get_backend_name().startswith("postgres"):
            for name in counts:
                pk = list(meta.tables[name].primary_key.columns)
                if len(pk) == 1 and pk[0].type.python_type is int:
                    conn.execute(text(
                        f"SELECT setval(pg_get_serial_sequence('{name}', '{pk[0].name}'), "
                        f"COALESCE((SELECT MAX({pk[0].name}) FROM {name}), 1))"))
    return counts


def _data_files() -> list[Path]:
    out = []
    for p in DATA_DIR.rglob("*"):
        if not p.is_file():
            continue
        if BACKUP_DIR in p.parents or p == BACKUP_DIR:
            continue
        if p.name in EXCLUDE_FILES or p.suffix in EXCLUDE_SUFFIXES:
            continue
        out.append(p)
    return out


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# create / list / restore
# --------------------------------------------------------------------------
def _recent_batch_excels(n: int = 4) -> list[tuple[str, bytes]]:
    """Build Air-Cargo Excel files for the most recent `n` batch dates.
    Returns a list of (filename, bytes) tuples.  Silently skips any batch
    that fails to export (e.g. missing label template)."""
    try:
        import io as _io
        from sqlalchemy import select as _sel, MetaData as _Meta
        from label_excel import build_aircargo_xlsx
        import datetime as _dt

        # Reflect tables through the engine directly (backup.py may be
        # imported before app.py finishes wiring, so we avoid app imports).
        meta = _Meta()
        meta.reflect(bind=_engine)
        if "shipments" not in meta.tables:
            return []
        table = meta.tables["shipments"]

        with _engine.connect() as conn:
            # Fetch the N most recent distinct batch dates
            dates_q = (
                _sel(table.c.batch_date)
                .distinct()
                .order_by(table.c.batch_date.desc())
                .limit(n)
            )
            batch_dates = [r[0] for r in conn.execute(dates_q).fetchall()]

        results = []
        for bd in batch_dates:
            try:
                with _engine.connect() as conn:
                    rows_q = (
                        _sel(table)
                        .where(table.c.batch_date == bd)
                        .order_by(table.c.box_number)
                    )
                    raw = conn.execute(rows_q).fetchall()
                    cols = [c.name for c in table.columns]

                def _safe(v):
                    if isinstance(v, (_dt.datetime, _dt.date)):
                        return v.isoformat()
                    return v

                row_dicts = [{c: _safe(v) for c, v in zip(cols, r)} for r in raw]
                if not row_dicts:
                    continue

                # bd may be a date or string
                if isinstance(bd, str):
                    bd_date = _dt.date.fromisoformat(bd)
                else:
                    bd_date = bd

                buf = _io.BytesIO()
                build_aircargo_xlsx(row_dicts, bd_date, buf)
                buf.seek(0)
                fname = f"Shipments_{bd_date.strftime('%Y-%m-%d')}.xlsx"
                results.append((fname, buf.read()))
            except Exception as e:
                log.warning("Could not export batch %s to Excel for backup: %s", bd, e)
        return results
    except Exception as e:
        log.warning("Skipping batch Excel export in backup: %s", e)
        return []


def create_backup(reason: str = "auto", upload: bool = True) -> dict:
    """Build a backup zip, store locally, upload to Drive, prune old copies.

    The ZIP contains:
    - database.json   — full JSON dump of all DB tables
    - files/*         — data-dir files (templates, uploads)
    - batch_exports/  — Air Cargo Excel for the 4 most recent batch dates
    - manifest.json   — names + SHA-256 checksums of all entries
    """
    with _lock:
        now = dt.datetime.now()
        suffix = "_pre-restore" if reason == "pre-restore" else ""
        name = f"monfreight_backup_{now:%Y-%m-%d_%H%M%S}{suffix}.zip"
        path = BACKUP_DIR / name

        dump = _dump_database()
        db_bytes = json.dumps(dump, ensure_ascii=False).encode()
        files = _data_files()

        # Build Excel files for the 4 most recent batch dates
        batch_excels = _recent_batch_excels(4)

        manifest = {
            "name": name, "reason": reason,
            "created_at": now.isoformat() + "Z",
            "row_counts": {t: len(p["rows"]) for t, p in dump["tables"].items()},
            "checksums": {"database.json": _sha256(db_bytes)},
            "files": {},
            "batch_exports": {},
        }
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("database.json", db_bytes)
            for f in files:
                rel = f"files/{f.relative_to(DATA_DIR)}"
                data = f.read_bytes()
                manifest["files"][rel] = _sha256(data)
                zf.writestr(rel, data)
            for fname, data in batch_excels:
                rel = f"batch_exports/{fname}"
                manifest["batch_exports"][rel] = _sha256(data)
                zf.writestr(rel, data)
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))

        size = path.stat().st_size
        log.info("Backup created: %s (%.1f KB, reason=%s, batch_excels=%d)",
                 name, size / 1024, reason, len(batch_excels))

        drive_id = _drive_upload(path) if upload else None
        _prune_local()
        if upload:
            _drive_prune()

        return {"name": name, "size": size, "created_at": manifest["created_at"],
                "row_counts": manifest["row_counts"],
                "batch_exports_included": [f for f, _ in batch_excels],
                "uploaded_to_drive": bool(drive_id), "reason": reason}


def _prune_local() -> None:
    cutoff = dt.datetime.now() - dt.timedelta(days=RETENTION_DAYS)
    for p in BACKUP_DIR.glob("monfreight_backup_*.zip"):
        if dt.datetime.fromtimestamp(p.stat().st_mtime) < cutoff:
            p.unlink(missing_ok=True)
            log.info("Pruned old local backup: %s", p.name)


def list_backups() -> list[dict]:
    """Merged local + Drive backups, newest first."""
    items: dict[str, dict] = {}
    for p in sorted(BACKUP_DIR.glob("monfreight_backup_*.zip")):
        items[p.name] = {"name": p.name, "size": p.stat().st_size,
                         "local": True, "drive": False, "drive_id": None}
    for f in _drive_list():
        e = items.setdefault(f["name"], {"name": f["name"],
                                         "size": int(f.get("size") or 0),
                                         "local": False, "drive": False,
                                         "drive_id": None})
        e["drive"], e["drive_id"] = True, f["id"]
    out = list(items.values())
    for e in out:
        m = re.search(r"(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})", e["name"])
        e["created_at"] = (f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4)}Z"
                           if m else None)
        e["pre_restore"] = "_pre-restore" in e["name"]
    out.sort(key=lambda e: e["name"], reverse=True)
    return out


def _local_path_for(name: str) -> Path:
    if not NAME_RE.fullmatch(name):
        raise HTTPException(400, "Invalid backup name.")
    return BACKUP_DIR / name


def _ensure_local(name: str) -> Path:
    """Make sure the named backup exists locally (download from Drive if not)."""
    path = _local_path_for(name)
    if path.exists():
        return path
    for f in _drive_list():
        if f["name"] == name:
            if _drive_download(f["id"], path):
                return path
            raise HTTPException(502, "Could not download backup from Google Drive.")
    raise HTTPException(404, "Backup not found locally or in Google Drive.")


def restore_backup(name: str, skip_snapshot: bool = False) -> dict:
    """Verify integrity → (optional) safety snapshot → transactional restore.

    skip_snapshot=True is used by auto_restore_on_startup when the database
    is empty; there is nothing worth snapshotting and we don't want to
    upload an empty backup to Google Drive.
    """
    path = _ensure_local(name)

    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        if "manifest.json" not in names or "database.json" not in names:
            raise HTTPException(400, "Backup file is incomplete or corrupted.")
        manifest = json.loads(zf.read("manifest.json"))
        db_bytes = zf.read("database.json")
        if _sha256(db_bytes) != manifest["checksums"]["database.json"]:
            raise HTTPException(400,
                "Integrity check FAILED for database.json — backup not restored.")
        for rel, expected in manifest.get("files", {}).items():
            if rel not in names or _sha256(zf.read(rel)) != expected:
                raise HTTPException(400,
                    f"Integrity check FAILED for {rel} — backup not restored.")

        # 1) safety snapshot of current state (skipped when DB is already empty)
        snapshot = create_backup(reason="pre-restore", upload=False) if not skip_snapshot else None

        with _lock:
            # 2) restore database inside one transaction
            counts = _load_database(json.loads(db_bytes))

            # 3) restore data files
            restored_files = []
            for rel in manifest.get("files", {}):
                target = (DATA_DIR / rel[len("files/"):]).resolve()
                if DATA_DIR.resolve() not in target.parents and target != DATA_DIR.resolve():
                    continue       # path traversal guard
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(rel))
                restored_files.append(rel)

    log.warning("RESTORE COMPLETED from %s — rows: %s, files: %d "
                "(safety snapshot: %s)", name, counts, len(restored_files),
                snapshot["name"] if snapshot else "skipped (DB was empty)")
    return {"ok": True, "restored_from": name, "row_counts": counts,
            "files_restored": len(restored_files),
            "safety_snapshot": snapshot["name"] if snapshot else None}


def last_backup_info() -> Optional[dict]:
    backups = [b for b in list_backups() if not b["pre_restore"]]
    return backups[0] if backups else None


# --------------------------------------------------------------------------
# API (admin only — enforced via auth.require_admin)
# --------------------------------------------------------------------------
router = APIRouter(prefix="/api/backups")


class RestoreIn(BaseModel):
    name: str
    confirm: bool = False


def _admin(request: Request):
    from auth import require_admin
    return require_admin(request)


@router.get("")
def api_list(request: Request):
    _admin(request)
    return {"backups": list_backups(),
            "drive_configured": drive_configured(),
            "retention_days": RETENTION_DAYS,
            "schedule_utc": BACKUP_TIME_UTC}


@router.post("/run")
def api_run(request: Request):
    admin = _admin(request)
    result = create_backup(reason="manual")
    try:
        from activity_log import log_activity
        ip = request.client.host if request.client else ""
        log_activity(admin.get("u", "admin"), "backup_created",
                     f"Manual backup: {result.get('name')}, "
                     f"size: {result.get('size', 0) // 1024} KB", ip)
    except Exception:
        pass
    return result


@router.get("/download/{name}")
def api_download(name: str, request: Request):
    _admin(request)
    path = _ensure_local(name)
    return FileResponse(path, filename=name, media_type="application/zip")


@router.post("/restore")
def api_restore(payload: RestoreIn, request: Request):
    admin = _admin(request)
    if not payload.confirm:
        raise HTTPException(400, "Restore not confirmed.")
    result = restore_backup(payload.name)
    try:
        from activity_log import log_activity
        ip = request.client.host if request.client else ""
        log_activity(admin.get("u", "admin"), "backup_restored",
                     f"Restored from: {payload.name}, "
                     f"safety snapshot: {result.get('safety_snapshot')}", ip)
    except Exception:
        pass
    return result


# --------------------------------------------------------------------------
# auto-restore on startup
# --------------------------------------------------------------------------
async def _auto_restore_on_startup() -> None:
    """Restore the latest backup automatically when the database is empty.

    This runs once at every startup *before* the daily scheduler begins.
    It is the key guard against data loss on Railway (or any platform with
    an ephemeral filesystem): each redeploy wipes the SQLite file, so on
    boot the database is empty and we pull the latest backup from Google
    Drive (or the local backup directory if a Volume is mounted).

    Behaviour
    ---------
    * Checks whether the ``shipments`` table is empty.
    * If empty, finds the newest non-pre-restore backup (Drive or local).
    * Restores it without creating a useless empty safety snapshot.
    * Logs clearly at WARNING level so the restore is visible in Railway logs.

    Control
    -------
    Set ``AUTO_RESTORE=0`` (or ``false``) in Railway → Variables to disable.
    Default is enabled.  Use ``AUTO_RESTORE=0`` only if you are certain your
    database is always persistent (e.g. Railway PostgreSQL with no data loss).
    """
    if os.environ.get("AUTO_RESTORE", "1").strip().lower() in ("0", "false", "no"):
        log.info("Auto-restore: disabled via AUTO_RESTORE env var.")
        return

    # ── 1. check whether a restore is needed ──────────────────────────────
    try:
        meta = MetaData()
        meta.reflect(bind=_engine)
        if "shipments" not in meta.tables:
            log.info("Auto-restore: shipments table not found yet, skipping.")
            return
        with _engine.connect() as conn:
            count = conn.execute(text("SELECT COUNT(*) FROM shipments")).scalar()
        if count and count > 0:
            log.info("Auto-restore: database has %d shipment(s) — no restore needed.", count)
            return
    except Exception as exc:                          # noqa: BLE001
        log.error("Auto-restore: could not read shipments table: %s", exc)
        return

    # ── 2. find the best available backup ─────────────────────────────────
    try:
        candidates = [b for b in list_backups() if not b.get("pre_restore")]
    except Exception as exc:                          # noqa: BLE001
        log.error("Auto-restore: could not list backups: %s", exc)
        return

    if not candidates:
        log.warning(
            "Auto-restore: shipments table is EMPTY and no backups are available "
            "(Drive not configured or no backups uploaded yet).  "
            "Starting with an empty database."
        )
        return

    latest = candidates[0]   # list_backups() returns newest-first
    log.warning(
        "Auto-restore: EMPTY database detected on startup — "
        "restoring from backup: %s  (Drive=%s, local=%s)",
        latest["name"], latest.get("drive"), latest.get("local"),
    )

    # ── 3. restore ─────────────────────────────────────────────────────────
    try:
        result = await asyncio.to_thread(
            restore_backup, latest["name"], True   # skip_snapshot=True
        )
        log.warning(
            "Auto-restore COMPLETED: %d shipment row(s) restored from %s.",
            result.get("row_counts", {}).get("shipments", 0),
            latest["name"],
        )
    except Exception as exc:                          # noqa: BLE001
        log.error(
            "Auto-restore FAILED — application is starting with an empty database. "
            "Error: %s", exc,
        )


# --------------------------------------------------------------------------
# daily scheduler
# --------------------------------------------------------------------------
async def _scheduler() -> None:
    # catch-up backup shortly after boot when the last one is >25h old
    await asyncio.sleep(20)
    try:
        last = last_backup_info()
        stale = True
        if last and last.get("created_at"):
            age = dt.datetime.utcnow() - dt.datetime.fromisoformat(
                last["created_at"].rstrip("Z"))
            stale = age > dt.timedelta(hours=25)
        if stale:
            log.info("No recent backup found — running catch-up backup.")
            await asyncio.to_thread(create_backup, "auto")
    except Exception as e:                            # noqa: BLE001
        log.error("Catch-up backup failed: %s", e)

    hh, mm = (int(x) for x in BACKUP_TIME_UTC.split(":"))
    while True:
        now = dt.datetime.utcnow()
        nxt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if nxt <= now:
            nxt += dt.timedelta(days=1)
        await asyncio.sleep((nxt - now).total_seconds())
        try:
            await asyncio.to_thread(create_backup, "auto")
        except Exception as e:                        # noqa: BLE001
            log.error("Scheduled backup failed: %s", e)


def init_backup(app, engine) -> None:
    global _engine
    _engine = engine
    app.include_router(router)

    @app.on_event("startup")
    async def _start_scheduler():
        # Auto-restore must complete first so the scheduler sees real data.
        await _auto_restore_on_startup()
        asyncio.create_task(_scheduler())

    log.info("Backups enabled: daily at %s UTC, retention %d days, Drive: %s",
             BACKUP_TIME_UTC, RETENTION_DAYS,
             "configured" if drive_configured() else "NOT configured (local only)")
