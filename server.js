import 'dotenv/config';
import dns from 'dns';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// some container networks (Railway included) have broken/restricted
// outbound IPv6 routing while IPv4 works fine — Node's fetch tries IPv6
// first by default, which manifests as a silent connect timeout rather
// than a clear error, so prefer IPv4 explicitly
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const GRID_W = 128;
const GRID_H = 64;
const REFRESH_MS = (Number(process.env.REFRESH_MINUTES) || 15) * 60 * 1000;

// OpenSky's anonymous (no-auth) access is capped at 400 credits/day, and a
// full-globe /states/all call costs 4 credits — so 15-minute polling
// (~96 calls, 384 credits/day) fits comfortably without registering a key
const OPENSKY_URL = 'https://opensky-network.org/api/states/all';

let densityGrid = new Float32Array(GRID_W * GRID_H); // all-zero until the first successful fetch
let rawCounts = new Float32Array(GRID_W * GRID_H); // exact per-cell aircraft counts, pre-blur/compress/normalize
let lastFetchAt = 0;
let lastError = null;
let lastCount = 0;

function binStates(states) {
  const counts = new Float32Array(GRID_W * GRID_H);
  for (const s of states) {
    // state vector layout: [icao24, callsign, origin_country, time_position,
    // last_contact, longitude, latitude, baro_altitude, on_ground, ...]
    const lon = s[5];
    const lat = s[6];
    const onGround = s[8];
    if (typeof lat !== 'number' || typeof lon !== 'number' || onGround) continue;
    const col = Math.min(GRID_W - 1, Math.max(0, Math.round(((lon + 180) / 360) * (GRID_W - 1))));
    const row = Math.min(GRID_H - 1, Math.max(0, Math.round(((lat + 90) / 180) * (GRID_H - 1))));
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

// one-time diagnostic: is Railway's outbound network blocked entirely, or
// is this specific to OpenSky? Remove once the real cause is known.
let outboundDiagnostic = 'not run yet';
async function checkOutboundConnectivity() {
  try {
    const res = await fetch('https://api.github.com', { signal: AbortSignal.timeout(8000) });
    outboundDiagnostic = `api.github.com reachable, HTTP ${res.status}`;
  } catch (err) {
    const cause = err && err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    outboundDiagnostic = `api.github.com FAILED: ${String(err)}${cause}`;
  }
  console.log('[diagnostic]', outboundDiagnostic);
}

async function refreshDensity() {
  try {
    const res = await fetch(OPENSKY_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      lastError = `OpenSky returned HTTP ${res.status}`;
      console.error('[density] refresh failed:', lastError);
      return;
    }
    const data = await res.json();
    const states = Array.isArray(data.states) ? data.states : [];
    const counts = binStates(states);
    rawCounts = counts;
    densityGrid = normalize(compress(blur(counts, GRID_W, GRID_H, 2)));
    lastError = null;
    lastCount = states.length;
    lastFetchAt = Date.now();
    console.log(`[density] refreshed from ${states.length} aircraft states at ${new Date(lastFetchAt).toISOString()}`);
  } catch (err) {
    // Node's fetch wraps the real network error in a generic "TypeError:
    // fetch failed" — the actual reason (DNS failure, connection refused,
    // timeout, etc.) is on err.cause, which String(err) alone doesn't show
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
    outboundDiagnostic, // TEMP: remove once the OpenSky connectivity issue is diagnosed
  });
});

// manual refresh — cheap against OpenSky's anonymous budget, but still
// throttled a little so accidental rapid clicking can't trip their rate limit
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
  checkOutboundConnectivity();
  refreshDensity();
  setInterval(refreshDensity, REFRESH_MS);
});
