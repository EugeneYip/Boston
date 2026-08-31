import * as THREE from 'three';
import yieldToPaint from './Yield.js';

/**
 * Deterministic screenshot harness for the automated visual-critic loop.
 *
 * Browser tabs throttle requestAnimationFrame to zero when backgrounded, so an
 * automation agent cannot rely on the normal loop running. Everything here steps
 * the engine synchronously instead.
 *
 * From an automation context:
 *   await window.__boston.ready()
 *   await window.__boston.capture({ shot: 'downtown_dusk' })
 */

/**
 * Wait `ms` of real wall-clock time without using a timer.
 *
 * Chrome clamps setTimeout in a hidden tab to ~1/second, and ~1/minute once the
 * tab has been hidden five minutes. Every automation tab is hidden, so a
 * `setTimeout(60)` here can cost 60 SECONDS -- and this runs once per capture,
 * eight times per critic pass. yieldToPaint() is a MessageChannel task, which is
 * exempt from the clamp, so we spin on it until the clock actually advances.
 */
async function settle(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) await yieldToPaint();
}

export default class CaptureHarness {
  static id = 'capture';
  static label = 'Capture harness';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    const engine = ctx.engine;

    /** Named viewpoints the critic compares against GTA V reference framing. */
    this.shots = {
      // Re-authored: the original [40,1.7,120] was parked in Boston Common with no
      // road surface in the near field at all. Toggling the road material moved the
      // lower-frame mean by 0.2/255 there -- the shot was grass. A critic pass
      // graded "the rain carriageway is identical to the dry one" from a shot with
      // no carriageway in it. East Berkeley St, South End: 23 buildings within
      // 45 m, and the same ablation moves 27.2.
      street_level:   { pos: [-312.4, 5.06, 1275.9], look: [-237.6, 5.15, 1297.6],
                        tod: 9.5,  fov: 55, eye: 1.7 },
      // Re-authored: the original [180,42,260] ended up pressed against a facade
      // once building heights were fixed, so the shot was a wall of windows.
      downtown_dusk:  { pos: [700, 120, 900],  look: [-100, 40, -200], tod: 19.4, fov: 48 },
      // Parked ON A LIT STREET. The previous position sat in Boston Common with no
      // street lamp within 186 m of it -- geographically correct (the Common has no
      // roads through it) but useless for judging night lighting.
      night_neon:     { pos: [-1453.4, 4.85, 401.4], look: [-1200, 11, 470],
                        tod: 22.0, fov: 62, eye: 1.7 },
      hero_skyline:   { pos: [620, 150, 780],  look: [-200, 60, -300],tod: 17.8, fov: 40 },
      golden_hour:    { pos: [-300, 18, 420],  look: [300, 40, -200], tod: 6.6,  fov: 50 },
      overcast_wide:  { pos: [0, 320, 900],    look: [0, 30, -400],   tod: 13.0, fov: 60,
                        weather: 'overcast' },
      // Re-authored off the Common for the same reason as street_level, and onto a
      // DIFFERENT street so the two are not the same view twice -- a previous
      // critic pass noted they were. Saint James Ave, Back Bay: 25 buildings
      // within 45 m, road ablation moves 14.0.
      rain_street:    { pos: [-459.2, 5.53, 496.8], look: [-523.8, 5.62, 527.8],
                        tod: 15.2, fov: 58, weather: 'rain', eye: 1.7 },
      bridge:         { pos: [-40, 26, -980],  look: [120, 8, -1500], tod: 8.2,  fov: 52 },

      // ---- Level eye-height street cameras -------------------------------
      // The critic's single biggest process finding: not one named shot was a
      // level camera at eye height on a built street, which is why the horizon
      // step, the triangle overrun, the car shells and buildings standing in the
      // carriageway were all invisible to earlier passes. These are sampled from
      // real road-graph edges that have 8+ buildings within 45 m.
      // Beacon St, Back Bay -- level camera at eye height on a BUILT street.
      st_backbay:    { pos: [-457.3, 5.29, -53.3], look: [-575.9, 5.66, -13.8],
                        tod: 9.6, fov: 58, eye: 1.65 },
      // Chestnut St, Beacon Hill -- level camera at eye height on a BUILT street.
      st_beaconhill: { pos: [-379.8, 5.19, -193.1], look: [-232.6, 6.12, -221.9],
                        tod: 16.0, fov: 58, eye: 1.65 },
      // Hanover St, North End -- level camera at eye height on a BUILT street.
      st_northend:   { pos: [830.0, 5.16, -873.0], look: [919.9, 4.6, -993.1],
                        tod: 18.4, fov: 58, eye: 1.65 },
      // Arlington St, South End -- level camera at eye height on a BUILT street.
      st_southend:   { pos: [-334.5, 5.03, 577.3], look: [-282.1, 5.14, 717.9],
                        tod: 11.2, fov: 58, eye: 1.65 },
      // Summer St, Seaport -- level camera at eye height on a BUILT street.
      st_seaport:    { pos: [1326.9, 5.14, 593.1], look: [1464.5, 4.77, 652.9],
                        tod: 20.0, fov: 58, eye: 1.65 },
    };

    // Any system id that may write to the camera. `setCamera` stands these down,
    // but the transform lock below is what actually guarantees the shot.
    const CAMERA_DRIVERS = new Set(['cameraRig', 'player', 'gameplay', 'missions']);
    const camLock = { active: false, pos: new THREE.Vector3(),
                      quat: new THREE.Quaternion(), fov: null };
    const _lookTmp = new THREE.Vector3();
    {
      const cam = engine.camera;
      const origUpdate = cam.updateMatrixWorld.bind(cam);
      cam.updateMatrixWorld = function (force) {
        if (camLock.active) {
          this.position.copy(camLock.pos);
          this.quaternion.copy(camLock.quat);
          if (camLock.fov && this.fov !== camLock.fov) {
            this.fov = camLock.fov; this.updateProjectionMatrix();
          }
        }
        return origUpdate(force);
      };
    }

    const api = {
      engine,
      ready: async () => {
        for (let i = 0; i < 200 && !engine._running; i++) await settle(50);
        return true;
      },
      /** Advance n frames synchronously with a fixed dt, ignoring rAF throttling. */
      step: (n = 1, dt = 1 / 60) => {
        const wasRunning = engine._running;
        engine.stop();
        const realDelta = engine._clock.getDelta;
        engine._clock.getDelta = () => dt;
        for (let i = 0; i < n; i++) {
          // Re-assert before the frame, not just in updateMatrixWorld. The render
          // was always correct, but systems reading camera.position during their
          // own update() saw whatever a camera driver had just written -- so the
          // HUD reported a position the frame was not rendered from, which made
          // one agent distrust a set of perfectly valid captures.
          if (camLock.active) {
            engine.camera.position.copy(camLock.pos);
            engine.camera.quaternion.copy(camLock.quat);
          }
          engine.frame();
        }
        engine._clock.getDelta = realDelta;
        if (wasRunning) engine.start();
        return { frames: n, fps: engine.perf.fps, draws: engine.perf.drawCalls,
                 tris: engine.perf.tris };
      },
      /**
       * Stop the systems that animate under their own dt rather than off the
       * world clock: traffic, vehicles and pedestrians.
       *
       * `freeze()` only ever stopped the clock, so a "frozen" frame still had
       * cars rolling and crowds walking through it. Two reads of the supposedly
       * identical frame therefore differed, and an agent doing an A/B on the
       * road surface measured a 40% A/A noise floor until it worked this out and
       * stubbed the three systems by hand. Any pixel comparison that does not do
       * this is measuring pedestrians.
       *
       * Deliberately NOT the streaming or render systems: `Buildings._pump`
       * builds geometry from `update()`, so stubbing it would stop `capture()`
       * ever settling.
       * @param {boolean} on
       */
      pauseActors: (on = true) => {
        const ids = ['traffic', 'vehicles', 'peds'];
        for (const id of ids) {
          const sys = engine.systems.get(id);
          if (!sys) continue;
          if (on) {
            if (sys._capturePaused) continue;
            sys._capturePaused = { update: sys.update, fixedUpdate: sys.fixedUpdate,
                                   lateUpdate: sys.lateUpdate };
            const noop = () => {};
            if (sys.update) sys.update = noop;
            if (sys.fixedUpdate) sys.fixedUpdate = noop;
            if (sys.lateUpdate) sys.lateUpdate = noop;
          } else if (sys._capturePaused) {
            const p = sys._capturePaused;
            if (p.update) sys.update = p.update;
            if (p.fixedUpdate) sys.fixedUpdate = p.fixedUpdate;
            if (p.lateUpdate) sys.lateUpdate = p.lateUpdate;
            delete sys._capturePaused;
          }
        }
        return ids.filter((id) => !!engine.systems.get(id)?._capturePaused);
      },
      /**
       * Freeze the world clock AND the actors, so a shot is genuinely static.
       * Two reads of the same frame must return the same pixels; before this
       * also paused the actors, they did not.
       */
      freeze: (on = true) => {
        engine.settings.timeScale = on ? 0 : 40;
        api.pauseActors(on);
      },
      setTime: (h) => { engine.settings.timeOfDay = h % 24; engine.time.timeOfDay = h % 24; },
      setWeather: (w) => { engine.settings.weather = w; ctx.bus.emit('weather:set', w); },
      setQuality: (p) => { engine.settings.apply(p); ctx.bus.emit('quality:changed'); },
      /**
       * Park the camera for a shot.
       *
       * Politely asking camera systems to stand down does not work: any system may
       * write to the camera, new ones get added, and one that ignores `enabled`
       * silently invalidates every screenshot the visual critic takes. So we also
       * hard-lock the transform in `camera.updateMatrixWorld`, which the renderer
       * calls immediately before rasterising — whatever a system did during
       * update/lateUpdate is overwritten before it can reach the frame.
       */
      /**
       * Resolve a shot's Y against the terrain.
       *
       * Shot positions were authored as absolute heights before the city had real
       * elevation, which parked `street_level` (y=1.7) and `rain_street` (y=2.4)
       * *underneath* the road -- ground there is 3.10 m and 7.99 m. That produced a
       * mostly-black frame which was misread for a long time as a post-processing
       * feedback loop. Eye heights are now relative to the ground beneath the shot.
       */
      groundedY: (x, y, z, eye) => {
        const city = engine.systems.get('city');
        if (!city || typeof city.groundHeight !== 'function') return y;
        const g = city.groundHeight(x, z);
        if (!Number.isFinite(g)) return y;
        // `eye` is the intended height above ground; absolute shots keep their
        // height but are never allowed below the surface.
        return eye != null ? g + eye : Math.max(y, g + 1.6);
      },

      /**
       * Push a shot position out of solid geometry.
       *
       * Shot positions are authored against the city as it was that day. When
       * buildings change height or a new block lands, a shot that was in open air
       * ends up buried inside a tower and the capture is a wall of facade.
       *
       * Buildings have no physics colliders -- only terrain and roads do -- so this
       * tests the render geometry directly: fire rays along the six axes and treat
       * the point as enclosed if nearly all of them hit something close by.
       *
       * @returns {{moved:number, pos:number[]}} how far it had to retreat
       */
      unstick: (pos, look, maxBack = 500) => {
        const targets = [];
        engine.scene.traverse((o) => {
          if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
          const nm = (o.name || '') + '|' + (o.parent?.name || '');
          if (/build|facade|shell|landmark/i.test(nm)) targets.push(o);
        });
        if (!targets.length) return { moved: 0, pos };

        const ray = new THREE.Raycaster();
        ray.far = 70;
        const dirs = [
          new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
          new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
        ];
        const origin = new THREE.Vector3();
        const _dirTmp = new THREE.Vector3();
        // Exact test first: buildings publish their footprint polygon and height,
        // so point-in-polygon plus a height check is definitive. The raycast
        // heuristic below missed `golden_hour` sitting inside a brownstone --
        // rays escaped through window openings, so it never reached 5 of 6 hits.
        const specs = engine.systems.get('buildings')?.specs;
        const insideFootprint = (p) => {
          if (!Array.isArray(specs)) return null;   // unknown -> fall through
          for (const b of specs) {
            if (b.cx === undefined) continue;
            // Cheap reject before the polygon walk.
            if (Math.abs(b.cx - p[0]) > 120 || Math.abs(b.cz - p[2]) > 120) continue;
            const top = (b.base || 0) + (b.h || 0);
            if (p[1] > top) continue;
            const poly = b.poly;
            if (!poly || poly.length < 3) continue;
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
              if (((zi > p[2]) !== (zj > p[2])) &&
                  (p[0] < (xj - xi) * (p[2] - zi) / (zj - zi) + xi)) inside = !inside;
            }
            if (inside) return true;
          }
          return false;
        };

        const enclosed = (p) => {
          const exact = insideFootprint(p);
          if (exact !== null) return exact;
          origin.set(p[0], p[1], p[2]);
          let hits = 0;
          for (const d of dirs) {
            ray.set(origin, d);
            if (ray.intersectObjects(targets, false).length) hits++;
          }
          return hits >= 5;   // boxed in on nearly every side
        };

        // Being pressed against a facade is as useless as being inside one, and it
        // does not read as "enclosed" -- only one ray hits.
        //
        // The threshold has to be SMALL. An earlier 25m version fired on ordinary
        // street-level shots -- looking down a street at a building 20m away is the
        // normal case, not a defect -- and backed the camera 10m the other way,
        // straight into the facade behind. 4m only catches a camera genuinely
        // jammed against a wall.
        const NEAR_WALL = 4;
        const viewClear = (p) => {
          origin.set(p[0], p[1], p[2]);
          _dirTmp.set(look[0] - p[0], look[1] - p[1], look[2] - p[2]).normalize();
          ray.set(origin, _dirTmp);
          ray.far = NEAR_WALL;
          const hit = ray.intersectObjects(targets, false).length > 0;
          ray.far = 70;
          return !hit;
        };
        // A retreat point is only good if it is also clear BEHIND -- otherwise
        // backing away from one wall parks the camera inside another.
        const backClear = (p) => {
          origin.set(p[0], p[1], p[2]);
          _dirTmp.set(p[0] - look[0], p[1] - look[1], p[2] - look[2]).normalize();
          ray.set(origin, _dirTmp);
          ray.far = NEAR_WALL;
          const hit = ray.intersectObjects(targets, false).length > 0;
          ray.far = 70;
          return !hit;
        };
        if (!enclosed(pos) && viewClear(pos)) return { moved: 0, pos };

        // Retreat along the view axis, which preserves the framing intent.
        const dx = pos[0] - look[0], dy = pos[1] - look[1], dz = pos[2] - look[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        const ux = dx / len, uy = dy / len, uz = dz / len;
        for (let d = 10; d <= maxBack; d += 10) {
          const p = [pos[0] + ux * d, pos[1] + uy * d, pos[2] + uz * d];
          if (!enclosed(p) && viewClear(p) && backClear(p)) {
            console.warn(`[capture] shot was inside or against geometry; backed off ${d}m`);
            return { moved: d, pos: p };
          }
        }
        for (let up = 20; up <= 400; up += 20) {
          const p = [pos[0], pos[1] + up, pos[2]];
          if (!enclosed(p) && viewClear(p) && backClear(p)) {
            console.warn(`[capture] shot was inside or against geometry; raised ${up}m`);
            return { moved: up, pos: p };
          }
        }
        return { moved: 0, pos };
      },

      setCamera: (pos, look, fov) => {
        for (const s of engine.order) {
          // Note: no `'enabled' in s` test. A driver that hasn't declared the flag
          // yet (Player currently reports `undefined`) still gets it set, so it
          // opts in the moment it starts honouring it.
          if (CAMERA_DRIVERS.has(s.constructor.id)) {
            // Only record the ORIGINAL value. Two setCamera calls without an
            // intervening release would otherwise save the already-false value
            // and latch the controller off permanently after release.
            if (!('userData_wasEnabled' in s)) s.userData_wasEnabled = s.enabled;
            s.enabled = false;
          }
        }
        const cam = engine.camera;
        cam.position.set(pos[0], pos[1], pos[2]);
        cam.lookAt(_lookTmp.set(look[0], look[1], look[2]));
        if (fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
        camLock.pos.copy(cam.position);
        camLock.quat.copy(cam.quaternion);
        camLock.fov = fov || cam.fov;
        camLock.active = true;
      },
      releaseCamera: () => {
        camLock.active = false;
        for (const s of engine.order) {
          if (CAMERA_DRIVERS.has(s.constructor.id) && 'userData_wasEnabled' in s) {
            s.enabled = s.userData_wasEnabled;
            delete s.userData_wasEnabled;
          }
        }
        const rig = engine.systems.get('cameraRig');
        if (rig?.pos) rig.pos.copy(engine.camera.position);
      },
      /** True if a shot is currently holding the camera. */
      cameraLocked: () => camLock.active,
      /**
       * Set up a named (or ad-hoc) shot and render it deterministically.
       * Returns the perf numbers so the critic can enforce the frame budget.
       */
      capture: async ({ shot, pos, look, tod, fov, weather, quality, warmup = 24 } = {}) => {
        const s = shot ? this.shots[shot] : null;
        if (shot && !s) throw new Error(`unknown shot "${shot}"`);
        api.freeze(true);
        if (quality) api.setQuality(quality);
        const w = weather ?? s?.weather ?? 'clear';
        api.setWeather(w);
        api.setTime(tod ?? s?.tod ?? 12);
        const rawPos = (pos ?? s.pos).slice();
        const rawLook = (look ?? s.look).slice();
        const eye = (pos ? null : s.eye);
        const groundedPos = api.groundedY(rawPos[0], rawPos[1], rawPos[2], eye);
        // Shift the aim point by the same amount the camera rose, so a grounded
        // street shot still looks level instead of straight into a hillside.
        rawLook[1] += groundedPos - rawPos[1];
        rawPos[1] = groundedPos;
        const freed = api.unstick(rawPos, rawLook);
        api.setCamera(freed.pos, rawLook, fov ?? s.fov);
        // A capture into a degenerate drawing buffer is not a dark shot, it is no
        // shot at all -- readPixels comes back empty and every measurement taken
        // from it is fiction. Engine.resize() now floors the size, so re-asserting
        // it here recovers a pane that collapsed after boot without firing a
        // resize event.
        const gl0 = engine.renderer.getContext();
        if (gl0.drawingBufferWidth < 2 || gl0.drawingBufferHeight < 2) {
          console.warn('[capture] drawing buffer was '
            + `${gl0.drawingBufferWidth}x${gl0.drawingBufferHeight}; forcing a resize.`);
          engine.resize();
        }
        // Let the actors run through warm-up so traffic and crowds reach sensible
        // positions, then freeze them again below for the frame we hand back.
        api.pauseActors(false);
        // Warm up: lets IBL, LOD and temporal effects settle.
        api.step(warmup);
        // Then wait for streaming to ACTUALLY finish rather than assuming a frame
        // count covers it. setCamera above is a teleport, which invalidates every
        // near chunk; Buildings widens its build budget for CATCHUP_FRAMES (45)
        // afterwards, against the 30 frames this function used to advance. Every
        // capture therefore rendered before the detailed chunks existed, and most
        // buildings in every shot were the crude LOD-2 shell — flat and pale
        // beside fully facaded neighbours. That corrupted a whole critic pass.
        // Counting frames here is what drifted; asking cannot.
        let guard = 0;
        while (!api.settled() && guard < 600) { api.step(4); guard += 4; }
        const streamed = guard;
        await settle(60);
        // Re-assert the freeze. capture() froze time on entry, but Menu's unpause
        // path (`Menu.js:661`) restores timeScale from its own saved value whenever
        // it closes, and anything that reopens the menu between then and here puts
        // the clock back to 40 game-seconds per real-second. A caller that then
        // benches or reads pixels is measuring a moving sun: that is the entire
        // source of the ~18% luminance drift between captures minutes apart which
        // a critic pass previously wrote off as unavoidable auto-exposure noise.
        api.freeze(true);
        const stats = api.step(6);
        if (!api.settled()) {
          console.warn(`[capture] streaming did not settle in ${guard} frames; `
            + 'the shot may contain LOD-2 shell where detail was expected.');
        }
        return { shot: shot || 'custom', weather: w, streamed,
                 timeScale: engine.settings.timeScale,
                 tod: +engine.settings.timeOfDay.toFixed(2), ...stats };
      },
      /**
       * Measure REAL frame rate from the natural rAF loop.
       *
       * Read this before trusting any fps number: a backgrounded tab throttles
       * requestAnimationFrame to zero, and `step()` drives frames synchronously,
       * so neither reflects real performance. Only a fronted, visible tab does.
       * `hidden: true` in the result means the number is meaningless — front the
       * tab (mcp__Claude_Browser__tabs_select) and measure again.
       */
      measureFps: async (seconds = 2) => {
        // `document.hidden` is NOT sufficient. When the Browser pane is collapsed
        // rather than backgrounded, document.hidden stays FALSE while rAF still
        // delivers zero frames -- so the old guard passed and returned a garbage
        // number. Measure actual frame delivery and judge on that.
        if (document.hidden) {
          return { hidden: true, fps: null,
            warning: 'Tab is backgrounded — rAF is throttled to zero. Front the tab first; this number would be meaningless.' };
        }
        const f0 = engine.time.frame, t0 = performance.now();
        await settle(seconds * 1000);
        const frames = engine.time.frame - f0;
        const elapsed = (performance.now() - t0) / 1000;
        if (frames < 2) {
          return { hidden: false, notCompositing: true, fps: null, frames,
            warning: `rAF delivered ${frames} frames in ${elapsed.toFixed(1)}s despite document.hidden===false. `
              + 'The Browser pane is almost certainly collapsed or not compositing. '
              + 'Display the pane and measure again; any number from here would be meaningless.' };
        }
        return {
          hidden: false,
          fps: +(frames / elapsed).toFixed(1),
          frames,
          draws: engine.perf.drawCalls,
          tris: engine.perf.tris,
          resolution: [engine.renderer.domElement.width, engine.renderer.domElement.height],
          preset: engine.settings.preset,
        };
      },
      /**
       * True when every system that streams geometry reports it has caught up.
       *
       * Systems opt in by implementing `settled()`. A system without one is
       * treated as always ready, so this degrades to the old behaviour rather
       * than hanging on a system that never answers.
       */
      settled: () => {
        for (const sys of engine.systems.values()) {
          if (typeof sys.settled === 'function' && !sys.settled()) return false;
        }
        return true;
      },
      shotNames: () => Object.keys(this.shots),
      stats: () => ({
        fps: +engine.perf.fps.toFixed(1), ms: +engine.perf.ms.toFixed(2),
        draws: engine.perf.drawCalls, tris: engine.perf.tris,
        geometries: engine.renderer.info.memory.geometries,
        textures: engine.renderer.info.memory.textures,
        programs: engine.renderer.info.programs?.length ?? 0,
      }),
      errors: [],
      glFaults: [],
    };

    window.__boston = api;
    this.api = api;

    // Collect runtime errors so the critic can fail a shot that logged one.
    const origErr = console.error;
    console.error = (...a) => { api.errors.push(a.map(String).join(' ')); origErr(...a); };

    // GL driver faults arrive as console.warn, NOT console.error. A sampler-unit
    // collision that rejected every building draw call hid behind this for an
    // entire session because nothing was watching warnings.
    const origWarn = console.warn;
    const GL_FAULT = /GL_INVALID|INVALID_OPERATION|INVALID_VALUE|INVALID_ENUM|Framebuffer is incomplete|program not valid|feedback loop|not renderable/i;
    console.warn = (...a) => {
      const msg = a.map(String).join(' ');
      if (GL_FAULT.test(msg)) api.glFaults.push(msg.slice(0, 300));
      origWarn(...a);
    };
  }
  dispose() { delete window.__boston; }
}
