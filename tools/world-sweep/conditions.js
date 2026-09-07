/**
 * BOSTON — condition sweeps over the canonical routes.
 *
 * `routes.mjs` decides WHERE (headless, from production geography), `traverse.js`
 * drives ONE route and reports what happened along it, and this file decides
 * WHICH routes under WHICH conditions — because the interesting defects are not
 * evenly distributed across the condition matrix.
 *
 * A settled night capture cannot contain the thing a night route is looking for.
 * Entering a lamp volume, a headlight arriving, the fixed real-light pool
 * re-aiming as the camera moves, a window emissive tier swapping — every one of
 * those is a TRANSITION, and a transition has no representation in a photograph
 * of a stationary world. That is the whole argument for this file existing.
 *
 * Subsets are named and justified rather than sliced off the top of the list, so
 * a run is reproducible and so the coverage claim can be checked against the
 * reason each route is in it.
 *
 *   const C = await import('/tools/world-sweep/conditions.js');
 *   const r = await C.runCondition(window.__boston, routes, C.NIGHT, { cond: 'night' });
 */
import { runRoute, findEvents, summarise } from './traverse.js';

/**
 * Time of day per condition, matching the committed static subsets so a dynamic
 * result is comparable with a settled one at the same hour.
 *   day 11:00, dusk 19.4 (inside the B2 interval), night 22:00.
 */
export const TOD = { day: 11, dusk: 19.4, night: 22 };

/**
 * Night subset — 12 routes, one per lighting context worth separating.
 *
 * `why` is the coverage claim. Lamp FIXTURE follows `Props.js`: a heritage
 * street carries acorn/twin heads 3.85 m up, everything else a cobra head on a
 * davit 9.2 m up, so the district choice is what selects the fixture.
 */
export const NIGHT = [
  ['drive:arterial:e56',       'cobra-lit arterial, LED lamping, four lanes'],
  ['drive:arterial:e381',      'vehicle-heavy corridor: the busiest edge in the set'],
  ['walk:sidewalk:e247',       'heritage pavement, Beacon Hill: acorn/twin fixture'],
  ['walk:sidewalk:e381',       'financial-district pavement, tower windows above'],
  ['walk:sidewalk:e507',       'dark residential street, Charlestown'],
  ['walk:park:boston-common:diagonal', 'park path: lamps on one side, unlit lawn on the other'],
  ['walk:park:charles-river-esplanade:shore', 'waterfront promenade, water reflection, few lamps'],
  ['drive:junctions:e473',     'downtown intersection sequence, 8 arms'],
  ['drive:junctions:e513',     'second junction run in a different district'],
  ['drive:curve:e488',         'curved road: lamps enter frame from the side'],
  ['drive:grade:e503',         'hill: lamp volumes arrive from below eye level'],
  ['drive:bridge:e402',        'bridge approach: no side geometry to catch light'],
];

/**
 * Rain subset — 8 routes. Wetness is a single global scalar in `Weather.js`
 * applied through `Assets.setWetness`, so the question is not "does it look
 * different" but whether that scalar reaches every surface the camera crosses.
 */
export const RAIN = [
  ['drive:arterial:e56',       'straight arterial: the reference wet carriageway'],
  ['drive:arterial:e381',      'vehicle-heavy: wet road plus wet vehicle shells'],
  ['drive:curve:e488',         'curve: reflection sweeps across the frame'],
  ['drive:junctions:e473',     'intersection: several road stamps meeting'],
  ['drive:grade:e503',         'hill: a wet surface seen at a grazing angle'],
  ['drive:bridge:e402',        'bridge deck: a separate material from the carriageway'],
  ['walk:park:charles-river-esplanade:shore', 'waterfront: wet path against water'],
  ['walk:sidewalk:e381',       'pavement: wet footway, not carriageway'],
];

/** Dusk subset — 5 routes, secondary. B2 is closed absent fresh evidence. */
export const DUSK = [
  ['drive:arterial:e56',       'the arterial control, at the hour B2 grades'],
  ['walk:sidewalk:e247',       'heritage pavement as lamps come up'],
  ['walk:park:boston-common:diagonal', 'park at the hour the grade keyframe sits on'],
  ['drive:junctions:e473',     'downtown intersection through the transition'],
  ['walk:park:charles-river-esplanade:shore', 'low sun over water, the worst case for clipping'],
];

/** Ids only, for callers that just want the selection. */
export const idsOf = (subset) => subset.map(s => s[0]);

/**
 * Before / transition / after around each event.
 *
 * Three samples, not a frame dump: the point of an event is the DELTA, and the
 * delta needs the sample on each side of it to be a claim rather than a number.
 */
function evidence(run, events, keys) {
  const S = run.samples || [];
  const pick = (s) => {
    if (!s) return null;
    const o = { i: s.i, d: s.d };
    for (const k of keys) if (s[k] != null) o[k] = s[k];
    if (s.L) o.L = { nAct: s.L.nAct, nOvl: s.L.nOvl, nReal: s.L.nReal,
                     realSum: s.L.realSum, dLamp: s.L.dLamp, fam: s.L.fam,
                     nHead: s.L.nHead, nWin: s.L.nWin };
    return o;
  };
  return events.map(e => ({
    kind: e.kind, at: e.d, span: e.span ?? null, batch: e.batch ?? null,
    before: pick(S[e.i - 1]), transition: pick(S[e.i]), after: pick(S[e.i + 1]),
  }));
}

/**
 * @param {object} B        window.__boston
 * @param {Array}  routes   routes.json `routes`
 * @param {Array}  subset   one of NIGHT / RAIN / DUSK
 * @param {object} opts     { cond, weather, tod, maxSamples, onRoute }
 */
export async function runCondition(B, routes, subset, opts = {}) {
  const cond = opts.cond || 'night';
  const tod = opts.tod ?? TOD[cond] ?? TOD.night;
  const weather = opts.weather ?? (cond === 'rain' ? 'rain' : 'clear');
  const byId = new Map(routes.map(r => [r.id, r]));
  const out = { cond, tod, weather, started: new Date().toISOString(), runs: [] };
  const KEYS = ['mean', 'blown', 'dark', 'draws', 'inst', 'meshes', 'groundY', 'settled'];

  for (const [id, why] of subset) {
    const route = byId.get(id);
    if (!route) { out.runs.push({ id, err: 'route not in routes.json' }); continue; }
    const run = await runRoute(B, route, {
      tod, weather, luma: true, lights: true,
      maxSamples: opts.maxSamples ?? 40,
    });
    if (run.err) { out.runs.push({ id, err: run.err }); continue; }
    const events = findEvents(run, opts.thresholds || {});
    out.runs.push({
      why,
      ...summarise(run, events),
      events: events.map(e => ({ ...e })),
      evidence: evidence(run, events, KEYS),
      samples: run.samples,          // kept for the sink, not for the repo
    });
    if (opts.onRoute) opts.onRoute(out.runs[out.runs.length - 1]);
  }
  out.finished = new Date().toISOString();
  return out;
}

/** Drop the per-sample arrays: what is worth committing as a baseline. */
export function compact(result) {
  return {
    ...result,
    runs: result.runs.map(({ samples, ...r }) => r),
  };
}
