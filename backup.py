"""
Mon Freight CDP — Automatic backup, cloud sync (Google Drive) and restore.

What gets backed up
-------------------
* Every database table (shipments, users, …) as an engine-agnostic JSON dump
  — works identically for SQLite and PostgreSQL.
* Every file in the data/ folder (label templates, uploads), excluding the
  live database file and secrets.
* A manifest with SHA-256 checksums so integrity can be verified on restore.

Schedule & retention
--------------------
* Automatic daily backup at BACKUP_TIME_UTC (default 17:00 UTC ≈ 3am Sydney).
* A catch-up backup runs at startup if the last one is older than 25 hours.
* Local + Google Drive copies are both kept for BACKUP_RETENTION_DAYS (30).

Restore
-------
* Admin picks a backup (local or Drive) in Settings → confirmation screen →
  one-click restore.
* Integrity: checksums verified first; an automatic "pre-restore" safety
  snapshot is taken; the table reload runs inside a single transaction.

Environment variables
---------------------
GDRIVE_SERVICE_ACCOUNT_JSON  full JSON key of a Google service account, or
GDRIVE_SERVICE_ACCOUNT_FILE  path to the key file
GDRIVE_FOLDER_ID             ID of the Drive folder shared with that account
BACKUP_TIME_UTC              "HH:MM" daily run time (default "17:00")
BACKUP_RETENTION_DAYS        default 30
BACKUP_DIR                   local folder (default data/backups)
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
# Google Drive (service-account, REST v3 — no heavy SDK)
# --------------------------------------------------------------------------
def _drive_folder() -> str:
    return os.environ.get("GDRIVE_FOLDER_ID", "").strip()


def drive_configured() -> bool:
    return bool(_drive_folder() and (
        os.environ.get("GDRIVE_SERVICE_ACCOUNT_JSON")
        or os.environ.get("GDRIVE_SERVICE_ACCOUNT_FILE")))


def _drive_session():
    """AuthorizedSession for the Drive API, or None if not configured."""
    if not drive_configured():
        return None
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
        scopes = ["https://www.googleapis.com/auth/drive"]
        raw = os.environ.get("GDRIVE_SERVICE_ACCOUNT_JSON", "")
        if raw:
            creds = service_account.Credentials.from_service_account_info(
                json.loads(raw), scopes=scopes)
        else:
            creds = service_account.Credentials.from_service_account_file(
                os.environ["GDRIVE_SERVICE_ACCOUNT_FILE"], scopes=scopes)
        return AuthorizedSession(creds)
    except Exception as e:                            # noqa: BLE001
        log.error("Google Drive auth failed: %s", e)
        return None


def _drive_upload(path: Path) -> Optional[str]:
    sess = _drive_session()
    if not sess:
        return None
    meta = json.dumps({"name": path.name, "parents": [_drive_folder()]})
    body = io.BytesIO()
    boundary = "mf_backup_boundary"
    body.write(f"--{boundary}\r\nContent-Type: application/json; "
               f"charset=UTF-8\r\n\r\n{meta}\r\n".encode())
    body.write(f"--{boundary}\r\nContent-Type: application/zip\r\n\r\n".encode())
    body.write(path.read_bytes())
    body.write(f"\r\n--{boundary}--".encode())
    r = sess.post(
        "https://www.googleapis.com/upload/drive/v3/files"
        "?uploadType=multipart&supportsAllDrives=true",
        headers={"Content-Type": f"multipart/related; boundary={boundary}"},
        data=body.getvalue(), timeout=120)
    if r.status_code >= 300:
        log.error("Drive upload failed (%s): %s", r.status_code, r.text[:300])
        return None
    file_id = r.json().get("id")
    log.info("Backup uploaded to Google Drive: %s (id=%s)", path.name, file_id)
    return file_id


def _drive_list() -> list[dict]:
    sess = _drive_session()
    if not sess:
        return []
    q = (f"'{_drive_folder()}' in parents and trashed=false "
         f"and name contains 'monfreight_backup_'")
    r = sess.get("https://www.googleapis.com/drive/v3/files",
                 params={"q": q, "pageSize": 200,
                         "fields": "files(id,name,size,createdTime)",
                         "supportsAllDrives": "true",
                         "includeItemsFromAllDrives": "true"},
                 timeout=30)
    if r.status_code >= 300:
        log.error("Drive list failed (%s): %s", r.status_code, r.text[:300])
        return []
    return r.json().get("files", [])


def _drive_download(file_id: str, dest: Path) -> bool:
    sess = _drive_session()
    if not sess:
        return False
    r = sess.get(f"https://www.googleapis.com/drive/v3/files/{file_id}"
                 f"?alt=media&supportsAllDrives=true", timeout=300)
    if r.status_code >= 300:
        log.error("Drive download failed (%s)", r.status_code)
        return False
    dest.write_bytes(r.content)
    return True


def _drive_prune() -> None:
    cutoff = dt.datetime.utcnow() - dt.timedelta(days=RETENTION_DAYS)
    sess = _drive_session()
    if not sess:
        return
    for f in _drive_list():
        try:
            created = dt.datetime.fromisoformat(
                f["createdTime"].replace("Z", "+00:00")).replace(tzinfo=None)
            if created < cutoff:
                sess.delete(f"https://www.googleapis.com/drive/v3/files/{f['id']}"
                            f"?supportsAllDrives=true", timeout=30)
                log.info("Pruned old Drive backup: %s", f["name"])
        except Exception as e:                        # noqa: BLE001
            log.warning("Drive prune skipped %s: %s", f.get("name"), e)


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
def create_backup(reason: str = "auto", upload: bool = True) -> dict:
    """Build a backup zip, store locally, upload to Drive, prune old copies."""
    with _lock:
        now = dt.datetime.utcnow()
        suffix = "_pre-restore" if reason == "pre-restore" else ""
        name = f"monfreight_backup_{now:%Y-%m-%d_%H%M%S}{suffix}.zip"
        path = BACKUP_DIR / name

        dump = _dump_database()
        db_bytes = json.dumps(dump, ensure_ascii=False).encode()
        files = _data_files()

        manifest = {
            "name": name, "reason": reason,
            "created_at": now.isoformat() + "Z",
            "row_counts": {t: len(p["rows"]) for t, p in dump["tables"].items()},
            "checksums": {"database.json": _sha256(db_bytes)},
            "files": {},
        }
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("database.json", db_bytes)
            for f in files:
                rel = f"files/{f.relative_to(DATA_DIR)}"
                data = f.read_bytes()
                manifest["files"][rel] = _sha256(data)
                zf.writestr(rel, data)
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))

        size = path.stat().st_size
        log.info("Backup created: %s (%.1f KB, reason=%s)", name, size / 1024, reason)

        drive_id = _drive_upload(path) if upload else None
        _prune_local()
        if upload:
            _drive_prune()

        return {"name": name, "size": size, "created_at": manifest["created_at"],
                "row_counts": manifest["row_counts"],
                "uploaded_to_drive": bool(drive_id), "reason": reason}


def _prune_local() -> None:
    cutoff = dt.datetime.utcnow() - dt.timedelta(days=RETENTION_DAYS)
    for p in BACKUP_DIR.glob("monfreight_backup_*.zip"):
        if dt.datetime.utcfromtimestamp(p.stat().st_mtime) < cutoff:
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


def restore_backup(name: str) -> dict:
    """Verify integrity → safety snapshot → transactional restore."""
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

        # 1) safety snapshot of current state (kept locally)
        snapshot = create_backup(reason="pre-restore", upload=False)

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
                snapshot["name"])
    return {"ok": True, "restored_from": name, "row_counts": counts,
            "files_restored": len(restored_files),
            "safety_snapshot": snapshot["name"]}


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
    _admin(request)
    return create_backup(reason="manual")


@router.get("/download/{name}")
def api_download(name: str, request: Request):
    _admin(request)
    path = _ensure_local(name)
    return FileResponse(path, filename=name, media_type="application/zip")


@router.post("/restore")
def api_restore(payload: RestoreIn, request: Request):
    _admin(request)
    if not payload.confirm:
        raise HTTPException(400, "Restore not confirmed.")
    return restore_backup(payload.name)


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
        asyncio.create_task(_scheduler())

    log.info("Backups enabled: daily at %s UTC, retention %d days, Drive: %s",
             BACKUP_TIME_UTC, RETENTION_DAYS,
             "configured" if drive_configured() else "NOT configured (local only)")
