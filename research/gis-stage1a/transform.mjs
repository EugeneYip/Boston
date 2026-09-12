/**
 * Stage 1A coordinate transform, and an independent check on it.
 *
 * CANONICAL PATH (what the fixture uses):
 *   source EPSG:6492  --[ArcGIS server, outSR=4326]-->  WGS84 lat/lon
 *                     --[src/core/Geo.js geo()]------>  Boston local X/Z
 *
 * `geo()` is NOT modified and NOT reimplemented — it is imported from production.
 *
 * CHECK PATH (this file):
 *   source EPSG:6492 native ftUS --[inverse Lambert Conformal Conic, here]--> lat/lon
 * compared against the server's own 4326 output for the SAME vertices. The
 * residual is reported, so the server-side reprojection is verified rather than
 * trusted. The check deliberately uses the NAD83 ellipsoid with NO datum shift,
 * which is what makes the residual meaningful: it isolates the NAD83->WGS84
 * question instead of hiding it.
 */
import { geo } from '../../src/core/Geo.js';

const D = Math.PI / 180;
/** GRS80 / NAD83. */
const a = 6378137.0, f = 1 / 298.257222101, e2 = f * (2 - f), e = Math.sqrt(e2);
/** US survey foot, exactly 1200/3937 m — matches the layer's xyUnits 3048.00609601. */
export const FT_US = 1200 / 3937;

/** EPSG:6492 = NAD83(2011) / Massachusetts Mainland (ftUS). LCC 2SP. */
const P1 = (42 + 41 / 60) * D, P2 = (41 + 43 / 60) * D, P0 = 41 * D, L0 = -71.5 * D;
const FE_M = 200000, FN_M = 750000;                   // metres, per the CRS definition
const m_ = (p) => Math.cos(p) / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
const t_ = (p) => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);
const n_ = (Math.log(m_(P1)) - Math.log(m_(P2))) / (Math.log(t_(P1)) - Math.log(t_(P2)));
const F_ = m_(P1) / (n_ * Math.pow(t_(P1), n_));
const rho0 = a * F_ * Math.pow(t_(P0), n_);

/** EPSG:6492 (ftUS) -> NAD83 lat/lon degrees. Inverse LCC, iterated on phi. */
export function lccInverse(xFt, yFt) {
  const E = xFt * FT_US, N = yFt * FT_US;             // ftUS -> metres
  const dx = E - FE_M, dy = rho0 - (N - FN_M);
  const rho = Math.sign(n_) * Math.hypot(dx, dy);
  const theta = Math.atan2(dx, dy);
  const t = Math.pow(rho / (a * F_), 1 / n_);
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 30; i++) {
    const s = Math.sin(phi);
    const next = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - e * s) / (1 + e * s), e / 2));
    if (Math.abs(next - phi) < 1e-13) { phi = next; break; }
    phi = next;
  }
  return { lat: phi / D, lon: (theta / n_ + L0) / D };
}

/** WGS84 (or NAD83, see note) lat/lon -> Boston world X/Z via PRODUCTION geo(). */
export const toWorld = (lat, lon) => geo(lat, lon);

/** Metres per degree at Boston, for turning an angular residual into metres. */
export const M_PER_DEG_LAT = 111320;
export const M_PER_DEG_LON = 111320 * Math.cos(42.35538 * D);
