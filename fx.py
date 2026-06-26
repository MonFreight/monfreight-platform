"""
AUD -> MNT exchange rate.

Pulls the Australian dollar SELL rate from Golomt bank as published on
gogo.mn/exchange (the "Австралийн доллар · Голомт · Зарах" value), with a
safe fallback so a fetch failure can never break the page.

This module is intentionally side-effect free: it only fetches and parses.
Caching/persistence lives in app.py (the app_settings table).
"""
from __future__ import annotations

import html as _html
import re

import requests

GOGO_URL = "https://gogo.mn/exchange"

# Last known Golomt AUD sell rate (2026-06-26). Used only if there is no
# cached value AND the live fetch fails — purely a safety net so the UI can
# still show a number on a brand-new install.
FALLBACK_RATE = 2552.48

# Sanity band for an AUD->MNT rate. Anything outside this is treated as a
# parse error and ignored, so a layout change on gogo.mn can't feed a junk
# number into the conversion.
PLAUSIBLE_MIN = 1500.0
PLAUSIBLE_MAX = 4000.0

# A money figure like "2,552.48" or "2552" or "2,418.00". Deliberately does
# NOT match the small delta numbers gogo shows (e.g. "2.42") because those
# have fewer than 3 leading digits and no thousands separator.
_NUM_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{3,}(?:\.\d+)?")


def parse_golomt_aud_sell(html_text: str) -> float | None:
    """Extract the Golomt AUD sell rate from the gogo.mn exchange HTML.

    Strategy: strip tags to plain text, then for each "Австралийн доллар"
    block look for the "Голомт" row that follows and read its rate figures.
    On that row the first money figure is Авах (buy) and the second is
    Зарах (sell). Returns the sell rate, or None if nothing plausible found.
    """
    if not html_text:
        return None
    text = re.sub(r"<[^>]+>", " ", html_text)
    text = _html.unescape(text)
    # Drop the "last updated" dates (e.g. 2026/06/26) so the year can't be
    # mistaken for a rate figure.
    text = re.sub(r"\d{4}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{1,2}", " ", text)
    text = re.sub(r"[\s ]+", " ", text)

    candidates: list[float] = []
    for m in re.finditer(r"Австралийн доллар", text):
        segment = text[m.start():m.start() + 1500]
        g = re.search(r"Голомт", segment)
        if not g:
            continue
        after = segment[g.start():g.start() + 220]
        vals = [float(n.replace(",", "")) for n in _NUM_RE.findall(after)]
        big = [v for v in vals if v >= 500]  # drop delta figures like 2.42
        if len(big) >= 2:
            candidates.append(big[1])        # second money figure = sell
        elif len(big) == 1:
            candidates.append(big[0])

    for c in candidates:
        if PLAUSIBLE_MIN <= c <= PLAUSIBLE_MAX:
            return round(c, 2)
    return None


def fetch_live_rate(timeout: int = 12) -> float | None:
    """Fetch gogo.mn and return the Golomt AUD sell rate, or None on failure.

    Raises nothing for HTTP/parse problems is NOT guaranteed — callers should
    wrap this in try/except so a network error can't bubble into a request.
    """
    resp = requests.get(
        GOGO_URL,
        timeout=timeout,
        headers={"User-Agent": "Mozilla/5.0 (MonFreight exchange-rate fetcher)"},
    )
    resp.raise_for_status()
    return parse_golomt_aud_sell(resp.text)
