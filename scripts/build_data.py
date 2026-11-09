#!/usr/bin/env python3
"""Convert spreadsheet exports into the data files used by the map.

    data/raw.csv        ->  data/nodes.geojson   (always)
    data/raw_links.csv  ->  data/links.json      (if the file exists)

Usage:
    python scripts/build_data.py
    python scripts/build_data.py --nodes my_nodes.csv --links my_links.csv

Only the Python standard library is used. CSV files may be comma-, semicolon-
or tab-separated (Excel in French locale exports with ";"), UTF-8 with or
without BOM.

Node columns (raw.csv):
    id, name, type, country, lat, lon, description, sources, date, confidence, sample
Link columns (raw_links.csv):
    id, from, to, product, volume_tonnes, description, sources, date, confidence, sample

`sources`: one or more URLs separated by " | ".
`sample`:  true/false (anything else counts as false). Marks SAMPLE DATA.
"""

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE_TYPES = {"cotton_cluster", "ginnery", "spinning_mill", "fabric_mill", "garment_factory", "brand"}
CONFIDENCE = {"confirmed", "probable", "unverified"}
NODE_REQUIRED = ["id", "name", "type", "country", "lat", "lon", "confidence"]
LINK_REQUIRED = ["id", "from", "to", "product", "confidence"]
TRUE_VALUES = {"true", "yes", "1", "y", "oui", "x"}


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def error(self, where, msg):
        self.errors.append(f"{where}: {msg}")

    def warn(self, where, msg):
        self.warnings.append(f"{where}: {msg}")


def read_csv(path):
    text = path.read_text(encoding="utf-8-sig")
    first_line = text.splitlines()[0] if text else ""
    try:
        dialect = csv.Sniffer().sniff(first_line, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(text.splitlines(), dialect=dialect)
    rows = []
    for row in reader:
        clean = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        if any(clean.values()):  # skip fully empty lines
            rows.append(clean)
    return rows


def parse_sources(raw, where, rep):
    urls = [u.strip() for u in raw.split("|") if u.strip()]
    for u in urls:
        if not (u.startswith("http://") or u.startswith("https://")):
            rep.error(where, f"source is not an http(s) URL: {u!r}")
    if not urls:
        rep.warn(where, "no source URL")
    return urls


def common_fields(row, where, rep):
    conf = row.get("confidence", "").lower()
    if conf not in CONFIDENCE:
        rep.error(where, f"confidence must be one of {sorted(CONFIDENCE)}, got {conf!r}")
    if not row.get("date"):
        rep.warn(where, "no date")
    return {
        "description": row.get("description", ""),
        "sources": parse_sources(row.get("sources", ""), where, rep),
        "date": row.get("date", ""),
        "confidence": conf,
        "sample": row.get("sample", "").lower() in TRUE_VALUES,
    }


def check_required(row, required, where, rep):
    ok = True
    for col in required:
        if not row.get(col):
            rep.error(where, f"missing required column '{col}'")
            ok = False
    return ok


def build_nodes(rows, rep):
    features, seen = [], set()
    for i, row in enumerate(rows, start=2):  # row 1 is the header
        where = f"raw.csv line {i}"
        if not check_required(row, NODE_REQUIRED, where, rep):
            continue
        nid = row["id"]
        if nid in seen:
            rep.error(where, f"duplicate id {nid!r}")
        seen.add(nid)
        ntype = row["type"].lower()
        if ntype not in NODE_TYPES:
            rep.error(where, f"type must be one of {sorted(NODE_TYPES)}, got {ntype!r}")
        try:
            lat, lon = float(row["lat"].replace(",", ".")), float(row["lon"].replace(",", "."))
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError
        except ValueError:
            rep.error(where, f"invalid coordinates lat={row['lat']!r} lon={row['lon']!r}")
            continue
        props = {"id": nid, "name": row["name"], "type": ntype, "country": row["country"],
                 "city": row.get("city", "")}
        props.update(common_fields(row, where, rep))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},  # GeoJSON order
            "properties": props,
        })
    return {"type": "FeatureCollection", "features": features}


def build_links(rows, node_ids, rep):
    links, seen = [], set()
    for i, row in enumerate(rows, start=2):
        where = f"raw_links.csv line {i}"
        if not check_required(row, LINK_REQUIRED, where, rep):
            continue
        if row["id"] in seen:
            rep.error(where, f"duplicate id {row['id']!r}")
        seen.add(row["id"])
        for end in ("from", "to"):
            if row[end] not in node_ids:
                rep.error(where, f"'{end}' references unknown node id {row[end]!r}")
        vol = None
        if row.get("volume_tonnes"):
            try:
                vol = float(row["volume_tonnes"].replace(" ", "").replace(",", "."))
            except ValueError:
                rep.error(where, f"volume_tonnes is not a number: {row['volume_tonnes']!r}")
        else:
            rep.warn(where, "no volume estimate (link will be drawn thin)")
        link = {
            "id": row["id"],
            "from": row["from"],
            "to": row["to"],
            "product": row["product"],
            "volume_tonnes": vol,
        }
        link.update(common_fields(row, where, rep))
        links.append(link)
    return links


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nodes", default=ROOT / "data" / "raw.csv", type=Path)
    ap.add_argument("--links", default=ROOT / "data" / "raw_links.csv", type=Path)
    ap.add_argument("--out-dir", default=ROOT / "data", type=Path)
    args = ap.parse_args()

    rep = Report()
    if not args.nodes.exists():
        sys.exit(f"Not found: {args.nodes}")
    geojson = build_nodes(read_csv(args.nodes), rep)
    node_ids = {f["properties"]["id"] for f in geojson["features"]}

    links = None
    if args.links.exists():
        links = build_links(read_csv(args.links), node_ids, rep)

    for w in rep.warnings:
        print(f"warning  {w}")
    for e in rep.errors:
        print(f"ERROR    {e}")
    if rep.errors:
        sys.exit(f"\n{len(rep.errors)} error(s); nothing written.")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    nodes_out = args.out_dir / "nodes.geojson"
    nodes_out.write_text(json.dumps(geojson, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {nodes_out} ({len(geojson['features'])} nodes)")
    if links is not None:
        links_out = args.out_dir / "links.json"
        links_out.write_text(json.dumps(links, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {links_out} ({len(links)} links)")
    else:
        print(f"{args.links} not found; links.json left unchanged")


if __name__ == "__main__":
    main()
