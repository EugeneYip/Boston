/**
 * The smallest I3S reader that answers one question: how tall is that building?
 *
 * Boston's authoritative 3D model is published only as an I3S SceneServer, and
 * the obvious reading of that is "decode the meshes". You do not have to. A 3D
 * Object scene layer carries a full per-feature attribute table alongside the
 * geometry, in a documented binary form, and Boston's includes `Height_Ft`,
 * `Gnd_El_Ft`, `Z_Max_Ft`, `Centr_Lat/Lon`, `Name` and `Parcel_ID`. So this
 * reads attributes and never touches a vertex.
 *
 * Scope is deliberately this dataset. It is not an ArcGIS client: it supports
 * the node-page index, a bbox filter over node bounding boxes, and the three
 * attribute encodings this layer actually uses.
 *
 * FORMAT ASSUMPTIONS, all verified against the live service:
 *
 *   - `store.profile` is `meshpyramids`, version 1.10, with `nodePages`
 *     (64 nodes per page). Node ids index into pages: page = floor(id/64).
 *   - Leaf nodes carry `mesh.attribute.resource`; attribute blobs live at
 *     `nodes/{resource}/attributes/{key}/0`.
 *   - Every blob starts with a UInt32 `count`.
 *   - **Value arrays are aligned to their element size.** A Float64 array
 *     therefore begins at byte 8, not byte 4 — the 4-byte header is followed by
 *     4 bytes of padding. Reading from 4 yields NaN, which looks exactly like
 *     the layer's null encoding, so this is worth stating rather than guessing.
 *   - Strings: UInt32 count, UInt32 total byte length, UInt32 per-value byte
 *     counts, then NUL-terminated UTF-8 back to back.
 *   - NaN in a Float64 array means null.
 */
const NODES_PER_PAGE = 64;

export class I3SLayer {
  constructor(base, { fetchImpl = fetch, ua = 'boston-neu-height/1.0' } = {}) {
    this.base = base.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.headers = { 'User-Agent': ua };
    this._pages = new Map();
  }
  async layerInfo() {
    if (this._info) return this._info;
    const r = await this.fetch(`${this.base}?f=json`, { headers: this.headers });
    if (!r.ok) throw new Error(`layer info: HTTP ${r.status}`);
    const j = await r.json();
    this._info = j.layers ? j.layers[0] : j;
    return this._info;
  }
  /** name -> { key, kind } for every published attribute. */
  async attributeMap() {
    const info = await this.layerInfo();
    const m = new Map();
    for (const a of info.attributeStorageInfo || []) {
      const vt = a.attributeValues?.valueType;
      const kind = vt === 'String' ? 'str'
        : vt === 'Float64' ? 'f64'
        : vt === 'Float32' ? 'f32'
        : vt === 'Oid32' || vt === 'UInt32' ? 'u32'
        : vt === 'Int32' ? 'i32' : null;
      if (kind) m.set(a.name, { key: a.key, kind });
    }
    return m;
  }
  async page(n) {
    if (this._pages.has(n)) return this._pages.get(n);
    const r = await this.fetch(`${this.base}/nodepages/${n}?f=json`, { headers: this.headers });
    const j = r.ok ? await r.json() : null;
    this._pages.set(n, j);
    return j;
  }
  async node(i) {
    const p = await this.page(Math.floor(i / NODES_PER_PAGE));
    return p ? (p.nodes[i % NODES_PER_PAGE] || null) : null;
  }
  /**
   * Leaf nodes whose bounding box can reach `bbox` {w,e,s,n} in degrees.
   * The OBB is treated as a sphere of its half-diagonal — conservative, so it
   * over-selects rather than dropping a building at a tile edge.
   */
  async leavesIn(bbox) {
    const out = [];
    const hits = (obb) => {
      const [lon, lat] = obb.center;
      const r = Math.hypot(obb.halfSize[0], obb.halfSize[1], obb.halfSize[2]);
      const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
      return !(lon + dLon < bbox.w || lon - dLon > bbox.e
            || lat + dLat < bbox.s || lat - dLat > bbox.n);
    };
    const walk = async (i) => {
      const n = await this.node(i);
      if (!n || (n.obb && !hits(n.obb))) return;
      if (n.children?.length) { for (const c of n.children) await walk(c); return; }
      if (n.mesh?.attribute?.resource != null)
        out.push({ index: n.index, resource: n.mesh.attribute.resource,
                   featureCount: n.mesh.geometry?.featureCount ?? null });
    };
    await walk(0);
    return out;
  }
  async attributeBlob(resource, key) {
    const r = await this.fetch(`${this.base}/nodes/${resource}/attributes/${key}/0`,
                               { headers: this.headers });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }
}

/** Decode one attribute blob. See the format notes above. */
export function decodeAttribute(buf, kind) {
  if (!buf || buf.length < 4) return [];
  const count = buf.readUInt32LE(0);
  const out = new Array(count);
  if (kind === 'u32' || kind === 'i32') {
    const rd = kind === 'u32' ? 'readUInt32LE' : 'readInt32LE';
    for (let i = 0; i < count; i++) out[i] = buf[rd](4 + i * 4);
    return out;
  }
  if (kind === 'f32') {
    for (let i = 0; i < count; i++) { const v = buf.readFloatLE(4 + i * 4); out[i] = Number.isNaN(v) ? null : v; }
    return out;
  }
  if (kind === 'f64') {
    // 8-byte alignment: skip 4 bytes of padding after the header.
    for (let i = 0; i < count; i++) { const v = buf.readDoubleLE(8 + i * 8); out[i] = Number.isNaN(v) ? null : v; }
    return out;
  }
  let off = 8;                                   // count + attributeValuesByteCount
  const lens = new Array(count);
  for (let i = 0; i < count; i++) { lens[i] = buf.readUInt32LE(off); off += 4; }
  for (let i = 0; i < count; i++) {
    const L = lens[i];
    out[i] = L > 0 ? buf.toString('utf8', off, off + L - 1) : null;   // strip the NUL
    off += L;
  }
  return out;
}
