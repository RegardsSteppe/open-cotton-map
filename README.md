# Open Cotton Map (prototype)

Interactive map tracing cotton supply chains from Central Asia (Uzbekistan,
Turkmenistan, Tajikistan, Kazakhstan) to European fashion brands.

> **All current entries are SAMPLE DATA**: fictional names placed in real regions.
> They are not findings about any real company. Replace them with sourced data.

## Run

```sh
python -m http.server
```

Then open <http://localhost:8000>. No API key and no build step. Leaflet loads from
unpkg and the basemap (Esri Light Gray Canvas, keyless) from ArcGIS Online, so you
need an internet connection.

Selections can be shared by URL: `http://localhost:8000/#node=gin_kokand` or `#link=l08`.

## Files

```
index.html               page shell
css/style.css            styles
js/app.js                map, filters, side panel
data/raw.csv             nodes spreadsheet (source of truth)
data/raw_links.csv       flows spreadsheet (source of truth)
data/nodes.geojson       generated: nodes used by the map
data/links.json          generated: flows used by the map
scripts/build_data.py    CSV -> GeoJSON/JSON converter with validation
scripts/fetch_comtrade.py  UN Comtrade -> data/trade_flows.json (real country trade)
data/trade_flows.json    generated: country-level cotton trade flows
```

## Updating the data from a spreadsheet

1. Edit the two sheets (Excel, LibreOffice or Google Sheets) and export them as CSV
   to `data/raw.csv` and `data/raw_links.csv`. Comma, semicolon or tab separators all work.
2. Run `python scripts/build_data.py`
3. Reload the page.

The script stops without writing anything if it finds errors (unknown type, bad
coordinates, duplicate id, a flow pointing to a missing node, a non-http source…),
and lists warnings for missing dates, sources or volumes.

### `raw.csv` (nodes)

| column | required | notes |
|---|---|---|
| id | yes | unique, used by `raw_links.csv` |
| name | yes | |
| type | yes | `cotton_cluster`, `ginnery`, `spinning_mill`, `garment_factory`, `brand` |
| country | yes | free text, appears in the country filter |
| lat, lon | yes | decimal degrees (`41.3` or `41,3`) |
| description | | |
| sources | | one or more URLs separated by ` \| ` |
| date | | date of the information, ISO `YYYY-MM-DD` preferred |
| confidence | yes | `confirmed`, `probable`, `unverified` |
| sample | | `true` shows a SAMPLE DATA tag |

### `raw_links.csv` (flows)

| column | required | notes |
|---|---|---|
| id | yes | unique |
| from, to | yes | node ids |
| product | yes | e.g. seed cotton, cotton lint, yarn, garments |
| volume_tonnes | | estimated tonnes per year; sets line width |
| description, sources, date, confidence, sample | | same as nodes |

## Real country-level trade data (UN Comtrade)

```sh
python scripts/fetch_comtrade.py                 # 2023, raw cotton (HS 5201) + yarn (HS 5205)
python scripts/fetch_comtrade.py --year 2022 --hs 5201,5205,5208 --min-tonnes 200
```

This writes `data/trade_flows.json`, shown as the blue "Country trade" layer. It uses
**mirror statistics**: the imports that each partner country declares from Uzbekistan,
Turkmenistan, Tajikistan and Kazakhstan, because these four report little themselves.
No key is needed (public preview API, one year per call). With a free key from
<https://comtradedeveloper.un.org>, set `COMTRADE_KEY` to use the full API.

Limits: country-to-country only (no companies); Russia does not report since 2022;
importer and exporter figures can differ. If a partner country is skipped, add its
centroid to `CENTROIDS` in the script.

## How the map reads

- **Node colour** = node type. **Node style** = confidence (solid fill = confirmed,
  light fill = probable, dashed outline = unverified).
- **Flows** are arcs coloured by the sending node's type, with width set by
  √volume. Line style shows confidence (solid / dashed / dotted). Arrows show direction.
- Clicking a node opens its details and highlights the full chain upstream and
  downstream of it. Clicking a flow shows that flow.
- A flow is shown only when both of its nodes pass the filters and its own
  confidence level is selected.
