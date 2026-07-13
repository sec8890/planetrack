import 'dotenv/config';
import dns from 'dns';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// some container networks have broken/restricted outbound IPv6 routing
// while IPv4 works fine — Node's fetch tries IPv6 first by default, which
// manifests as a silent connect timeout rather than a clear error
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const GRID_W = 128;
const GRID_H = 64;
const REFRESH_MS = (Number(process.env.REFRESH_MINUTES) || 15) * 60 * 1000;

// OpenSky Network blocks connections from major cloud-hosting IP ranges
// (confirmed: identical connection timeouts from both Railway and Render,
// while every other host works fine) — adsb.lol is a free, no-key-required
// community ADS-B aggregator that doesn't have this problem. It has no
// single "whole planet" endpoint like OpenSky did, so instead we tile
// point+radius queries across the globe and merge the results.
const ADSB_BASE_URL = 'https://api.adsb.lol/v2/point';
const TILE_RADIUS_NM = 600;
const LON_STEP_DEG = 45;
const LAT_STEP_DEG = 30;
const LAT_MIN = -60; // skip the poles — negligible traffic, not worth the extra tiles
const LAT_MAX = 60;
const TILE_DELAY_MS = 2000; // gap between requests — even 1s sequential still had a 78% failure rate on Render

function buildTileCenters() {
  const centers = [];
  for (let lat = LAT_MIN; lat <= LAT_MAX; lat += LAT_STEP_DEG) {
    for (let lon = -180; lon < 180; lon += LON_STEP_DEG) {
      centers.push([lat, lon]);
    }
  }
  return centers;
}
const TILE_CENTERS = buildTileCenters();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let densityGrid = new Float32Array(GRID_W * GRID_H); // all-zero until the first successful fetch
let rawCounts = new Float32Array(GRID_W * GRID_H); // exact per-cell aircraft counts, pre-blur/compress/normalize
let lastFetchAt = 0;
let lastError = null;
let lastCount = 0;

// adjacent tiles overlap on purpose (no gaps in coverage), so the same
// aircraft shows up in multiple tiles' results — dedupe by its unique
// ICAO24 hex before binning, or overlap zones would look artificially dense
async function fetchTile(lat, lon, attempt = 1) {
  const url = `${ADSB_BASE_URL}/${lat}/${lon}/${TILE_RADIUS_NM}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (res.status === 429 || res.status === 420) {
    // rate-limited — back off and retry once rather than just dropping the tile
    if (attempt >= 2) throw new Error(`HTTP ${res.status} (gave up after retry)`);
    await sleep(2000);
    return fetchTile(lat, lon, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.ac) ? data.ac : [];
}

async function fetchAllAircraft() {
  const byHex = new Map();
  let failedTiles = 0;

  // strictly one request at a time with a gap between — the free tier here
  // does not tolerate concurrent bursts the way OpenSky's did
  for (const [lat, lon] of TILE_CENTERS) {
    try {
      const aircraft = await fetchTile(lat, lon);
      for (const ac of aircraft) {
        if (typeof ac.lat === 'number' && typeof ac.lon === 'number') byHex.set(ac.hex, ac);
      }
    } catch (err) {
      failedTiles++;
      if (failedTiles <= 3) console.error('[density] tile failed:', err.message); // TEMP diagnostic
    }
    await sleep(TILE_DELAY_MS);
  }

  if (failedTiles > 0) console.warn(`[density] ${failedTiles}/${TILE_CENTERS.length} tiles failed`);
  return { aircraft: Array.from(byHex.values()), failedTiles };
}

function binAircraft(aircraft) {
  const counts = new Float32Array(GRID_W * GRID_H);
  for (const ac of aircraft) {
    // adsb.lol reports "ground" (a string) for alt_baro instead of a numeric
    // altitude when an aircraft is on the ground
    if (ac.alt_baro === 'ground') continue;
    const col = Math.min(GRID_W - 1, Math.max(0, Math.round(((ac.lon + 180) / 360) * (GRID_W - 1))));
    const row = Math.min(GRID_H - 1, Math.max(0, Math.round(((ac.lat + 90) / 180) * (GRID_H - 1))));
    counts[row * GRID_W + col] += 1;
  }
  return counts;
}

// thousands of points still leaves gaps between grid cells, so spread each
// hit out over its neighborhood before normalizing, for a smoother heatmap
function blur(grid, w, h, passes) {
  let src = grid;
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
            sum += src[yy * w + xx];
            n++;
          }
        }
        dst[y * w + x] = sum / n;
      }
    }
    src = dst;
  }
  return src;
}

// raw counts are dominated by a handful of hub-airport cells (dozens of
// aircraft stacked in one grid square) next to thousands of corridor cells
// with just 1-2 planes crossing them. Dividing by the raw max alone crushes
// those corridor cells to near-zero — sqrt compression narrows that gap so
// real, spread-out traffic (transatlantic routes, etc.) stays visible
// instead of only the busiest hubs registering at all
function compress(grid) {
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

function normalize(grid) {
  let max = 0;
  for (const v of grid) if (v > max) max = v;
  if (max <= 0) return grid;
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = grid[i] / max;
  return out;
}

async function refreshDensity() {
  try {
    const { aircraft, failedTiles } = await fetchAllAircraft();
    const counts = binAircraft(aircraft);
    rawCounts = counts;
    densityGrid = normalize(compress(blur(counts, GRID_W, GRID_H, 2)));
    lastError = failedTiles > 0 ? `${failedTiles}/${TILE_CENTERS.length} tiles failed (partial data)` : null;
    lastCount = aircraft.length;
    lastFetchAt = Date.now();
    console.log(`[density] refreshed from ${aircraft.length} aircraft (${failedTiles} failed tiles) at ${new Date(lastFetchAt).toISOString()}`);
  } catch (err) {
    const cause = err && err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    lastError = String(err) + cause;
    console.error('[density] refresh failed:', err, err && err.cause);
  }
}

const app = express();
app.use(express.static(__dirname));

app.get('/api/density', (req, res) => {
  res.json({
    width: GRID_W,
    height: GRID_H,
    values: Array.from(densityGrid),
    // exact aircraft count per grid cell (pre-blur/compress/normalize), so
    // a click on the map can report a real number instead of just relative
    // density
    counts: Array.from(rawCounts),
    lastFetchAt,
    lastCount,
    error: lastError,
  });
});

// manual refresh — tiling the globe is heavier than a single OpenSky call
// was, so keep this throttled to avoid hammering adsb.lol on repeat clicks
let lastManualRefresh = 0;
app.post('/api/density/refresh', async (req, res) => {
  if (Date.now() - lastManualRefresh < 60 * 1000) {
    res.status(429).json({ ok: false, error: 'Refreshed too recently, try again in a minute' });
    return;
  }
  lastManualRefresh = Date.now();
  await refreshDensity();
  res.json({ ok: !lastError, lastFetchAt, lastCount, error: lastError });
});

app.listen(PORT, () => {
  console.log(`planetrack server on http://localhost:${PORT}`);
  refreshDensity();
  setInterval(refreshDensity, REFRESH_MS);
});
