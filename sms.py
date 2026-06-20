"""
Mon Freight CDP — Sender SMS notifications (Twilio).

Lets admin users send parcel-update SMS messages to the *senders* of every
shipment in a selected batch.  Built to mirror the existing Twilio integration
in auth.py (login OTP codes) and the activity_log.py module structure.

Design notes
------------
* Configuration is read from environment variables and the feature stays in
  a safe DEV MODE until they are present, so nothing breaks before the real
  Twilio account exists:
      TWILIO_ACCOUNT_SID    shared with auth.py
      TWILIO_AUTH_TOKEN     shared with auth.py
      TWILIO_SMS_FROM       dedicated parcel-update sender number (E.164).
                            Falls back to TWILIO_FROM if unset.
* Only Australian mobile numbers are targeted.  Sender phone numbers stored in
  any common local form (04xx xxx xxx, 4xxxxxxxx, +61 4xx…, 61 4xx…) are
  auto-normalised to E.164 (+614xxxxxxxx).  Anything that is not a valid AU
  mobile is flagged so the admin can review (it is excluded from sending unless
  the admin explicitly adds a valid number).
* Every send attempt — success or failure — is recorded in sms_history.
* All routes require admin access (require_admin from auth.py).
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import re
from typing import Optional

import requests as _requests
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import (Column, Date, DateTime, Integer, String, Text, func,
                        select, text)
from sqlalchemy.orm import DeclarativeBase, Session

log = logging.getLogger("monfreight.sms")

_engine = None


# --------------------------------------------------------------------------
# model
# --------------------------------------------------------------------------
class SMSBase(DeclarativeBase):
    pass


class SMSHistory(SMSBase):
    """One row per recipient per send attempt."""
    __tablename__ = "sms_history"
    id          = Column(Integer, primary_key=True)
    batch_date  = Column(Date, index=True)
    phone       = Column(String, nullable=False)       # E.164, as sent
    message     = Column(Text, default="")             # full body (Unicode)
    status      = Column(String, default="", index=True)  # "sent" | "failed"
    error       = Column(String, default="")           # provider error, if any
    twilio_sid  = Column(String, default="")           # Twilio message SID
    admin_user  = Column(String, default="", index=True)
    sent_at     = Column(DateTime, default=dt.datetime.now, index=True)


def init_sms(engine) -> None:
    """Create the sms_history table and register the module engine."""
    global _engine
    _engine = engine
    SMSBase.metadata.create_all(engine)
    log.info("SMS notifications enabled. Twilio: %s",
             "configured" if sms_configured() else
             "DEV MODE (messages logged, not sent)")


# --------------------------------------------------------------------------
# Twilio config (kept separate so parcel SMS can use its own sender number)
# --------------------------------------------------------------------------
def _sms_from() -> str:
    """Dedicated parcel-update sender number, falling back to the login
    (OTP) number so the feature still works with a single configured number."""
    return (os.environ.get("TWILIO_SMS_FROM")
            or os.environ.get("TWILIO_FROM") or "").strip()


def sms_configured() -> bool:
    """True only when we have credentials AND a sender number."""
    return bool(os.environ.get("TWILIO_ACCOUNT_SID")
                and os.environ.get("TWILIO_AUTH_TOKEN")
                and _sms_from())


def _mask_from(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) < 6:
        return value or "(not set)"
    return f"+{digits[:4]}•••{digits[-3:]}"


# --------------------------------------------------------------------------
# Australian mobile-number normalisation
# --------------------------------------------------------------------------
# AU mobile numbers are 04xx xxx xxx locally → +61 4xx xxx xxx in E.164.
# The national number (after the country code) is always 9 digits starting
# with 4.
def normalize_au_mobile(raw: str) -> tuple[Optional[str], str]:
    """Return (e164, reason).

    * On success: ("+614XXXXXXXX", "ok").
    * On failure: (None, human-readable reason) so the UI can flag it.

    Accepts the common stored forms, ignoring spaces, dashes, brackets and a
    spurious trailing ``.0`` (Excel float artefact)::

        0412 345 678     +61412345678
        0412-345-678     +61412345678
        412345678        +61412345678
        +61 412 345 678  +61412345678
        0061412345678    +61412345678
    """
    if raw is None:
        return None, "empty"
    s = str(raw).strip()
    if not s:
        return None, "empty"
    # Excel float artefact: "412345678.0" → "412345678"
    if s.endswith(".0") and s[:-2].lstrip("+").isdigit():
        s = s[:-2]

    has_plus = s.strip().startswith("+")
    digits = re.sub(r"\D", "", s)
    if not digits:
        return None, "no digits"

    # Strip international prefixes → leave the national part.
    if digits.startswith("0011"):           # AU international dialling prefix
        digits = digits[4:]
    if digits.startswith("00"):             # generic international prefix
        digits = digits[2:]
    if digits.startswith("61"):             # country code (with/without +)
        national = digits[2:]
    elif has_plus:
        # +<something not 61> → not an Australian number
        return None, "non-AU (+%s…)" % digits[:3]
    elif digits.startswith("0"):            # local form 04xxxxxxxx
        national = digits[1:]
    else:
        national = digits                   # bare 4xxxxxxxx

    if not national.startswith("4"):
        return None, "not an AU mobile"
    if len(national) != 9:
        return None, f"wrong length ({len(national)} digits)"
    return "+61" + national, "ok"


# --------------------------------------------------------------------------
# batch / recipient lookup (queries the shared shipments table directly so we
# don't have to import the Shipment model from app.py — avoids a circular import)
# --------------------------------------------------------------------------
def list_batches() -> list[dict]:
    """Distinct batch dates that have at least one shipment, newest first,
    with a sender count for each."""
    if not _engine:
        return []
    with Session(_engine) as s:
        rows = s.execute(text(
            "SELECT batch_date, COUNT(*) AS n "
            "FROM shipments GROUP BY batch_date ORDER BY batch_date DESC"
        )).all()
    out = []
    for r in rows:
        d = r[0]
        d_str = d.isoformat() if hasattr(d, "isoformat") else str(d)
        out.append({"date": d_str, "shipments": r[1]})
    return out


def recipients_for_batch(batch_date: dt.date) -> list[dict]:
    """Sender phone numbers for a batch, normalised and flagged.

    Receiver phones are deliberately ignored — we only message senders.
    Duplicate sender numbers (same normalised E.164) are collapsed so we never
    text the same person twice for one batch.
    """
    if not _engine:
        return []
    with Session(_engine) as s:
        rows = s.execute(text(
            "SELECT sender_name, sender_phone, box_number FROM shipments "
            "WHERE batch_date = :d ORDER BY box_number"
        ), {"d": batch_date}).all()

    seen: dict[str, dict] = {}
    out: list[dict] = []
    for name, phone, box in rows:
        e164, reason = normalize_au_mobile(phone)
        key = e164 or f"raw:{(phone or '').strip()}:{box}"
        if key in seen:
            # already have this number — just remember the extra sender name
            continue
        rec = {
            "name": (name or "").strip(),
            "raw": (str(phone).strip() if phone is not None else ""),
            "phone": e164 or "",
            "valid": e164 is not None,
            "reason": reason,
            "box": box,
        }
        seen[key] = rec
        out.append(rec)
    return out


# --------------------------------------------------------------------------
# sending
# --------------------------------------------------------------------------
def _send_one(to: str, body: str) -> dict:
    """Send a single SMS. Never raises — returns a status dict so one bad
    number doesn't abort a whole batch.

    DEV MODE (no Twilio config): pretends to send and records status
    ``dev`` so admins can exercise the full flow before go-live.
    """
    if not sms_configured():
        log.info("[SMS DEV MODE] would send to %s: %s", to, body[:60])
        return {"phone": to, "status": "dev",
                "error": "Twilio not configured — message not actually sent.",
                "sid": ""}

    sid = os.environ["TWILIO_ACCOUNT_SID"]
    token = os.environ["TWILIO_AUTH_TOKEN"]
    sender = _sms_from()
    try:
        resp = _requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
            auth=(sid, token),
            # requests encodes data as UTF-8 form fields → Twilio accepts
            # Unicode (incl. Mongolian Cyrillic) and segments as UCS-2.
            data={"To": to, "From": sender, "Body": body},
            timeout=20,
        )
    except Exception as exc:                       # network / DNS / timeout
        log.warning("Twilio request failed for %s: %s", to, exc)
        return {"phone": to, "status": "failed",
                "error": f"Network error: {exc}", "sid": ""}

    if resp.status_code >= 300:
        msg = resp.text[:300]
        try:
            msg = resp.json().get("message", msg)
        except Exception:
            pass
        log.warning("Twilio send failed (%s) for %s: %s",
                    resp.status_code, to, msg)
        return {"phone": to, "status": "failed",
                "error": f"{resp.status_code}: {msg}", "sid": ""}

    try:
        sid_msg = resp.json().get("sid", "")
    except Exception:
        sid_msg = ""
    return {"phone": to, "status": "sent", "error": "", "sid": sid_msg}


def _record(batch_date: Optional[dt.date], phone: str, message: str,
            result: dict, admin_user: str) -> None:
    if not _engine:
        return
    try:
        with Session(_engine) as s:
            s.add(SMSHistory(
                batch_date=batch_date,
                phone=phone,
                message=message[:2000],
                status=result.get("status", ""),
                error=(result.get("error") or "")[:500],
                twilio_sid=result.get("sid", ""),
                admin_user=admin_user or "unknown",
                sent_at=dt.datetime.now(),
            ))
            s.commit()
    except Exception as exc:
        log.warning("Could not write SMS history: %s", exc)


# --------------------------------------------------------------------------
# request models
# --------------------------------------------------------------------------
class SendPayload(BaseModel):
    batch_date: Optional[str] = None
    message: str
    recipients: list[str]          # E.164 numbers the admin confirmed


# --------------------------------------------------------------------------
# router  (admin-only)
# --------------------------------------------------------------------------
router = APIRouter(prefix="/api/sms")


def _admin(request: Request) -> dict:
    from auth import require_admin
    return require_admin(request)


def _username(request: Request) -> str:
    user = getattr(request.state, "user", None)
    return user.get("u", "unknown") if user else "unknown"


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


@router.get("/status")
def sms_status(request: Request):
    """Whether Twilio is configured + the (masked) sender number."""
    _admin(request)
    configured = sms_configured()
    return {
        "configured": configured,
        "from": _mask_from(_sms_from()) if _sms_from() else "",
        "dev_mode": not configured,
    }


@router.get("/batches")
def sms_batches(request: Request):
    """Batch dates available to message, newest first."""
    _admin(request)
    return {"batches": list_batches()}


@router.get("/recipients")
def sms_recipients(request: Request, date: str):
    """Sender recipients for a batch date (normalised + flagged)."""
    _admin(request)
    try:
        d = dt.date.fromisoformat(date)
    except ValueError:
        raise HTTPException(400, "Invalid date. Use YYYY-MM-DD.")
    recs = recipients_for_batch(d)
    valid = sum(1 for r in recs if r["valid"])
    return {
        "date": date,
        "recipients": recs,
        "total": len(recs),
        "valid": valid,
        "invalid": len(recs) - valid,
    }


@router.post("/validate-number")
def sms_validate_number(request: Request, payload: dict):
    """Validate/normalise a single number the admin wants to add manually."""
    _admin(request)
    raw = (payload or {}).get("phone", "")
    e164, reason = normalize_au_mobile(raw)
    return {"raw": raw, "phone": e164 or "", "valid": e164 is not None,
            "reason": reason}


@router.post("/send")
def sms_send(request: Request, payload: SendPayload):
    """Send the (admin-edited) message to the confirmed recipient list.

    Each recipient is re-validated server-side, sent individually, and the
    outcome recorded in sms_history.  Returns a per-recipient result list.
    """
    admin = _admin(request)
    admin_user = admin.get("u", "unknown")

    message = (payload.message or "").strip()
    if not message:
        raise HTTPException(400, "Message text is empty.")
    if not payload.recipients:
        raise HTTPException(400, "No recipients selected.")

    batch_date = None
    if payload.batch_date:
        try:
            batch_date = dt.date.fromisoformat(payload.batch_date)
        except ValueError:
            batch_date = None

    # De-duplicate + re-validate every number on the server side. We never
    # trust the client to have filtered correctly.
    seen: set[str] = set()
    valid_targets: list[str] = []
    rejected: list[dict] = []
    for raw in payload.recipients:
        e164, reason = normalize_au_mobile(raw)
        if not e164:
            rejected.append({"phone": raw, "status": "rejected",
                             "error": reason, "sid": ""})
            continue
        if e164 in seen:
            continue
        seen.add(e164)
        valid_targets.append(e164)

    results: list[dict] = []
    sent = failed = 0
    for to in valid_targets:
        res = _send_one(to, message)
        _record(batch_date, to, message, res, admin_user)
        results.append(res)
        if res["status"] in ("sent", "dev"):
            sent += 1
        else:
            failed += 1

    # Record rejected numbers too, so history is complete.
    for r in rejected:
        _record(batch_date, r["phone"], message, r, admin_user)

    # Activity-log a single summary line.
    try:
        from activity_log import log_activity
        log_activity(
            admin_user, "sms_sent",
            f"Batch: {payload.batch_date or '-'}, recipients: {len(valid_targets)}, "
            f"sent: {sent}, failed: {failed}, rejected: {len(rejected)}",
            _client_ip(request),
        )
    except Exception:
        pass

    return {
        "ok": True,
        "sent": sent,
        "failed": failed,
        "rejected": len(rejected),
        "dev_mode": not sms_configured(),
        "results": results + rejected,
    }


@router.get("/history")
def sms_history(request: Request, limit: int = 200, offset: int = 0,
                date: Optional[str] = None):
    """Recent SMS history, newest first. Optional batch-date filter."""
    _admin(request)
    if not _engine:
        return {"history": [], "total": 0}
    limit = min(max(1, int(limit)), 1000)

    with Session(_engine) as s:
        base_q = select(SMSHistory)
        if date:
            try:
                base_q = base_q.where(SMSHistory.batch_date == dt.date.fromisoformat(date))
            except ValueError:
                pass
        total = s.scalar(select(func.count()).select_from(base_q.subquery())) or 0
        rows = list(s.scalars(
            base_q.order_by(SMSHistory.sent_at.desc()).offset(offset).limit(limit)
        ).all())

    return {
        "total": total,
        "history": [
            {
                "id": r.id,
                "batch_date": r.batch_date.isoformat() if r.batch_date else "",
                "phone": r.phone,
                "message": r.message or "",
                "status": r.status or "",
                "error": r.error or "",
                "admin_user": r.admin_user or "",
                "sent_at": r.sent_at.strftime("%Y-%m-%d %H:%M") if r.sent_at else "",
            }
            for r in rows
        ],
    }
