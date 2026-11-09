#!/usr/bin/env python3
"""Fetch country-level cotton trade flows from UN Comtrade into data/trade_flows.json.

Method: "mirror" statistics. Central Asian countries report little or late to
Comtrade, so we use the IMPORTS that every other country declares from them.

    python scripts/fetch_comtrade.py                     # 2023, HS 5201 + 5205
    python scripts/fetch_comtrade.py --year 2022 --min-tonnes 200
    python scripts/fetch_comtrade.py --hs 5201,5203,5205,5208

Without a key the public preview API is used (one year per call, rate-limited).
With a free key from https://comtradedeveloper.un.org set COMTRADE_KEY to use
the full API instead. Only the Python standard library is used.

Known gaps: Russia has not reported trade since 2022, so its purchases are missing.
Mirror figures can differ from the origin country's own export figures.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREVIEW = "https://comtradeapi.un.org/public/v1/preview/C/A/HS"
FULL = "https://comtradeapi.un.org/data/v1/get/C/A/HS"
PARTNERS = "https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json"
UA = {"User-Agent": "open-cotton-map/0.1 (research prototype)"}

ORIGINS = {"860": "Uzbekistan", "795": "Turkmenistan", "762": "Tajikistan", "398": "Kazakhstan"}
HS_LABELS = {
    "5201": "raw cotton (lint)", "5202": "cotton waste", "5203": "carded/combed cotton",
    "5204": "cotton sewing thread", "5205": "cotton yarn", "5206": "cotton yarn (<85%)",
    "5207": "cotton yarn (retail)", "5208": "cotton fabric", "5209": "cotton fabric (heavy)",
    "5210": "cotton blend fabric", "5211": "cotton blend fabric (heavy)", "5212": "other cotton fabric",
}

# Approximate country centroids (lat, lon), used to place countries on the map.
CENTROIDS = {
    "UZB": (41.4, 64.6), "TKM": (39.0, 59.6), "TJK": (38.9, 71.0), "KAZ": (48.0, 67.0),
    "KGZ": (41.5, 74.6), "AFG": (34.0, 66.0), "TUR": (39.0, 35.0), "IRN": (32.5, 54.0),
    "CHN": (35.0, 103.0), "RUS": (56.0, 45.0), "PAK": (30.0, 70.0), "IND": (22.0, 79.0),
    "BGD": (24.0, 90.0), "VNM": (16.0, 107.5), "IDN": (-2.5, 118.0), "JPN": (36.5, 138.5),
    "KOR": (36.5, 128.0), "THA": (15.5, 101.0), "MYS": (4.0, 102.0), "KHM": (12.5, 105.0),
    "MMR": (21.0, 96.0), "LKA": (7.8, 80.7), "PHL": (12.5, 122.0),
    "ARM": (40.2, 45.0), "AZE": (40.3, 47.7), "GEO": (42.2, 43.5), "BLR": (53.5, 28.0),
    "UKR": (49.0, 31.5), "MDA": (47.2, 28.5), "ROU": (45.9, 25.0), "BGR": (42.7, 25.3),
    "GRC": (39.3, 22.0), "MKD": (41.6, 21.7), "SRB": (44.0, 20.8), "ALB": (41.1, 20.0),
    "BIH": (44.2, 17.8), "MNE": (42.8, 19.3), "HRV": (45.3, 16.0), "SVN": (46.1, 14.8),
    "HUN": (47.2, 19.4), "SVK": (48.7, 19.5), "CZE": (49.8, 15.5), "POL": (52.1, 19.4),
    "LTU": (55.3, 23.9), "LVA": (56.9, 24.9), "EST": (58.7, 25.5), "FIN": (63.0, 26.0),
    "SWE": (62.0, 15.5), "NOR": (61.0, 9.0), "DNK": (56.0, 9.5), "DEU": (51.1, 10.4),
    "AUT": (47.6, 14.1), "CHE": (46.8, 8.2), "ITA": (42.8, 12.6), "FRA": (46.6, 2.4),
    "BEL": (50.6, 4.6), "NLD": (52.2, 5.5), "LUX": (49.8, 6.1), "GBR": (53.0, -1.8),
    "IRL": (53.2, -8.0), "ESP": (40.2, -3.6), "PRT": (39.6, -8.0), "MLT": (35.9, 14.4),
    "CYP": (35.0, 33.2), "ISR": (31.4, 35.0), "EGY": (26.5, 30.0), "MAR": (31.8, -6.8),
    "TUN": (34.0, 9.5), "DZA": (28.0, 2.6), "SAU": (24.0, 45.0), "ARE": (24.0, 54.0),
    "USA": (39.5, -98.5), "CAN": (56.0, -96.0), "MEX": (23.6, -102.5), "BRA": (-10.0, -52.0),
    "COL": (4.0, -73.0), "PER": (-9.5, -75.0),
}


def get_json(url, retries=4):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                wait = 5 * (attempt + 1)
                print(f"  HTTP {e.code}, retrying in {wait}s")
                time.sleep(wait)
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(5)
                continue
            raise


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, default=2023)
    ap.add_argument("--hs", default="5201,5205", help="comma-separated HS4 codes (default: lint + yarn)")
    ap.add_argument("--min-tonnes", type=float, default=500, help="drop flows below this weight")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "trade_flows.json")
    args = ap.parse_args()

    key = os.environ.get("COMTRADE_KEY")
    base = FULL if key else PREVIEW
    print(f"Using {'full API (COMTRADE_KEY)' if key else 'public preview API (no key)'}")

    ref = {p["id"]: p for p in get_json(PARTNERS)["results"]}
    iso = lambda code: ref.get(code, {}).get("PartnerCodeIsoAlpha3")
    name = lambda code: ref.get(code, {}).get("text", str(code))

    flows, countries, skipped = [], {}, []
    retrieved = date.today().isoformat()
    for code, origin in ORIGINS.items():
        params = {"partnerCode": code, "period": args.year, "cmdCode": args.hs, "flowCode": "M"}
        public_url = PREVIEW + "?" + urllib.parse.urlencode(params)  # never contains the key
        url = base + "?" + urllib.parse.urlencode(dict(params, **({"subscription-key": key} if key else {})))
        print(f"{origin}: fetching")
        data = get_json(url)
        if data.get("error"):
            sys.exit(f"Comtrade error for {origin}: {data['error']}")
        rows = [r for r in data.get("data") or []
                if r.get("motCode") == 0 and r.get("customsCode") == "C00" and r.get("partner2Code") == 0]
        o_iso = iso(int(code))
        for r in rows:
            kg = r.get("netWgt") or (r.get("qty") if r.get("qtyUnitCode") == 8 else None)
            tonnes = kg / 1000 if kg else None
            if tonnes is None or tonnes < args.min_tonnes:
                continue
            d_iso = iso(r["reporterCode"])
            if d_iso not in CENTROIDS:
                skipped.append(f"{name(r['reporterCode'])} ({d_iso}): no centroid, add it to CENTROIDS")
                continue
            hs = r["cmdCode"]
            for c_iso, c_code in ((o_iso, int(code)), (d_iso, r["reporterCode"])):
                lat, lon = CENTROIDS[c_iso]
                countries[c_iso] = {"name": name(c_code), "lat": lat, "lon": lon}
            flows.append({
                "id": f"ct_{o_iso}_{d_iso}_{hs}_{args.year}",
                "from": o_iso, "to": d_iso,
                "hs": hs, "product": HS_LABELS.get(hs, "HS " + hs),
                "volume_tonnes": round(tonnes, 1),
                "value_usd": round(r.get("primaryValue") or 0),
                "year": args.year,
                "description": (f"{name(r['reporterCode'])} declared {tonnes:,.0f} t of HS {hs} "
                                f"({HS_LABELS.get(hs, '')}) imported from {origin} in {args.year}. "
                                "Mirror statistic: reported by the importing country."),
                "sources": [public_url, "https://comtradeplus.un.org/"],
                "date": retrieved,
                "confidence": "confirmed",
                "sample": False,
            })
        print(f"  {len(rows)} records, {sum(f['from'] == o_iso for f in flows)} flows kept")
        if not key:
            time.sleep(3)  # stay under the preview rate limit

    for s in sorted(set(skipped)):
        print("warning  " + s)
    out = {
        "meta": {
            "source": "UN Comtrade (mirror import statistics)",
            "year": args.year, "hs": args.hs.split(","), "min_tonnes": args.min_tonnes,
            "retrieved": retrieved,
            "notes": "Country level only. Russia does not report since 2022. "
                     "Figures are declared by importers and may differ from exporter data.",
        },
        "countries": countries,
        "flows": sorted(flows, key=lambda f: -f["volume_tonnes"]),
    }
    args.out.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out} ({len(flows)} flows, {len(countries)} countries)")


if __name__ == "__main__":
    main()
