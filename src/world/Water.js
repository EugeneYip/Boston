import * as THREE from 'three';
import { geo } from '../core/Geo.js';
import { WATER } from '../data/boston-geo.js';

/**
 * The Charles basin, Boston Harbor and Fort Point Channel.
 *
 * Boston water is grey-green and turbid — glacial till, silt and a lot of
 * weather. It is never Caribbean blue, and getting that wrong is the single
 * fastest way to make a Boston scene look like it was built by someone who has
 * never been there.
 *
 * Depth and distance-to-shore are baked per vertex at build time (they come
 * straight out of the terrain raster), which buys depth-graded colour and a
 * shoreline foam line without a depth pre-pass or a second render target.
 */

const MAX_EDGE = 34;        // triangle subdivision target, metres

/** Fast deterministic hash — the ripple bake is a quarter-million pixels. */
const rnd = (s) => {
  let h = (s * 374761393) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Seamless ripple normal map: three octaves of rotated, scrolling wavelets. */
function rippleNormal(size = 512) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const h = new Float32Array(size * size);
  const waves = [];
  for (let i = 0; i < 22; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);
    const k = 1 + (i % 5);
    waves.push({ kx: Math.round(Math.cos(a) * k), ky: Math.round(Math.sin(a) * k),
                 ph: (i * 1.7) % (Math.PI * 2), amp: 1 / (1 + k * 0.9) });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      const u = x / size * Math.PI * 2, w = y / size * Math.PI * 2;
      for (const g of waves) v += Math.sin(u * g.kx + w * g.ky + g.ph) * g.amp;
      h[y * size + x] = v;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x + size - 1) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y + size - 1) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      const i = (y * size + x) * 4;
      img.data[i] = 128 - (r - l) * 46;
      img.data[i + 1] = 128 - (d - u) * 46;
      img.data[i + 2] = 235;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  return t;
}

export default class Water {
  constructor(terrain) {
    this.terrain = terrain;
    this.meshes = [];
    this.time = 0;
  }

  // -- tessellation ---------------------------------------------------------

  /** Earcut the ring, then split long edges until waves have something to move. */
  _tessellate(ring) {
    const pts = ring.map(([la, lo]) => { const p = geo(la, lo); return new THREE.Vector2(p.x, p.z); });
    if (THREE.ShapeUtils.area(pts) < 0) pts.reverse();
    let tris = THREE.ShapeUtils.triangulateShape(pts, []);
    const verts = pts.map(p => [p.x, p.y]);
    const mid = new Map();
    const midpoint = (a, b) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let m = mid.get(k);
      if (m === undefined) {
        m = verts.length;
        verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]);
        mid.set(k, m);
      }
      return m;
    };
    for (let pass = 0; pass < 7; pass++) {
      const next = [];
      let split = false;
      for (const t of tris) {
        const e = [0, 1, 2].map(i => {
          const a = verts[t[i]], b = verts[t[(i + 1) % 3]];
          return Math.hypot(b[0] - a[0], b[1] - a[1]);
        });
        const longest = e[0] > e[1] ? (e[0] > e[2] ? 0 : 2) : (e[1] > e[2] ? 1 : 2);
        if (e[longest] < MAX_EDGE) { next.push(t); continue; }
        split = true;
        const i0 = t[longest], i1 = t[(longest + 1) % 3], i2 = t[(longest + 2) % 3];
        const m = midpoint(i0, i1);
        next.push([i0, m, i2], [m, i1, i2]);
      }
      tris = next;
      if (!split) break;
    }
    return { verts, tris };
  }

  build(scene) {
    this.normalTex = rippleNormal();
    for (const body of WATER) {
      const { verts, tris } = this._tessellate(body.ring);
      const pos = new Float32Array(verts.length * 3);
      const nrm = new Float32Array(verts.length * 3);
      const dep = new Float32Array(verts.length);
      for (let i = 0; i < verts.length; i++) {
        const [x, z] = verts[i];
        pos[i * 3] = x; pos[i * 3 + 1] = body.level; pos[i * 3 + 2] = z;
        nrm[i * 3 + 1] = 1;
        dep[i] = Math.max(0, body.level - this.terrain.groundHeight(x, z));
      }
      const idx = new Uint32Array(tris.length * 3);
      for (let i = 0; i < tris.length; i++) {
        idx[i * 3] = tris[i][0]; idx[i * 3 + 1] = tris[i][1]; idx[i * 3 + 2] = tris[i][2];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();

      const mat = this._material(body);
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'water_' + body.name;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      mesh.receiveShadow = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
    return this;
  }

  // -- material -------------------------------------------------------------

  _material(body) {
    const sea = body.kind === 'sea' || body.kind === 'channel';
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.075, metalness: 0.0,
      envMapIntensity: 2.1, transparent: true, depthWrite: true,
    });
    const u = {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color().setStyle(sea ? '#0b1b1e' : '#0d1a1c') },
      uShallow: { value: new THREE.Color().setStyle(sea ? '#2c4442' : '#31463a') },
      uFoam: { value: new THREE.Color().setStyle('#c9d2cf') },
      uRipple: { value: this.normalTex },
      uChop: { value: sea ? 1.0 : 0.55 },
      uSun: { value: new THREE.Vector3(0.3, 0.6, 0.4) },
      uSunCol: { value: new THREE.Color(1, 0.96, 0.88) },
    };
    m.userData.u = u;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aDepth;
          uniform float uTime; uniform float uChop;
          varying float vDepth; varying vec3 vWPos; varying float vWave;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vDepth = aDepth;
          vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
          // two crossed swells; killed off in the shallows so the shore stays put
          float shoal = smoothstep(0.0, 2.6, aDepth);
          float w =
            sin(wp.x * 0.055 + wp.z * 0.021 + uTime * 0.85) * 0.085 +
            sin(wp.x * -0.017 + wp.z * 0.049 + uTime * 1.31) * 0.062 +
            sin(wp.x * 0.113 + wp.z * -0.097 + uTime * 2.17) * 0.028;
          w *= uChop * shoal;
          transformed.y += w;
          vWave = w;
          vWPos = wp + vec3(0.0, w, 0.0);`);

      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; uniform float uChop;
          uniform vec3 uDeep, uShallow, uFoam, uSun, uSunCol;
          uniform sampler2D uRipple;
          varying float vDepth; varying vec3 vWPos; varying float vWave;
          vec3 rip(vec2 p, float sc, vec2 vel) {
            return texture2D(uRipple, p * sc + vel * uTime).xyz * 2.0 - 1.0;
          }`)
        .replace('#include <normal_fragment_begin>', `
          vec2 wp = vWPos.xz;
          vec3 nA = rip(wp, 0.0125, vec2( 0.0062, 0.0031));
          vec3 nB = rip(wp, 0.0305, vec2(-0.0041, 0.0074));
          vec3 nC = rip(wp, 0.0810, vec2( 0.0110,-0.0053));
          // fade the fine octaves out with distance so the surface does not boil
          float dist = length(vWPos - cameraPosition);
          float fine = 1.0 - smoothstep(90.0, 620.0, dist);
          vec3 nrm = normalize(vec3(
            (nA.x * 1.0 + nB.x * 0.72 * fine + nC.x * 0.45 * fine) * uChop,
            2.4,
            (nA.y * 1.0 + nB.y * 0.72 * fine + nC.y * 0.45 * fine) * uChop));
          // NB: three declares geometryNormal itself in lights_fragment_begin;
          // only normal and nonPerturbedNormal belong to this chunk.
          vec3 normal = normalize(nrm);
          vec3 nonPerturbedNormal = normal;`)
        .replace('#include <roughnessmap_fragment>', `
          float dist2 = length(vWPos - cameraPosition);
          // distant water goes glossier: the chop is below a pixel out there
          float roughnessFactor = mix(0.055, 0.018, smoothstep(140.0, 900.0, dist2))
            + (1.0 - smoothstep(0.0, 1.4, vDepth)) * 0.35;`)
        .replace('#include <map_fragment>', `
          float dgrad = 1.0 - exp(-vDepth * 0.42);
          vec3 base = mix(uShallow, uDeep, dgrad);
          // silt suspended in the shallows lifts the green
          base += vec3(0.02, 0.045, 0.028) * (1.0 - dgrad);
          // shoreline foam: a wash band that breathes with the swell
          float wash = 0.55 + 0.45 * sin(vWPos.x * 0.09 + vWPos.z * 0.07 + uTime * 1.4);
          float foam = smoothstep(1.15, 0.10, vDepth - vWave * 2.2 - wash * 0.24);
          float streak = texture2D(uRipple, vWPos.xz * 0.055 + uTime * vec2(0.004, 0.002)).z;
          foam *= 0.35 + 0.75 * smoothstep(0.35, 0.95, streak);
          diffuseColor.rgb *= mix(base, uFoam, clamp(foam, 0.0, 1.0));
          diffuseColor.a *= mix(0.72, 1.0, smoothstep(0.0, 1.1, vDepth));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          // specular glitter: a compressed sun highlight the BRDF alone misses
          vec3 V = normalize(cameraPosition - vWPos);
          vec3 H = normalize(V + uSun);
          float spec = pow(max(dot(normal, H), 0.0), 420.0);
          float fres = pow(1.0 - max(dot(normal, V), 0.0), 5.0);
          totalEmissiveRadiance += uSunCol * spec * 2.6 * max(uSun.y, 0.0)
            + uSunCol * fres * 0.05 * max(uSun.y, 0.0);`);
    };
    m.customProgramCacheKey = () => 'bostonWater' + (sea ? 'S' : 'R');
    return m;
  }

  /** @param {number} dt @param {THREE.Vector3} sunDir */
  update(dt, sunDir) {
    this.time += dt;
    for (const mesh of this.meshes) {
      const u = mesh.material.userData.u;
      u.uTime.value = this.time;
      if (sunDir) u.uSun.value.copy(sunDir);
    }
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose(); m.material.dispose(); m.parent?.remove(m);
    }
    this.meshes.length = 0;
    this.normalTex?.dispose();
  }
}
