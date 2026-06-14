"""
Mon Freight CDP — User Activity Logging.

Provides a shared ActivityLog model and helper used by both auth.py and app.py.
Logs are written to the same database as the rest of the application.
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Optional

from fastapi import APIRouter, Request
from sqlalchemy import Column, DateTime, Integer, String, select
from sqlalchemy.orm import DeclarativeBase, Session

log = logging.getLogger("monfreight.activity")

_engine = None


class LogBase(DeclarativeBase):
    pass


class ActivityLog(LogBase):
    __tablename__ = "activity_logs"
    id        = Column(Integer, primary_key=True)
    username  = Column(String, nullable=False, index=True)
    action    = Column(String, nullable=False, index=True)
    details   = Column(String, default="")
    ip        = Column(String, default="")
    timestamp = Column(DateTime, default=dt.datetime.utcnow, index=True)


def init_activity_log(engine) -> None:
    """Create the activity_logs table and register the module engine."""
    global _engine
    _engine = engine
    LogBase.metadata.create_all(engine)
    log.info("Activity logging enabled.")


def log_activity(username: str, action: str,
                 details: str = "", ip: str = "") -> None:
    """Insert one log entry.  Silent on any DB error so logging never
    disrupts the main request flow."""
    if not _engine:
        return
    try:
        with Session(_engine) as s:
            s.add(ActivityLog(
                username=username or "system",
                action=action,
                details=details[:2000],   # cap detail length
                ip=ip,
                timestamp=dt.datetime.utcnow(),
            ))
            s.commit()
    except Exception as exc:
        log.warning("Could not write activity log: %s", exc)


# --------------------------------------------------------------------------
# API routes  (admin-only)
# --------------------------------------------------------------------------
router = APIRouter(prefix="/api/activity-logs")


def _admin(request: Request):
    from auth import require_admin
    return require_admin(request)


@router.get("")
def api_list_logs(request: Request,
                  limit: int = 200,
                  offset: int = 0,
                  user: Optional[str] = None,
                  action: Optional[str] = None):
    """Return recent activity log entries (newest first).

    Query params:
      limit   – max rows to return (default 200, max 1000)
      offset  – skip N most-recent rows (for pagination)
      user    – filter by username substring
      action  – filter by action substring
    """
    _admin(request)
    if not _engine:
        return {"logs": [], "total": 0}

    limit = min(max(1, int(limit)), 1000)

    with Session(_engine) as s:
        base_q = select(ActivityLog)
        if user:
            base_q = base_q.where(ActivityLog.username.ilike(f"%{user}%"))
        if action:
            base_q = base_q.where(ActivityLog.action.ilike(f"%{action}%"))

        # Count matching rows
        from sqlalchemy import func
        count_q = select(func.count()).select_from(base_q.subquery())
        total = s.scalar(count_q) or 0

        rows = list(s.scalars(
            base_q.order_by(ActivityLog.timestamp.desc())
                  .offset(offset).limit(limit)
        ).all())

    return {
        "total": total,
        "logs": [
            {
                "id": r.id,
                "username": r.username,
                "action": r.action,
                "details": r.details or "",
                "ip": r.ip or "",
                "timestamp": (r.timestamp.isoformat() + "Z") if r.timestamp else None,
            }
            for r in rows
        ],
    }
