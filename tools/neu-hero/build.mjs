/**
 * Generates `src/data/neu-hero.js` from the committed factual package.
 *
 *   node tools/neu-hero/build.mjs
 *
 * Source of truth is `docs/neu/HERO_FOOTPRINTS.json` (Boston Buildings with Roof
 * Breaks, City of Boston, PDDL, 2010 snapshot). Nothing here re-derives GIS
 * geometry — it de-duplicates, classifies and emits, so the runtime never parses
 * JSON and the factual package stays the only place a footprint is authored.
 *
 * Two things this does that a naive dump would get wrong:
 *
 * 1. **Parts, not buildings.** Three source parts are shared between two named
 *    buildings each — 661061 is the dominant mass of BOTH Ell and Curry, 666437
 *    is a tier of both Richards and Hayden, and 676669 of both Dodge and
 *    Hastings. Emitting per building would extrude those twice, giving coincident
 *    surfaces and doubled colliders. The part is the honest unit.
 *
 * 2. **Tier classification.** A roof-break polygon is not automatically worth
 *    runtime geometry. Anything under MICRO_M2 is recorded but not rendered.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'docs', 'neu', 'HERO_FOOTPRINTS.json');
const INV = join(ROOT, 'docs', 'neu', 'BUILDING_INVENTORY.json');
const OUT = join(ROOT, 'src', 'data', 'neu-hero.js');

/** Below this a roof-break part is mechanical clutter, not silhouette. */
const MICRO_M2 = 100;

const hf = JSON.parse(readFileSync(SRC, 'utf8'));
const inv = JSON.parse(readFileSync(INV, 'utf8'));
const invByName = new Map(inv.buildings.map(b => [b.name, b]));

/**
 * Storey evidence, graded, because facade rhythm must not invent floors.
 *
 * `storeysCrossCheck` in HERO_FOOTPRINTS is the OSM level count that the factual
 * height corroborates — dividing one by the other lands at 3.69-4.33 m per
 * storey every time, which is why it is trusted (confidence C). Where it is null
 * the inventory's `impliedFromGrossArea` is all there is (confidence D), and for
 * Hastings the package's own targeted validation records 7 assessor storeys at
 * 3.98 m each. Anything still unresolved gets a conservative 3.8 m course and is
 * marked DERIVED — a rhythm consistent with the measured mass, NOT a claim about
 * how many floors the building has.
 */
const ASSESSOR_STOREYS = { 'Hastings Hall': 7 };
const DEFAULT_COURSE_M = 3.8;

/**
 * Storey counts the building's OWNER publishes, which outrank every derivation
 * below. Northeastern Housing describes 337 Huntington Avenue verbatim as
 * "This 5-story apartment complex" — a direct statement about the building,
 * not a count inferred from mass or gross area.
 *
 * It matters here because the derived path would have reached 5 anyway
 * (18.46 / 3.8 rounds to 5) and labelled it DERIVED. The number is the same; the
 * provenance is not, and a rhythm that happens to agree with the evidence should
 * not be recorded as though arithmetic produced it. It also supersedes the
 * inventory's `impliedFromGrossArea` of 5.9, which was never a storey count:
 * that figure is an INDIRECT implication from 50,023 sq ft of gross area over a
 * 783 m2 footprint. Direct owner evidence outranks it. Why the arithmetic lands
 * near 5.9 is NOT established by any evidence this project accepts — basement
 * area, differing footprint definitions and gross-area accounting conventions
 * would each account for it, and none of them is evidenced, so none is recorded.
 */
const OFFICIAL_STOREYS = {
  '337 Huntington Avenue': { n: 5, basis: 'owner-published: Northeastern Housing, "This 5-story apartment complex"' },
};

function storeyEvidence(b) {
  const iv = invByName.get(b.name);
  const dom = b.dominantMass.heightM;
  const off = OFFICIAL_STOREYS[b.name];
  if (off) {
    return { storeys: off.n, courseM: +(dom / off.n).toFixed(2),
             confidence: 'B', basis: off.basis };
  }
  if (b.storeysCrossCheck) {
    return { storeys: b.storeysCrossCheck, courseM: +(dom / b.storeysCrossCheck).toFixed(2),
             confidence: 'C', basis: 'OSM levels, corroborated by the factual height' };
  }
  const a = ASSESSOR_STOREYS[b.name];
  if (a) {
    return { storeys: a, courseM: +(dom / a).toFixed(2),
             confidence: 'D', basis: 'assessor storey count in HERO_FOOTPRINTS.targetedValidation' };
  }
  const n = Math.max(1, Math.round(dom / DEFAULT_COURSE_M));
  return { storeys: n, courseM: +(dom / n).toFixed(2), confidence: 'DERIVED',
           basis: `dominant mass / ${DEFAULT_COURSE_M} m; gross-area implication was ` +
                  `${iv?.storeys?.impliedFromGrossArea ?? 'absent'}` };
}

// -- de-duplicate to parts, remembering every building that claims each one ---
const parts = new Map();
for (const b of hf.buildings) {
  for (const t of b.tiers) {
    let p = parts.get(t.objectId);
    if (!p) parts.set(t.objectId, p = { ...t, buildings: [], dominantOf: [] });
    if (!p.buildings.includes(b.name)) p.buildings.push(b.name);
    if (b.dominantMass.objectId === t.objectId && !p.dominantOf.includes(b.name)) {
      p.dominantOf.push(b.name);
    }
  }
}

const classify = (p) => {
  if (p.areaM2 < MICRO_M2) return 'MICRO';
  return p.dominantOf.length ? 'PRIMARY' : 'SECONDARY';
};

const all = [...parts.values()].map(p => ({ ...p, tier: classify(p) }));
// Tall first so the merged buffer front-loads the parts that matter, and stable
// by objectId so regenerating never reorders the output.
all.sort((a, b) => (b.areaM2 - a.areaM2) || (a.objectId - b.objectId));

const render = all.filter(p => p.tier !== 'MICRO');
const micro = all.filter(p => p.tier === 'MICRO');

const num = (n) => Number(n.toFixed(2));
const outline = (p) => '[' + p.outlineWorld
  .map(([x, z]) => `[${num(x)},${num(z)}]`).join(', ') + ']';

const partSrc = (p) => `  {
    id: ${p.objectId}, tier: '${p.tier}', heightM: ${p.heightM}, areaM2: ${p.areaM2},
    landUse: ${JSON.stringify(p.landUse ?? null)}, gndElevM: ${num(p.gndElevM)},
    buildings: ${JSON.stringify(p.buildings)},
    dominantOf: ${JSON.stringify(p.dominantOf)},
    outline: ${outline(p)},
  },`;

const buildings = hf.buildings.map(b => {
  const ev = storeyEvidence(b);
  const iv = invByName.get(b.name);
  return `  {
    name: ${JSON.stringify(b.name)}, status: '${b.status}',
    headlineHeightM: ${b.heightM}, dominantPart: ${b.dominantMass.objectId},
    dominantHeightM: ${b.dominantMass.heightM},
    parts: [${b.tiers.map(t => t.objectId).join(', ')}],
    sourceFootprintM2: ${b.totalFootprintM2}, officialFootprintM2: ${b.officialFootprintM2 ?? 'null'},
    yearBuilt: ${iv?.yearBuilt ?? 'null'},
    storeys: ${ev.storeys}, courseM: ${ev.courseM}, storeyConfidence: '${ev.confidence}',
    storeyBasis: ${JSON.stringify(ev.basis)},
    statusWhy: ${JSON.stringify(b.statusWhy ?? null)},
  },`;
}).join('\n');

const totalVerts = render.reduce((s, p) => s + p.outlineWorld.length, 0);

const src = `/**
 * Northeastern hero cluster — factual massing data. GENERATED, do not hand-edit.
 *
 *   node tools/neu-hero/build.mjs
 *
 * Source: ${hf.source.dataset} — ${hf.source.publisher}
 * Licence: ${hf.source.licence}
 * Vintage: ${hf.source.vintage}
 * Fields:  ${hf.source.fields}
 * Service: ${hf.source.service}
 *
 * Validated sub-metre against two towers whose heights are independently known:
 * Prudential ${hf.validation.prudentialM} m against a true ${hf.validation.prudentialTruthM} m,
 * 111 Clarendon ${hf.validation.clarendonM} m against a true ${hf.validation.clarendonTruthM} m.
 *
 * This layer SUPERSEDES the Boston 3D heights in docs/neu/HEIGHT_MEASUREMENTS.json,
 * which run a median +${hf.supersedes.excessOverThisLayerM.median} m high and imply
 * 4.9-5.9 m per storey on this quadrangle against this layer's 3.7-4.3.
 * **Do not reintroduce the ~24-25 m Krentzman values.**
 *
 * Outlines are CLOSED rings of [x, z] in world metres, already projected through
 * \`Geo.geo()\`, so no conversion happens at runtime. Heights are metres of the
 * part itself (ROOF_ELEV - GRND_ELEV), NOT metres above the game terrain.
 *
 * The unit here is the SOURCE PART, not the named building: 661061 is the
 * dominant mass of both Ell and Curry, 666437 a tier of both Richards and
 * Hayden, 676669 of both Dodge and Hastings. Rendering per building would
 * extrude those twice.
 */

/** Parts worth runtime geometry: ${render.length} of ${all.length}, ${totalVerts} ring vertices. */
export const NEU_HERO_PARTS = [
${render.map(partSrc).join('\n')}
];

/**
 * Recorded but deliberately NOT rendered — under ${MICRO_M2} m2 of roof break.
 * Note ${micro.filter(p => p.buildings.includes('Shillman Hall')).map(p => p.objectId).join(' and ')}: these two
 * ${micro.filter(p => p.buildings.includes('Shillman Hall')).length ? `carry Shillman's headline 19.6 m on ${micro.filter(p => p.buildings.includes('Shillman Hall')).map(p => p.areaM2 + ' m2').join(' and ')} of plan,
 * so the rendered mass tops out at its dominant part's 17.56 m instead. That is
 * the intended trade: structural silhouette over completeness.` : ''}
 */
export const NEU_HERO_MICRO = [
${micro.map(partSrc).join('\n')}
];

/** Named buildings and the parts they claim. Evidence, not geometry. */
export const NEU_HERO_BUILDINGS = [
${buildings}
];

export const NEU_HERO_SOURCE = {
  dataset: ${JSON.stringify(hf.source.dataset)},
  publisher: ${JSON.stringify(hf.source.publisher)},
  licence: ${JSON.stringify(hf.source.licence)},
  vintage: ${JSON.stringify(hf.source.vintage)},
  service: ${JSON.stringify(hf.source.service)},
  microThresholdM2: ${MICRO_M2},
};
`;

writeFileSync(OUT, src);
console.log(`wrote ${OUT}`);
console.log(`  ${render.length} rendered parts (${render.filter(p => p.tier === 'PRIMARY').length} PRIMARY, ` +
  `${render.filter(p => p.tier === 'SECONDARY').length} SECONDARY), ${micro.length} MICRO withheld`);
console.log(`  ${totalVerts} ring vertices -> ~${render.reduce((s, p) => s + 3 * (p.outlineWorld.length - 1), 0)} triangles`);
