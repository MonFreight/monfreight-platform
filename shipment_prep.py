"""
Mon Freight — Shipment Preparation module.

Adds package management, parcel-to-package assignment, outer package labels
(with QR + barcode and battery information), and a Packing List / Commercial
Invoice generator, all keyed on the existing Batch Date.

Wired into the main app via ``init_prep(app, engine, templates, Shipment)``.
The module reuses the host app's engine, Jinja2 templates and the existing
``Shipment`` model, and enforces the same admin/staff permission model used by
the rest of the platform (``auth.require_admin``).
"""
from __future__ import annotations

import datetime as dt
import json
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import (Column, Date, DateTime, Float, Integer, String, Text,
                        select, text)
from sqlalchemy.orm import DeclarativeBase, Session

# Pulled from the host app in init_prep()
_engine = None
_templates = None
_Shipment = None

# Admin gate — reuse the platform's existing permission helper.
from auth import require_admin  # noqa: E402

router = APIRouter()


# --------------------------------------------------------------------------
# Company constants (shipper / consignee from the reference template)
# --------------------------------------------------------------------------
SHIPPER_DETAILS = (
    "ABN NO: 88679480098\n"
    "MON FREIGHT PTY LTD\n"
    "907/52 Bank Street, West End QLD 4101\n"
    "Phone : +61 731933458\n"
    "E-mail: info@monfreight.com.au"
)
CONSIGNEE_DETAILS = (
    "PickPack Worldwide LLC\n"
    "2nd floor, MCS CoSpace Building, Zaisan street,\n"
    "Central Industrial Zone, 1st khoroo, Khan-Uul district,\n"
    "Ulaanbaatar 17040, Mongolia\n"
    "Phone: +976-7777-2080\n"
    "E-mail : info@ppworldwide.mn"
)
TO_PARTY = "PickPack Worldwide LLC"
DESTINATION = "Ulaanbaatar, Mongolia"

# Canonical handling-mark options an admin can tick in Shipment Preparation.
# Order here is the order they appear on the printed label.
HANDLING_MARKS = [
    "Fragile",
    "This Way Up",
    "Keep Dry",
    "Heavy",
    "Battery / Lithium Battery",
]
_HANDLING_LOOKUP = {m.lower(): m for m in HANDLING_MARKS}


def _clean_handling_marks(raw) -> str:
    """Normalise handling marks (list or comma string) to a canonical CSV string."""
    if not raw:
        return ""
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",")]
    else:
        parts = [str(p).strip() for p in raw]
    out = []
    for p in parts:
        if not p:
            continue
        canon = _HANDLING_LOOKUP.get(p.lower(), p)
        if canon not in out:
            out.append(canon)
    return ",".join(out)


def _split_handling_marks(value: str) -> list[str]:
    if not value:
        return []
    return [p.strip() for p in value.split(",") if p.strip()]


# --------------------------------------------------------------------------
# models
# --------------------------------------------------------------------------
class PrepBase(DeclarativeBase):
    pass


class Package(PrepBase):
    __tablename__ = "packages"
    id = Column(Integer, primary_key=True)
    batch_date = Column(Date, nullable=False, index=True)
    package_number = Column(Integer, nullable=False)        # sequence within a batch
    package_type = Column(String, default="Carton")          # Carton/Pallet/Bag/Crate
    gross_weight = Column(Float, default=0.0)
    length_cm = Column(Float, default=0.0)
    width_cm = Column(Float, default=0.0)
    height_cm = Column(Float, default=0.0)
    parcel_count_manual = Column(Integer, nullable=True)     # optional override
    reference_number = Column(String, default="")
    notes = Column(String, default="")
    status = Column(String, default="Open")                  # Open/Packed/Ready for Shipment
    dropoff_reference = Column(String, default="")           # e.g. "H9337" (manual, admin)
    handling_marks = Column(String, default="")              # comma-separated, e.g. "Fragile,This Way Up"
    created_at = Column(DateTime, default=dt.datetime.now)


class PackingList(PrepBase):
    __tablename__ = "packing_lists"
    id = Column(Integer, primary_key=True)
    batch_date = Column(Date, nullable=False, unique=True, index=True)
    items_json = Column(Text, default="[]")                  # [{description, qty, unit_price, amount}]
    to_party = Column(String, default=TO_PARTY)
    shipper = Column(Text, default=SHIPPER_DETAILS)
    consignee = Column(Text, default=CONSIGNEE_DETAILS)
    signer_name = Column(String, default="")
    doc_date = Column(String, default="")
    total_amount = Column(Float, default=0.0)
    total_packages = Column(Integer, default=0)
    total_weight = Column(Float, default=0.0)
    total_parcels = Column(Integer, default=0)
    generated_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=dt.datetime.now)


# --------------------------------------------------------------------------
# battery detection (reads each parcel's Internal Note = Shipment.notes)
# --------------------------------------------------------------------------
_UN_RE = re.compile(r"\bUN\s?(3090|3091|3480|3481|3171)\b", re.IGNORECASE)
_PI_RE = re.compile(r"\bPI\s?9(6[5-9])\b(?:\s*(section|sec\.?)\s*([I]{1,3}|1|2))?",
                    re.IGNORECASE)
_WH_RE = re.compile(r"(\d+(?:\.\d+)?)\s*wh\b", re.IGNORECASE)
_V_RE = re.compile(r"(\d+(?:\.\d+)?)\s*v\b", re.IGNORECASE)
_MAH_RE = re.compile(r"(\d+(?:\.\d+)?)\s*mah\b", re.IGNORECASE)
_QTY_RE = re.compile(r"(?:x|qty|quantity)\s*(\d+)|(\d+)\s*(?:pcs|cells?|batteries|battery|units?)",
                     re.IGNORECASE)
# Explicit "<count> x <watt-hours> Wh" rating, e.g. "2 x 74Wh".
_RATING_RE = re.compile(r"(\d+)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*wh\b", re.IGNORECASE)

_BATTERY_HINTS = ("lithium", "li-ion", "li ion", "lipo", "battery", "batteries",
                  "accumulator")


def detect_battery(note: str) -> Optional[dict]:
    """Parse a parcel's Internal Note for battery / dangerous-goods info.

    Returns a dict of detected attributes, or None if no battery signal at all.
    """
    if not note:
        return None
    low = note.lower()
    has_signal = (any(h in low for h in _BATTERY_HINTS)
                  or _UN_RE.search(note) or _PI_RE.search(note)
                  or _WH_RE.search(note))
    if not has_signal:
        return None

    un = sorted({"UN" + m.group(1) for m in _UN_RE.finditer(note)})

    pi = []
    for m in _PI_RE.finditer(note):
        sec = m.group(3)
        label = "PI9" + m.group(1)
        if sec:
            sec_norm = {"1": "I", "2": "II", "I": "I", "II": "II",
                        "III": "III"}.get(sec.upper(), sec.upper())
            label += f" Section {sec_norm}"
        pi.append(label)
    pi = sorted(set(pi))

    installed = bool(re.search(r"installed\s+in\s+equipment|in\s+equipment", low))
    packed_with = bool(re.search(r"packed\s+with\s+equipment", low))
    if " none" in low and not (un or pi):
        pass

    condition = None
    if re.search(r"\bused\b", low):
        condition = "Used"
    elif re.search(r"\bnew\b", low):
        condition = "New"

    wh = [m.group(1) + " Wh" for m in _WH_RE.finditer(note)]
    volts = [m.group(1) + " V" for m in _V_RE.finditer(note)]
    mah = [m.group(1) + " mAh" for m in _MAH_RE.finditer(note)]

    qty = None
    qm = _QTY_RE.search(note)
    if qm:
        qty = qm.group(1) or qm.group(2)

    packing_type = None
    if installed:
        packing_type = "Battery installed in equipment"
    elif packed_with:
        packing_type = "Battery packed with equipment"

    return {
        "raw": note.strip(),
        "is_lithium": ("lithium" in low or "li-ion" in low or "li ion" in low
                       or "lipo" in low or bool(un) or bool(pi)),
        "un_numbers": un,
        "pi_sections": pi,
        "packing_type": packing_type,
        "condition": condition,
        "capacity_wh": wh,
        "voltage": volts,
        "mah": mah,
        "quantity": qty,
    }


def _merge_battery(items: list[dict]) -> Optional[dict]:
    """Aggregate per-parcel battery dicts into one package-level summary."""
    items = [i for i in items if i]
    if not items:
        return None

    def _union(key):
        out = []
        for i in items:
            for v in (i.get(key) or []):
                if v not in out:
                    out.append(v)
        return out

    un = _union("un_numbers")
    pi = _union("pi_sections")
    wh = _union("capacity_wh")
    volts = _union("voltage")
    mah = _union("mah")
    types = [i["packing_type"] for i in items if i.get("packing_type")]
    conds = [i["condition"] for i in items if i.get("condition")]
    is_lithium = any(i.get("is_lithium") for i in items)

    # ---- label-ready display fields ----
    # UN number: use what was detected; default to UN3481 (lithium ion in
    # equipment) when a battery is present but no UN code was written in notes.
    un_display = ", ".join(un) if un else "UN3481"

    # Chemistry: lithium metal for UN3090/3091, otherwise lithium ion.
    if any(u in ("UN3090", "UN3091") for u in un):
        chemistry = "Lithium metal batteries"
    elif un or is_lithium:
        chemistry = "Lithium ion batteries"
    else:
        chemistry = "Batteries"

    # Packing: map detected packing type to the short label used on the sticker.
    packing = ""
    joined_types = " ".join(types).lower()
    if "installed" in joined_types or "contained" in joined_types:
        packing = "Contained in equipment"
    elif "packed" in joined_types:
        packing = "Packed with equipment"

    # Rating string(s): "<count> x <Wh>" per parcel, e.g. "2 x 74Wh".
    # Prefer an explicit "N x M Wh" written in the note; otherwise fall back
    # to a separately-detected count + capacity.
    ratings: list[str] = []
    for i in items:
        raw = i.get("raw", "") or ""
        matched = False
        for m in _RATING_RE.finditer(raw):
            r = f"{m.group(1)} x {m.group(2)}Wh"
            matched = True
            if r not in ratings:
                ratings.append(r)
        if matched:
            continue
        qty = i.get("quantity")
        for w in (i.get("capacity_wh") or []):
            wc = w.replace(" ", "")            # "74 Wh" -> "74Wh"
            r = f"{qty} x {wc}" if qty else wc
            if r not in ratings:
                ratings.append(r)
    rating_display = " · ".join(ratings)

    return {
        "present": True,
        "is_lithium": is_lithium,
        "un_numbers": un,
        "pi_sections": pi,
        "packing_types": sorted(set(types)),
        "conditions": sorted(set(conds)),
        "capacity_wh": wh,
        "voltage": volts,
        "mah": mah,
        "parcel_count": len(items),
        "lines": [i["raw"] for i in items],
        # display fields consumed by the outer label
        "un_display": un_display,
        "chemistry": chemistry,
        "packing": packing,
        "rating_display": rating_display,
    }


# --------------------------------------------------------------------------
# item auto-summary
# --------------------------------------------------------------------------
# Professional English categories used on the Packing List / Commercial Invoice.
# Order matters: the first matching category wins, so the more specific
# "Electronic Devices with Lithium Batteries" is checked before "Electronics".
_CATEGORY_KEYWORDS = {
    "Vitamins": ["vitamin", "supplement", "omega", "fish oil", "collagen",
                 "magnesium", "probiotic", "multivitamin"],
    "Shoes": ["shoe", "boot", "sneaker", "footwear", "sandal", "heel", "loafer"],
    "Clothing": ["clothes", "clothing", "shirt", "t-shirt", "tshirt", "tee",
                 "jacket", "pant", "trouser", "dress", "hoodie", "apparel",
                 "garment", "jeans", "coat", "sweater", "jumper", "skirt",
                 "shorts", "socks", "underwear"],
    "Metal Detectors": ["metal detector", "minelab", "gold monster", "gpz",
                         "gpx", "vanquish", "equinox", "detector", "search coil"],
    "Electronic Devices with Lithium Batteries": [
        "power bank", "powerbank", "jump starter", "lithium", "li-ion", "li ion",
        "lipo", "drone", "e-bike", "ebike", "scooter battery", "battery pack"],
    "Electronics": ["electronic", "phone", "laptop", "charger", "cable",
                    "headphone", "speaker", "camera", "tablet", "gadget",
                    "adapter", "mouse", "keyboard", "monitor", "router"],
    "Snacks": ["snack", "chocolate", "candy", "lolly", "biscuit", "chips",
               "food", "coffee", "tea", "honey", "noodle"],
    "Tools": ["tool", "hammer", "spanner", "wrench", "screwdriver", "drill",
              "pick", "entrenching", "knife", "spacer", "tow pin", "pliers"],
    "Personal Items": ["personal", "hand bag", "handbag", "bag", "cosmetic",
                       "perfume", "toiletr", "makeup", "skincare", "shampoo"],
}

_QTY_PREFIX = re.compile(r"^\s*(\d+)\s*[x*]\s+", re.IGNORECASE)
# The "x"/"*" multiplier must be space-separated so words like "Box 3" are not
# misread as "Bo" + "x3".
_QTY_SUFFIX = re.compile(r"\s+[x*]\s*(\d+)\s*$|\s*\((\d+)\)\s*$|\s+(\d+)\s*(?:pcs|pc|units?)\s*$",
                         re.IGNORECASE)

# --- description cleaning (strip serials, sizes, box/parcel refs, stray numbers) ---
_SIZE_RE = re.compile(r"\b(?:size|sz|us|eu|uk)\s*[-:]?\s*\d+(?:\.\d+)?\b", re.IGNORECASE)
_BOXREF_RE = re.compile(r"\b(?:box|carton|parcel|pkg|package|ctn|pallet|bag)\s*#?\s*\d+\b",
                        re.IGNORECASE)
_HASHNUM_RE = re.compile(r"#\s*\d+")
_UNITNUM_RE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:wh|v|mah|kg|g|gram|ml|l|cm|mm|inch|in|pcs|pc)\b",
                         re.IGNORECASE)
_SERIAL_RE = re.compile(r"\b(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9]{2,}(?:-[a-z0-9]+)*\b",
                        re.IGNORECASE)  # mixed letter+digit tokens e.g. GPZ7000, X100
_STRAYNUM_RE = re.compile(r"\b\d+(?:\.\d+)?\b")
_PUNCT_RE = re.compile(r"\s*[-–—:,/]+\s*$")
# Noise tokens commonly left over from serial/model labelling.
_STOPWORDS = {"serial", "sn", "model", "mdl", "no", "nos", "ref", "code",
              "item", "type", "ver", "version"}


def _clean_description(name: str) -> str:
    """Strip serial numbers, sizes, box/parcel refs and stray numbers, then
    de-duplicate words and Title-case the result for a clean invoice line."""
    s = " " + (name or "").strip() + " "
    s = _SIZE_RE.sub(" ", s)
    s = _BOXREF_RE.sub(" ", s)
    s = _HASHNUM_RE.sub(" ", s)
    s = _UNITNUM_RE.sub(" ", s)
    s = _SERIAL_RE.sub(" ", s)
    s = _STRAYNUM_RE.sub(" ", s)
    # collapse whitespace and drop duplicate words (case-insensitive, keep order)
    words, seen = [], set()
    for w in s.split():
        key = w.lower()
        if key in seen or key in _STOPWORDS:
            continue
        seen.add(key)
        words.append(w)
    cleaned = " ".join(words).strip()
    cleaned = _PUNCT_RE.sub("", cleaned).strip()
    if not cleaned:
        return ""
    # Title-case while preserving existing all-caps acronyms
    return " ".join(w if w.isupper() and len(w) > 1 else w.capitalize()
                    for w in cleaned.split())


def _categorise(desc: str) -> Optional[str]:
    low = desc.lower()
    for cat, kws in _CATEGORY_KEYWORDS.items():
        if any(k in low for k in kws):
            return cat
    return None


def _split_items(description: str) -> list[tuple[str, int]]:
    """Break a parcel description into (item, qty) pairs."""
    out = []
    if not description:
        return out
    parts = re.split(r"[\n,;/]+", description)
    for p in parts:
        p = p.strip()
        if not p:
            continue
        qty = 1
        m = _QTY_PREFIX.match(p)
        if m:
            qty = int(m.group(1))
            p = _QTY_PREFIX.sub("", p).strip()
        else:
            m = _QTY_SUFFIX.search(p)
            if m:
                qty = int(next(g for g in m.groups() if g))
                p = _QTY_SUFFIX.sub("", p).strip()
        if p:
            out.append((p, qty))
    return out


def summarise_items(parcels: list[dict]) -> list[dict]:
    """Auto-summarise all parcel contents into combined invoice lines.

    Groups by category where a description matches a known category, otherwise
    keeps the cleaned description as its own line. Sums quantities and rolls
    declared value into the line amount as a starting point (editable later).
    """
    agg: dict[str, dict] = {}
    order: list[str] = []
    for p in parcels:
        desc = p.get("description") or ""
        value = float(p.get("declared_value") or 0)
        items = _split_items(desc)
        # distribute declared value evenly across the items in this parcel
        share = (value / len(items)) if items else 0.0
        if not items and desc.strip():
            items = [(desc.strip(), 1)]
            share = value
        for name, qty in items:
            cat = _categorise(name)
            if cat:
                key, label = cat.lower(), cat
            else:
                cleaned = _clean_description(name)
                if not cleaned:
                    continue
                key, label = cleaned.lower(), cleaned
            if key not in agg:
                agg[key] = {"description": label, "qty": 0, "amount": 0.0}
                order.append(key)
            agg[key]["qty"] += qty
            agg[key]["amount"] += share
    out = []
    for key in order:
        row = agg[key]
        qty = row["qty"] or 1
        amount = round(row["amount"], 2)
        unit = round(amount / qty, 2) if qty else 0.0
        out.append({
            "description": row["description"],
            "qty": qty,
            "unit_price": unit,
            "amount": amount,
        })
    return out


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _parse_date(s: str) -> dt.date:
    try:
        return dt.date.fromisoformat(s)
    except Exception:
        raise HTTPException(400, f"Invalid date: {s!r} (expected YYYY-MM-DD)")


def _parcels_for(session: Session, batch_date: dt.date) -> list:
    return list(session.scalars(
        select(_Shipment).where(_Shipment.batch_date == batch_date)
        .order_by(_Shipment.box_number)
    ).all())


def _parcel_brief(s) -> dict:
    note = getattr(s, "notes", "") or ""
    bat = detect_battery(note)
    return {
        "id": s.id,
        "box_number": s.box_number,
        "mf_number": s.mf_number,
        "receiver_name": s.receiver_name,
        "sender_name": s.sender_name,
        "description": s.description or "",
        "declared_value": float(s.declared_value or 0),
        "weight": float(s.weight or 0),
        "notes": note,
        "package_id": getattr(s, "package_id", None),
        "battery": bat,
        "has_battery": bool(bat),
    }


def _package_totals(session: Session, pkg: Package) -> dict:
    parcels = list(session.scalars(
        select(_Shipment).where(_Shipment.package_id == pkg.id)
        .order_by(_Shipment.box_number)
    ).all())
    weight = sum(float(p.weight or 0) for p in parcels)
    value = sum(float(p.declared_value or 0) for p in parcels)
    batteries = [detect_battery(getattr(p, "notes", "") or "") for p in parcels]
    item_summary = summarise_items([_parcel_brief(p) for p in parcels])
    return {
        "id": pkg.id,
        "batch_date": pkg.batch_date.isoformat(),
        "package_number": pkg.package_number,
        "package_type": pkg.package_type,
        "gross_weight": float(pkg.gross_weight or 0),
        "length_cm": float(pkg.length_cm or 0),
        "width_cm": float(pkg.width_cm or 0),
        "height_cm": float(pkg.height_cm or 0),
        "reference_number": pkg.reference_number or "",
        "notes": pkg.notes or "",
        "status": pkg.status or "Open",
        "dropoff_reference": (pkg.dropoff_reference or "").strip(),
        "handling_marks": _split_handling_marks(pkg.handling_marks or ""),
        "parcel_count": len(parcels),
        "parcel_count_manual": pkg.parcel_count_manual,
        "total_weight": round(weight, 2),
        "total_declared_value": round(value, 2),
        "parcels": [_parcel_brief(p) for p in parcels],
        "item_summary": item_summary,
        "battery": _merge_battery(batteries),
    }


def _next_pkg_number(session: Session, batch_date: dt.date) -> int:
    nums = [p.package_number for p in session.scalars(
        select(Package).where(Package.batch_date == batch_date)).all()]
    return (max(nums) + 1) if nums else 1


def _is_admin(request: Request) -> bool:
    u = getattr(request.state, "user", None)
    return bool(u and u.get("role") == "admin")


# --------------------------------------------------------------------------
# pydantic payloads
# --------------------------------------------------------------------------
class PackageIn(BaseModel):
    batch_date: str
    package_type: str = "Carton"
    gross_weight: float = 0.0
    length_cm: float = 0.0
    width_cm: float = 0.0
    height_cm: float = 0.0
    reference_number: str = ""
    notes: str = ""
    status: str = "Open"
    dropoff_reference: str = ""
    handling_marks: list[str] = []
    parcel_count_manual: Optional[int] = None


class PackagePatch(BaseModel):
    package_type: Optional[str] = None
    gross_weight: Optional[float] = None
    length_cm: Optional[float] = None
    width_cm: Optional[float] = None
    height_cm: Optional[float] = None
    reference_number: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    dropoff_reference: Optional[str] = None
    handling_marks: Optional[list[str]] = None
    parcel_count_manual: Optional[int] = None


class AssignIn(BaseModel):
    parcel_ids: list[int]
    package_id: Optional[int] = None   # None => unassign


class PackingListIn(BaseModel):
    batch_date: str
    items: list[dict]
    to_party: Optional[str] = None
    shipper: Optional[str] = None
    consignee: Optional[str] = None
    signer_name: Optional[str] = None
    doc_date: Optional[str] = None


# --------------------------------------------------------------------------
# API — packages
# --------------------------------------------------------------------------
@router.get("/api/prep/packages")
def list_packages(date: str):
    bd = _parse_date(date)
    with Session(_engine) as s:
        pkgs = list(s.scalars(
            select(Package).where(Package.batch_date == bd)
            .order_by(Package.package_number)).all())
        return [_package_totals(s, p) for p in pkgs]


@router.post("/api/prep/packages")
def create_package(payload: PackageIn, request: Request):
    require_admin(request)
    bd = _parse_date(payload.batch_date)
    with Session(_engine) as s:
        num = _next_pkg_number(s, bd)
        ref = payload.reference_number.strip() or f"MF-{bd.strftime('%Y%m%d')}-P{num:02d}"
        pkg = Package(
            batch_date=bd, package_number=num,
            package_type=payload.package_type or "Carton",
            gross_weight=payload.gross_weight or 0,
            length_cm=payload.length_cm or 0, width_cm=payload.width_cm or 0,
            height_cm=payload.height_cm or 0,
            reference_number=ref, notes=payload.notes or "",
            status=payload.status or "Open",
            dropoff_reference=(payload.dropoff_reference or "").strip(),
            handling_marks=_clean_handling_marks(payload.handling_marks),
            parcel_count_manual=payload.parcel_count_manual,
        )
        s.add(pkg)
        s.commit()
        return _package_totals(s, pkg)


@router.put("/api/prep/packages/{pkg_id}")
def update_package(pkg_id: int, payload: PackagePatch, request: Request):
    require_admin(request)
    with Session(_engine) as s:
        pkg = s.get(Package, pkg_id)
        if not pkg:
            raise HTTPException(404, "Package not found")
        for field, val in payload.model_dump(exclude_unset=True).items():
            if field == "handling_marks":
                pkg.handling_marks = _clean_handling_marks(val)
            elif field == "dropoff_reference":
                pkg.dropoff_reference = (val or "").strip()
            else:
                setattr(pkg, field, val)
        s.commit()
        return _package_totals(s, pkg)


@router.delete("/api/prep/packages/{pkg_id}")
def delete_package(pkg_id: int, request: Request):
    require_admin(request)
    with Session(_engine) as s:
        pkg = s.get(Package, pkg_id)
        if not pkg:
            raise HTTPException(404, "Package not found")
        # unassign parcels first
        for p in s.scalars(select(_Shipment).where(_Shipment.package_id == pkg_id)).all():
            p.package_id = None
        s.delete(pkg)
        s.commit()
        return {"ok": True}


# --------------------------------------------------------------------------
# API — parcels + assignment
# --------------------------------------------------------------------------
@router.get("/api/prep/parcels")
def list_parcels(date: str):
    bd = _parse_date(date)
    with Session(_engine) as s:
        parcels = _parcels_for(s, bd)
        return [_parcel_brief(p) for p in parcels]


@router.post("/api/prep/assign")
def assign_parcels(payload: AssignIn, request: Request):
    require_admin(request)
    with Session(_engine) as s:
        if payload.package_id is not None:
            pkg = s.get(Package, payload.package_id)
            if not pkg:
                raise HTTPException(404, "Target package not found")
        moved = 0
        for pid in payload.parcel_ids:
            sh = s.get(_Shipment, pid)
            if not sh:
                continue
            sh.package_id = payload.package_id   # None => unassign
            moved += 1
        s.commit()
        return {"ok": True, "moved": moved}


# --------------------------------------------------------------------------
# API — dashboard
# --------------------------------------------------------------------------
@router.get("/api/prep/dashboard")
def prep_dashboard(date: str):
    bd = _parse_date(date)
    with Session(_engine) as s:
        parcels = _parcels_for(s, bd)
        pkgs = list(s.scalars(
            select(Package).where(Package.batch_date == bd)
            .order_by(Package.package_number)).all())
        assigned = [p for p in parcels if getattr(p, "package_id", None)]
        unassigned = [p for p in parcels if not getattr(p, "package_id", None)]
        total_weight = sum(float(p.weight or 0) for p in parcels)
        total_value = sum(float(p.declared_value or 0) for p in parcels)
        battery_parcels = [p for p in parcels
                           if detect_battery(getattr(p, "notes", "") or "")]
        pl = s.scalar(select(PackingList).where(PackingList.batch_date == bd))
        pkg_no_weight = [p.package_number for p in pkgs
                         if not (p.gross_weight and p.gross_weight > 0)]

        warnings = []
        if unassigned:
            warnings.append({
                "level": "danger",
                "text": f"{len(unassigned)} parcel(s) not assigned to any package.",
            })
        if pkg_no_weight:
            warnings.append({
                "level": "warn",
                "text": "Package(s) with no gross weight: "
                        + ", ".join(f"#{n}" for n in pkg_no_weight),
            })
        if battery_parcels:
            warnings.append({
                "level": "warn",
                "text": f"{len(battery_parcels)} parcel(s) contain battery information — "
                        "review before shipment.",
            })
        if pl is None or pl.generated_at is None:
            warnings.append({
                "level": "info",
                "text": "Packing List / Invoice has not been generated yet.",
            })

        ready = (len(parcels) > 0 and not unassigned and not pkg_no_weight
                 and pl is not None and pl.generated_at is not None)
        return {
            "batch_date": bd.isoformat(),
            "total_packages": len(pkgs),
            "total_parcels": len(parcels),
            "assigned_parcels": len(assigned),
            "unassigned_parcels": len(unassigned),
            "total_weight": round(total_weight, 2),
            "total_declared_value": round(total_value, 2),
            "battery_items": len(battery_parcels),
            "packing_list_generated": bool(pl and pl.generated_at),
            "readiness": "Ready for Shipment" if ready else "In Preparation",
            "ready": ready,
            "warnings": warnings,
        }


# --------------------------------------------------------------------------
# API — packing list (auto-summary + save/load)
# --------------------------------------------------------------------------
def _pl_dict(pl: PackingList) -> dict:
    return {
        "batch_date": pl.batch_date.isoformat(),
        "items": json.loads(pl.items_json or "[]"),
        "to_party": pl.to_party,
        "shipper": pl.shipper,
        "consignee": pl.consignee,
        "signer_name": pl.signer_name or "",
        "doc_date": pl.doc_date or "",
        "total_amount": float(pl.total_amount or 0),
        "total_packages": pl.total_packages or 0,
        "total_weight": float(pl.total_weight or 0),
        "total_parcels": pl.total_parcels or 0,
        "generated_at": pl.generated_at.isoformat() if pl.generated_at else None,
    }


@router.get("/api/prep/packing-list")
def get_packing_list(date: str):
    """Return the saved packing list if any, else a fresh auto-summary."""
    bd = _parse_date(date)
    with Session(_engine) as s:
        parcels = _parcels_for(s, bd)
        pkgs = list(s.scalars(select(Package).where(Package.batch_date == bd)).all())
        total_weight = sum(float(getattr(p, "gross_weight", 0) or 0) for p in pkgs) \
            or sum(float(p.weight or 0) for p in parcels)
        total_parcels = len(parcels)
        pl = s.scalar(select(PackingList).where(PackingList.batch_date == bd))
        if pl is not None:
            d = _pl_dict(pl)
            d["saved"] = True
            d["auto_total_weight"] = round(total_weight, 2)
            d["auto_total_packages"] = len(pkgs)
            d["auto_total_parcels"] = total_parcels
            return d
        items = summarise_items([_parcel_brief(p) for p in parcels])
        return {
            "batch_date": bd.isoformat(),
            "items": items,
            "to_party": TO_PARTY,
            "shipper": SHIPPER_DETAILS,
            "consignee": CONSIGNEE_DETAILS,
            "signer_name": "",
            "doc_date": bd.strftime("%-d/%-m/%Y"),
            "total_amount": round(sum(i["amount"] for i in items), 2),
            "total_packages": len(pkgs),
            "total_weight": round(total_weight, 2),
            "total_parcels": total_parcels,
            "generated_at": None,
            "saved": False,
            "auto_total_weight": round(total_weight, 2),
            "auto_total_packages": len(pkgs),
            "auto_total_parcels": total_parcels,
        }


@router.post("/api/prep/packing-list")
def save_packing_list(payload: PackingListIn, request: Request):
    require_admin(request)
    bd = _parse_date(payload.batch_date)
    # Build the line items, merging any rows that share the same description
    # (case-insensitive) so an admin can merge categories simply by renaming
    # two lines to the same label. Quantities and amounts are summed and the
    # unit price is recomputed from the merged totals.
    merged: dict[str, dict] = {}
    order: list[str] = []
    for it in payload.items:
        desc = str(it.get("description", "")).strip()
        if not desc:
            continue
        qty = float(it.get("qty") or 0)
        unit = float(it.get("unit_price") or 0)
        amount = it.get("amount")
        amount = float(amount) if amount not in (None, "") else round(qty * unit, 2)
        key = desc.lower()
        if key not in merged:
            merged[key] = {"description": desc, "qty": 0.0, "amount": 0.0}
            order.append(key)
        merged[key]["qty"] += qty
        merged[key]["amount"] += amount
    clean = []
    for key in order:
        row = merged[key]
        qty = round(row["qty"], 2)
        amount = round(row["amount"], 2)
        unit = round(amount / qty, 2) if qty else 0.0
        clean.append({"description": row["description"], "qty": qty,
                      "unit_price": unit, "amount": amount})
    total_amount = round(sum(i["amount"] for i in clean), 2)
    with Session(_engine) as s:
        pkgs = list(s.scalars(select(Package).where(Package.batch_date == bd)).all())
        parcels = _parcels_for(s, bd)
        total_weight = sum(float(p.gross_weight or 0) for p in pkgs) \
            or sum(float(p.weight or 0) for p in parcels)
        pl = s.scalar(select(PackingList).where(PackingList.batch_date == bd))
        if pl is None:
            pl = PackingList(batch_date=bd)
            s.add(pl)
        pl.items_json = json.dumps(clean)
        pl.to_party = payload.to_party or TO_PARTY
        pl.shipper = payload.shipper or SHIPPER_DETAILS
        pl.consignee = payload.consignee or CONSIGNEE_DETAILS
        pl.signer_name = payload.signer_name or ""
        pl.doc_date = payload.doc_date or bd.strftime("%-d/%-m/%Y")
        pl.total_amount = total_amount
        pl.total_packages = len(pkgs)
        pl.total_weight = round(total_weight, 2)
        pl.total_parcels = len(parcels)
        pl.generated_at = dt.datetime.now()
        pl.updated_at = dt.datetime.now()
        s.commit()
        return _pl_dict(pl)


# --------------------------------------------------------------------------
# Print routes (HTML → browser Save-as-PDF, matching existing label system)
# --------------------------------------------------------------------------
def _company(batch_date: dt.date) -> dict:
    return {
        "shipper": SHIPPER_DETAILS, "consignee": CONSIGNEE_DETAILS,
        "to_party": TO_PARTY, "destination": DESTINATION,
        "batch_date": batch_date.isoformat(),
    }


@router.get("/prep/{date}/labels.html", response_class=HTMLResponse)
def print_outer_labels(request: Request, date: str, ids: str = ""):
    require_admin(request)   # only admins may generate/print package labels
    bd = _parse_date(date)
    with Session(_engine) as s:
        q = select(Package).where(Package.batch_date == bd).order_by(Package.package_number)
        pkgs = list(s.scalars(q).all())
        if ids:
            wanted = {int(x) for x in ids.split(",") if x.strip().isdigit()}
            pkgs = [p for p in pkgs if p.id in wanted]
        if not pkgs:
            raise HTTPException(404, "No packages to print for this batch.")
        total_count = len(list(s.scalars(
            select(Package).where(Package.batch_date == bd)).all()))
        labels = [_package_totals(s, p) for p in pkgs]
    return _templates.TemplateResponse("prep_outer_label.html", {
        "request": request, "labels": labels, "total_count": total_count,
        "company": _company(bd), "auto_print": True,
    })


@router.get("/prep/package/{pkg_id}/label.html", response_class=HTMLResponse)
def print_single_label(request: Request, pkg_id: int):
    require_admin(request)   # only admins may generate/print package labels
    with Session(_engine) as s:
        pkg = s.get(Package, pkg_id)
        if not pkg:
            raise HTTPException(404, "Package not found")
        total_count = len(list(s.scalars(
            select(Package).where(Package.batch_date == pkg.batch_date)).all()))
        label = _package_totals(s, pkg)
        bd = pkg.batch_date
    return _templates.TemplateResponse("prep_outer_label.html", {
        "request": request, "labels": [label], "total_count": total_count,
        "company": _company(bd), "auto_print": True,
    })


@router.get("/prep/{date}/packing-list.html", response_class=HTMLResponse)
def print_packing_list(request: Request, date: str):
    bd = _parse_date(date)
    data = get_packing_list(date)
    return _templates.TemplateResponse("prep_packing_list.html", {
        "request": request, "doc": data, "company": _company(bd),
        "title": "Packing list & Invoice", "auto_print": True,
    })


@router.get("/prep/{date}/invoice.html", response_class=HTMLResponse)
def print_invoice(request: Request, date: str):
    bd = _parse_date(date)
    data = get_packing_list(date)
    return _templates.TemplateResponse("prep_packing_list.html", {
        "request": request, "doc": data, "company": _company(bd),
        "title": "Commercial Invoice", "auto_print": True,
    })


@router.get("/prep/{date}/summary.html", response_class=HTMLResponse)
def print_summary(request: Request, date: str):
    bd = _parse_date(date)
    dash = prep_dashboard(date)
    with Session(_engine) as s:
        pkgs = list(s.scalars(
            select(Package).where(Package.batch_date == bd)
            .order_by(Package.package_number)).all())
        packages = [_package_totals(s, p) for p in pkgs]
    return _templates.TemplateResponse("prep_summary.html", {
        "request": request, "dash": dash, "packages": packages,
        "company": _company(bd), "auto_print": True,
    })


# --------------------------------------------------------------------------
# init
# --------------------------------------------------------------------------
def _ensure_package_id_column(engine):
    """Add shipments.package_id on existing SQLite databases."""
    if not str(engine.url).startswith("sqlite"):
        return
    with engine.connect() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(shipments)")).fetchall()}
        if "package_id" not in cols:
            try:
                conn.execute(text("ALTER TABLE shipments ADD COLUMN package_id INTEGER"))
                conn.commit()
            except Exception:
                pass


def _ensure_package_columns(engine):
    """Add newer packages columns (dropoff_reference, handling_marks) on existing DBs."""
    if not str(engine.url).startswith("sqlite"):
        return
    with engine.connect() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(packages)")).fetchall()}
        for name in ("dropoff_reference", "handling_marks"):
            if name not in cols:
                try:
                    conn.execute(text(
                        f"ALTER TABLE packages ADD COLUMN {name} VARCHAR DEFAULT ''"))
                    conn.commit()
                except Exception:
                    pass


def init_prep(app, engine, templates, Shipment) -> None:
    global _engine, _templates, _Shipment
    _engine = engine
    _templates = templates
    _Shipment = Shipment
    PrepBase.metadata.create_all(engine)
    _ensure_package_id_column(engine)
    _ensure_package_columns(engine)
    app.include_router(router)
