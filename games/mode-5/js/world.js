/* =====================================================================
   world.js — the 3D look of Mode 5: arena, paint floor, lights, camera.

   Art & UI owns this file. It never changes game rules: it only READS the
   paint grid and the arena data that Gameplay provides, and draws them.

   Usage (from main.js / match.js):
     const world = new TP.M5.World(scene, arena, grid);
     world.useRenderer(renderer);       // optional: glossy reflections
     ...every frame...
     world.frame(cars, dt);             // camera follows all cars
     world.update(dt);                  // paint texture, pulses, animations
     renderer.render(scene, world.camera);

   What it reads (read-only):
     arena = { size, obstacles:[{x,z,w,d,h}], ramps:[{x,z,w,d,h,dir}], pads:[{x,z,heading}] }
       size      world width of the square floor (e.g. 96), centred on 0,0
       obstacle  solid box: centre x,z, footprint w (along x) × d (along z), height h
       ramp      wedge: centre x,z, w = width across, d = length along the slope,
                 h = height at the high end, dir = heading the ramp RISES toward
                 (same angle convention as car.heading: forward = (sin, cos))
       pad       spawn pad for player i (index in the array = player index)
     grid  = { n, owner:Uint8Array, wet:Uint8Array, blocked?:Uint8Array, dirty }
       n         cells per side; cell (i, j) is index j*n + i; i runs along +x, j along +z
       owner     0 = unpainted, 1..4 = player index + 1
       wet       non-zero = that cell is part of a wet (unfinished) trail
       dirty     set true by Gameplay whenever cells change; we clear it after drawing
               (optional dirtyMin / dirtyMax = changed row range, if provided)

   How the paint floor works (the important trick):
     The floor is ONE big plane. Its colour comes from a tiny 72×72 texture
     (a DataTexture) where each pixel is one paint cell. We write the cell
     colours into that texture on the CPU and upload it (~20 KB) only when
     something changed or an animation is playing. A small shader tweak on a
     normal lit material then:
       • tints the glossy floor with the paint colour,
       • makes the paint GLOW (emissive), with a little bevel on each tile so
         the floor reads like a grid of LED tiles,
       • makes wet-trail cells pulse brighter with a ripple moving through them.
     Pulsing is done entirely in the shader (a time uniform), so a wet trail
     animates without re-uploading the texture every frame.
   ===================================================================== */
(function () {
  "use strict";
  TP.M5 = TP.M5 || {};

  /* ---------- Look settings (art only, no gameplay meaning) ---------- */
  const LOOK = {
    sky: 0x04050d,          // background + fog colour
    floor: 0x0b0e1c,        // unpainted floor base colour
    wall: 0x7dd3fc,         // perimeter light-wall colour (cool cyan)
    wallH: 2.6,             // light-wall height
    glow: 1.0,              // overall paint glow strength
    dryAlpha: 150,          // texture alpha byte for dry paint (glow level)
    wetAlpha: 255,          // texture alpha byte for wet trails (shader pulses these)
    fillSweep: 0.4,         // seconds for a fill wave to sweep across its area
    flashTime: 0.35,        // seconds a freshly revealed cell flashes white-hot
  };

  /* Each arena has its own mood so the rotation feels fresh: sky/fog
     colour, light-wall and edge accents, floor tint, grout and apron grid. */
  const MOODS = {
    plaza: { sky: 0x04050d, wall: 0x7dd3fc, line: 0xc9f1ff, edge: 0x9be7ff, hemi: 0x8fa8ff, floor: 0x0b0e1c,
             grout: [0.05, 0.07, 0.12], grid: "rgba(90,120,255,0.18)" },
    split: { sky: 0x0a0414, wall: 0xc084fc, line: 0xf0d4ff, edge: 0xe879f9, hemi: 0xc8a0ff, floor: 0x120b20,
             grout: [0.10, 0.05, 0.13], grid: "rgba(200,90,255,0.18)" },
    rings: { sky: 0x020b0d, wall: 0x5eead4, line: 0xccfff5, edge: 0x67e8f9, hemi: 0x8ffff0, floor: 0x071417,
             grout: [0.04, 0.10, 0.10], grid: "rgba(60,220,200,0.16)" },
  };
  TP.M5.MOODS = MOODS;

  // Brighter, more saturated "neon" versions of the four shared player colours.
  // (Index = player index.) Kept close to TP.PLAYER_COLORS so players recognise them.
  const NEON = [0x3d8bff, 0xff7a1f, 0x2ee86a, 0xff4fb0];
  TP.M5.NEON = NEON;
  TP.M5.NEON_CSS = NEON.map((c) => "#" + c.toString(16).padStart(6, "0"));

  // Player index from an event field that might be a number or a player object.
  TP.M5.pi = (p) => (typeof p === "number" ? p : p && typeof p.index === "number" ? p.index : 0);

  /* ---------- A small canvas texture helper (gradients, glows) ---------- */
  function canvasTex(w, h, draw) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // Soft round glow (white centre fading to clear) — reused for car underglow,
  // light-tower flares and pickup halos. Tint it with the material colour.
  let glowTexCache = null;
  function glowTex() {
    if (!glowTexCache) {
      glowTexCache = canvasTex(128, 128, (g, w, h) => {
        const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        grd.addColorStop(0, "rgba(255,255,255,1)");
        grd.addColorStop(0.35, "rgba(255,255,255,0.45)");
        grd.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grd;
        g.fillRect(0, 0, w, h);
      });
    }
    return glowTexCache;
  }
  TP.M5.glowTex = glowTex;

  /* =====================================================================
     World
     ===================================================================== */
  class World {
    constructor(scene, arena, grid, camera) {
      this.scene = scene;
      this.arena = arena;
      this.grid = grid;
      this.size = arena.size || 96;
      this.mood = MOODS[arena.id] || MOODS.plaza;
      this.circle = arena.shape === "circle";
      this.radius = arena.radius || this.size / 2;
      this.n = grid.N || grid.n || 72;
      this.cell = this.size / this.n;    // world units per cell
      this.time = 0;
      this.group = new THREE.Group();    // everything we add lives here (easy dispose)
      scene.add(this.group);

      scene.background = new THREE.Color(this.mood.sky);
      // Low fog: the far edge of the arena and the city fade into the night.
      scene.fog = new THREE.Fog(this.mood.sky, this.size * 0.9, this.size * 2.6);

      this.buildLights();
      this.buildFloor();
      this.buildWalls();
      this.buildObstacles();
      this.buildDecks();
      this.buildRamps();
      this.buildPads();
      this.buildSurroundings();

      /* ---------- Camera ---------- */
      // A camera can be handed in so it survives an arena change.
      this.camera = camera || new THREE.PerspectiveCamera(42, 1, 0.5, this.size * 6);
      this.camera.fov = 42;
      this.camera.far = this.size * 6;
      this.camTarget = new THREE.Vector3(0, 0, 0);  // smoothed look-at point
      this.camDist = this.size * 1.0;               // smoothed distance from target
      this.camPitch = 0.98;                         // radians down from horizontal (~56°)
      this.camMode = "follow";                      // "follow" | "overview"
      this.shakeAmt = 0;
      this.aspect = 16 / 9;
      this.placeCamera(true);
    }

    /* ---------------------------------------------------------------
       Lights: dim cool sky light, one shadow-casting key light, and four
       coloured rim lights (one per player colour) at the corners, so every
       car picks up a hint of neon on its sides.
       --------------------------------------------------------------- */
    buildLights() {
      const S = this.size;
      this.group.add(new THREE.HemisphereLight(this.mood.hemi, 0x0a0a18, 0.55));

      const key = new THREE.DirectionalLight(0xdfe8ff, 1.15);
      key.position.set(S * 0.25, S * 0.9, S * 0.45);
      // No real-time shadows: from the overhead camera each car's underglow
      // and floor ring already ground it, and shadows were one of the
      // biggest per-frame costs on weak GPUs.
      key.castShadow = false;
      key.shadow.mapSize.set(1024, 1024);   // plenty for blocky cars; much cheaper
      const s = S * 0.62;
      Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: S * 3 });
      key.shadow.bias = -0.0006;
      this.group.add(key);
      this.group.add(key.target);

      // Corner colour: instead of four real point lights (expensive on
      // phones: every lit pixel pays for each one) each corner gets a soft
      // glow painted onto the floor in that player's colour. Looks the same
      // from the overhead camera for a fraction of the cost.
      this.rims = [];
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      corners.forEach(([cx, cz], i) => {
        const pool = new THREE.Mesh(new THREE.PlaneGeometry(S * 0.55, S * 0.55), new THREE.MeshBasicMaterial({
          map: glowTex(), color: NEON[i], transparent: true, opacity: 0.32,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        pool.rotation.x = -Math.PI / 2;
        // Round arenas: pull the pools in so they stay on the floor.
        const k = this.circle ? this.radius * 0.6 : S * 0.5;
        pool.position.set(cx * k, 0.03, cz * k);
        this.group.add(pool);
        this.rims.push(pool);
      });
    }

    /* ---------------------------------------------------------------
       The paint floor (see the big comment at the top of the file).
       --------------------------------------------------------------- */
    buildFloor() {
      const n = this.n;
      // RGBA bytes, one pixel per cell. Alpha = glow level: 0 empty, dry, wet.
      this.texData = new Uint8Array(n * n * 4);
      this.paintTex = new THREE.DataTexture(this.texData, n, n, THREE.RGBAFormat);
      this.paintTex.magFilter = THREE.NearestFilter;  // crisp tile edges
      this.paintTex.minFilter = THREE.NearestFilter;
      this.paintTex.colorSpace = THREE.SRGBColorSpace;
      this.paintTex.needsUpdate = true;

      // What is currently ON SCREEN per cell. Usually the same as grid.owner,
      // but during a fill sweep some cells are held back until the wave reaches them.
      this.shown = new Uint8Array(n * n);
      this.revealAt = new Float32Array(n * n);   // game time when a pending cell appears
      this.pendingOwner = new Uint8Array(n * n); // what it becomes when revealed
      this.flashAt = new Float32Array(n * n).fill(-99); // time a cell last changed (for flash)
      this.flashK = new Float32Array(n * n);     // how strong that flash is (0..1)
      this.animUntil = 0;                        // keep re-uploading until this time
      this.fillQueue = [];                       // fills announced by events, waiting for the grid to change

      // Pre-computed RGB bytes per owner (0 = unpainted → black, the shader ignores it).
      this.ownerRGB = [[0, 0, 0]].concat(NEON.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]));

      const uniforms = {
        paintMap: { value: this.paintTex },
        uTime: { value: 0 },
        uGridN: { value: n },
        uGlow: { value: LOOK.glow },
        uSize: { value: this.size },
        uRadius: { value: this.circle ? this.radius : 0 },   // 0 = square arena
        uGrout: { value: new THREE.Vector3(...this.mood.grout) },
      };
      this.floorUniforms = uniforms;

      const mat = new THREE.MeshStandardMaterial({ color: this.mood.floor, roughness: 0.3, metalness: 0.35 });
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        // Pass the plane's UV through to the fragment shader ourselves (the
        // standard material only does this when it has its own map).
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec2 vPaintUv;")
          .replace("#include <uv_vertex>", "#include <uv_vertex>\nvPaintUv = uv;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>
            varying vec2 vPaintUv;
            uniform sampler2D paintMap;
            uniform float uTime, uGridN, uGlow, uSize, uRadius;
            uniform vec3 uGrout;
            vec4 m5Paint; float m5Painted; float m5Wet; float m5Tile; float m5Edge;`)
          // 1) Base colour: tint the floor with the paint, draw faint grout lines on bare floor.
          .replace("#include <color_fragment>", `#include <color_fragment>
            m5Paint = texture2D(paintMap, vPaintUv);
            // Round arenas: outside the wall is not floor (no paint, no tiles).
            vec2 m5w = vec2(vPaintUv.x - 0.5, 0.5 - vPaintUv.y) * uSize;
            float m5In = uRadius > 0.0 ? step(length(m5w), uRadius) : 1.0;
            m5Painted = step(0.02, m5Paint.a) * m5In;
            m5Wet = step(0.9, m5Paint.a) * m5In;
            vec2 m5f = fract(vPaintUv * uGridN);
            m5Edge = min(min(m5f.x, 1.0 - m5f.x), min(m5f.y, 1.0 - m5f.y)); // 0 at tile edge, .5 centre
            m5Tile = smoothstep(0.0, 0.14, m5Edge);                         // bevel: dark rim per tile
            diffuseColor.rgb = mix(diffuseColor.rgb, m5Paint.rgb * (0.30 - 0.18 * m5Wet), m5Painted);
            float m5Grout = 1.0 - smoothstep(0.0, 0.035, m5Edge);
            diffuseColor.rgb += uGrout * m5Grout * (1.0 - m5Painted) * m5In;
            diffuseColor.rgb *= mix(0.25, 1.0, m5In);`)
          // 2) Glow: painted tiles emit their colour; wet trails pulse with a moving ripple.
          .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
            float m5Level = m5Paint.a * (0.55 + 0.45 * m5Tile);
            // DRY turf: steady glow.
            totalEmissiveRadiance += m5Paint.rgb * m5Painted * (1.0 - m5Wet) * uGlow * m5Level * 0.9;
            // WET trail ("danger, unfinished"): diagonal hazard stripes that
            // slide along, a fast throb, and a white-hot outline where the
            // trail meets anything that isn't trail. Neighbour cells are
            // looked up in the paint texture to find those outline edges.
            if (m5Wet > 0.5) {
              float m5Throb = 0.6 + 0.4 * sin(uTime * 9.0);
              float m5Stripe = step(0.5, fract((vPaintUv.x + vPaintUv.y) * uGridN * 0.5 - uTime * 1.4));
              float tx = 1.0 / uGridN;
              float wL = step(0.9, texture2D(paintMap, vPaintUv + vec2(-tx, 0.0)).a);
              float wR = step(0.9, texture2D(paintMap, vPaintUv + vec2(tx, 0.0)).a);
              float wD = step(0.9, texture2D(paintMap, vPaintUv + vec2(0.0, -tx)).a);
              float wU = step(0.9, texture2D(paintMap, vPaintUv + vec2(0.0, tx)).a);
              float e = 0.22;
              float m5Out = max(max((1.0 - wL) * (1.0 - smoothstep(0.0, e, m5f.x)), (1.0 - wR) * (1.0 - smoothstep(0.0, e, 1.0 - m5f.x))),
                                max((1.0 - wD) * (1.0 - smoothstep(0.0, e, m5f.y)), (1.0 - wU) * (1.0 - smoothstep(0.0, e, 1.0 - m5f.y))));
              vec3 m5Hot = mix(m5Paint.rgb, vec3(1.0), 0.45);
              totalEmissiveRadiance += uGlow * (m5Paint.rgb * (0.25 + 1.1 * m5Stripe * m5Throb) + m5Hot * m5Out * 1.6 * m5Throb);
            }`);
      };

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(this.size, this.size), mat);
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.floor = floor;
      this.group.add(floor);

      this.uploadAll();
    }

    /* Write texture pixels for rows [j0, j1] (grid rows). Grid row j is
       drawn at texture row n-1-j because the plane's v axis runs toward -z. */
    writeRows(j0, j1) {
      const n = this.n, d = this.texData, g = this.grid, t = this.time;
      const owner = g.owner || g.cells, wet = g.wet || g.trail;
      for (let j = j0; j <= j1; j++) {
        const row = (n - 1 - j) * n;
        for (let i = 0; i < n; i++) {
          const k = j * n + i;

          // Held back by a fill sweep? Reveal once the wave reaches this cell.
          if (this.revealAt[k] > 0) {
            if (t >= this.revealAt[k]) {
              this.revealAt[k] = 0;
              this.shown[k] = this.pendingOwner[k];
              this.flashAt[k] = t; this.flashK[k] = 1;
            }
          } else if (this.shown[k] !== owner[k]) {
            // Ordinary paint change (driving, splats, pops): small flash.
            this.shown[k] = owner[k];
            this.flashAt[k] = t; this.flashK[k] = 0.55;
          }

          const o = this.shown[k];
          const p = (row + i) * 4;
          if (!o) { d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0; continue; }
          const rgb = this.ownerRGB[o] || this.ownerRGB[1];
          // Flash: fade from near-white back to the paint colour.
          const age = t - this.flashAt[k];
          const f = age < LOOK.flashTime ? this.flashK[k] * (1 - age / LOOK.flashTime) : 0;
          d[p] = rgb[0] + (255 - rgb[0]) * f * 0.8;
          d[p + 1] = rgb[1] + (255 - rgb[1]) * f * 0.8;
          d[p + 2] = rgb[2] + (255 - rgb[2]) * f * 0.8;
          // The cell only counts as wet if the wet cell is still the colour on screen.
          const isWet = wet && wet[k] && this.shown[k] === owner[k];
          d[p + 3] = isWet ? LOOK.wetAlpha : LOOK.dryAlpha;
        }
      }
      this.paintTex.needsUpdate = true;
    }

    uploadAll() { this.writeRows(0, this.n - 1); }

    /* ---------------------------------------------------------------
       Fill reveal. Call when a fill happens (vfx/events do this for you:
       the World listens to the "fill" event itself). `cells` is an optional
       list of the filled cell indices; without it we take every cell that
       changes to that player's colour on the next grid update.
       --------------------------------------------------------------- */
    queueFill(player, cx, cz, cells) {
      const fill = { owner: TP.M5.pi(player) + 1, cx: cx || 0, cz: cz || 0, cells: cells || null };
      if (fill.cells) this.startSweep(fill, fill.cells);
      else this.fillQueue.push(fill);
    }

    // Hold each cell back by a delay proportional to its distance from the
    // fill's centre, so the colour floods outward like a wave.
    startSweep(fill, cells) {
      if (!cells.length) return;
      const n = this.n, half = this.size / 2;
      let maxD = 1;
      const dist = new Float32Array(cells.length);
      cells.forEach((k, idx) => {
        const x = -half + ((k % n) + 0.5) * this.cell, z = -half + (Math.floor(k / n) + 0.5) * this.cell;
        dist[idx] = Math.hypot(x - fill.cx, z - fill.cz);
        if (dist[idx] > maxD) maxD = dist[idx];
      });
      cells.forEach((k, idx) => {
        this.pendingOwner[k] = fill.owner;
        this.revealAt[k] = this.time + 0.0001 + (dist[idx] / maxD) * LOOK.fillSweep;
      });
      this.animUntil = Math.max(this.animUntil, this.time + LOOK.fillSweep + LOOK.flashTime + 0.05);
    }

    /* ---------------------------------------------------------------
       Perimeter: a dark curb plus a glowing translucent light wall that
       fades upward, with a bright top line. Additive blending so it glows.
       --------------------------------------------------------------- */
    buildWalls() {
      const S = this.size, H = LOOK.wallH;
      const fade = canvasTex(4, 64, (g, w, h) => {
        const grd = g.createLinearGradient(0, h, 0, 0);
        grd.addColorStop(0, "rgba(255,255,255,0.95)");
        grd.addColorStop(0.25, "rgba(255,255,255,0.35)");
        grd.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
      });
      const wallMat = new THREE.MeshBasicMaterial({
        color: this.mood.wall, map: fade, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const curbMat = new THREE.MeshStandardMaterial({ color: 0x151a33, roughness: 0.6, metalness: 0.3 });
      const lineMat = new THREE.MeshBasicMaterial({ color: this.mood.line });
      this.wallMat = wallMat;

      if (this.circle) {
        // Round arena: one cylinder of light, a round curb and a bright rim line.
        const R = this.radius;
        const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 128, 1, true), wallMat);
        wall.position.y = H / 2;
        this.group.add(wall);
        const curb = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.6, R + 0.6, 0.5, 128, 1, true), curbMat);
        curb.position.y = 0.25;
        this.group.add(curb);
        const line = new THREE.Mesh(new THREE.TorusGeometry(R + 0.05, 0.06, 6, 160), lineMat);
        line.rotation.x = Math.PI / 2;
        line.position.y = 0.52;
        this.group.add(line);
      }
      for (let side = 0; side < (this.circle ? 0 : 4); side++) {
        const g = new THREE.Group();
        g.rotation.y = (side * Math.PI) / 2;
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(S, H), wallMat);
        wall.position.set(0, H / 2, S / 2);
        g.add(wall);
        const curb = new THREE.Mesh(new THREE.BoxGeometry(S + 1.2, 0.5, 0.6), curbMat);
        curb.position.set(0, 0.25, S / 2 + 0.3);
        curb.receiveShadow = true;
        g.add(curb);
        const line = new THREE.Mesh(new THREE.BoxGeometry(S + 1.2, 0.08, 0.08), lineMat);
        line.position.set(0, 0.52, S / 2 + 0.05);
        g.add(line);
        this.group.add(g);
      }

      // Corner posts with a glow flare on top, in player colours (they match
      // the rim lights, so each corner "belongs" to a colour).
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([cx, cz], i) => {
        const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.5, 1.2), curbMat);
        // On a round arena the posts stand on the wall at the four diagonals.
        const k = this.circle ? (this.radius + 0.8) / Math.SQRT2 : S / 2 + 0.6;
        post.position.set(cx * k, 2.25, cz * k);
        this.group.add(post);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.35, 1.3), new THREE.MeshBasicMaterial({ color: NEON[i] }));
        cap.position.set(post.position.x, 4.6, post.position.z);
        this.group.add(cap);
        const flare = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex(), color: NEON[i], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
        }));
        flare.position.copy(cap.position);
        flare.scale.setScalar(7);
        this.group.add(flare);
      });
    }

    /* ---------------------------------------------------------------
       Obstacles (pillars / blocks): dark glossy boxes with a glowing top
       edge and a thin light band near the base, so they read at night.
       --------------------------------------------------------------- */
    buildObstacles() {
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x232b55, roughness: 0.35, metalness: 0.4, emissive: 0x0b1030 });
      const edgeMat = new THREE.LineBasicMaterial({ color: this.mood.edge });
      const bandMat = new THREE.MeshBasicMaterial({ color: this.mood.edge });
      const capMat = new THREE.MeshBasicMaterial({ color: 0x5fd4ff, transparent: true, opacity: 0.85 });
      for (const o of this.arena.obstacles || []) {
        const h = o.h || 4;
        const box = new THREE.Mesh(new THREE.BoxGeometry(o.w, h, o.d), bodyMat);
        box.position.set(o.x, h / 2, o.z);
        box.castShadow = true;
        box.receiveShadow = true;
        this.group.add(box);
        // Bright outline of the box edges.
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), edgeMat);
        edges.position.copy(box.position);
        this.group.add(edges);
        // A glowing cap on top so it reads from the overhead camera.
        const cap = new THREE.Mesh(new THREE.BoxGeometry(o.w * 0.8, 0.12, o.d * 0.8), capMat);
        cap.position.set(o.x, h + 0.06, o.z);
        this.group.add(cap);
        // A glowing band a little above the floor.
        const band = new THREE.Mesh(new THREE.BoxGeometry(o.w + 0.06, 0.18, o.d + 0.06), bandMat);
        band.position.set(o.x, 0.6, o.z);
        this.group.add(band);
      }
      // Round pillars: a dark column with glowing rings near the base and top
      // and a glowing disc on top (it's what you see from the camera).
      for (const p of this.arena.pillars || []) {
        const h = p.h || 8;
        const col = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 1.04, h, 40), bodyMat);
        col.position.set(p.x, h / 2, p.z);
        col.castShadow = true;
        col.receiveShadow = true;
        this.group.add(col);
        for (const y of [0.6, h - 0.5]) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(p.r * 1.03, 0.1, 6, 48), bandMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.set(p.x, y, p.z);
          this.group.add(ring);
        }
        const top = new THREE.Mesh(new THREE.CircleGeometry(p.r * 0.8, 40), capMat);
        top.rotation.x = -Math.PI / 2;
        top.position.set(p.x, h + 0.02, p.z);
        this.group.add(top);
      }
    }

    /* ---------------------------------------------------------------
       Decks: raised flat platforms you can paint on. The sides are a dark
       block with glowing edges and a light band; the TOP is a plane using
       the very same paint material as the floor, with its UVs set to the
       floor coordinates underneath, so deck cells show their paint (and
       wet stripes, flashes, sweeps) at deck height.
       --------------------------------------------------------------- */
    buildDecks() {
      const decks = this.arena.decks || [];
      if (!decks.length) return;
      const half = this.size / 2;
      const sideMat = new THREE.MeshStandardMaterial({ color: 0x1a1f3d, roughness: 0.45, metalness: 0.35, emissive: 0x070a1c });
      const edgeMat = new THREE.LineBasicMaterial({ color: this.mood.edge });
      const bandMat = new THREE.MeshBasicMaterial({ color: this.mood.edge, transparent: true, opacity: 0.7 });
      for (const d of decks) {
        const block = new THREE.Mesh(new THREE.BoxGeometry(d.w, d.h, d.d), sideMat);
        block.position.set(d.x, d.h / 2 - 0.01, d.z);
        this.group.add(block);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(block.geometry), edgeMat);
        edges.position.copy(block.position);
        this.group.add(edges);
        // Light band around the sides, a third of the way up.
        const band = new THREE.Mesh(new THREE.BoxGeometry(d.w + 0.05, 0.16, d.d + 0.05), bandMat);
        band.position.set(d.x, d.h * 0.35, d.z);
        this.group.add(band);

        const geo = new THREE.PlaneGeometry(d.w, d.d, 1, 1);
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        for (let k = 0; k < pos.count; k++) {
          // Plane is laid flat with rotation.x = -90°, so local y becomes world -z.
          const wx = d.x + pos.getX(k), wz = d.z - pos.getY(k);
          uv.setXY(k, (wx + half) / this.size, (half - wz) / this.size);
        }
        const top = new THREE.Mesh(geo, this.floor.material);
        top.rotation.x = -Math.PI / 2;
        top.position.set(d.x, d.h + 0.02, d.z);
        this.group.add(top);
      }
    }

    /* ---------------------------------------------------------------
       Ramps: wedges built from a box whose low-end top vertices are pushed
       down to the floor. Chevron arrows glow on the slope, pointing uphill.
       --------------------------------------------------------------- */
    buildRamps() {
      const chevron = canvasTex(64, 128, (g, w, h) => {
        g.fillStyle = "#12172e"; g.fillRect(0, 0, w, h);
        g.strokeStyle = "#ffd23f"; g.lineWidth = 7; g.lineCap = "round";
        for (let k = 0; k < 3; k++) {
          const y = 20 + k * 40;
          g.beginPath(); g.moveTo(10, y + 18); g.lineTo(w / 2, y); g.lineTo(w - 10, y + 18); g.stroke();
        }
      });
      chevron.wrapS = chevron.wrapT = THREE.RepeatWrapping;
      const sideMat = new THREE.MeshStandardMaterial({ color: 0x161b36, roughness: 0.5, metalness: 0.4 });
      for (const r of this.arena.ramps || []) {
        const geo = new THREE.BoxGeometry(r.w, r.h, r.d);
        // Box is centred; move it so its bottom sits on y=0, then flatten the
        // top vertices at the low end (−z) down to the floor.
        const pos = geo.attributes.position;
        for (let v = 0; v < pos.count; v++) {
          let y = pos.getY(v) + r.h / 2;
          if (y > 0.001 && pos.getZ(v) < 0) y = 0.02;
          pos.setY(v, y);
        }
        geo.computeVertexNormals();
        const top = chevron.clone();
        top.needsUpdate = true;
        top.repeat.set(1, Math.max(1, Math.round(r.d / 4)));
        const topMat = new THREE.MeshStandardMaterial({
          map: top, emissiveMap: top, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.5,
        });
        // BoxGeometry face order: +x, −x, +y (top/slope), −y, +z, −z.
        const mesh = new THREE.Mesh(geo, [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
        mesh.position.set(r.x, 0, r.z);
        mesh.rotation.y = r.dir || 0;  // local +z points uphill → heading `dir`
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: 0xffd23f }));
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        this.group.add(edges);
      }
    }

    /* Spawn pads: a glowing ring in the owner's colour that slowly turns. */
    buildPads() {
      this.padRings = [];
      (this.arena.pads || []).forEach((p, i) => {
        const g = new THREE.Group();
        g.position.set(p.x, (p.y || 0) + 0.04, p.z);
        const ring = new THREE.Mesh(new THREE.RingGeometry(2.7, 3.0, 40),
          new THREE.MeshBasicMaterial({ color: NEON[i % 4], transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        g.add(ring);
        // Four little ticks around the ring, so its rotation is visible.
        const tickMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        for (let k = 0; k < 4; k++) {
          const tick = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.04, 0.7), tickMat);
          const a = (k * Math.PI) / 2;
          tick.position.set(Math.sin(a) * 3.35, 0, Math.cos(a) * 3.35);
          tick.rotation.y = a;
          g.add(tick);
        }
        this.group.add(g);
        this.padRings.push(g);
      });
    }

    /* ---------------------------------------------------------------
       Outside the arena: a dark apron with a faint grid, a ring of city
       blocks with lit windows, light towers and a starry sky. Purely
       scenery; it fades into the fog.
       --------------------------------------------------------------- */
    buildSurroundings() {
      const S = this.size;
      const apronTex = canvasTex(64, 64, (g, w, h) => {
        g.fillStyle = "#06070f"; g.fillRect(0, 0, w, h);
        g.strokeStyle = this.mood.grid; g.lineWidth = 2;
        g.strokeRect(0, 0, w, h);
      });
      apronTex.wrapS = apronTex.wrapT = THREE.RepeatWrapping;
      apronTex.repeat.set(S * 4 / 8, S * 4 / 8);
      // Scenery is UNLIT (basic materials, no shadows): it covers a lot of
      // the screen, and lighting it costs a lot on phones for no visible gain.
      // Built as a square FRAME around the arena (four strips), not one big
      // plane under it, so no pixel is drawn twice under the paint floor.
      const apron = new THREE.Group();
      const W = S * 4, inner = S + 1.2, strip = (W - inner) / 2;
      for (const [w, d, x, z] of [[W, strip, 0, -(inner + strip) / 2], [W, strip, 0, (inner + strip) / 2],
                                  [strip, inner, -(inner + strip) / 2, 0], [strip, inner, (inner + strip) / 2, 0]]) {
        // Each strip repeats the grid tile once per 8 units, like one big plane would.
        const tex = apronTex.clone();
        tex.repeat.set(w / 8, d / 8);
        tex.needsUpdate = true;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex }));
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, -0.05, z);
        apron.add(m);
      }
      this.group.add(apron);

      // City blocks: one window texture shared by all buildings (random lit squares).
      const winTex = canvasTex(64, 128, (g, w, h) => {
        g.fillStyle = "#0a0c18"; g.fillRect(0, 0, w, h);
        const tints = ["#ffe7a3", "#9fd8ff", "#ff9ad5", "#a8ffcf"];
        for (let y = 4; y < h - 4; y += 8) for (let x = 4; x < w - 4; x += 8) {
          if (Math.random() < 0.32) { g.fillStyle = tints[(Math.random() * tints.length) | 0]; g.fillRect(x, y, 4, 5); }
        }
      });
      const buildMat = new THREE.MeshBasicMaterial({ map: winTex, color: 0xb8c0e0 });
      const rng = mulberry(7);
      for (let k = 0; k < 46; k++) {
        const a = (k / 46) * Math.PI * 2 + rng() * 0.08;
        // Leave a gap on the camera's side (+Z): buildings there end up right
        // in front of the lens on tall screens.
        if (Math.cos(a) > 0.55) continue;
        const r = S * (1.05 + rng() * 0.55);
        const w = 6 + rng() * 10, d = 6 + rng() * 10, h = 10 + rng() * 34;
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), buildMat);
        b.position.set(Math.sin(a) * r, h / 2, Math.cos(a) * r);
        b.rotation.y = a;
        this.group.add(b);
      }

      // Stars.
      const pts = [];
      for (let k = 0; k < 600; k++) {
        const a = rng() * Math.PI * 2, e = 0.15 + rng() * 1.2, R = S * 3.5;
        pts.push(Math.cos(a) * Math.cos(e) * R, Math.sin(e) * R, Math.sin(a) * Math.cos(e) * R);
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      this.group.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xbfd0ff, size: 1.4, fog: false })));
    }

    /* ---------------------------------------------------------------
       Car dressing. The shared car is a rocket car; in this mode it also
       carries a paint ROLLER on its nose (it is the paintbrush) and a soft
       neon underglow, both in the player's colour. Added the first time a
       car is seen by frame(); safe to call yourself too.
       --------------------------------------------------------------- */
    decorateCar(car) {
      const mesh = car.mesh;
      if (!mesh || mesh.userData.m5) return;
      const i = car.index ?? (car.player ? car.player.index : 0);
      const color = NEON[i % 4];
      const body = mesh.userData.body || mesh;

      // Roller drum on two arms in front of the car.
      const roller = new THREE.Group();
      // Big and bright on purpose: from the overhead camera the roller is one
      // of the main ways you spot your own car.
      roller.position.set(0, 0.38, 2.4);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 2.15, 18),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1, roughness: 0.5 }));
      drum.rotation.z = Math.PI / 2;
      // Darker end caps + a stripe so you can see it spin.
      const capMat = new THREE.MeshStandardMaterial({ color: 0x20253f, metalness: 0.6, roughness: 0.3 });
      for (const sx of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.08, 16), capMat);
        cap.rotation.z = Math.PI / 2;
        cap.position.x = sx * 1.1;
        roller.add(cap);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.85), capMat);
        arm.position.set(sx * 1.1, 0.18, -0.4);
        arm.rotation.x = -0.4;
        roller.add(arm);
      }
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.17, 0.08, 0.08), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      stripe.position.y = 0.37;
      // The drum and its stripe spin together; the arms and caps stay put.
      const spinner = new THREE.Group();
      spinner.add(drum, stripe);
      roller.add(spinner);
      body.add(roller);

      // Underglow: a flat additive glow on the ground under the car.
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 9), new THREE.MeshBasicMaterial({
        map: glowTex(), color, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.06;
      mesh.add(glow);

      // A bright ring on the floor around the car (white core, coloured edge)
      // so each car has a clear "here I am" outline even on its own paint.
      const ring = new THREE.Group();
      const ringOuter = new THREE.Mesh(new THREE.RingGeometry(2.75, 3.15, 40), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      const ringInner = new THREE.Mesh(new THREE.RingGeometry(2.62, 2.75, 40), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide,
      }));
      ring.add(ringOuter, ringInner);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.08;
      mesh.add(ring);

      // The shared floating marker: taller, bigger, with a glow halo.
      const marker = mesh.userData.marker;
      let beacon = null;
      if (marker) {
        marker.scale.setScalar(1.9);
        marker.position.y = 3.8;
        beacon = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        beacon.scale.setScalar(3.4);
        beacon.position.y = 3.9;
        mesh.add(beacon);
      }

      mesh.userData.m5 = { roller, spinner, glow, ring, marker, beacon, t: i * 1.3 };
    }

    /* ---------------------------------------------------------------
       Pickups: a floating icon over a pad, inside a tall light beam.
       Gameplay places/removes the returned group; call pickup.userData.tick(dt)
       each frame (World.update does it for groups made through here).
         kind: "bomb" | "mega" | "boost"
       --------------------------------------------------------------- */
    buildPickup(kind) {
      const COLORS = { bomb: 0xff3d6e, mega: 0xffe14d, boost: 0x45f0ff };
      const color = COLORS[kind] || 0xffffff;
      const g = new THREE.Group();
      const iconMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0.3 });
      const icon = new THREE.Group();
      if (kind === "bomb") {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 14), iconMat);
        icon.add(ball);
        const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.45, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        fuse.position.y = 0.85;
        icon.add(fuse);
      } else if (kind === "mega") {
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.7, 18), iconMat);
        drum.rotation.z = Math.PI / 2;
        icon.add(drum);
        const handle = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.08, 6, 16, Math.PI), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        handle.position.y = 0.45;
        icon.add(handle);
      } else {
        const can = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.3, 18), iconMat);
        icon.add(can);
        const bolt = new THREE.Mesh(new THREE.OctahedronGeometry(0.38), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        bolt.scale.set(0.6, 1.3, 0.25);
        bolt.position.z = 0.5;
        icon.add(bolt);
      }
      icon.position.y = 1.8;
      icon.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      g.add(icon);

      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 26, 20, 1, true), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      beam.position.y = 13;
      g.add(beam);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.8, 32), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      g.add(ring);

      let t = Math.random() * 6;
      g.userData.kind = kind;
      g.userData.tick = (dt) => {
        t += dt;
        icon.rotation.y += dt * 2.2;
        icon.position.y = 1.8 + Math.sin(t * 3) * 0.25;
        const k = 1 + Math.sin(t * 5) * 0.08;
        ring.scale.set(k, k, k);
        beam.material.opacity = 0.1 + Math.sin(t * 4) * 0.04;
      };
      (this.pickups = this.pickups || new Set()).add(g);
      g.addEventListener("removed", () => this.pickups.delete(g));
      return g;
    }

    /* ---------------------------------------------------------------
       Camera rig. "follow": angled overhead, dolly in/out so every live car
       stays in view at any aspect ratio (portrait phones pull back further).
       "overview": the whole floor from high above (end of round).
       --------------------------------------------------------------- */
    setAspect(aspect) {
      this.aspect = aspect;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    overview(on = true) { this.camMode = on ? "overview" : "follow"; }
    shake(amount) { this.shakeAmt = Math.min(1.5, this.shakeAmt + amount); }

    frame(cars, dt) {
      if (this.camera.aspect !== this.aspect) this.setAspect(this.aspect);
      const half = this.size / 2;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, count = 0;
      this.cars = cars;
      for (const car of cars || []) {
        if (!car) continue;
        this.decorateCar(car);
        this.animateCar(car, dt);
        if (car.out) continue;
        const p = car.pos || car.mesh.position;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
        count++;
      }

      // Where to look and how much must fit.
      // Tall (portrait) screens are narrow, so look down more steeply: a
      // top-down floor is as tall as it is wide, which uses the height best.
      const portrait = Math.min(1, Math.max(0, (1.2 - this.aspect) / 0.7));
      let cx = 0, cz = 0, rx = half, rz = half, pitch = 0.98 + portrait * 0.42;
      if (this.camMode === "overview" || !count) {
        pitch = 1.22 + portrait * 0.2;  // steeper: almost straight down
        rx = half + 3; rz = half + 3;
      } else {
        const margin = 7;               // floor kept visible around the outermost cars
        cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
        rx = (maxX - minX) / 2 + margin; rz = (maxZ - minZ) / 2 + margin;
        // Never zoom in so far that the play feels claustrophobic.
        rx = Math.max(rx, 18); rz = Math.max(rz, 14);
      }
      this.box = { rx, rz };

      // Find the distance at which the whole box (cx±rx, cz±rz, and a car's
      // height above it) lands inside the HUD-free part of the screen.
      const dist = this.fitDistance(cx, cz, rx, rz, pitch);
      // Smooth everything (exponential ease) so the camera never snaps, but
      // zoom OUT quickly: a car must never slip off screen while we catch up.
      const dt0 = dt || 0.016;
      const kIn = 1 - Math.exp(-(this.camMode === "overview" ? 1.8 : 2.2) * dt0);
      const kOut = 1 - Math.exp(-7 * dt0);
      const kMove = 1 - Math.exp(-3.5 * dt0);
      this.camTarget.x += (cx - this.camTarget.x) * kMove;
      this.camTarget.z += (cz - this.camTarget.z) * kMove;
      this.camDist += (dist - this.camDist) * (dist > this.camDist ? kOut : kIn);
      this.camPitch += (pitch - this.camPitch) * kIn;
      this.portrait = portrait;
      this.placeCamera(false, dt);
    }

    // Point the scratch camera like the real one would be for (target, pitch, dist).
    _aimFit(cx, cz, pitch, d) {
      const cam = this._fitCam || (this._fitCam = new THREE.PerspectiveCamera());
      cam.fov = this.camera.fov;
      cam.aspect = this.aspect;
      cam.near = this.camera.near; cam.far = this.camera.far;
      cam.updateProjectionMatrix();
      cam.position.set(cx, Math.sin(pitch) * d, cz + Math.cos(pitch) * d);
      cam.lookAt(cx, 0, cz);
      cam.updateMatrixWorld();
      return cam;
    }

    fitDistance(cx, cz, rx, rz, pitch) {
      const v = this._fitV || (this._fitV = new THREE.Vector3());
      // The HUD (and an open results card) cover parts of the screen.
      // placeCamera() shifts the picture into the free space; here the box
      // only has to fit that space's size.
      const sa = this.safeArea();
      const xLim = Math.max(0.3, 1 - sa.left - sa.right) * 0.95;
      const yLim = Math.max(0.3, 1 - sa.top - sa.bottom) * 0.95;
      const fits = (d) => {
        const cam = this._aimFit(cx, cz, pitch, d);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 3.5]) {
          v.set(cx + sx * rx, y, cz + sz * rz).project(cam);
          if (Math.abs(v.x) > xLim || Math.abs(v.y) > yLim || v.z > 1) return false;
        }
        return true;
      };
      let lo = 10, hi = this.size * 4;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid; else lo = mid;
      }
      return hi;
    }

    // Fractions of the screen the HUD covers on each side. The HUD
    // publishes them as TP.M5.safeArea; sensible default otherwise.
    safeArea() {
      const s = TP.M5.safeArea || {};
      return { top: s.top ?? 0.12, bottom: s.bottom ?? 0, left: s.left ?? 0, right: s.right ?? 0 };
    }

    placeCamera(snap, dt = 0) {
      const p = this.camPitch, d = this.camDist, t = this.camTarget;
      const sa = this.safeArea();
      /* Shift the picture into the free space (a pure 2D shift of the
         projection, in NDC units: +1 = half the screen). Normally centred;
         on portrait screens the floor is pushed up to sit right under the
         top HUD, so the spare height collects at the bottom (by the chips)
         instead of as empty sky. */
      let sx = sa.left - sa.right, sy = sa.bottom - sa.top;
      if (this.portrait > 0.5 && this.box) {
        const cam = this._aimFit(t.x, t.z, p, d);
        const v = this._fitV || (this._fitV = new THREE.Vector3());
        const yFar = v.set(t.x, 0, t.z - this.box.rz).project(cam).y;
        const yNear = v.set(t.x, 0, t.z + this.box.rz).project(cam).y;
        const top = 1 - 2 * sa.top - 0.03, bottom = -1 + 2 * sa.bottom + 0.03;
        const up = top - yFar;
        if (yNear + up >= bottom) sy = up;
      }
      const H = 1000, W = H * this.aspect;
      this.camera.setViewOffset(W, H, -(sx / 2) * W, (sy / 2) * H, W, H);
      this.camera.position.set(t.x, Math.sin(p) * d, t.z + Math.cos(p) * d);
      if (this.shakeAmt > 0.001) {
        const s = this.shakeAmt;
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s;
        this.shakeAmt *= Math.exp(-7 * dt);
      }
      this.camera.lookAt(t.x, 0, t.z);
      // Fog starts just past the arena from wherever the camera is, so a
      // far-back camera (portrait phones) still sees the floor clearly.
      if (this.scene.fog) {
        this.scene.fog.near = d * 0.9 + this.size * 0.3;
        this.scene.fog.far = d * 1.6 + this.size * 1.6;
      }
      this.updateCelebration(dt);
    }

    /* ---------------------------------------------------------------
       Round winner celebration: a tall light beam in the winner's colour
       on their car, with rings rising up it, until the next countdown.
       --------------------------------------------------------------- */
    celebrate(players) {
      this.endCelebration();
      players = [].concat(players).filter((p) => p != null && p >= 0);
      this.cels = players.map((p) => this.makeBeam(p));
    }
    makeBeam(player) {
      const color = NEON[player % 4];
      const g = new THREE.Group();
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.4, 60, 24, 1, true), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      beam.position.y = 30;
      g.add(beam);
      const rings = [];
      for (let k = 0; k < 3; k++) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.18, 6, 32), new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        r.rotation.x = Math.PI / 2;
        g.add(r);
        rings.push(r);
      }
      this.group.add(g);
      return { player, g, rings, t: 0 };
    }
    endCelebration() {
      for (const c of this.cels || []) {
        this.group.remove(c.g);
        c.g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      }
      this.cels = [];
    }
    updateCelebration(dt) {
      for (const c of this.cels || []) this.updateBeam(c, dt);
    }
    updateBeam(c, dt) {
      c.t += dt;
      const car = this.cars && this.cars[c.player];
      if (car) c.g.position.set(car.pos.x, car.pos.y || 0, car.pos.z);
      c.rings.forEach((r, k) => {
        const u = (c.t * 0.6 + k / 3) % 1;          // 0 → 1 up the beam
        r.position.y = u * 22;
        r.scale.setScalar(1 + u * 0.6);
        r.material.opacity = 1 - u;
      });
    }

    // Spin the roller with ground speed and dim the underglow while airborne.
    animateCar(car, dt) {
      const m = car.mesh && car.mesh.userData.m5;
      if (!m || !dt) return;
      const v = car.vel ? Math.hypot(car.vel.x, car.vel.z) : 0;
      const fwd = car.vel ? Math.sign(car.vel.x * Math.sin(car.heading || 0) + car.vel.z * Math.cos(car.heading || 0)) : 1;
      m.spinner.rotation.x += (fwd * v * dt) / 0.3;
      const air = car.onGround === false ? 1 : 0;
      m.glow.material.opacity += ((car.out ? 0 : air ? 0.15 : car.boosting ? 0.85 : 0.55) - m.glow.material.opacity) * Math.min(1, dt * 10);
      // Underglow and ring stay on the floor even when the car jumps.
      // Height above the surface it last drove on (floor, deck or ramp).
      if (car.onGround !== false || m.groundY === undefined) m.groundY = car.mesh.position.y || 0;
      const lift = (car.mesh.position.y || 0) - m.groundY;
      m.glow.position.y = 0.06 - lift;
      m.ring.position.y = 0.08 - lift;
      m.ring.visible = !car.out;
      // Marker bobs gently so the eye catches it.
      m.t += dt;
      if (m.marker) {
        m.marker.position.y = 3.8 + Math.sin(m.t * 3) * 0.25;
        if (m.beacon) { m.beacon.position.y = m.marker.position.y + 0.1; m.beacon.visible = !car.out; }
      }
    }

    /* ---------------------------------------------------------------
       Per frame: advance time, redraw the paint texture if the grid changed
       or a sweep/flash is playing, turn the pad rings, tick pickups.
       --------------------------------------------------------------- */
    update(dt) {
      this.time += dt;
      this.floorUniforms.uTime.value = this.time;
      const g = this.grid;

      // Did the paint change? Gameplay's grid bumps `version`; the preview
      // grid sets `dirty`.
      const changed = g.version !== undefined ? g.version !== this._ver : g.dirty;
      if (changed) {
        // A fill was announced without a cell list: every cell that is about
        // to change to that player's colour is part of the fill.
        if (this.fillQueue.length) {
          const owner = g.owner || g.cells;
          for (const fill of this.fillQueue) {
            const cells = [];
            for (let k = 0; k < owner.length; k++) {
              if (owner[k] === fill.owner && this.shown[k] !== fill.owner && !this.revealAt[k]) cells.push(k);
            }
            this.startSweep(fill, cells);
          }
          this.fillQueue.length = 0;
        }
        // Small change, no animation running → redraw only the rows Gameplay says changed.
        let j0 = 0, j1 = this.n - 1;
        if (g.dirtyRows) {
          j0 = g.dirtyRows.indexOf(1);
          j1 = g.dirtyRows.lastIndexOf(1);
          if (j0 < 0) { j0 = 0; j1 = this.n - 1; }
        }
        if (this.time < this.animUntil) this.uploadAll(); else this.writeRows(j0, j1);
        this.animUntil = Math.max(this.animUntil, this.time + LOOK.flashTime);
        this._ver = g.version;
        if (g.clearDirty) g.clearDirty(); else g.dirty = false;
      } else if (this.time < this.animUntil) {
        this.uploadAll();   // sweep or flashes still playing
      }

      for (const r of this.padRings) r.rotation.y += dt * 0.6;
      if (this.pickups) for (const p of this.pickups) p.userData.tick(dt);
      // Overdrive: walls shift from cyan toward hot magenta and throb.
      if (this.overdrive) {
        const k = 0.5 + 0.5 * Math.sin(this.time * 9);
        this.wallMat.color.setHex(0xff3d9a).lerp(new THREE.Color(0xffd23f), k * 0.4);
      }
    }

    setOverdrive(on) {
      this.overdrive = on;
      if (!on) this.wallMat.color.setHex(this.mood.wall);
    }

    // Convert a world point to grid cell coordinates (handy for effects).
    cellAt(x, z) {
      const half = this.size / 2;
      return { i: Math.floor((x + half) / this.cell), j: Math.floor((z + half) / this.cell) };
    }

    /* Listen to Gameplay's events (called automatically if the bus exists). */
    listen() {
      if (!TP.M5.on || this.listening) return;
      this.listening = true;
      // Keep the "stop listening" handles so dispose() can unhook us.
      this.offs = [];
      const on = (n, fn) => { const off = TP.M5.on(n, fn); if (typeof off === "function") this.offs.push(off); };
      on("fill", (e) => this.queueFill(e.player, e.cx, e.cz, e.cellsList));
      on("overdrive", () => this.setOverdrive(true));
      on("roundCountdown", () => { this.setOverdrive(false); this.overview(false); this.resetPaint(); this.endCelebration(); });
      // In teams, `winner` is a team: light up both of its players.
      on("roundEnd", (e) => {
        this.overview(true);
        this.celebrate(e.teams ? e.teams.map((t, i) => (t === e.winner ? i : -1)) : e.winner);
      });
      on("bump", (e) => { if (e.hard || e.impact > 9) this.shake(0.5); });
      on("pop", () => this.shake(0.35));
      on("land", (e) => { if (e.airtime > 0.8) this.shake(0.25); });
    }

    // New round: forget any fill sweep still in progress from the last one.
    resetPaint() {
      this.revealAt.fill(0);
      this.fillQueue.length = 0;
      this.animUntil = this.time + 0.1;
    }

    dispose() {
      (this.offs || []).forEach((off) => off());
      this.offs = [];
      this.scene.remove(this.group);
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach((m) => { if (m.map && m.map !== glowTexCache) m.map.dispose(); m.dispose(); });
      });
      this.paintTex.dispose();
    }
  }

  // Tiny seeded random number generator so the city looks the same every time.
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* =====================================================================
     Stage = the look of one arena (floor, walls, lights, camera rig),
     listening to events. art-preview.html uses it directly.
     ===================================================================== */
  class Stage extends World {
    constructor(scene, arena, grid, camera) { super(scene, arena, grid, camera); this.listen(); }
  }
  TP.M5.Stage = Stage;

  // Gameplay's arena data → the shape the Stage draws.
  //   ramps { x, z, fx, fz, L, W, h } → { x, z, w: W, d: L, h, dir }
  //   (dir = heading the ramp climbs toward; heading 0 faces +Z, so
  //    dir = atan2(fx, fz))
  function lookArena(a) {
    return {
      id: a.id,
      name: a.name,
      size: a.size || a.half * 2,
      shape: a.shape || "square",
      radius: a.radius,
      decks: a.decks || [],
      obstacles: a.obstacles || [],
      pillars: a.pillars || [],
      ramps: (a.ramps || []).map((r) => ({ x: r.x, z: r.z, w: r.W, d: r.L, h: r.h, dir: Math.atan2(r.fx, r.fz) })),
      pads: a.spawns || a.pads || [],
    };
  }
  TP.M5.lookArena = lookArena;

  /* =====================================================================
     TP.M5.World — the hand-off main.js expects:
       new TP.M5.World(match, renderer) → { scene, camera, update(dt), resize(w, h), dispose() }
     It owns the scene (adds match.root, the cars), builds the Stage for the
     current arena (rebuilt if the arena changes between rounds), and drives
     the effects, pickups, HUD and audio every frame.
     ===================================================================== */
  TP.M5.World = class MatchWorld {
    constructor(match, renderer) {
      this.match = match;
      this.renderer = renderer;
      TP.M5.__world = this;   // handy in the browser console and for perf probes
      this.scene = new THREE.Scene();
      this.scene.add(match.root);
      this.aspect = innerWidth / Math.max(1, innerHeight);
      this.camera = new THREE.PerspectiveCamera(42, this.aspect, 0.5, 600);
      this.pickupMeshes = new Map();
      this.buildStage();
      this.vfx = TP.M5.Vfx ? new TP.M5.Vfx(this.scene, this.stage) : null;

      if (TP.M5.Audio) TP.M5.Audio.init();
      // One HUD for the whole page (it's DOM, not 3D); new players each match.
      if (TP.M5.Hud) {
        TP.M5.hud = TP.M5.hud || new TP.M5.Hud();
        TP.M5.hud.setPlayers(match.players.map((p) => ({ name: p.name, index: p.index, team: p.team })), !!match.teams);
        TP.M5.hud.setCamera(this.camera);
        TP.M5.hud.reset();
        TP.M5.hud.show(!(TP.M5.Menu && TP.M5.Menu.isOpen));
      }
    }

    buildStage() {
      if (this.stage) this.stage.dispose();
      for (const g of this.pickupMeshes.values()) this.scene.remove(g);
      this.pickupMeshes.clear();
      this.arenaId = this.match.arena.id;
      this.stage = new Stage(this.scene, lookArena(this.match.arena), this.match.grid, this.camera);
      this.stage.setAspect(this.aspect);
      if (this.vfx) this.vfx.setWorld(this.stage);
    }

    resize(w, h) {
      this.aspect = w / Math.max(1, h);
      this.stage.setAspect(this.aspect);
    }

    update(dt) {
      const m = this.match;
      if (m.arena.id !== this.arenaId) this.buildStage();
      this.stage.frame(m.cars, dt);
      this.stage.update(dt);
      if (this.vfx) this.vfx.update(dt, m.cars);
      this.syncPickups();
      if (TP.M5.hud) TP.M5.hud.update(dt, m);
    }

    // One floating pickup (with its beam) per live pickup in the match.
    syncPickups() {
      const live = new Set();
      for (const p of this.match.pickups || []) {
        live.add(p.id);
        if (!this.pickupMeshes.has(p.id)) {
          const g = this.stage.buildPickup(p.kind);
          g.position.set(p.x, p.y || 0, p.z);
          this.scene.add(g);
          this.pickupMeshes.set(p.id, g);
        }
      }
      for (const [id, g] of this.pickupMeshes) {
        if (!live.has(id)) { this.scene.remove(g); this.pickupMeshes.delete(id); }
      }
    }

    dispose() {
      // The cars belong to the match (it disposes them itself).
      this.scene.remove(this.match.root);
      for (const g of this.pickupMeshes.values()) this.scene.remove(g);
      if (this.vfx) this.vfx.dispose();
      this.stage.dispose();
      TP.disposeScene(this.scene);
    }
  };
  TP.M5.LOOK = LOOK;
})();
