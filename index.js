"use strict";

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const DEFAULT_API_URL =
  "https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast";
const COLLECTION = "waterlevelforecastdata";
const PLUGIN_VERSION = "1.0.24";
const DEFAULT_SKN_GRID_FILE = "F:\\Navi\\BSH_SKN_2026\\SKN-Flaeche_Nordsee_2026_de.txt";
const sknLookupCache = new Map();

module.exports = function createPlugin(app) {
  const plugin = {};
  let timer = null;
  let config = null;
  let lastFeature = null;
  let lastStations = [];
  let pendingRouter = null;

  plugin.id = "signalk-bsh-tides";
  plugin.version = PLUGIN_VERSION;
  plugin.name = `BSH Water Level Forecast v${PLUGIN_VERSION}`;
  plugin.description =
    `Publishes BSH water level and tide forecasts as Signal K deltas. Version ${PLUGIN_VERSION}.`;

  plugin.schema = {
    type: "object",
    properties: {
      stationId: {
        type: "string",
        title: "BSH station id",
        description:
          "Feature id from the BSH API, for example 'alte_weser_leuchtturm', 'wyk' or 'zingst'."
      },
      pluginVersion: {
        type: "string",
        title: "Installed plugin version",
        default: PLUGIN_VERSION,
        description: "Nur Anzeige. Damit ist in Signal K sichtbar, welche Paketversion aktiv geladen wurde."
      },
      apiUrl: {
        type: "string",
        title: "BSH API base URL",
        default: DEFAULT_API_URL
      },
      updateIntervalMinutes: {
        type: "number",
        title: "Update interval in minutes",
        default: 60,
        minimum: 5
      },
      preferForecast: {
        type: "boolean",
        title: "Prefer forecast values over tidal prediction",
        default: true
      },
      publishNearestCurvePoint: {
        type: "boolean",
        title: "Publish nearest curve point as current water level",
        default: true
      },
      publishOnStartup: {
        type: "boolean",
        title: "Load selected station on Signal K startup",
        default: false,
        description:
          "Off by default: the plugin publishes only version/status on startup. KIP/Node-RED load the selected station on demand."
      },
      cacheDirectory: {
        type: "string",
        title: "Offline tide cache directory",
        description:
          "Directory for saved tide curves. Leave empty to use the Signal K configuration directory."
      },
      sknGridFile: {
        type: "string",
        title: "BSH SKN grid file",
        default: "",
        description:
          "Optionaler Pfad zur BSH SKN-Flaeche. API-Stationswerte werden bevorzugt; die Datei dient als Fallback/Plausibilitaet."
      }
    }
  };

  plugin.start = function start(options) {
    config = normalizeOptions(options);
    if (!config.cacheDirectory) {
      config.cacheDirectory = defaultCacheDirectory(app);
    }
    clearDeprecatedStationList(app, plugin.id);
    setTimeout(() => clearDeprecatedStationList(app, plugin.id), 2000);
    setTimeout(() => clearDeprecatedStationList(app, plugin.id), 10000);

    async function update() {
      try {
        if (!lastFeature && !config.publishOnStartup) {
          return;
        }
        const stationId = lastFeature ? lastFeature.id : config.stationId;
        if (!stationId) {
          return;
        }
        const feature = await fetchStationFeature({
          ...config,
          stationId
        });
        lastFeature = feature;
        const delta = featureToDelta(plugin.id, feature, config);

        if (delta.updates[0].values.length > 0) {
          app.handleMessage(plugin.id, delta);
        }
      } catch (error) {
        app.error(`BSH tide update failed: ${error.message}`);
      }
    }

    if (config.publishOnStartup) {
      update();
    }
    timer = setInterval(update, config.updateIntervalMinutes * 60 * 1000);

    if (pendingRouter) {
      plugin.registerWithRouter(pendingRouter);
      pendingRouter = null;
    }
  };

  plugin.stop = function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearDeprecatedStationList(app, plugin.id);
  };

  plugin.registerWithRouter = function registerWithRouter(router) {
    if (!router) {
      return;
    }

    router.get("/stations", async (req, res) => {
      try {
        const force = String(req.query.refresh || "").toLowerCase() === "true";
        const stations = !force && lastStations.length
          ? lastStations
          : await refreshStations(currentConfig(app, config));
        lastStations = stations;
        res.json({
          online: true,
          status: "Stationen geladen",
          activeStationId: lastFeature && lastFeature.id,
          stations
        });
      } catch (error) {
        res.json({
          online: false,
          status: "offline",
          error: error.message,
          activeStationId: lastFeature && lastFeature.id,
          stations: []
        });
      }
    });

    router.get("/state", (req, res) => {
      res.json({
        pluginVersion: PLUGIN_VERSION,
        activeStationId: config && config.stationId,
        station: lastFeature ? summarizeFeature(lastFeature, currentConfig(app, config)) : null,
        source: "BSH WaterLevelForecast API",
        updatedAt: new Date().toISOString()
      });
    });

    router.get("/curve", async (req, res) => {
      try {
        if (!lastFeature) {
          if (!config || !config.stationId) {
            res.status(404).json({ error: "No active station" });
            return;
          }
          lastFeature = await fetchStationFeature(config);
        }

        const properties = lastFeature.properties || {};
        const curve = normalizeCurve(properties.curve);
        const events = normalizeEvents(properties.high_water_low_water, config || normalizeOptions({}));

        res.json({
          activeStationId: lastFeature.id,
          station: summarizeFeature(lastFeature, currentConfig(app, config)),
          source: "BSH WaterLevelForecast API",
          forecastTimestamp: toIso(properties.forecast_timestamp),
          curveForecastTimestamp: toIso(properties.automated_curveforecast_timestamp),
          curve,
          events
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    router.get("/kip", (req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.send(kipHtml());
    });

    router.get("/clear-available-stations", (req, res) => {
      clearDeprecatedStationList(app, plugin.id);
      res.json({
        ok: true,
        pluginVersion: PLUGIN_VERSION,
        clearedPath: "environment.tide.availableStations"
      });
    });

    router.get("/cache/config", (req, res) => {
      const activeConfig = currentConfig(app, config);
      res.json({
        cacheDirectory: activeConfig.cacheDirectory,
        defaultCacheDirectory: defaultCacheDirectory(app)
      });
    });

    router.post("/cache/config", async (req, res) => {
      try {
        const body = req.body || {};
        const cacheDirectory = String(body.cacheDirectory || "").trim();
        if (!cacheDirectory) {
          res.status(400).json({ error: "cacheDirectory is required" });
          return;
        }

        config = {
          ...(config || normalizeOptions({})),
          cacheDirectory
        };
        await ensureDirectory(config.cacheDirectory);

        if (typeof app.savePluginOptions === "function") {
          app.savePluginOptions(config, error => {
            if (error) {
              app.error(`BSH tide cache config save failed: ${error.message}`);
            }
          });
        }

        res.json({
          ok: true,
          cacheDirectory: config.cacheDirectory
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    router.get("/cache/list", async (req, res) => {
      try {
        const activeConfig = currentConfig(app, config);
        res.json({
          cacheDirectory: activeConfig.cacheDirectory,
          items: await listCacheItems(activeConfig)
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    router.post("/cache/save", async (req, res) => {
      try {
        const activeConfig = currentConfig(app, config);
        if (!lastFeature) {
          if (!activeConfig.stationId) {
            res.status(404).json({ error: "No active station" });
            return;
          }
          lastFeature = await fetchStationFeature(activeConfig);
        }

        const payload = featureToCurvePayload(lastFeature, activeConfig);
        const saved = await saveCurveCache(activeConfig, payload);
        res.json({
          ok: true,
          item: saved,
          items: await listCacheItems(activeConfig)
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    router.get("/cache/load", async (req, res) => {
      try {
        const id = String(req.query.id || "").trim();
        if (!id) {
          res.status(400).json({ error: "id is required" });
          return;
        }
        const payload = await loadCurveCache(currentConfig(app, config), id);
        app.handleMessage(plugin.id, cachePayloadToDelta(plugin.id, payload));
        res.json(payload);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    router.post("/cache/delete", async (req, res) => {
      try {
        const body = req.body || {};
        const id = String(body.id || req.query.id || "").trim();
        if (!id) {
          res.status(400).json({ error: "id is required" });
          return;
        }
        await deleteCurveCache(currentConfig(app, config), id);
        res.json({
          ok: true,
          items: await listCacheItems(currentConfig(app, config))
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    router.get("/select", async (req, res) => {
      selectStation(req.query.stationId, res);
    });

    router.post("/select", async (req, res) => {
      const body = req.body || {};
      selectStation(body.stationId || req.query.stationId, res);
    });

    async function selectStation(stationId, res) {
      try {
        const selected = String(stationId || "").trim();
        if (!selected) {
          res.status(400).json({ error: "stationId is required" });
          return;
        }

        config = { ...(config || normalizeOptions({})), stationId: selected };
        const feature = await fetchStationFeature(config);
        lastFeature = feature;

        if (typeof app.savePluginOptions === "function") {
          app.savePluginOptions(config, error => {
            if (error) {
              app.error(`BSH tide select save failed: ${error.message}`);
            }
          });
        }

        const delta = featureToDelta(plugin.id, feature, config);
        app.handleMessage(plugin.id, delta);
        res.json({
          ok: true,
          pluginVersion: PLUGIN_VERSION,
          activeStationId: selected,
          station: summarizeFeature(feature, currentConfig(app, config))
        });
      } catch (error) {
        app.error(`BSH tide station select failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    }
  };

  if (pendingRouter) {
    plugin.registerWithRouter(pendingRouter);
    pendingRouter = null;
  }

  return plugin;
};

function clearDeprecatedStationList(app, pluginId) {
  const clearHeavyPaths = [
    "environment.tide.curve",
    "environment.tide.curve.forecast",
    "environment.tide.curve.prediction",
    "environment.tide.curve.measurement",
    "environment.tide.curve.nearest.time",
    "environment.tide.curve.nearest.height",
    "environment.tide.curve.nearest.forecast.height",
    "environment.tide.curve.nearest.prediction.height",
    "environment.tide.curve.nearest.measurement.height",
    "environment.tide.nextHighWater.time",
    "environment.tide.nextHighWater.height",
    "environment.tide.nextHighWater.heightText",
    "environment.tide.nextHighWater.heightSkn",
    "environment.tide.nextHighWater.heightSknText",
    "environment.tide.nextHighWater.uncertainty",
    "environment.tide.nextLowWater.time",
    "environment.tide.nextLowWater.height",
    "environment.tide.nextLowWater.heightText",
    "environment.tide.nextLowWater.heightSkn",
    "environment.tide.nextLowWater.heightSknText",
    "environment.tide.nextLowWater.uncertainty",
    "environment.tide.height",
    "environment.tide.forecast.height",
    "environment.tide.prediction.height",
    "environment.tide.measurement.height",
    "environment.tide.offline.savedAt",
    "environment.tide.offline.savedAtText",
    "environment.tide.offline.savedAtEpoch"
  ];
  app.handleMessage(pluginId, {
    updates: [
      {
        source: {
          label: pluginId,
          type: "internet"
        },
        timestamp: new Date().toISOString(),
        values: [
          {
            path: "environment.tide.availableStations",
            value: {
              loadedInSignalK: false,
              message: "Stationsliste wird nicht in Signal K vorgeladen. KIP/Node-RED laden die Stationen bei Bedarf ueber /plugins/signalk-bsh-tides/stations.",
              pluginVersion: PLUGIN_VERSION,
              updatedAt: new Date().toISOString()
            }
          },
          {
            path: "environment.tide.plugin.version",
            value: PLUGIN_VERSION
          },
          {
            path: "environment.tide.stationList.mode",
            value: "http-on-demand"
          },
          ...clearHeavyPaths.map(pathToClear => ({
            path: pathToClear,
            value: null
          }))
        ]
      }
    ]
  });
}

function kipHtml() {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumea Tide Chart</title>
<style>
:root { color-scheme: dark; --bg:#05070a; --panel:#10151d; --panel2:#151b24; --line:#2e3845; --text:#e6edf3; --muted:#94a3b8; --blue:#9ebcff; --accent:#4ade80; --warn:#f59e0b; --err:#fb7185; }
* { box-sizing: border-box; }
html, body { margin:0; min-height:100%; background:var(--bg); color:var(--text); font-family:Roboto, system-ui, -apple-system, Segoe UI, sans-serif; }
body { overflow:hidden; }
.app { width:100vw; height:100vh; display:grid; grid-template-rows:auto 1fr; background:var(--bg); }
.top { height:48px; display:flex; align-items:center; gap:10px; padding:0 14px; border-bottom:1px solid #18202a; background:#0c1119; }
.brand { font-size:22px; font-weight:800; }
.brand small { margin-left:8px; font-size:13px; font-weight:500; color:#cbd5e1; }
.engine { margin-left:24px; color:#cbd5e1; font-size:13px; }
.version { margin-left:auto; color:#64748b; font-size:12px; }
.main { min-height:0; display:grid; grid-template-columns:minmax(360px, 1fr) 330px; gap:10px; padding:10px; }
.left, .right { min-height:0; }
.left { display:grid; grid-template-rows:auto minmax(170px, 1fr) auto; gap:10px; }
.card { border:1px solid var(--line); border-radius:8px; background:var(--panel); overflow:hidden; }
.controls { padding:10px; display:grid; gap:8px; }
.label { font-size:11px; color:var(--muted); font-weight:700; }
.row { display:grid; grid-template-columns:1fr auto auto; gap:8px; align-items:center; }
select, input, button { min-height:34px; border:1px solid #3b4656; border-radius:7px; background:#0b111a; color:var(--text); font:inherit; }
select, input { width:100%; padding:0 10px; }
button { padding:0 12px; cursor:pointer; font-weight:700; }
button:hover { border-color:var(--blue); }
button:disabled { opacity:.48; cursor:not-allowed; }
.chartbox { position:relative; min-height:170px; background:#111827; }
svg { display:block; width:100%; height:100%; min-height:170px; }
.grid { stroke:#334155; stroke-width:1; opacity:.8; vector-effect:non-scaling-stroke; }
.forecast { fill:none; stroke:#f97316; stroke-width:3; vector-effect:non-scaling-stroke; }
.prediction { fill:none; stroke:#94a3b8; stroke-width:2; opacity:.9; vector-effect:non-scaling-stroke; }
.measurement { fill:none; stroke:#38bdf8; stroke-width:2; vector-effect:non-scaling-stroke; }
.event { font-size:10px; fill:#67e8f9; }
.now { stroke:#f8fafc; stroke-width:1; stroke-dasharray:4 4; vector-effect:non-scaling-stroke; }
.empty { position:absolute; inset:0; display:grid; place-items:center; color:#64748b; font-size:13px; }
.legend { padding:8px 10px; display:flex; gap:14px; flex-wrap:wrap; color:#cbd5e1; font-size:12px; border-top:1px solid #1f2937; }
.sw { width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:5px; }
.meta { padding:8px 10px; display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; color:var(--muted); font-size:12px; border-top:1px solid #1f2937; }
.right { display:grid; grid-template-rows:auto auto minmax(0, 1fr); gap:10px; }
.panel { padding:12px; }
.panel h3 { margin:0 0 8px; font-size:15px; }
.status { color:#cbd5e1; font-size:12px; line-height:1.45; }
.ok { color:var(--accent); } .warn { color:var(--warn); } .err { color:var(--err); }
.pathrow { display:grid; grid-template-columns:1fr auto; gap:8px; margin-top:8px; }
.offline { min-height:0; overflow:auto; padding:8px; display:grid; gap:8px; align-content:start; }
.item { position:relative; border:1px solid #334155; border-radius:7px; padding:9px 34px 9px 10px; background:#0b111a; cursor:pointer; }
.item:hover { border-color:var(--blue); }
.item strong { display:block; font-size:13px; }
.item span { display:block; margin-top:3px; color:var(--muted); font-size:11px; }
.x { position:absolute; right:7px; top:7px; width:22px; height:22px; min-height:22px; padding:0; color:#cbd5e1; }
.mode { margin-left:8px; font-size:11px; color:var(--muted); }
@media (max-width: 820px) { body { overflow:auto; } .app { height:auto; min-height:100vh; } .main { grid-template-columns:1fr; } .right { grid-template-rows:auto auto auto; } .row { grid-template-columns:1fr; } .meta { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="app">
  <div class="top"><div class="brand">LTC<small>Lumea Tide Chart</small></div><div class="engine">engine: BSH Api</div><div class="version">Ver:${PLUGIN_VERSION}</div></div>
  <div class="main">
    <div class="left">
      <div class="card controls">
        <div class="label">Pegelstation <span id="mode" class="mode">online</span></div>
        <div class="row">
          <select id="station"><option>Stationen werden geladen ...</option></select>
          <button id="reload" type="button">Aktualisieren</button>
          <button id="save" type="button">Kurve speichern</button>
        </div>
      </div>
      <div class="card chartbox"><svg id="chart" viewBox="0 0 760 300" preserveAspectRatio="none"></svg><div id="empty" class="empty">Keine Kurve</div></div>
      <div class="card">
        <div class="legend">
          <span><i class="sw" style="background:#38bdf8"></i>Messwert</span>
          <span><i class="sw" style="background:#94a3b8"></i>Astronomische Tide</span>
          <span><i class="sw" style="background:#f97316"></i>BSH Forecast</span>
          <span><i class="sw" style="background:#67e8f9"></i>HW/NW</span>
        </div>
        <div class="meta"><div id="range">-</div><div id="until">-</div><div id="source">-</div></div>
      </div>
    </div>
    <div class="right">
      <div class="card panel"><h3>Status</h3><div id="status" class="status warn">Bereit</div></div>
      <div class="card panel">
        <h3>Speicherkonfiguration</h3>
        <div class="status" id="cachePath">-</div>
        <div class="pathrow"><input id="cacheInput" placeholder="Speicherort"><button id="savePath" type="button">Speichern</button></div>
      </div>
      <div class="card offline"><h3 style="margin:0 0 2px;font-size:15px;">Offline gespeichert</h3><div id="offlineList" class="status">Noch keine lokalen Dateien im Index.</div></div>
    </div>
  </div>
</div>
<script>
const API = "/plugins/signalk-bsh-tides";
const station = document.getElementById("station");
const reload = document.getElementById("reload");
const save = document.getElementById("save");
const savePath = document.getElementById("savePath");
const cacheInput = document.getElementById("cacheInput");
const cachePath = document.getElementById("cachePath");
const offlineList = document.getElementById("offlineList");
const statusBox = document.getElementById("status");
const chart = document.getElementById("chart");
const empty = document.getElementById("empty");
const range = document.getElementById("range");
const until = document.getElementById("until");
const source = document.getElementById("source");
const mode = document.getElementById("mode");
let currentData = null;
function setStatus(text, cls) { statusBox.className = "status " + (cls || ""); statusBox.textContent = text; }
async function api(path, options) {
  const response = await fetch(API + path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}
function post(path, body) {
  return api(path, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body || {}) });
}
function fmt(value) { if (!value) return "-"; return new Date(value).toLocaleString("de-DE", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }); }
function labelFor(item) { return [item.label || item.name || item.id, item.area || item.region].filter(Boolean).join(" · "); }
function pointsFor(data) {
  return (data.curve || []).map(p => ({ ...p, timestampMs:p.timestampMs || Date.parse(p.time) })).filter(p => Number.isFinite(p.timestampMs));
}
function line(points, key, x0, x1, y0, y1) {
  const list = points.filter(p => Number.isFinite(p[key]));
  if (list.length < 2) return "";
  return list.map((p, index) => {
    const x = 40 + ((p.timestampMs - x0) / Math.max(1, x1 - x0)) * 690;
    const y = 270 - ((p[key] - y0) / Math.max(.01, y1 - y0)) * 230;
    return (index ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
  }).join(" ");
}
function draw(data, offline) {
  currentData = data;
  const points = pointsFor(data);
  const values = [];
  points.forEach(p => ["measurementHeight", "predictionHeight", "forecastHeight", "height"].forEach(k => { if (Number.isFinite(p[k])) values.push(p[k]); }));
  if (!points.length || !values.length) {
    chart.innerHTML = "";
    empty.style.display = "grid";
    range.textContent = "-"; until.textContent = "-"; source.textContent = offline ? "Offline Cache" : "-";
    return;
  }
  empty.style.display = "none";
  const x0 = Math.min(...points.map(p => p.timestampMs));
  const x1 = Math.max(...points.map(p => p.timestampMs));
  const min = Math.min(...values), max = Math.max(...values), pad = Math.max(.15, (max - min) * .12);
  const y0 = min - pad, y1 = max + pad;
  const now = Date.now();
  const nx = 40 + ((now - x0) / Math.max(1, x1 - x0)) * 690;
  const grid = [40, 97.5, 155, 212.5, 270].map(y => '<line class="grid" x1="34" y1="' + y + '" x2="735" y2="' + y + '"></line>').join("");
  const measurement = line(points, "measurementHeight", x0, x1, y0, y1);
  const prediction = line(points, "predictionHeight", x0, x1, y0, y1);
  const forecast = line(points, "forecastHeight", x0, x1, y0, y1);
  const events = (data.events || []).map(e => {
    if (!e.time || !Number.isFinite(e.height)) return "";
    const x = 40 + ((Date.parse(e.time) - x0) / Math.max(1, x1 - x0)) * 690;
    const y = 270 - ((e.height - y0) / Math.max(.01, y1 - y0)) * 230;
    if (x < 35 || x > 740 || y < 24 || y > 284) return "";
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.5" fill="#22d3ee"></circle><text class="event" x="' + (x + 5).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '">' + e.event + ' ' + fmt(e.time).slice(7) + '</text>';
  }).join("");
  chart.innerHTML = grid +
    (prediction ? '<path class="prediction" d="' + prediction + '"></path>' : "") +
    (measurement ? '<path class="measurement" d="' + measurement + '"></path>' : "") +
    (forecast ? '<path class="forecast" d="' + forecast + '"></path>' : "") +
    (nx >= 40 && nx <= 730 ? '<line class="now" x1="' + nx.toFixed(1) + '" y1="28" x2="' + nx.toFixed(1) + '" y2="278"></line>' : "") +
    events;
  range.textContent = min.toFixed(2) + " - " + max.toFixed(2) + " m";
  until.textContent = "Daten bis " + fmt(data.dataUntil || (points[points.length - 1] && points[points.length - 1].time));
  source.textContent = offline ? "Offline Cache vom " + fmt(data.savedAt) : (data.source || "BSH WaterLevelForecast API");
}
async function loadStations() {
  setStatus("Stationen werden geladen ...", "warn");
  mode.textContent = "online";
  station.disabled = true;
  try {
    const data = await api("/stations");
    if (data.online === false) {
      station.innerHTML = "<option>offline</option>";
      mode.textContent = "offline";
      setStatus("offline", "err");
      return;
    }
    station.innerHTML = "";
    (data.stations || []).forEach(item => {
      const option = document.createElement("option");
      option.value = item.id; option.textContent = labelFor(item); station.appendChild(option);
    });
    if (data.activeStationId) station.value = data.activeStationId;
    await loadCurve();
    setStatus((data.stations || []).length + " Stationen geladen", "ok");
  } catch (error) {
    station.innerHTML = "<option>offline</option>";
    mode.textContent = "offline";
    setStatus("offline: " + error.message, "err");
  } finally {
    station.disabled = false;
  }
}
async function loadCurve() {
  const data = await api("/curve");
  data.dataUntil = data.curve && data.curve.length ? data.curve[data.curve.length - 1].time : undefined;
  draw(data, false);
}
async function selectStation() {
  if (!station.value || station.value === "offline") return;
  setStatus("Station wird geladen ...", "warn");
  await api("/select?stationId=" + encodeURIComponent(station.value));
  await loadCurve();
  setStatus("Station geladen", "ok");
}
async function loadCacheConfig() {
  const data = await api("/cache/config");
  cachePath.textContent = data.cacheDirectory || data.defaultCacheDirectory || "-";
  cacheInput.value = data.cacheDirectory || data.defaultCacheDirectory || "";
}
async function saveCachePath() {
  const data = await post("/cache/config", { cacheDirectory: cacheInput.value });
  cachePath.textContent = data.cacheDirectory;
  setStatus("Speicherort gespeichert", "ok");
  await loadOfflineList();
}
async function saveCurrentCurve() {
  setStatus("Kurve wird gespeichert ...", "warn");
  const data = await post("/cache/save", {});
  setStatus("Gespeichert: " + (data.item && data.item.label ? data.item.label : "Kurve"), "ok");
  renderOfflineList(data.items || []);
}
async function loadOfflineList() {
  const data = await api("/cache/list");
  cachePath.textContent = data.cacheDirectory || cachePath.textContent;
  renderOfflineList(data.items || []);
}
function renderOfflineList(items) {
  if (!items.length) {
    offlineList.innerHTML = "Noch keine lokalen Dateien im Index.";
    return;
  }
  offlineList.innerHTML = "";
  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = "<strong>" + (item.stationName || item.label || item.id) + "</strong><span>" + fmt(item.savedAt) + " · " + item.points + " Punkte · bis " + fmt(item.dataUntil) + "</span>";
    row.addEventListener("click", () => loadOffline(item.id));
    const x = document.createElement("button");
    x.className = "x"; x.type = "button"; x.textContent = "x";
    x.addEventListener("click", async event => { event.stopPropagation(); await post("/cache/delete", { id:item.id }); await loadOfflineList(); setStatus("Offline-Kurve gelöscht", "ok"); });
    row.appendChild(x);
    offlineList.appendChild(row);
  });
}
async function loadOffline(id) {
  const data = await api("/cache/load?id=" + encodeURIComponent(id));
  mode.textContent = "offline cache";
  draw(data, true);
  setStatus("Offline Cache vom " + fmt(data.savedAt), "ok");
}
station.addEventListener("change", () => selectStation().catch(error => setStatus(error.message, "err")));
reload.addEventListener("click", () => loadStations().catch(error => setStatus(error.message, "err")));
save.addEventListener("click", () => saveCurrentCurve().catch(error => setStatus(error.message, "err")));
savePath.addEventListener("click", () => saveCachePath().catch(error => setStatus(error.message, "err")));
Promise.all([loadCacheConfig(), loadOfflineList(), loadStations()]).catch(error => setStatus(error.message, "err"));
</script>
</body>
</html>`;
}

function normalizeOptions(options = {}) {
  const cacheDirectory = String(options.cacheDirectory || "").trim();
  const configuredSknGridFile = String(options.sknGridFile || "").trim();
  const sknGridFile = configuredSknGridFile ||
    (fsSync.existsSync(DEFAULT_SKN_GRID_FILE) ? DEFAULT_SKN_GRID_FILE : "");

  return {
    pluginVersion: PLUGIN_VERSION,
    stationId: String(options.stationId || "").trim(),
    apiUrl: String(options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, ""),
    updateIntervalMinutes: Math.max(
      5,
      Number(options.updateIntervalMinutes || 60)
    ),
    preferForecast: options.preferForecast !== false,
    publishNearestCurvePoint: options.publishNearestCurvePoint !== false,
    cacheDirectory,
    sknGridFile
  };
}

function currentConfig(app, config) {
  const activeConfig = config || normalizeOptions({});
  if (!activeConfig.cacheDirectory) {
    activeConfig.cacheDirectory = defaultCacheDirectory(app);
  }
  return activeConfig;
}

function defaultCacheDirectory(app) {
  const candidates = [
    process.env.SIGNALK_NODE_CONFIG_DIR,
    app && app.config && app.config.configPath,
    app && app.config && app.configPath,
    path.join(process.cwd(), ".signalk")
  ].filter(Boolean);
  return path.join(String(candidates[0] || process.cwd()), "bsh-tides-cache");
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function listCacheItems(config) {
  await ensureDirectory(config.cacheDirectory);
  const entries = await fs.readdir(config.cacheDirectory, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const payload = await readCacheFile(config, entry.name);
      items.push(cacheSummary(entry.name, payload));
    } catch (error) {
      // Ignore broken cache files so one bad save does not hide the whole list.
    }
  }

  return items.sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
}

async function saveCurveCache(config, payload) {
  await ensureDirectory(config.cacheDirectory);
  const id = cacheFileName(payload);
  const filePath = safeCachePath(config, id);
  const body = {
    schemaVersion: 1,
    ...payload,
    id,
    savedAt: new Date().toISOString()
  };

  await fs.writeFile(filePath, JSON.stringify(body, null, 2), "utf8");
  return cacheSummary(id, body);
}

async function loadCurveCache(config, id) {
  return readCacheFile(config, id);
}

async function deleteCurveCache(config, id) {
  await fs.unlink(safeCachePath(config, id));
}

async function readCacheFile(config, id) {
  const filePath = safeCachePath(config, id);
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function safeCachePath(config, id) {
  const fileName = path.basename(String(id || ""));
  if (!fileName || fileName !== id || !fileName.endsWith(".json")) {
    throw new Error("Invalid cache id");
  }
  return path.join(config.cacheDirectory, fileName);
}

function cacheSummary(id, payload) {
  const curve = Array.isArray(payload.curve) ? payload.curve : [];
  const events = Array.isArray(payload.events) ? payload.events : [];
  return {
    id,
    stationId: payload.station && payload.station.id,
    stationName: payload.station && (payload.station.label || payload.station.name),
    savedAt: payload.savedAt,
    dataUntil: payload.dataUntil,
    points: curve.length,
    events: events.length,
    hasCurve: curve.length > 0,
    hasEvents: events.length > 0,
    label: payload.label || cacheLabel(payload)
  };
}

function cacheFileName(payload) {
  const stationName = payload.station && (payload.station.label || payload.station.name || payload.station.id);
  const stamp = fileStamp(new Date());
  return `BSH_Tide_${sanitizeFileName(stationName || "Station")}_${stamp}.json`;
}

function cacheLabel(payload) {
  const stationName = payload.station && (payload.station.label || payload.station.name || payload.station.id);
  return `${stationName || "Station"} · ${formatGermanDateTime(payload.savedAt)}`;
}

function sanitizeFileName(valueToSanitize) {
  return String(valueToSanitize)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function fileStamp(date) {
  const pad = valueToPad => String(valueToPad).padStart(2, "0");
  return [
    pad(date.getDate()),
    pad(date.getMonth() + 1),
    date.getFullYear()
  ].join(".") + "_" + pad(date.getHours()) + pad(date.getMinutes());
}

function epochSeconds(valueToFormat) {
  const time = Date.parse(valueToFormat);
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function formatGermanDateTime(valueToFormat) {
  if (!valueToFormat) {
    return "";
  }
  const date = new Date(valueToFormat);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function featureToCurvePayload(feature, config) {
  const properties = feature.properties || {};
  const curve = normalizeCurve(properties.curve);
  const events = normalizeEvents(properties.high_water_low_water, config);

  return {
    label: `${properties.gauge_label || feature.id} · ${formatGermanDateTime(new Date().toISOString())}`,
    station: summarizeFeature(feature, config),
    source: {
      name: "BSH WaterLevelForecast API",
      license: properties.licence
    },
    forecastTimestamp: toIso(properties.forecast_timestamp),
    curveForecastTimestamp: toIso(properties.automated_curveforecast_timestamp),
    dataFrom: curve.length ? curve[0].time : undefined,
    dataUntil: curve.length ? curve[curve.length - 1].time : undefined,
    curve,
    events
  };
}

async function fetchStationFeature(config) {
  if (!config.stationId) {
    throw new Error("stationId is required");
  }

  const itemUrl = `${config.apiUrl}/collections/${COLLECTION}/items/${encodeURIComponent(
    config.stationId
  )}?f=json`;

  try {
    const item = await fetchJson(itemUrl);
    if (item && item.type === "Feature") {
      return item;
    }
  } catch (error) {
    // Some ldproxy deployments expose only the collection endpoint.
  }

  const collectionUrl = `${config.apiUrl}/collections/${COLLECTION}/items?f=json`;
  const collection = await fetchJson(collectionUrl);
  const feature = (collection.features || []).find(
    item => String(item.id).toLowerCase() === config.stationId.toLowerCase()
  );

  if (!feature) {
    throw new Error(`BSH station '${config.stationId}' not found`);
  }

  return feature;
}

async function refreshStations(config) {
  const baseConfig = config || normalizeOptions({});
  const collectionUrl = `${baseConfig.apiUrl}/collections/${COLLECTION}/items?f=json`;
  const collection = await fetchJson(collectionUrl);

  return (collection.features || [])
    .map(feature => summarizeFeature(feature, baseConfig))
    .sort((left, right) => left.label.localeCompare(right.label, "de"));
}

function summarizeFeature(feature, config) {
  const properties = feature.properties || {};
  const hasCurve = Array.isArray(properties.curve) && properties.curve.length > 0;
  const hasEvents =
    Array.isArray(properties.high_water_low_water) &&
    properties.high_water_low_water.length > 0;
  const stationPosition = position(feature, properties);

  return {
    id: feature.id,
    label: properties.gauge_label || feature.id,
    name: properties.gauge_label || feature.id,
    area: properties.area,
    region: properties.region,
    position: stationPosition,
    latitude: stationPosition && stationPosition.latitude,
    longitude: stationPosition && stationPosition.longitude,
    referenceLevels: referenceLevelsFor(properties, stationPosition, config),
    hasCurve,
    hasEvents,
    hasForecast: hasCurve || hasEvents
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/geo+json, application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

function cachePayloadToDelta(pluginId, payload) {
  const station = payload.station || {};
  const stationPosition = stationPositionFromSummary(station);
  const referenceLevels = station.referenceLevels || payload.referenceLevels;
  const curve = (Array.isArray(payload.curve) ? payload.curve : [])
    .map(point => ({
      ...point,
      timestampMs: point.timestampMs || Date.parse(point.time || point.timestamp)
    }))
    .filter(point => point.time && Number.isFinite(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const events = (Array.isArray(payload.events) ? payload.events : [])
    .map(event => ({
      ...event,
      timestampMs: event.timestampMs || Date.parse(event.time || event.timestamp)
    }))
    .filter(event => event.time && Number.isFinite(event.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const now = Date.now();
  const futureEvents = events.filter(event => event.timestampMs >= now);
  const nextHigh = futureEvents.find(event => event.event === "HW");
  const nextLow = futureEvents.find(event => event.event === "NW");
  const nearestCurve = findNearestCurvePoint(curve, now);

  const values = [
    value("environment.tide.availableStations", {
      loadedInSignalK: false,
      message: "Stationsliste wird nicht in Signal K vorgeladen. KIP/Node-RED laden die Stationen bei Bedarf ueber /plugins/signalk-bsh-tides/stations.",
      pluginVersion: PLUGIN_VERSION,
      updatedAt: new Date().toISOString()
    }),
    value("environment.tide.plugin.version", PLUGIN_VERSION),
    value("environment.tide.stationList.mode", "http-on-demand"),
    value("environment.tide.station.id", station.id),
    value("environment.tide.station.name", station.label || station.name),
    value("environment.tide.station.region", station.region),
    value("environment.tide.station.area", station.area),
    value("environment.tide.station.position", stationPosition),
    value("environment.tide.station.position.latitude", stationPosition && stationPosition.latitude),
    value("environment.tide.station.position.longitude", stationPosition && stationPosition.longitude),
    value("environment.tide.station.latitude", stationPosition && stationPosition.latitude),
    value("environment.tide.station.longitude", stationPosition && stationPosition.longitude),
    value("environment.tide.station.referenceLevels", referenceLevels),
    value("environment.tide.selectedStation.id", station.id),
    value("environment.tide.selectedStation.name", station.label || station.name),
    value("environment.tide.selectedStation.position", stationPosition),
    value("environment.tide.selectedStation.position.latitude", stationPosition && stationPosition.latitude),
    value("environment.tide.selectedStation.position.longitude", stationPosition && stationPosition.longitude),
    value("environment.tide.source.name", "Offline Cache"),
    value("environment.tide.source.license", payload.source && payload.source.license),
    value("environment.tide.offline.savedAt", payload.savedAt),
    value("environment.tide.offline.savedAtText", formatGermanDateTime(payload.savedAt)),
    value("environment.tide.offline.savedAtEpoch", epochSeconds(payload.savedAt)),
    value("environment.tide.forecast.timestamp", payload.forecastTimestamp),
    value("environment.tide.automatedCurveForecast.timestamp", payload.curveForecastTimestamp),
    value("environment.tide.nextHighWater.time", nextHigh ? nextHigh.time : null),
    value("environment.tide.nextHighWater.height", nextHigh ? nextHigh.height : null),
    value("environment.tide.nextHighWater.heightText", nextHigh ? tideHeightText(nextHigh.height, "PNP", "Hoch") : null),
    value("environment.tide.nextHighWater.heightSkn", nextHigh ? heightAtReference(nextHigh.height, referenceLevels, "skn") : null),
    value("environment.tide.nextHighWater.heightSknText", nextHigh ? tideHeightText(heightAtReference(nextHigh.height, referenceLevels, "skn"), "SKN", "Hoch") : null),
    value("environment.tide.nextHighWater.uncertainty", nextHigh ? cmToM(nextHigh.forecast_uncertainty) : null),
    value("environment.tide.nextLowWater.time", nextLow ? nextLow.time : null),
    value("environment.tide.nextLowWater.height", nextLow ? nextLow.height : null),
    value("environment.tide.nextLowWater.heightText", nextLow ? tideHeightText(nextLow.height, "PNP", "Niedrig") : null),
    value("environment.tide.nextLowWater.heightSkn", nextLow ? heightAtReference(nextLow.height, referenceLevels, "skn") : null),
    value("environment.tide.nextLowWater.heightSknText", nextLow ? tideHeightText(heightAtReference(nextLow.height, referenceLevels, "skn"), "SKN", "Niedrig") : null),
    value("environment.tide.nextLowWater.uncertainty", nextLow ? cmToM(nextLow.forecast_uncertainty) : null),
    value("environment.tide.height", nearestCurve && nearestCurve.height),
    value("environment.tide.forecast.height", nearestCurve && nearestCurve.forecastHeight),
    value("environment.tide.prediction.height", nearestCurve && nearestCurve.predictionHeight),
    value("environment.tide.measurement.height", nearestCurve && nearestCurve.measurementHeight),
    value("environment.tide.curve", null),
    value("environment.tide.curve.forecast", null),
    value("environment.tide.curve.prediction", null),
    value("environment.tide.curve.measurement", null),
    value("environment.tide.curve.nearest.time", nearestCurve && nearestCurve.time),
    value("environment.tide.curve.nearest.height", nearestCurve && nearestCurve.height),
    value("environment.tide.curve.nearest.forecast.height", nearestCurve && nearestCurve.forecastHeight),
    value("environment.tide.curve.nearest.prediction.height", nearestCurve && nearestCurve.predictionHeight),
    value("environment.tide.curve.nearest.measurement.height", nearestCurve && nearestCurve.measurementHeight)
  ].filter(item => item.value !== undefined);

  return {
    updates: [
      {
        source: {
          label: pluginId,
          type: "offline"
        },
        timestamp: new Date().toISOString(),
        values
      }
    ]
  };
}

function featureToDelta(pluginId, feature, config) {
  const properties = feature.properties || {};
  const stationPosition = position(feature, properties);
  const referenceLevels = referenceLevelsFor(properties, stationPosition, config);
  const events = normalizeEvents(properties.high_water_low_water, config);
  const curve = normalizeCurve(properties.curve);
  const now = Date.now();
  const futureEvents = events.filter(event => event.timestampMs >= now);
  const nextHigh = futureEvents.find(event => event.event === "HW");
  const nextLow = futureEvents.find(event => event.event === "NW");
  const nearestCurve = config.publishNearestCurvePoint
    ? findNearestCurvePoint(curve, now)
    : null;

  const values = [
    value("environment.tide.availableStations", {
      loadedInSignalK: false,
      message: "Stationsliste wird nicht in Signal K vorgeladen. KIP/Node-RED laden die Stationen bei Bedarf ueber /plugins/signalk-bsh-tides/stations.",
      pluginVersion: PLUGIN_VERSION,
      updatedAt: new Date().toISOString()
    }),
    value("environment.tide.plugin.version", PLUGIN_VERSION),
    value("environment.tide.stationList.mode", "http-on-demand"),
    value("environment.tide.station.id", feature.id),
    value("environment.tide.station.name", properties.gauge_label),
    value("environment.tide.station.region", properties.region),
    value("environment.tide.station.area", properties.area),
    value("environment.tide.station.position", stationPosition),
    value("environment.tide.station.position.latitude", stationPosition && stationPosition.latitude),
    value("environment.tide.station.position.longitude", stationPosition && stationPosition.longitude),
    value("environment.tide.station.latitude", stationPosition && stationPosition.latitude),
    value("environment.tide.station.longitude", stationPosition && stationPosition.longitude),
    value("environment.tide.station.referenceLevels", referenceLevels),
    value("environment.tide.selectedStation.id", feature.id),
    value("environment.tide.selectedStation.name", properties.gauge_label),
    value("environment.tide.selectedStation.position", stationPosition),
    value("environment.tide.selectedStation.position.latitude", stationPosition && stationPosition.latitude),
    value("environment.tide.selectedStation.position.longitude", stationPosition && stationPosition.longitude),
    value("environment.tide.source.name", "Bundesamt fuer Seeschifffahrt und Hydrographie"),
    value("environment.tide.source.license", properties.licence),
    value("environment.tide.offline.savedAt", null),
    value("environment.tide.offline.savedAtText", null),
    value("environment.tide.offline.savedAtEpoch", null),
    value("environment.tide.forecast.timestamp", toIso(properties.forecast_timestamp)),
    value(
      "environment.tide.automatedCurveForecast.timestamp",
      toIso(properties.automated_curveforecast_timestamp)
    ),
    value("environment.tide.nextHighWater.time", nextHigh && nextHigh.time),
    value("environment.tide.nextHighWater.height", nextHigh && nextHigh.height),
    value("environment.tide.nextHighWater.heightText", nextHigh ? tideHeightText(nextHigh.height, "PNP", "Hoch") : null),
    value("environment.tide.nextHighWater.heightSkn", nextHigh ? heightAtReference(nextHigh.height, referenceLevels, "skn") : null),
    value("environment.tide.nextHighWater.heightSknText", nextHigh ? tideHeightText(heightAtReference(nextHigh.height, referenceLevels, "skn"), "SKN", "Hoch") : null),
    value(
      "environment.tide.nextHighWater.uncertainty",
      nextHigh && cmToM(nextHigh.forecast_uncertainty)
    ),
    value("environment.tide.nextLowWater.time", nextLow && nextLow.time),
    value("environment.tide.nextLowWater.height", nextLow && nextLow.height),
    value("environment.tide.nextLowWater.heightText", nextLow ? tideHeightText(nextLow.height, "PNP", "Niedrig") : null),
    value("environment.tide.nextLowWater.heightSkn", nextLow ? heightAtReference(nextLow.height, referenceLevels, "skn") : null),
    value("environment.tide.nextLowWater.heightSknText", nextLow ? tideHeightText(heightAtReference(nextLow.height, referenceLevels, "skn"), "SKN", "Niedrig") : null),
    value(
      "environment.tide.nextLowWater.uncertainty",
      nextLow && cmToM(nextLow.forecast_uncertainty)
    ),
    value("environment.tide.height", nearestCurve && nearestCurve.height),
    value("environment.tide.forecast.height", nearestCurve && nearestCurve.forecastHeight),
    value(
      "environment.tide.prediction.height",
      nearestCurve && nearestCurve.predictionHeight
    ),
    value(
      "environment.tide.measurement.height",
      nearestCurve && nearestCurve.measurementHeight
    ),
    value("environment.tide.curve", null),
    value("environment.tide.curve.forecast", null),
    value("environment.tide.curve.prediction", null),
    value("environment.tide.curve.measurement", null),
    value("environment.tide.curve.nearest.time", nearestCurve && nearestCurve.time),
    value("environment.tide.curve.nearest.height", nearestCurve && nearestCurve.height),
    value("environment.tide.curve.nearest.forecast.height", nearestCurve && nearestCurve.forecastHeight),
    value("environment.tide.curve.nearest.prediction.height", nearestCurve && nearestCurve.predictionHeight),
    value("environment.tide.curve.nearest.measurement.height", nearestCurve && nearestCurve.measurementHeight)
  ].filter(item => item.value !== undefined);

  return {
    updates: [
      {
        source: {
          label: pluginId,
          type: "internet"
        },
        timestamp: new Date().toISOString(),
        values
      }
    ]
  };
}

function normalizeCurve(rawCurve = []) {
  return rawCurve
    .map(point => {
      const time = toIso(point.timestamp);
      const predictionHeight = cmToM(point.tidal_prediction);
      const forecastHeight = cmToM(point.automated_curve_forecast ?? point.forecast);
      const measurementHeight = cmToM(point.measurement);
      const height =
        forecastHeight !== undefined
          ? forecastHeight
          : predictionHeight !== undefined
            ? predictionHeight
            : measurementHeight;

      return {
        time,
        timestamp: time,
        timestampMs: time ? Date.parse(time) : 0,
        height,
        forecastHeight,
        predictionHeight,
        measurementHeight
      };
    })
    .filter(point => point.time && point.height !== undefined)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function normalizeEvents(rawEvents = [], config) {
  return rawEvents
    .map(event => {
      const time = toIso(event.event_timestamp);
      const height = selectEventHeight(event, config);
      const eventType = normalizeEventType(event.event);
      const predictionHeight = cmToM(event.tidal_prediction_value);
      const officialForecastHeight = cmToM(event.forecast_value);
      const mosR0Height = cmToM(event.mos_forecast_r0_value);
      const mosR1Height = cmToM(event.mos_forecast_r1_value);
      const mosR2Height = cmToM(event.mos_forecast_r2_value);
      const mosR3Height = cmToM(event.mos_forecast_r3_value);
      const mosR4Height = cmToM(event.mos_forecast_r4_value);
      const mosR5Height = cmToM(event.mos_forecast_r5_value);

      return {
        event: eventType,
        rawEvent: event.event,
        time,
        timestampMs: time ? Date.parse(time) : 0,
        height,
        predictionHeight,
        officialForecastHeight,
        mosR0Height,
        mosR1Height,
        mosR2Height,
        mosR3Height,
        mosR4Height,
        mosR5Height,
        officialForecastTimestamp: toIso(event.forecast_event_forecast_timestamp),
        mosForecastTimestamp: toIso(event.mos_forecast_event_forecast_timestamp),
        forecastDeviation: event.forecast_deviation,
        mosR0Deviation: event.mos_forecast_r0_deviation,
        mosR1Deviation: event.mos_forecast_r1_deviation,
        mosR2Deviation: event.mos_forecast_r2_deviation,
        mosR3Deviation: event.mos_forecast_r3_deviation,
        mosR4Deviation: event.mos_forecast_r4_deviation,
        mosR5Deviation: event.mos_forecast_r5_deviation,
        forecast_uncertainty: event.forecast_uncertainty
      };
    })
    .filter(event => event.time && event.height !== undefined)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function normalizeEventType(value) {
  const text = String(value || "").trim().toUpperCase();
  if (["HW", "H", "HIGH", "HIGH_WATER", "HIGH WATER", "HOCHWASSER"].includes(text)) {
    return "HW";
  }
  if (["NW", "LW", "L", "LOW", "LOW_WATER", "LOW WATER", "NIEDRIGWASSER"].includes(text)) {
    return "NW";
  }
  return text || undefined;
}

function selectEventHeight(event, config) {
  const preferred = config.preferForecast
    ? [
        event.forecast_value,
        event.mos_forecast_r0_value,
        event.tidal_prediction_value
      ]
    : [
        event.tidal_prediction_value,
        event.forecast_value,
        event.mos_forecast_r0_value
      ];

  for (const candidate of preferred) {
    const meters = cmToM(candidate);
    if (meters !== undefined) {
      return meters;
    }
  }

  return undefined;
}

function findNearestCurvePoint(curve = [], now) {
  let best = null;

  for (const point of curve) {
    const distance = Math.abs(point.timestampMs - now);
    if (!best || distance < best.distance) {
      best = {
        ...point,
        distance,
      };
    }
  }

  return best;
}

function position(feature, properties) {
  const coordinates = feature.geometry && feature.geometry.coordinates;
  const longitude = Array.isArray(coordinates)
    ? coordinates[0]
    : properties.longitude;
  const latitude = Array.isArray(coordinates)
    ? coordinates[1]
    : properties.latitude;

  if (latitude === undefined || longitude === undefined) {
    return undefined;
  }

  return {
    latitude: Number(latitude),
    longitude: Number(longitude)
  };
}

function stationPositionFromSummary(station) {
  if (station && station.position) {
    return station.position;
  }
  if (
    station &&
    station.latitude !== undefined &&
    station.longitude !== undefined
  ) {
    return {
      latitude: Number(station.latitude),
      longitude: Number(station.longitude)
    };
  }
  return undefined;
}

function tideHeightText(height, reference, eventLabel) {
  if (!Number.isFinite(height)) return null;
  return `${height.toFixed(2).replace(".", ",")} ${reference} ${eventLabel}`;
}

function heightAtReference(height, referenceLevels, reference) {
  if (!Number.isFinite(height)) return null;
  const offsets = referenceLevels && referenceLevels.offsets;
  const offset = offsets && offsets[reference];
  return Number.isFinite(offset) ? Math.round((height + offset) * 1000) / 1000 : null;
}

function referenceLevelsFor(properties, stationPosition, config) {
  const fromProperties = referenceLevelsFromProperties(properties);
  const levels = {
    ...fromProperties,
    offsets: {
      ...(fromProperties.offsets || {})
    },
    labels: {
      ...(fromProperties.labels || {})
    }
  };
  const needsSknFallback =
    !Number.isFinite(fromProperties.sknAbovePnp) &&
    Number.isFinite(fromProperties.pnpToNhn);
  const sknNhn = needsSknFallback ? lookupSknNhn(stationPosition, config) : undefined;

  if (Number.isFinite(sknNhn)) {
    levels.sknNhn = sknNhn;
    levels.sknSource = "BSH SKN-Flaeche";
  }

  if (!Number.isFinite(levels.sknAbovePnp) && Number.isFinite(sknNhn) && Number.isFinite(levels.pnpToNhn)) {
    levels.sknAbovePnp = sknNhn - levels.pnpToNhn;
    levels.offsets.skn = -levels.sknAbovePnp;
  }

  if (!Number.isFinite(levels.pnpToNhn) && Number.isFinite(levels.nhnAbovePnp)) {
    levels.pnpToNhn = -levels.nhnAbovePnp;
  }

  return levels;
}

function referenceLevelsFromProperties(properties) {
  const sknAbovePnp = firstMetricNumber(properties, [
    "skn_above_pnp",
    "skn_ueber_pnp",
    "skn_over_pnp",
    "seekartennull_ueber_pnp",
    "seekartennull_over_pnp",
    "chartdatum_relative_to_gaugezero"
  ]);
  const pnpToNhn = firstMetricNumber(properties, [
    "pnp_to_nhn",
    "pnp_zu_nhn",
    "pegelnullpunkt_zu_nhn",
    "pegelnullpunkt_to_nhn",
    "gaugezero_relative_to_nhn"
  ]);
  const nhnAbovePnp = firstMetricNumber(properties, [
    "nhn_above_pnp",
    "nhn_ueber_pnp",
    "nhn_over_pnp",
    "normalhoehennull_ueber_pnp",
    "normalhoehennull_over_pnp"
  ]);

  const levels = {
    base: "pnp",
    offsets: {
      pnp: 0
    },
    labels: {
      pnp: "Pegelnullpunkt (PNP)",
      skn: "Seekartennull (SKN)",
      nhn: "Normalhoehennull (NHN)"
    }
  };

  if (sknAbovePnp !== undefined) {
    levels.sknAbovePnp = sknAbovePnp;
    levels.offsets.skn = -sknAbovePnp;
  }
  if (pnpToNhn !== undefined) {
    levels.pnpToNhn = pnpToNhn;
    levels.offsets.nhn = pnpToNhn;
    levels.nhnAbovePnp = -pnpToNhn;
  } else if (nhnAbovePnp !== undefined) {
    levels.nhnAbovePnp = nhnAbovePnp;
    levels.offsets.nhn = -nhnAbovePnp;
    levels.pnpToNhn = -nhnAbovePnp;
  }

  return levels;
}

function firstMetricNumber(object, names) {
  for (const name of names) {
    const valueToRead = object && object[name];
    const number = parseDecimalNumber(valueToRead);
    if (valueToRead !== undefined && valueToRead !== null && Number.isFinite(number)) {
      return isCentimeterProperty(name) ? number / 100 : number;
    }
  }
  return undefined;
}

function isCentimeterProperty(name) {
  return [
    "chartdatum_relative_to_gaugezero",
    "gaugezero_relative_to_nhn"
  ].includes(name);
}

function firstNumber(object, names) {
  for (const name of names) {
    const valueToRead = object && object[name];
    const number = parseDecimalNumber(valueToRead);
    if (valueToRead !== undefined && valueToRead !== null && Number.isFinite(number)) {
      return number;
    }
  }
  return undefined;
}

function lookupSknNhn(stationPosition, config) {
  const sknGridFile = config && config.sknGridFile;
  if (!stationPosition || !Number.isFinite(stationPosition.latitude) || !Number.isFinite(stationPosition.longitude) || !sknGridFile) {
    return undefined;
  }
  const cacheKey = `${sknGridFile}|${stationPosition.latitude.toFixed(5)}|${stationPosition.longitude.toFixed(5)}`;
  if (sknLookupCache.has(cacheKey)) {
    return sknLookupCache.get(cacheKey);
  }
  if (!fsSync.existsSync(sknGridFile)) {
    sknLookupCache.set(cacheKey, undefined);
    return undefined;
  }

  try {
    const content = fsSync.readFileSync(sknGridFile, "utf8");
    let best = undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const line of content.split(/\r?\n/)) {
      if (!line || line[0] === "#") {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) {
        continue;
      }
      const longitude = parseDecimalNumber(parts[2]);
      const latitude = parseDecimalNumber(parts[3]);
      const sknNhn = parseDecimalNumber(parts[4]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(sknNhn)) {
        continue;
      }
      const distance = Math.pow(latitude - stationPosition.latitude, 2) + Math.pow(longitude - stationPosition.longitude, 2);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = sknNhn;
      }
    }

    sknLookupCache.set(cacheKey, best);
    return best;
  } catch (error) {
    sknLookupCache.set(cacheKey, undefined);
    return undefined;
  }
}

function parseDecimalNumber(valueToParse) {
  if (valueToParse === undefined || valueToParse === null || valueToParse === "") {
    return undefined;
  }
  const normalized = String(valueToParse).trim().replace(",", ".");
  if (!normalized || normalized.toLowerCase() === "nan") {
    return undefined;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function value(path, item) {
  return {
    path,
    value: item
  };
}

function cmToM(valueToConvert) {
  if (valueToConvert === undefined || valueToConvert === null || valueToConvert === "") {
    return undefined;
  }

  const value = Number(String(valueToConvert).replace(",", "."));
  return Number.isFinite(value) ? value / 100 : undefined;
}

function toIso(timestamp) {
  if (!timestamp) {
    return undefined;
  }

  const normalized = String(timestamp).replace(" ", "T");
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
