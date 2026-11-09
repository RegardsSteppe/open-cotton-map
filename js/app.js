/* PAXTA — Open Cotton Map
 * Loads data/nodes.geojson + data/links.json (+ optional data/trade_flows.json)
 * and draws nodes and curved flows. No build step, no API key.
 * Design rules: CLAUDE.md § Design. Node type = shape, confidence = fill (solid / outline / dotted) + line style.
 */
(function () {
  "use strict";

  // ---------- configuration ----------
  const C = {
    night: "#10162B", surface: "#18213F", cotton: "#F2EDE4",
    madder: "#B3261E", saffron: "#E0A526", rishtan: "#2BA6A0",
  };
  // Shapes drawn in a 24×24 box.
  const NODE_TYPES = {
    cotton_cluster:  { label: "Cotton field",    uz: "Paxta dalasi",            size: 24, shape: '<circle cx="12" cy="12" r="9.5"/>' },
    ginnery:         { label: "Ginnery",         uz: "Paxta tozalash zavodi",   size: 20, shape: '<rect x="3" y="3" width="18" height="18"/>' },
    spinning_mill:   { label: "Spinning mill",   uz: "Yigirish fabrikasi",      size: 22, shape: '<path d="M12 1.5 L22.5 12 L12 22.5 L1.5 12 Z"/>' },
    fabric_mill:     { label: "Fabric mill",     uz: "Mato fabrikasi",          size: 22, shape: '<path d="M12 2 L22 9.5 L18.5 21.5 H5.5 L2 9.5 Z"/>' },
    garment_factory: { label: "Garment factory", uz: "Tikuv fabrikasi",         size: 22, shape: '<path d="M12 2 L22.5 21 H1.5 Z"/>' },
    brand:           { label: "Brand",           uz: "Brend",                   size: 22, shape: '<path d="M12 1.5 L21.5 7 V17 L12 22.5 L2.5 17 V7 Z"/>' },
  };
  const CONFIDENCE = {
    confirmed:  { label: "Verified",  uz: "Tasdiqlangan",   filter: "",     dash: null,
                  help: "Independent sources, archived." },
    probable:   { label: "Claimed",   uz: "Ehtimoliy",      filter: "fray", dash: "10 3",
                  help: "Declared by a company or inferred from trade data, not verified." },
    unverified: { label: "Unknown",   uz: "Nomaʼlum",       filter: "fade", dash: "3 5",
                  help: "No public source." },
  };
  const HOME = [[33, -10], [52, 76]];
  const CA = [[34, 54], [46, 76]];
  const ARC_ZOOM = 6;            // projection zoom used to build arc geometry
  const MIN_W = 1.5, MAX_W = 11; // flow stroke width range (px)

  // ---------- state ----------
  const state = {
    nodes: new Map(),   // id -> feature properties + latlng
    links: [],
    trade: { meta: null, countries: {}, flows: [] },
    products: {},
    trace: null,
    maxVolume: 1,
    layers: { company: true, trade: false },
    filters: { country: new Set(), type: new Set(), confidence: new Set() },
    selected: null,     // { kind: "node"|"link"|"trade", id }
  };

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtT = (v) => (v == null ? "unknown" : Math.round(v).toLocaleString("en-US") + " t");
  const safeUrl = (u) => /^https?:\/\//i.test(u) ? u : null;
  const hostname = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  const widthFor = (v) => v == null ? MIN_W : MIN_W + (MAX_W - MIN_W) * Math.sqrt(v / state.maxVolume);
  const uz = (s) => `<span class="uz" lang="uz">· ${s}</span>`;
  const filterAttr = (conf) => CONFIDENCE[conf] && CONFIDENCE[conf].filter ? ` filter="url(#${CONFIDENCE[conf].filter})"` : "";

  // ikat swatch: the visual unit of confidence
  const ikatSwatch = (conf, w, h, cls) =>
    `<svg class="${cls || "swatch"}" width="${w}" height="${h}" aria-hidden="true"><rect width="100%" height="100%" fill="url(#ikat)"${filterAttr(conf)}/></svg>`;

  // node marker: shape = node type, 14px cotton. Confidence = fill:
  // confirmed solid, probable 1.5px outline, unverified dotted outline at 40 % opacity.
  const MARK = 14;
  function shapeSvg(type, conf, opts) {
    const t = NODE_TYPES[type], o = opts || {};
    const size = o.size || MARK;
    const k = 26 / size;                       // viewBox units per px
    const col = o.selected ? C.saffron : C.cotton;
    const solid = conf === "confirmed" && !o.outlineOnly;
    const dash = conf === "unverified" ? ` stroke-dasharray="${(2 * k).toFixed(2)} ${(1.5 * k).toFixed(2)}"` : "";
    const op = conf === "unverified" ? ' opacity=".4"' : "";
    return `<svg width="${size}" height="${size}" viewBox="-1 -1 26 26" aria-hidden="true"${op}>` +
      `<g fill="${solid ? col : "none"}" stroke="${col}" stroke-width="${(1.5 * k).toFixed(2)}"${dash}>${t.shape}</g></svg>`;
  }

  // confidence key: node fill + link stroke style, as drawn on the map
  const linkKey = (conf, w) => `<svg width="${w || 26}" height="12" aria-hidden="true"><line x1="1" y1="6" x2="${(w || 26) - 1}" y2="6"
    stroke="${C.madder}" stroke-width="2.5"${CONFIDENCE[conf].dash ? ` stroke-dasharray="${CONFIDENCE[conf].dash}"` : ""}/></svg>`;
  const confKey = (conf) => `<span class="key">${shapeSvg("cotton_cluster", conf)}</span>${linkKey(conf)}`;

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true, worldCopyJump: true, minZoom: 2, zoomSnap: 0.25 }).fitBounds(HOME);

  // Keyless basemap (Esri Dark Gray Canvas), tinted to night indigo in CSS.
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16, className: "base-tiles", attribution: "Tiles &copy; Esri — Esri, DeLorme, NAVTEQ",
  }).addTo(map);

  map.createPane("links").style.zIndex = 390;
  map.createPane("nodes").style.zIndex = 610;
  map.createPane("traceZone").style.zIndex = 385;
  map.createPane("traceLinks").style.zIndex = 620;
  map.createPane("traceNodes").style.zIndex = 630;
  map.createPane("water").style.zIndex = 380;
  const linkRenderer = L.svg({ pane: "links" });
  const nodeRenderer = L.svg({ pane: "nodes" });
  // Aral Sea, approximate 1960 shoreline (display only)
  const ARAL = [[46.9, 60.3], [46.8, 61.5], [46.2, 61.3], [45.5, 61.2], [44.8, 61.5], [44.0, 60.7], [43.6, 59.6], [43.9, 58.7], [44.5, 58.1], [45.2, 58.0], [45.9, 58.5], [46.5, 59.2]];
  L.polygon(ARAL, { renderer: L.svg({ pane: "water" }), pane: "water", color: C.rishtan, weight: 1.5, fill: true, fillColor: C.rishtan, fillOpacity: 0.12 })
    .bindTooltip("<strong>Aral Sea</strong><br>Shrank dramatically since the 1960s as the Amu Darya and Syr Darya were diverted to irrigate cotton.",
      { sticky: true, className: "water-tip" }).addTo(map);
  L.marker([45.3, 59.8], { pane: "water", interactive: false, keyboard: false,
    icon: L.divIcon({ className: "water-label", html: "Aral Sea", iconSize: [80, 14], iconAnchor: [40, 7] }) }).addTo(map);
  const linkLayer = L.layerGroup().addTo(map);
  const arrowLayer = L.layerGroup().addTo(map);
  const nodeLayer = L.layerGroup().addTo(map);

  map.on("click", () => { if (!state.trace) select(null); });
  map.on("zoomend", render);

  // Quadratic Bézier in Web-Mercator pixel space. Company arcs bow north, trade arcs south.
  function arc(a, b, steps, south) {
    const p0 = map.project(a, ARC_ZOOM), p2 = map.project(b, ARC_ZOOM);
    const dx = p2.x - p0.x, dy = p2.y - p0.y, len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len, ny = dx / len;
    if ((ny > 0) !== !!south) { nx = -nx; ny = -ny; }
    const bend = len * 0.2;
    const c = L.point((p0.x + p2.x) / 2 + nx * bend, (p0.y + p2.y) / 2 + ny * bend);
    const at = (t) => L.point(
      (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p2.x,
      (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p2.y);
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(map.unproject(at(i / steps), ARC_ZOOM));
    const m0 = at(0.5), m1 = at(0.52);
    return {
      latlngs: pts,
      mid: map.unproject(m0, ARC_ZOOM),
      angle: Math.atan2(m1.y - m0.y, m1.x - m0.x) * 180 / Math.PI,
      screenLen: len * Math.pow(2, map.getZoom() - ARC_ZOOM),
    };
  }

  // ---------- filtering ----------
  function nodeVisible(n) {
    const f = state.filters;
    return f.country.has(n.country) && f.type.has(n.type) && f.confidence.has(n.confidence);
  }
  function visibleTrade() {
    if (!state.layers.trade) return [];
    return state.trade.flows.filter((f) =>
      state.filters.country.has(state.trade.countries[f.from].name) && state.filters.confidence.has(f.confidence));
  }
  function visibleLinks() {
    if (!state.layers.company) return [];
    return state.links.filter((l) => {
      const a = state.nodes.get(l.from), b = state.nodes.get(l.to);
      return a && b && nodeVisible(a) && nodeVisible(b) && state.filters.confidence.has(l.confidence);
    });
  }

  // Everything upstream and downstream of the selection, through visible links.
  function traced(links) {
    const sel = state.selected;
    if (!sel) return null;
    const nodes = new Set(), linkIds = new Set();
    if (sel.kind === "trade") return { nodes, linkIds, trade: sel.id };
    if (sel.kind === "link") {
      const l = links.find((x) => x.id === sel.id);
      if (!l) return null;
      linkIds.add(l.id); nodes.add(l.from); nodes.add(l.to);
      return { nodes, linkIds };
    }
    nodes.add(sel.id);
    const walk = (start, fwd) => {
      const queue = [start], seen = new Set([start]);
      while (queue.length) {
        const cur = queue.shift();
        for (const l of links) {
          const [here, there] = fwd ? [l.from, l.to] : [l.to, l.from];
          if (here !== cur) continue;
          linkIds.add(l.id); nodes.add(there);
          if (!seen.has(there)) { seen.add(there); queue.push(there); }
        }
      }
    };
    walk(sel.id, true); walk(sel.id, false);
    return { nodes, linkIds };
  }

  // ---------- rendering ----------
  function render() {
    linkLayer.clearLayers(); arrowLayer.clearLayers(); nodeLayer.clearLayers();
    const links = visibleLinks();
    const trade = visibleTrade();
    const trace = traced(links);

    // country-level trade (UN Comtrade): cotton threads, under the company chain
    const tradeCountries = new Set();
    trade.slice().sort((a, b) => b.volume_tonnes - a.volume_tonnes).forEach((f) => {
      const A = state.trade.countries[f.from], B = state.trade.countries[f.to];
      tradeCountries.add(f.from); tradeCountries.add(f.to);
      const geo = arc(L.latLng(A.lat, A.lon), L.latLng(B.lat, B.lon), 48, true);
      const isSel = trace && trace.trade === f.id;
      const dim = trace && !isSel;
      const line = L.polyline(geo.latlngs, {
        renderer: linkRenderer, pane: "links", color: isSel ? C.saffron : C.cotton,
        weight: isSel ? 2 : 1, opacity: dim ? 0.06 : isSel ? 0.95 : 0.2,
      });
      line.bindTooltip(`${esc(A.name)} → ${esc(B.name)}<br><span class="mono">${esc(f.product)} · ${fmtT(f.volume_tonnes)} · ${f.year}</span>`, { sticky: true });
      line.on("click", (e) => { L.DomEvent.stopPropagation(e); select({ kind: "trade", id: f.id }); });
      linkLayer.addLayer(line);
      if (geo.screenLen > 50) arrowLayer.addLayer(arrowMarker(geo, isSel ? C.saffron : C.cotton, null, dim ? 0.1 : 0.3));
    });
    tradeCountries.forEach((iso) => {
      const c = state.trade.countries[iso];
      const m = L.circleMarker([c.lat, c.lon], {
        renderer: nodeRenderer, pane: "nodes", radius: 3.5, weight: 1.2,
        color: C.cotton, fillColor: C.night, fillOpacity: 1, opacity: trace && !trace.trade ? 0.25 : 0.7,
      });
      m.bindTooltip(`${esc(c.name)}<br><span class="mono">country · trade statistics</span>`, { direction: "top", offset: [0, -4] });
      nodeLayer.addLayer(m);
    });

    // company chain: madder lines, crisp; stroke style = confidence
    links.slice().sort((a, b) => (b.volume_tonnes || 0) - (a.volume_tonnes || 0)).forEach((l) => {
      const a = state.nodes.get(l.from), b = state.nodes.get(l.to);
      const geo = arc(a.latlng, b.latlng, 48);
      const dim = trace && !trace.linkIds.has(l.id);
      const isSel = state.selected && state.selected.kind === "link" && state.selected.id === l.id;
      const color = isSel ? C.saffron : C.madder;
      const line = L.polyline(geo.latlngs, {
        renderer: linkRenderer, pane: "links", className: "flow-" + l.confidence,
        color, weight: widthFor(l.volume_tonnes) + 1, opacity: dim ? 0.15 : 0.95,
        dashArray: CONFIDENCE[l.confidence].dash, lineCap: "butt",
      });
      line.bindTooltip(`${esc(a.name)} → ${esc(b.name)}<br><span class="mono">${esc(l.product)} · ${fmtT(l.volume_tonnes)} · ${esc(l.confidence)}</span>`, { sticky: true });
      line.on("click", (e) => { L.DomEvent.stopPropagation(e); select({ kind: "link", id: l.id }); });
      linkLayer.addLayer(line);
      if (geo.screenLen > 50) arrowLayer.addLayer(arrowMarker(geo, color, l.volume_tonnes, dim ? 0.15 : 0.95));
    });

    let nodeCount = 0;
    state.nodes.forEach((n) => {
      if (!state.layers.company || !nodeVisible(n)) return;
      nodeCount++;
      const t = NODE_TYPES[n.type];
      const dim = trace && !trace.nodes.has(n.id);
      const isSel = state.selected && state.selected.kind === "node" && state.selected.id === n.id;
      const size = MARK + (isSel ? 4 : 0);
      const m = L.marker(n.latlng, {
        pane: "nodes", opacity: dim ? 0.25 : 1, riseOnHover: true, keyboard: true, title: n.name,
        icon: L.divIcon({
          className: "node-icon", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          html: shapeSvg(n.type, n.confidence, { size, selected: isSel }),
        }),
      });
      m.bindTooltip(`<strong>${esc(n.name)}</strong><br><span class="mono">${t.label} · ${esc(n.country)} · ${esc(n.confidence)}</span>`,
        { direction: "top", offset: [0, -size / 2] });
      m.on("click", (e) => { L.DomEvent.stopPropagation(e); select({ kind: "node", id: n.id }); });
      nodeLayer.addLayer(m);
    });
    const seenCity = new Set();
    state.nodes.forEach((n) => {
      if (!n.city || seenCity.has(n.city) || !state.layers.company || !nodeVisible(n)) return;
      seenCity.add(n.city);
      nodeLayer.addLayer(cityLabel(n.city, n.latlng, trace && !trace.nodes.has(n.id)));
    });

    $("#stats").textContent = `${nodeCount}/${state.nodes.size} nodes · ${links.length}/${state.links.length} company flows · ` +
      `${trade.length}/${state.trade.flows.length} trade flows`;
  }

  function cityLabel(name, ll, dim, pane) {
    return L.marker(ll, {
      pane: pane || "nodes", interactive: false, keyboard: false, opacity: dim ? 0.25 : 1,
      icon: L.divIcon({ className: "city-label", html: esc(name), iconSize: null, iconAnchor: [-13, 7] }),
    });
  }

  function arrowMarker(geo, color, volume, opacity, pane) {
    const size = 8 + Math.min(widthFor(volume), 8);
    return L.marker(geo.mid, {
      pane: pane || "links", interactive: false, keyboard: false,
      icon: L.divIcon({
        className: "flow-arrow", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        html: `<svg width="${size}" height="${size}" viewBox="0 0 10 10" style="transform:rotate(${geo.angle}deg);opacity:${opacity}"><path d="M1,1 L9,5 L1,9 z" fill="${color}" stroke="${C.night}" stroke-width="0.8"/></svg>`,
      }),
    });
  }

  // ---------- side panel ----------
  function select(sel) {
    if (state.trace) { if (!sel) return; clearTrace(true); }
    state.selected = sel;
    history.replaceState(null, "", sel ? `#${sel.kind}=${encodeURIComponent(sel.id)}` : location.pathname);
    render();
    if (!sel) { $("#panel").hidden = true; return; }
    $("#panel-body").innerHTML = sel.kind === "node" ? nodeHtml(state.nodes.get(sel.id))
      : sel.kind === "trade" ? tradeHtml(state.trade.flows.find((f) => f.id === sel.id))
      : linkHtml(state.links.find((l) => l.id === sel.id));
    $("#panel").hidden = false;
    $("#panel").scrollTop = 0;
    setTimeout(() => {
      map.invalidateSize();
      // On narrow screens the panel covers the bottom of the map: move the selection to the top.
      if (window.innerWidth <= 900) {
        let ll;
        if (sel.kind === "node") ll = state.nodes.get(sel.id).latlng;
        else if (sel.kind === "trade") {
          const f = state.trade.flows.find((x) => x.id === sel.id), T = state.trade.countries;
          ll = L.latLngBounds([[T[f.from].lat, T[f.from].lon], [T[f.to].lat, T[f.to].lon]]).getCenter();
        } else {
          const l = state.links.find((x) => x.id === sel.id);
          ll = L.latLngBounds([state.nodes.get(l.from).latlng, state.nodes.get(l.to).latlng]).getCenter();
        }
        const p = map.latLngToContainerPoint(ll), s = map.getSize();
        map.panBy([p.x - s.x / 2, p.y - s.y * 0.2]);
      }
    }, 0);
  }

  const h4 = (en, uzLabel) => `<h4>${en} ${uz(uzLabel)}</h4>`;

  function confHtml(c) {
    const conf = CONFIDENCE[c] || { label: c, uz: "", help: "" };
    return `<div class="conf">${ikatSwatch(c, 16, 60, "")}
      <div><strong>${esc(conf.label)}</strong> ${conf.uz ? uz(conf.uz) : ""}<p>${esc(conf.help)}</p></div></div>`;
  }

  function sourcesHtml(sources) {
    if (!sources || !sources.length) return "<p class='meta'>No source recorded.</p>";
    return "<ul class='sources'>" + sources.map((u) => {
      const href = safeUrl(u);
      return href
        ? `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(hostname(href))}</a><span class="path">${esc(href.replace(/^https?:\/\/[^/]+/, ""))}</span></li>`
        : `<li>${esc(u)}</li>`;
    }).join("") + "</ul>";
  }

  const sampleTag = (s) => s ? `<span class="sample-tag">SAMPLE DATA</span>` : "";
  const nodeBtn = (id) => {
    const n = state.nodes.get(id);
    return `<button class="linkbtn" data-node="${esc(id)}">${esc(n ? n.name : id)}</button>`;
  };

  function nodeHtml(n) {
    const t = NODE_TYPES[n.type];
    const flows = (dir) => state.links.filter((l) => (dir === "in" ? l.to : l.from) === n.id);
    const flowList = (arr, dir) => arr.length ? `<ul class="flow-list">${arr.map((l) => `
      <li>${dir === "in" ? "from " + nodeBtn(l.from) : "to " + nodeBtn(l.to)}
        <div class="muted">${esc(l.product)} · ${fmtT(l.volume_tonnes)} · ${esc(l.confidence)}
        · <button class="linkbtn" data-link="${esc(l.id)}">details</button></div></li>`).join("")}</ul>`
      : "<p class='meta'>None recorded.</p>";
    return `
      <span class="chip">${shapeSvg(n.type, n.confidence, { size: 16 })}${t.label} ${uz(t.uz)}</span>${sampleTag(n.sample)}
      <h3>${esc(n.name)}</h3>
      <p class="meta">${esc(n.country)} · updated ${esc(n.date || "n/a")}</p>
      ${confHtml(n.confidence)}
      ${h4("Description", "Tavsif")}<p>${esc(n.description || "—")}</p>
      ${h4("Sources", "Manbalar")}${sourcesHtml(n.sources)}
      ${h4("Incoming flows", "Kiruvchi oqimlar")}${flowList(flows("in"), "in")}
      ${h4("Outgoing flows", "Chiquvchi oqimlar")}${flowList(flows("out"), "out")}
      <p class="meta" style="margin-top:16px">The map highlights everything upstream and downstream of this node.</p>`;
  }

  function linkHtml(l) {
    return `
      <span class="chip"><svg width="18" height="10" aria-hidden="true"><line x1="0" y1="5" x2="18" y2="5" stroke="${C.madder}" stroke-width="3"/></svg>Company flow ${uz("Oqim")}</span>${sampleTag(l.sample)}
      <h3>${esc(l.product)}</h3>
      <p class="meta">${nodeBtn(l.from)} → ${nodeBtn(l.to)}</p>
      ${confHtml(l.confidence)}
      ${h4("Details", "Tafsilotlar")}
      <dl><dt>Estimated volume</dt><dd>${fmtT(l.volume_tonnes)} / year</dd>
          <dt>Date</dt><dd>${esc(l.date || "n/a")}</dd></dl>
      ${h4("Description", "Tavsif")}<p>${esc(l.description || "—")}</p>
      ${h4("Sources", "Manbalar")}${sourcesHtml(l.sources)}`;
  }

  function tradeHtml(f) {
    const T = state.trade.countries, meta = state.trade.meta || {};
    return `
      <span class="chip"><svg width="18" height="10" aria-hidden="true"><line x1="0" y1="5" x2="18" y2="5" stroke="${C.cotton}" stroke-opacity=".6" stroke-width="3"/></svg>Country trade · UN Comtrade</span>
      <h3>${esc(T[f.from].name)} → ${esc(T[f.to].name)}</h3>
      <p class="meta">${esc(f.product)} · HS ${esc(f.hs)} · ${esc(f.year)}</p>
      ${confHtml(f.confidence)}
      ${h4("Details", "Tafsilotlar")}
      <dl><dt>Net weight</dt><dd>${fmtT(f.volume_tonnes)}</dd>
          <dt>Declared value</dt><dd>${f.value_usd ? "US$ " + Math.round(f.value_usd).toLocaleString("en-US") : "n/a"}</dd>
          <dt>Retrieved</dt><dd>${esc(f.date)}</dd></dl>
      ${h4("Description", "Tavsif")}<p>${esc(f.description)}</p>
      ${h4("Caveats", "Cheklovlar")}<p class="meta">${esc(meta.notes || "")} This is a country-to-country flow: it does not identify companies.</p>
      ${h4("Sources", "Manbalar")}${sourcesHtml(f.sources)}`;
  }

  $("#panel-body").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-trace]")) return clearTrace();
    const b = e.target.closest("[data-node],[data-link]");
    if (!b) return;
    if (b.dataset.node) {
      select({ kind: "node", id: b.dataset.node });
      const n = state.nodes.get(b.dataset.node);
      if (n && !map.getBounds().contains(n.latlng)) map.panTo(n.latlng);
    } else select({ kind: "link", id: b.dataset.link });
  });
  const closeAll = () => (state.trace ? clearTrace() : select(null));
  $("#panel-close").addEventListener("click", closeAll);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });

  // ---------- product trace (#trace-<id>) ----------
  const traceGroup = L.layerGroup().addTo(map);
  const traceRenderer = L.svg({ pane: "traceLinks" });
  const ORIGIN_ZONE = [
    [[[45.6, 56], [45, 61], [44, 66], [43, 71], [41, 73], [39.5, 71], [37.3, 67], [37.5, 64.5], [41, 60], [41.5, 56]]],
    [[[42, 54.5], [41, 60], [37.5, 64.5], [36.5, 66.5], [35.2, 62.5], [36.5, 60.5], [37.4, 56], [38, 54], [39.5, 53.8]]],
    [[[41, 70.5], [39.5, 71], [39, 74.8], [37.5, 75], [37.2, 71.5], [37.2, 68], [38.5, 67.7], [39.8, 68.5]]],
  ];
  let traceTimers = [];

  function stopTrace() { traceTimers.forEach(clearTimeout); traceTimers = []; traceGroup.clearLayers(); }

  function clearTrace(silent) {
    stopTrace(); state.trace = null;
    document.body.classList.remove("tracing");
    if (silent) return;
    history.replaceState(null, "", location.pathname);
    $("#panel").hidden = true;
    map.invalidateSize(); map.fitBounds(HOME); render();
  }

  function startTrace(id) {
    const p = state.products[id];
    if (!p || !p.steps.every((s) => !s.node || state.nodes.has(s.node))) return false;
    stopTrace();
    const tr = state.trace = { id, p };
    state.selected = null;
    document.body.classList.add("tracing");
    $("#panel-body").innerHTML = traceHtml(p);
    $("#panel").hidden = false;
    $("#panel").scrollTop = 0;
    map.invalidateSize();
    const anchor = L.latLng(p.origin.anchor);
    const pos = p.steps.map((s) => (s.node ? state.nodes.get(s.node).latlng : anchor));
    map.fitBounds(L.latLngBounds(pos.concat(ORIGIN_ZONE.flat(2))), { padding: [50, 50], animate: false });
    traceGroup.addLayer(L.polygon(ORIGIN_ZONE, { pane: "traceZone", className: "origin-zone", stroke: false, interactive: false }));
    traceGroup.addLayer(L.marker(anchor, {
      pane: "traceNodes", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "origin-label", iconSize: null, iconAnchor: [100, 56],
        html: `${esc(p.origin.label)} <span class="uz" lang="uz">· ${esc(p.origin.label_uz)}</span>` }),
    }));
    p.steps.forEach((s, i) => {
      if (i) traceTimers.push(setTimeout(() => drawTraceLink(tr, pos, i), 600 * i));
    });
    return true;
  }

  function drawTraceLink(tr, pos, i) {
    if (state.trace !== tr) return;
    const s = tr.p.steps[i], conf = s.link_in;
    const geo = arc(pos[i - 1], pos[i], 48);
    const line = L.polyline(geo.latlngs.slice(0, 2), {
      renderer: traceRenderer, pane: "traceLinks", className: "flow-" + conf, interactive: false,
      color: C.madder, weight: 5, opacity: 0.95, dashArray: CONFIDENCE[conf].dash, lineCap: "butt",
    });
    traceGroup.addLayer(line);
    const t0 = performance.now(), N = geo.latlngs.length;
    const frame = (now) => {
      if (state.trace !== tr) return;
      const k = Math.min(1, (now - t0) / 600);
      line.setLatLngs(geo.latlngs.slice(0, Math.max(2, Math.ceil(k * N))));
      if (k < 1) { requestAnimationFrame(frame); return; }
      traceGroup.addLayer(arrowMarker(geo, C.madder, null, 0.95, "traceLinks"));
      const n = state.nodes.get(s.node), t = NODE_TYPES[n.type], size = 18;
      traceGroup.addLayer(L.marker(n.latlng, {
        pane: "traceNodes", keyboard: false,
        icon: L.divIcon({ className: "node-icon", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          html: shapeSvg(n.type, s.confidence, { size }) }),
      }).bindTooltip(`<strong>${esc(n.name)}</strong><br><span class="mono">${esc(s.role)} · ${esc(s.confidence)}</span>`,
        { direction: "top", offset: [0, -size / 2] }));
      if (n.city) traceGroup.addLayer(cityLabel(n.city, n.latlng, false, "traceNodes"));
    };
    requestAnimationFrame(frame);
  }

  function traceHtml(p) {
    const block = (c, title, uzTitle, body) => `<section class="tblock">${ikatSwatch(c, 16, 60, "band")}<div class="in"><h5>${title} ${uz(uzTitle)}</h5>${body}</div></section>`;
    const conf = (c, label, uzLabel) => `Confidence: ${ikatSwatch(c, 26, 14, "mini")} ${label} ${uz(uzLabel)}`;
    const d = p.declared, v = p.verified;
    return `
      <span class="chip">${shapeSvg("brand", "confirmed", { size: 16 })}${esc(p.brand)}</span><span class="sample-tag">SAMPLE DATA</span>
      <h3>${esc(p.name)}</h3>
      <p class="meta">${esc(p.brand)} · EAN ${esc(p.ean)}</p>
      <div class="tscore"><span class="num">${p.score}<small>/${p.score_max}</small></span>
        <div><strong>Transparency score ${uz("Shaffoflik bahosi")}</strong><span class="q">What we know — and what we don't</span></div></div>
      ${block("probable", "SELF-DECLARED", "Brend oʻzi eʼlon qilgan",
        `<ul>${d.items.map((it) => `<li><b>${esc(it.label)}</b> · ${esc(it.value)} ${uz(esc(it.uz))}</li>`).join("")}</ul>
         <div class="src">Source: ${esc(d.source)}<br>${conf("probable", "PROBABLE", "Ehtimoliy")}</div>`)}
      ${block("confirmed", "VERIFIED BY OPEN COTTON MAP", "Open Cotton Map tomonidan tekshirilgan",
        `<ul><li><b>${esc(v.role)}</b> ${esc(v.summary)} ${uz(esc(v.uz))}</li></ul>
         <div class="src">${conf("confirmed", "VERIFIED", "Tasdiqlangan")}<br>${v.archived_sources} archived sources · SHA-256 <span class="hash">${esc(v.sha256_short)}</span></div>`)}
      ${block("unverified", "UNKNOWN", "Nomaʼlum",
        `<ul>${p.unknown.map((u) => `<li class="${u.water ? "water" : ""}"><span class="nodata">NO DATA</span><b>${esc(u.label)}</b> ${uz(esc(u.uz))}</li>`).join("")}</ul>
         <div class="src">${esc(p.unknown_note)}<br><span class="uz" lang="uz">${esc(p.unknown_note_uz)}</span></div>`)}
      <div class="tbtns"><a class="btn" href="mockup/scan.html">← Back to scan</a><button class="btn" data-clear-trace>Clear trace</button></div>`;
  }

  // ---------- filters & legend ----------
  function buildChecks(container, key, items) {
    container.innerHTML = items.map((it) => `
      <label><input type="checkbox" value="${esc(it.value)}" checked>${it.key || ""}
        <span>${esc(it.label)}${it.uz ? " " + uz(it.uz) : ""}</span><span class="count">${it.count}</span></label>`).join("");
    container.addEventListener("change", (e) => {
      const set = state.filters[key];
      e.target.checked ? set.add(e.target.value) : set.delete(e.target.value);
      if (state.selected && state.selected.kind === "node" && !nodeVisible(state.nodes.get(state.selected.id))) select(null);
      else render();
    });
    items.forEach((it) => state.filters[key].add(it.value));
  }

  function buildFilters() {
    const nodes = [...state.nodes.values()];
    const count = (fn) => nodes.filter(fn).length;
    const countries = [...new Set(nodes.map((n) => n.country))].sort();
    buildChecks($("#filter-country"), "country",
      countries.map((c) => ({ value: c, label: c, count: count((n) => n.country === c) })));
    buildChecks($("#filter-type"), "type", Object.entries(NODE_TYPES).map(([k, t]) => ({
      value: k, label: t.label, uz: t.uz, count: count((n) => n.type === k),
      key: `<span class="key">${shapeSvg(k, "confirmed", { size: 16, outlineOnly: true })}</span>` })));
    buildChecks($("#filter-confidence"), "confidence", Object.entries(CONFIDENCE).map(([k, c]) => ({
      value: k, label: c.label, uz: c.uz, key: confKey(k),
      count: count((n) => n.confidence === k) + state.links.filter((l) => l.confidence === k).length
        + state.trade.flows.filter((f) => f.confidence === k).length })));
  }

  function buildLegend() {
    const line = (w, color, opacity, cls, dash) => `<svg width="44" height="14" aria-hidden="true"><line x1="2" y1="7" x2="42" y2="7"
      stroke="${color}" stroke-opacity="${opacity}" stroke-width="${w}" ${cls ? `class="${cls}"` : ""} ${dash ? `stroke-dasharray="${dash}"` : ""}/></svg>`;
    const vols = [state.maxVolume, state.maxVolume / 10, state.maxVolume / 50].map((v) => Math.round(v / 100) * 100 || 100);
    const meta = state.trade.meta;
    const hs = meta && meta.hs ? [].concat(meta.hs).join(", ") : "";
    const desc = (t) => `<div class="note">${t}</div>`;
    $("#legend").innerHTML = `
      <div class="sub">The journey</div>
      ${Object.entries(NODE_TYPES).map(([k, t], i) => `<div class="row"><span class="step">${i + 1}</span>${shapeSvg(k, "confirmed", { size: 16, outlineOnly: true })}${t.label} ${uz(t.uz)}</div>`).join("")}
      <div class="sub">What we know — and what we don't</div>
      ${Object.entries(CONFIDENCE).map(([k, c]) => `<div class="row">${shapeSvg("cotton_cluster", k)}${line(3, C.madder, 0.95, "flow-" + k, c.dash)}${c.label} ${uz(c.uz)}</div>${desc(c.help)}`).join("")}
      <div class="sub">Flows</div>
      <div class="row">${line(4, C.madder, 0.95)}Company chain</div>
      ${desc("Trade link between two sites (sample data)")}
      <div class="row">${line(1, C.cotton, 0.35)}Country trade</div>
      ${desc("Official UN Comtrade volumes" + (meta ? " " + esc(meta.year) : "") + (hs ? ", HS " + esc(hs) : ""))}
      ${vols.map((v) => `<div class="row">${line(widthFor(v), C.cotton, 0.6)}<span style="font-family:var(--mono);font-size:12px">${fmtT(v)}/yr</span></div>`).join("")}
      <div class="sub">Water</div>
      <div class="row"><svg width="44" height="14" aria-hidden="true"><rect x="2" y="2" width="40" height="10" fill="none" stroke="${C.rishtan}" stroke-width="1.5"/></svg>Aral Sea ${uz("Orol dengizi")}</div>`;
  }

  $("#filter-layers").addEventListener("change", (e) => {
    state.layers[e.target.value] = e.target.checked;
    const k = state.selected && state.selected.kind;
    if ((k === "trade" && !state.layers.trade) || ((k === "node" || k === "link") && !state.layers.company)) select(null);
    else render();
  });

  $("#reset").addEventListener("click", () => {
    document.querySelectorAll(".sidebar input[type=checkbox]").forEach((cb) => {
      const key = cb.closest(".checks").id.replace("filter-", "");
      if (key === "layers") { cb.checked = cb.value !== "trade"; state.layers[cb.value] = cb.checked; }
      else { cb.checked = true; state.filters[key].add(cb.value); }
    });
    render();
  });
  $("#zoom-ca").addEventListener("click", () => map.fitBounds(CA));
  $("#toggle-filters").addEventListener("click", (e) => {
    const open = $("#sidebar").classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });

  // ---------- load ----------
  Promise.all([
    fetch("data/nodes.geojson").then((r) => { if (!r.ok) throw new Error("nodes.geojson: HTTP " + r.status); return r.json(); }),
    fetch("data/links.json").then((r) => { if (!r.ok) throw new Error("links.json: HTTP " + r.status); return r.json(); }),
    // optional: produced by scripts/fetch_comtrade.py
    fetch("data/trade_flows.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/products.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]).then(([geo, links, trade, products]) => {
    state.products = products || {};
    if (trade && trade.flows) {
      state.trade = trade;
      state.trade.flows = trade.flows.filter((f) => trade.countries[f.from] && trade.countries[f.to]);
    }
    $("#count-trade").textContent = state.trade.flows.length;
    if (!state.trade.flows.length) $("#filter-layers input[value=trade]").closest("label").hidden = true;
    geo.features.forEach((f) => {
      const p = f.properties;
      if (!NODE_TYPES[p.type]) { console.warn("Unknown node type, skipped:", p); return; }
      const [lon, lat] = f.geometry.coordinates;
      state.nodes.set(p.id, Object.assign({}, p, { latlng: L.latLng(lat, lon) }));
    });
    state.links = links.filter((l) => {
      const ok = state.nodes.has(l.from) && state.nodes.has(l.to);
      if (!ok) console.warn("Link with unknown endpoint, skipped:", l);
      return ok;
    });
    $("#count-company").textContent = state.links.length;
    state.maxVolume = Math.max(1, ...state.links.map((l) => l.volume_tonnes || 0),
      ...state.trade.flows.map((f) => f.volume_tonnes || 0));
    buildFilters();
    buildLegend();
    render();
    const tm = /^#trace-(.+)$/.exec(location.hash);
    if (tm && startTrace(decodeURIComponent(tm[1]))) return;
    // Shareable selection: #node=<id>, #link=<id> or #trade=<id>
    const m = /^#(node|link|trade)=(.+)$/.exec(location.hash);
    const id = m && decodeURIComponent(m[2]);
    const exists = m && (m[1] === "node" ? state.nodes.has(id)
      : m[1] === "link" ? state.links.some((l) => l.id === id)
      : state.trade.flows.some((f) => f.id === id));
    if (exists) select({ kind: m[1], id });
    else render();
  }).catch((err) => {
    console.error(err);
    const box = document.createElement("div");
    box.className = "load-error";
    box.innerHTML = `<div><p><strong>Could not load the data.</strong></p>
      <p>${esc(err.message)}</p>
      <p>Open the map through a local server: run <code>python -m http.server</code> in the project folder,
      then visit <code>http://localhost:8000</code>.</p></div>`;
    $("#map").appendChild(box);
  });
})();
