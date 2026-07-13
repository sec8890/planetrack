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
// community ADS-B aggregator that doesn't have this problem, but it rate
// limits heavily and unpredictably (likely shared across everyone on the
// same cloud egress IP pool, not just us — slowing our own pacing down
// barely moved the failure rate). It also has no single "whole planet"
// endpoint like OpenSky did, so we tile point+radius queries across the
// globe instead.
const ADSB_BASE_URL = 'https://api.adsb.lol/v2/point';
const TILE_RADIUS_NM = 600;
const LON_STEP_DEG = 45;
const LAT_STEP_DEG = 30;
const LAT_MIN = -60; // skip the poles — negligible traffic, not worth the extra tiles
const LAT_MAX = 60;
const TILE_DELAY_MS = 2000; // gap between requests

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

// persists across refresh cycles on purpose: a tile that fails this cycle
// leaves its region's last known values in place rather than going blank,
// so a ~80% per-cycle tile failure rate doesn't mean the map loses 80% of
// itself every 15 minutes — it just means most regions are a cycle or two
// stale rather than empty
let densityGrid = new Float32Array(GRID_W * GRID_H);
let rawCounts = new Float32Array(GRID_W * GRID_H); // exact per-cell aircraft counts, pre-blur/compress/normalize
let lastFetchAt = 0;
let lastError = null;
let lastCount = 0;

function normalizeLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180; // wrap into [-180, 180)
}
function lonToCol(lon) {
  const wrapped = normalizeLon(lon);
  return Math.min(GRID_W - 1, Math.max(0, Math.round(((wrapped + 180) / 360) * (GRID_W - 1))));
}
function latToRow(lat) {
  return Math.min(GRID_H - 1, Math.max(0, Math.round(((lat + 90) / 180) * (GRID_H - 1))));
}
// is lon within [lonMin, lonMax), correctly handling the antimeridian wrap
// for the tile centered at lon=-180?
function lonInRange(lon, lonMin, lonMax) {
  const nLon = normalizeLon(lon);
  const nMin = normalizeLon(lonMin);
  const nMax = normalizeLon(lonMax);
  if (nMin <= nMax) return nLon >= nMin && nLon < nMax;
  return nLon >= nMin || nLon < nMax; // range itself wraps around
}
// grid columns owned by a tile, handling the same antimeridian wrap
function ownedColumns(lonMin, lonMax) {
  const colMin = lonToCol(lonMin);
  const colMax = lonToCol(lonMax);
  const cols = [];
  if (colMin <= colMax) {
    for (let c = colMin; c <= colMax; c++) cols.push(c);
  } else {
    for (let c = colMin; c < GRID_W; c++) cols.push(c);
    for (let c = 0; c <= colMax; c++) cols.push(c);
  }
  return cols;
}

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
  let updatedTiles = 0;
  let failedTiles = 0;

  for (const [lat, lon] of TILE_CENTERS) {
    const latMin = lat - LAT_STEP_DEG / 2;
    const latMax = lat + LAT_STEP_DEG / 2;
    const lonMin = lon - LON_STEP_DEG / 2;
    const lonMax = lon + LON_STEP_DEG / 2;
    const rowMin = latToRow(latMin);
    const rowMax = latToRow(latMax);
    const cols = ownedColumns(lonMin, lonMax);

    try {
      const aircraft = await fetchTile(lat, lon);

      // clear this tile's owned region, then recount only aircraft that
      // actually fall within it — the query radius overlaps neighboring
      // tiles on purpose (solid coverage), so some results here belong to
      // them, not us; filtering by ownership bounds avoids double-counting
      for (let row = rowMin; row <= rowMax; row++) {
        for (const col of cols) rawCounts[row * GRID_W + col] = 0;
      }
      for (const ac of aircraft) {
        if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') continue;
        if (ac.alt_baro === 'ground') continue;
        if (ac.lat < latMin || ac.lat >= latMax) continue;
        if (!lonInRange(ac.lon, lonMin, lonMax)) continue;
        rawCounts[latToRow(ac.lat) * GRID_W + lonToCol(ac.lon)] += 1;
      }
      updatedTiles++;
    } catch (err) {
      failedTiles++;
      // this tile's region just keeps whatever it had from the last
      // successful cycle instead of going blank
      if (failedTiles <= 3) console.error('[density] tile failed:', err.message);
    }
    await sleep(TILE_DELAY_MS);
  }

  densityGrid = normalize(compress(blur(rawCounts, GRID_W, GRID_H, 2)));
  lastError =
    failedTiles > 0
      ? `${failedTiles}/${TILE_CENTERS.length} tiles failed this cycle (those regions show cached data from an earlier successful cycle)`
      : null;
  lastCount = Math.round(rawCounts.reduce((a, b) => a + b, 0));
  lastFetchAt = Date.now();
  console.log(
    `[density] ${updatedTiles}/${TILE_CENTERS.length} tiles refreshed (${failedTiles} failed), ${lastCount} aircraft currently represented at ${new Date(lastFetchAt).toISOString()}`
  );
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
