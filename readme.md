# Signalk-BSH-tides v1.0.12

<img width="1909" height="915" alt="Screenshot 2026-08-17 171926" src="https://github.com/user-attachments/assets/eb6f0bc8-48d1-4df0-9a97-49f479da867f" />
<img width="1670" height="796" alt="Screenshot 2026-08-17 172058" src="https://github.com/user-attachments/assets/8f99e1f9-25af-4b5b-8198-c235c6b8f7d8" />
<img width="1664" height="821" alt="Screenshot 2026-08-17 172034" src="https://github.com/user-attachments/assets/a27fe5ff-714f-4599-9593-f6ebc263a29a" />
<img width="1613" height="844" alt="Screenshot 2026-08-17 172022" src="https://github.com/user-attachments/assets/5eacd5a3-0207-4712-b453-9d37e9b2435d" />



Version: `1.0.12`

Signal K plugin for the BSH water level forecast API:

https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast

The plugin reads BSH gauge features from the `waterlevelforecastdata`
collection and publishes selected forecast values as Signal K deltas. It also
provides station selection endpoints for Node-RED/KIP embedded controls.

## Requirements

- Signal K Node Server  /NodeRED /KIP
- Node.js 18 or newer
- Internet access from the Signal K server

## Install

Install it from a local path inside the Signal K configuration directory.

Windows example for the Signal K Windows package:

```powershell
cd C:\signalk\signalkhome\.signalk
& C:\signalk\nodejs\npm.cmd install F:\Navi\signalk_bsh_tides_plugin_by_codex
```

Raspberry Pi / OpenPlotter example:

```bash
cd ~/.signalk
npm install /home/pi/signalk-bsh-tides
```

If the path contains spaces, quote it. Paths without spaces are recommended.
After installation, restart Signal K and open the plugin settings for
**BSH Water Level Forecast**.

The package is self-contained and has no npm dependencies. It requires a Signal K
Node Server running on Node.js 18 or newer.

## Configuration

`stationId` is required. It is the GeoJSON feature `id` from the BSH API. Known
examples from the API include:

- `wyk`
- `zingst`

The API also contains many other gauge ids. Open this URL and search for
`"id"`:

```text
https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/collections/waterlevelforecastdata/items?f=json
```

Recommended update interval: 30 to 60 minutes.

`sknGridFile` is optional. The plugin normally uses the BSH station fields
`gaugezero_relative_to_nhn` and `chartdatum_relative_to_gaugezero` for
PNP/SKN/NHN conversion. If these fields are missing, an installed BSH SKN grid
file can be used as fallback. Windows example:
`F:\Navi\BSH_SKN_2026\SKN-Flaeche_Nordsee_2026_de.txt`. OpenPlotter/Debian
example: `/home/pi/BSH_SKN_2026/SKN-Flaeche_Nordsee_2026_de.txt`.

## HTTP Endpoints

When the plugin is running, Signal K exposes these plugin endpoints:

```text
GET  /plugins/signalk-bsh-tides/stations
GET  /plugins/signalk-bsh-tides/state
GET  /plugins/signalk-bsh-tides/curve
GET  /plugins/signalk-bsh-tides/select?stationId=norderney_riffgat
POST /plugins/signalk-bsh-tides/select
GET  /plugins/signalk-bsh-tides/cache/config
POST /plugins/signalk-bsh-tides/cache/config
GET  /plugins/signalk-bsh-tides/cache/list
POST /plugins/signalk-bsh-tides/cache/save
GET  /plugins/signalk-bsh-tides/cache/load?id=...
POST /plugins/signalk-bsh-tides/cache/delete
```

`/stations` returns the same station basis used by Lumea Tide Chart / the BSH
Node-RED dashboard. The station list is loaded lazily: the plugin does not
preload all stations at Signal K startup. It fetches the list only when this
endpoint is opened by KIP, Node-RED, or another client. If the BSH API is not
reachable, the endpoint returns `online: false` and `status: "offline"`.
The complete station list is returned only as HTTP JSON and is not published
into the Signal K data tree, so the Data Browser stays compact.
Version `1.0.12` also overwrites the old `environment.tide.availableStations`
value with a small status object at startup, stop, and during station updates if
an earlier plugin version had already written the full station list.

The installed plugin version is visible in the Signal K plugin configuration
as `Installed plugin version`, in the plugin name, and via:

```text
GET /plugins/signalk-bsh-tides/state
```

Manual uninstall from the Signal K home directory must use the package name,
not the old install path:

```powershell
npm uninstall signalk-bsh-tides
```

`/select` changes the active station, saves the plugin options when supported
by the Signal K server, and immediately publishes fresh Signal K deltas.

The `/cache/*` endpoints store and load BSH tide curves as local JSON files.
They are intended for compact KIP/Node-RED embedded pages that need offline
curves while underway. The default cache directory is `bsh-tides-cache` inside
the Signal K configuration directory; it can be changed with `/cache/config`.

## Published Paths

The plugin publishes values under:

```text
environment.tide.station.id
environment.tide.station.name
environment.tide.station.region
environment.tide.station.area
environment.tide.station.position
environment.tide.selectedStation.id
environment.tide.selectedStation.name
environment.tide.source.name
environment.tide.source.license
environment.tide.forecast.timestamp
environment.tide.automatedCurveForecast.timestamp
environment.tide.nextHighWater.time
environment.tide.nextHighWater.height
environment.tide.nextHighWater.uncertainty
environment.tide.nextLowWater.time
environment.tide.nextLowWater.height
environment.tide.nextLowWater.uncertainty
environment.tide.height
environment.tide.forecast.height
environment.tide.prediction.height
environment.tide.measurement.height
environment.tide.curve
environment.tide.curve.forecast
environment.tide.curve.prediction
environment.tide.curve.measurement
environment.tide.curve.nearest.time
environment.tide.curve.nearest.height
environment.tide.curve.nearest.forecast.height
environment.tide.curve.nearest.prediction.height
environment.tide.curve.nearest.measurement.height
```

Heights from the BSH API are centimeters. Signal K values are published in
meters.

## KIP
<img width="1915" height="910" alt="Screenshot 2026-08-17 171006" src="https://github.com/user-attachments/assets/07b3fea7-c957-4fc3-bd09-c4559226fd75" />
For a normal KIP Data Chart widget, use a numeric path such as:

```text
self.environment.tide.curve.nearest.forecast.height
self.environment.tide.curve.nearest.prediction.height
self.environment.tide.height
```

KIP samples these paths into its own time window. This is suitable for a small
live tide/history curve.

For a true BSH forecast curve with future timestamps, use the array paths:

```text
self.environment.tide.curve
self.environment.tide.curve.forecast
self.environment.tide.curve.prediction
```

These are intended for a custom/embedded KIP page or a Node-RED mini page.

## NodeRED
for the KIP embedded Page (Tidecurve) i use a NodeRED Flow
see Download.
<img width="1183" height="452" alt="Screenshot 2026-08-17 171737" src="https://github.com/user-attachments/assets/b42b9133-fb2e-4685-8997-25fe316476b0" />



## Notes

The BSH API data declares `CC BY 4.0` in the response. The source and license
are published into Signal K as metadata-like values so downstream displays can
show attribution if needed.

For North Sea gauges, `HW` means high water and `NW` means low water.

