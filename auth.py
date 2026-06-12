"""
Mon Freight CDP — Authentication & user management.

Features
--------
* Username + password login (PBKDF2-SHA256 hashed passwords, 600k iterations)
* Mandatory 2nd step: 6-digit SMS verification code (Twilio) sent to the
  user's registered mobile number. Codes expire after 5 minutes.
* Brute-force protection: account lockout after repeated bad passwords,
  per-user/per-IP limits on code sends, max 5 wrong code attempts per code.
* Signed, HttpOnly session cookies (itsdangerous), 12h lifetime by default.
* Admin-managed users (no public sign-up). First run creates a default
  admin account and prints its credentials to the server log.

Environment variables
---------------------
SECRET_KEY            cookie-signing secret (auto-generated & persisted if unset)
SESSION_HOURS         session lifetime in hours (default 12)
ADMIN_USERNAME        default admin username        (default "admin")
ADMIN_PASSWORD        default admin password        (default: random, logged once)
ADMIN_PHONE           default admin mobile, E.164 e.g. +61400000000
TWILIO_ACCOUNT_SID    Twilio credentials — if missing, runs in DEV MODE:
TWILIO_AUTH_TOKEN     the code is shown on the login page instead of sent
TWILIO_FROM           by SMS (configure Twilio before real go-live!)
OTP_TTL_SECONDS       code lifetime (default 300 = 5 minutes)
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from pathlib import Path
from typing import Optional

import requests as _requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel
from sqlalchemy import (Boolean, Column, DateTime, Integer, String, select)
from sqlalchemy.orm import DeclarativeBase, Session

log = logging.getLogger("monfreight.auth")
logging.basicConfig(level=logging.INFO)

# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

SESSION_HOURS = int(os.environ.get("SESSION_HOURS", "12"))
OTP_TTL = int(os.environ.get("OTP_TTL_SECONDS", "300"))          # 5 minutes
OTP_MAX_ATTEMPTS = 5            # wrong-code guesses per code
OTP_RESEND_COOLDOWN = 60        # seconds between sends
OTP_MAX_PER_HOUR = 5            # codes per user per hour
OTP_MAX_PER_IP_HOUR = 12        # codes per IP per hour
LOCKOUT_FAILS = 5               # bad passwords before lockout
LOCKOUT_WINDOW = 15 * 60        # seconds

PBKDF2_ITERATIONS = 600_000

SESSION_COOKIE = "mf_session"
PENDING_COOKIE = "mf_pending"

# Paths reachable without a session
PUBLIC_PREFIXES = ("/static/", "/auth/")
PUBLIC_PATHS = {"/login", "/api/health", "/favicon.ico"}


def _load_secret_key() -> str:
    """SECRET_KEY from env, else generate once and persist next to the DB."""
    key = os.environ.get("SECRET_KEY", "").strip()
    if key:
        return key
    keyfile = DATA_DIR / ".secret_key"
    if keyfile.exists():
        return keyfile.read_text().strip()
    key = secrets.token_urlsafe(48)
    keyfile.write_text(key)
    try:
        keyfile.chmod(0o600)
    except OSError:
        pass
    return key


SECRET_KEY = _load_secret_key()
_session_signer = URLSafeTimedSerializer(SECRET_KEY, salt="mf-session")
_pending_signer = URLSafeTimedSerializer(SECRET_KEY, salt="mf-pending")


# --------------------------------------------------------------------------
# models
# --------------------------------------------------------------------------
class AuthBase(DeclarativeBase):
    pass


class User(AuthBase):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String, nullable=False, unique=True, index=True)
    password_hash = Column(String, nullable=False)
    phone = Column(String, default="")            # E.164, e.g. +61400000000
    role = Column(String, default="staff")        # "admin" | "staff"
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=dt.datetime.utcnow)
    last_login = Column(DateTime, nullable=True)


class LoginCode(AuthBase):
    __tablename__ = "login_codes"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    code_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=dt.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    attempts = Column(Integer, default=0)
    used = Column(Boolean, default=False)


# --------------------------------------------------------------------------
# password hashing (PBKDF2-SHA256 — stdlib, no external crypto dependency)
# --------------------------------------------------------------------------
def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, expected = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def _hash_code(code: str) -> str:
    return hmac.new(SECRET_KEY.encode(), code.encode(), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------
# in-memory rate limiting (single-process deployment)
# --------------------------------------------------------------------------
_pw_fails: dict[str, list[float]] = {}        # username -> fail timestamps
_otp_sends: dict[str, list[float]] = {}       # "u:<id>" / "ip:<addr>" -> send timestamps


def _prune(times: list[float], window: float) -> list[float]:
    cutoff = time.time() - window
    return [t for t in times if t > cutoff]


def _locked_out(username: str) -> Optional[int]:
    fails = _prune(_pw_fails.get(username, []), LOCKOUT_WINDOW)
    _pw_fails[username] = fails
    if len(fails) >= LOCKOUT_FAILS:
        return int(LOCKOUT_WINDOW - (time.time() - fails[0]))
    return None


def _record_fail(username: str) -> None:
    _pw_fails.setdefault(username, []).append(time.time())


def _can_send_otp(user_id: int, ip: str) -> Optional[str]:
    ukey, ikey = f"u:{user_id}", f"ip:{ip}"
    usends = _prune(_otp_sends.get(ukey, []), 3600)
    isends = _prune(_otp_sends.get(ikey, []), 3600)
    _otp_sends[ukey], _otp_sends[ikey] = usends, isends
    if usends and time.time() - usends[-1] < OTP_RESEND_COOLDOWN:
        wait = int(OTP_RESEND_COOLDOWN - (time.time() - usends[-1]))
        return f"Please wait {wait}s before requesting another code."
    if len(usends) >= OTP_MAX_PER_HOUR or len(isends) >= OTP_MAX_PER_IP_HOUR:
        return "Too many codes requested. Try again later."
    return None


def _record_send(user_id: int, ip: str) -> None:
    now = time.time()
    _otp_sends.setdefault(f"u:{user_id}", []).append(now)
    _otp_sends.setdefault(f"ip:{ip}", []).append(now)


# --------------------------------------------------------------------------
# SMS (Twilio REST API; dev mode when credentials are missing)
# --------------------------------------------------------------------------
def twilio_configured() -> bool:
    return all(os.environ.get(k) for k in
               ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"))


def send_sms(to: str, body: str) -> None:
    sid = os.environ["TWILIO_ACCOUNT_SID"]
    token = os.environ["TWILIO_AUTH_TOKEN"]
    sender = os.environ["TWILIO_FROM"]
    resp = _requests.post(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
        auth=(sid, token),
        data={"To": to, "From": sender, "Body": body},
        timeout=15,
    )
    if resp.status_code >= 300:
        log.error("Twilio send failed (%s): %s", resp.status_code, resp.text[:300])
        raise HTTPException(502, "Failed to send SMS verification code. "
                                 "Please try again or contact the administrator.")


def _phones(user: "User") -> list[str]:
    """A user may have several registered mobiles (comma-separated)."""
    return [p.strip() for p in (user.phone or "").split(",") if p.strip()]


PHONES_RE = re.compile(r"\+\d{7,15}(\s*,\s*\+\d{7,15})*")


def _normalize_phones(raw: str) -> str:
    return ",".join(p.strip() for p in raw.split(",") if p.strip())


def _mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    if len(digits) < 6:
        return "your registered number"
    return f"+{digits[:5]}•••{digits[-3:]}"


# --------------------------------------------------------------------------
# session helpers
# --------------------------------------------------------------------------
def _set_cookie(resp, name: str, value: str, max_age: int) -> None:
    # Secure flag: on when explicitly requested, or automatically on
    # Render / Railway (both serve over HTTPS).
    secure = (os.environ.get("COOKIE_SECURE", "") in ("1", "true")
              or bool(os.environ.get("RENDER"))
              or bool(os.environ.get("RAILWAY_ENVIRONMENT")))
    resp.set_cookie(name, value, max_age=max_age, httponly=True,
                    samesite="lax", secure=secure, path="/")


def current_user_id(request: Request) -> Optional[dict]:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    try:
        return _session_signer.loads(raw, max_age=SESSION_HOURS * 3600)
    except (BadSignature, SignatureExpired):
        return None


def require_admin(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "Administrator access required.")
    return user


# --------------------------------------------------------------------------
# router
# --------------------------------------------------------------------------
router = APIRouter()
_engine = None          # set by init_auth
_templates = None


class LoginIn(BaseModel):
    username: str
    password: str


class VerifyIn(BaseModel):
    code: str


class UserIn(BaseModel):
    username: str
    password: str
    phone: str = ""
    role: str = "staff"


class UserPatch(BaseModel):
    password: Optional[str] = None
    phone: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None


def _issue_code(s: Session, user: User, ip: str,
                phone: Optional[str] = None) -> dict:
    """Create + send a fresh 6-digit code to `phone`. Returns response payload."""
    err = _can_send_otp(user.id, ip)
    if err:
        raise HTTPException(429, err)

    code = f"{secrets.randbelow(1_000_000):06d}"
    now = dt.datetime.utcnow()
    # invalidate previous unused codes
    for old in s.scalars(select(LoginCode).where(
            LoginCode.user_id == user.id, LoginCode.used == False)):  # noqa: E712
        old.used = True
    otp = LoginCode(user_id=user.id, code_hash=_hash_code(code),
                    expires_at=now + dt.timedelta(seconds=OTP_TTL))
    s.add(otp)
    s.commit()
    _record_send(user.id, ip)

    dev_code = None
    if twilio_configured() and phone:
        send_sms(phone,
                 f"Mon Freight verification code: {code}. "
                 f"Expires in {OTP_TTL // 60} minutes.")
        log.info("OTP sent via SMS to user '%s' (%s)",
                 user.username, _mask_phone(phone))
    else:
        # DEV MODE — no SMS provider configured (or user has no phone).
        # Show the code so the operator is never locked out. Configure
        # Twilio env vars before real go-live.
        dev_code = code
        log.warning("AUTH DEV MODE — verification code for '%s': %s",
                    user.username, code)

    return {
        "ok": True,
        "otp_id": otp.id,
        "phone_hint": _mask_phone(phone or ""),
        "expires_in": OTP_TTL,
        "resend_in": OTP_RESEND_COOLDOWN,
        "dev_code": dev_code,
    }


@router.get("/login")
def login_page(request: Request):
    if current_user_id(request):
        return RedirectResponse("/", status_code=302)
    return _templates.TemplateResponse(request, "login.html")


@router.post("/auth/login")
def auth_login(payload: LoginIn, request: Request):
    username = payload.username.strip().lower()
    ip = request.client.host if request.client else "?"

    wait = _locked_out(username)
    if wait is not None:
        raise HTTPException(429,
            f"Too many failed attempts. Account locked for {max(wait, 1) // 60 + 1} more minute(s).")

    with Session(_engine) as s:
        user = s.scalar(select(User).where(User.username == username))
        if not user or not user.active or not verify_password(payload.password, user.password_hash):
            _record_fail(username)
            raise HTTPException(401, "Invalid username or password.")

        phones = _phones(user)
        if len(phones) > 1:
            # several registered mobiles — let the person pick before sending
            pending = _pending_signer.dumps({"uid": user.id, "stage": "choose"})
            resp = JSONResponse({"ok": True,
                                 "choose_phone": [_mask_phone(p) for p in phones]})
            _set_cookie(resp, PENDING_COOKIE, pending, max_age=OTP_TTL + 60)
            return resp

        result = _issue_code(s, user, ip, phones[0] if phones else None)
        pending = _pending_signer.dumps(
            {"uid": user.id, "otp": result["otp_id"], "idx": 0})

    resp = JSONResponse({k: v for k, v in result.items() if k != "otp_id"})
    _set_cookie(resp, PENDING_COOKIE, pending, max_age=OTP_TTL + 60)
    return resp


class SendIn(BaseModel):
    phone_index: int = 0


@router.post("/auth/send")
def auth_send(payload: SendIn, request: Request):
    """Send the code to the selected registered mobile (multi-phone accounts)."""
    raw = request.cookies.get(PENDING_COOKIE)
    if not raw:
        raise HTTPException(401, "Login session expired. Please sign in again.")
    try:
        pend = _pending_signer.loads(raw, max_age=OTP_TTL + 60)
    except (BadSignature, SignatureExpired):
        raise HTTPException(401, "Login session expired. Please sign in again.")

    ip = request.client.host if request.client else "?"
    with Session(_engine) as s:
        user = s.get(User, pend["uid"])
        if not user or not user.active:
            raise HTTPException(401, "Login session expired. Please sign in again.")
        phones = _phones(user)
        idx = payload.phone_index
        if not phones or idx < 0 or idx >= len(phones):
            raise HTTPException(400, "Invalid phone selection.")
        result = _issue_code(s, user, ip, phones[idx])
        pending = _pending_signer.dumps(
            {"uid": user.id, "otp": result["otp_id"], "idx": idx})

    resp = JSONResponse({k: v for k, v in result.items() if k != "otp_id"})
    _set_cookie(resp, PENDING_COOKIE, pending, max_age=OTP_TTL + 60)
    return resp


@router.post("/auth/resend")
def auth_resend(request: Request):
    raw = request.cookies.get(PENDING_COOKIE)
    if not raw:
        raise HTTPException(401, "Login session expired. Please sign in again.")
    try:
        pend = _pending_signer.loads(raw, max_age=OTP_TTL + 60)
    except (BadSignature, SignatureExpired):
        raise HTTPException(401, "Login session expired. Please sign in again.")

    ip = request.client.host if request.client else "?"
    with Session(_engine) as s:
        user = s.get(User, pend["uid"])
        if not user or not user.active:
            raise HTTPException(401, "Login session expired. Please sign in again.")
        phones = _phones(user)
        idx = min(pend.get("idx", 0), max(len(phones) - 1, 0))
        result = _issue_code(s, user, ip, phones[idx] if phones else None)
        pending = _pending_signer.dumps(
            {"uid": user.id, "otp": result["otp_id"], "idx": idx})

    resp = JSONResponse({k: v for k, v in result.items() if k != "otp_id"})
    _set_cookie(resp, PENDING_COOKIE, pending, max_age=OTP_TTL + 60)
    return resp


@router.post("/auth/verify")
def auth_verify(payload: VerifyIn, request: Request):
    raw = request.cookies.get(PENDING_COOKIE)
    if not raw:
        raise HTTPException(401, "Login session expired. Please sign in again.")
    try:
        pend = _pending_signer.loads(raw, max_age=OTP_TTL + 60)
    except (BadSignature, SignatureExpired):
        raise HTTPException(401, "Verification window expired. Please sign in again.")

    code = re.sub(r"\D", "", payload.code or "")
    if len(code) != 6:
        raise HTTPException(400, "Please enter the 6-digit code.")

    with Session(_engine) as s:
        otp = s.get(LoginCode, pend.get("otp") or 0)
        user = s.get(User, pend["uid"])
        if not otp or not user or not user.active or otp.user_id != user.id:
            raise HTTPException(401, "Login session expired. Please sign in again.")
        if otp.used:
            raise HTTPException(401, "This code was already used. Please sign in again.")
        if dt.datetime.utcnow() > otp.expires_at:
            raise HTTPException(401, "Code expired. Please request a new one.")
        if otp.attempts >= OTP_MAX_ATTEMPTS:
            otp.used = True
            s.commit()
            raise HTTPException(429, "Too many wrong attempts. Please sign in again.")

        if not hmac.compare_digest(otp.code_hash, _hash_code(code)):
            otp.attempts += 1
            s.commit()
            left = OTP_MAX_ATTEMPTS - otp.attempts
            raise HTTPException(401,
                f"Incorrect code. {left} attempt(s) remaining." if left
                else "Too many wrong attempts. Please sign in again.")

        otp.used = True
        user.last_login = dt.datetime.utcnow()
        s.commit()
        _pw_fails.pop(user.username, None)
        session_val = _session_signer.dumps(
            {"uid": user.id, "u": user.username, "role": user.role})

    resp = JSONResponse({"ok": True, "redirect": "/"})
    _set_cookie(resp, SESSION_COOKIE, session_val, max_age=SESSION_HOURS * 3600)
    resp.delete_cookie(PENDING_COOKIE, path="/")
    return resp


@router.post("/auth/logout")
def auth_logout():
    resp = JSONResponse({"ok": True, "redirect": "/login"})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    resp.delete_cookie(PENDING_COOKIE, path="/")
    return resp


@router.get("/auth/me")
def auth_me(request: Request):
    # /auth/* is skipped by the middleware, so check the cookie directly
    user = getattr(request.state, "user", None) or current_user_id(request)
    if not user:
        raise HTTPException(401, "Not signed in.")
    return {"username": user["u"], "role": user["role"],
            "sms_configured": twilio_configured()}


# --------------------------------------------------------------------------
# user management (admin only)
# --------------------------------------------------------------------------
def _user_dict(u: User) -> dict:
    return {"id": u.id, "username": u.username, "phone": u.phone,
            "role": u.role, "active": bool(u.active),
            "last_login": u.last_login.isoformat() + "Z" if u.last_login else None}


@router.get("/api/users")
def list_users(request: Request):
    require_admin(request)
    with Session(_engine) as s:
        return [_user_dict(u) for u in
                s.scalars(select(User).order_by(User.username)).all()]


@router.post("/api/users")
def create_user(payload: UserIn, request: Request):
    require_admin(request)
    username = payload.username.strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,32}", username):
        raise HTTPException(400, "Username: 3-32 chars, letters/digits/._- only.")
    if len(payload.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters.")
    if payload.phone and not PHONES_RE.fullmatch(payload.phone.strip()):
        raise HTTPException(400, "Phone must be E.164 format, e.g. +61400123456 "
                                 "(several numbers separated by commas allowed).")
    if payload.role not in ("admin", "staff"):
        raise HTTPException(400, "Role must be 'admin' or 'staff'.")
    with Session(_engine) as s:
        if s.scalar(select(User).where(User.username == username)):
            raise HTTPException(409, "Username already exists.")
        u = User(username=username, password_hash=hash_password(payload.password),
                 phone=_normalize_phones(payload.phone), role=payload.role)
        s.add(u)
        s.commit()
        return _user_dict(u)


@router.patch("/api/users/{user_id}")
def update_user(user_id: int, payload: UserPatch, request: Request):
    admin = require_admin(request)
    with Session(_engine) as s:
        u = s.get(User, user_id)
        if not u:
            raise HTTPException(404, "User not found.")
        if payload.password is not None:
            if len(payload.password) < 8:
                raise HTTPException(400, "Password must be at least 8 characters.")
            u.password_hash = hash_password(payload.password)
        if payload.phone is not None:
            p = payload.phone.strip()
            if p and not PHONES_RE.fullmatch(p):
                raise HTTPException(400, "Phone must be E.164 format, e.g. +61400123456 "
                                         "(several numbers separated by commas allowed).")
            u.phone = _normalize_phones(p)
        if payload.role is not None:
            if payload.role not in ("admin", "staff"):
                raise HTTPException(400, "Role must be 'admin' or 'staff'.")
            if u.username == admin["u"] and payload.role != "admin":
                raise HTTPException(400, "You cannot remove your own admin role.")
            u.role = payload.role
        if payload.active is not None:
            if u.username == admin["u"] and not payload.active:
                raise HTTPException(400, "You cannot deactivate your own account.")
            u.active = payload.active
        s.commit()
        return _user_dict(u)


@router.delete("/api/users/{user_id}")
def delete_user(user_id: int, request: Request):
    admin = require_admin(request)
    with Session(_engine) as s:
        u = s.get(User, user_id)
        if not u:
            raise HTTPException(404, "User not found.")
        if u.username == admin["u"]:
            raise HTTPException(400, "You cannot delete your own account.")
        s.delete(u)
        s.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# middleware + init
# --------------------------------------------------------------------------
def _bootstrap_admin(engine) -> None:
    with Session(engine) as s:
        if s.scalar(select(User).limit(1)):
            return
        username = os.environ.get("ADMIN_USERNAME", "admin").strip().lower()
        password = os.environ.get("ADMIN_PASSWORD", "")
        generated = False
        if not password:
            password = secrets.token_urlsafe(9)
            generated = True
        s.add(User(username=username, password_hash=hash_password(password),
                   phone=os.environ.get("ADMIN_PHONE", "").strip(), role="admin"))
        s.commit()
    banner = "=" * 62
    log.warning("\n%s\n  FIRST RUN — default admin account created\n"
                "  username : %s\n  password : %s%s\n"
                "  Change this password from Settings after first login.\n%s",
                banner, username,
                password if generated else "(from ADMIN_PASSWORD env var)",
                "  <-- write this down!" if generated else "", banner)


def init_auth(app, engine, templates) -> None:
    """Wire authentication into the FastAPI app."""
    global _engine, _templates
    _engine = engine
    _templates = templates

    AuthBase.metadata.create_all(engine)
    _bootstrap_admin(engine)

    app.include_router(router)

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        path = request.url.path
        if path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return await call_next(request)

        user = current_user_id(request)
        if user is None:
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Not authenticated."}, status_code=401)
            return RedirectResponse(f"/login", status_code=302)

        request.state.user = user
        return await call_next(request)

    log.info("Auth enabled. SMS verification: %s",
             "Twilio" if twilio_configured() else "DEV MODE (codes shown on login page)")
