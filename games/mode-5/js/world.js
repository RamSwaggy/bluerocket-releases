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
    constructor(scene, arena, grid) {
      this.scene = scene;
      this.arena = arena;
      this.grid = grid;
      this.size = arena.size || 96;
      this.n = grid.n || grid.size || 72;
      this.cell = this.size / this.n;    // world units per cell
      this.time = 0;
      this.group = new THREE.Group();    // everything we add lives here (easy dispose)
      scene.add(this.group);

      scene.background = new THREE.Color(LOOK.sky);
      // Low fog: the far edge of the arena and the city fade into the night.
      scene.fog = new THREE.Fog(LOOK.sky, this.size * 0.9, this.size * 2.6);

      this.buildLights();
      this.buildFloor();
      this.buildWalls();
      this.buildObstacles();
      this.buildRamps();
      this.buildPads();
      this.buildSurroundings();

      /* ---------- Camera ---------- */
      this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, this.size * 6);
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
      this.group.add(new THREE.HemisphereLight(0x8fa8ff, 0x0a0a18, 0.55));

      const key = new THREE.DirectionalLight(0xdfe8ff, 1.15);
      key.position.set(S * 0.25, S * 0.9, S * 0.45);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      const s = S * 0.62;
      Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: S * 3 });
      key.shadow.bias = -0.0006;
      this.group.add(key);
      this.group.add(key.target);

      // Rim lights sit just outside each corner, low, pointing in.
      // r160 uses physical light units, so point lights need large intensities.
      this.rims = [];
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      corners.forEach(([cx, cz], i) => {
        const light = new THREE.PointLight(NEON[i], S * S * 0.09, S * 1.6, 1.6);
        light.position.set(cx * S * 0.52, 7, cz * S * 0.52);
        this.group.add(light);
        this.rims.push(light);
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
      };
      this.floorUniforms = uniforms;

      const mat = new THREE.MeshStandardMaterial({ color: LOOK.floor, roughness: 0.3, metalness: 0.35 });
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
            uniform float uTime, uGridN, uGlow;
            vec4 m5Paint; float m5Painted; float m5Wet; float m5Tile; float m5Edge;`)
          // 1) Base colour: tint the floor with the paint, draw faint grout lines on bare floor.
          .replace("#include <color_fragment>", `#include <color_fragment>
            m5Paint = texture2D(paintMap, vPaintUv);
            m5Painted = step(0.02, m5Paint.a);
            m5Wet = step(0.9, m5Paint.a);
            vec2 m5f = fract(vPaintUv * uGridN);
            m5Edge = min(min(m5f.x, 1.0 - m5f.x), min(m5f.y, 1.0 - m5f.y)); // 0 at tile edge, .5 centre
            m5Tile = smoothstep(0.0, 0.14, m5Edge);                         // bevel: dark rim per tile
            diffuseColor.rgb = mix(diffuseColor.rgb, m5Paint.rgb * 0.30, m5Painted);
            float m5Grout = 1.0 - smoothstep(0.0, 0.035, m5Edge);
            diffuseColor.rgb += vec3(0.05, 0.07, 0.12) * m5Grout * (1.0 - m5Painted);`)
          // 2) Glow: painted tiles emit their colour; wet trails pulse with a moving ripple.
          .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
            vec2 m5c = floor(vPaintUv * uGridN);
            float m5Pulse = 0.5 + 0.5 * sin(uTime * 7.0 - (m5c.x + m5c.y) * 0.55);
            float m5Level = m5Paint.a * (0.55 + 0.45 * m5Tile);
            float m5WetBoost = m5Wet * (0.45 + 0.9 * m5Pulse);
            totalEmissiveRadiance += m5Paint.rgb * m5Painted * uGlow * (m5Level * 0.9 + m5WetBoost);`);
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
        color: LOOK.wall, map: fade, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const curbMat = new THREE.MeshStandardMaterial({ color: 0x151a33, roughness: 0.6, metalness: 0.3 });
      const lineMat = new THREE.MeshBasicMaterial({ color: 0xc9f1ff });
      this.wallMat = wallMat;

      for (let side = 0; side < 4; side++) {
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
        post.position.set(cx * (S / 2 + 0.6), 2.25, cz * (S / 2 + 0.6));
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
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x9be7ff });
      const bandMat = new THREE.MeshBasicMaterial({ color: 0x9be7ff });
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
        g.position.set(p.x, 0.04, p.z);
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
        g.strokeStyle = "rgba(90,120,255,0.18)"; g.lineWidth = 2;
        g.strokeRect(0, 0, w, h);
      });
      apronTex.wrapS = apronTex.wrapT = THREE.RepeatWrapping;
      apronTex.repeat.set(S * 4 / 8, S * 4 / 8);
      const apron = new THREE.Mesh(new THREE.PlaneGeometry(S * 4, S * 4),
        new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.9 }));
      apron.rotation.x = -Math.PI / 2;
      apron.position.y = -0.05;
      apron.receiveShadow = true;
      this.group.add(apron);

      // City blocks: one window texture shared by all buildings (random lit squares).
      const winTex = canvasTex(64, 128, (g, w, h) => {
        g.fillStyle = "#0a0c18"; g.fillRect(0, 0, w, h);
        const tints = ["#ffe7a3", "#9fd8ff", "#ff9ad5", "#a8ffcf"];
        for (let y = 4; y < h - 4; y += 8) for (let x = 4; x < w - 4; x += 8) {
          if (Math.random() < 0.32) { g.fillStyle = tints[(Math.random() * tints.length) | 0]; g.fillRect(x, y, 4, 5); }
        }
      });
      const buildMat = new THREE.MeshStandardMaterial({
        color: 0x0d1122, map: winTex, emissiveMap: winTex, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.8,
      });
      const rng = mulberry(7);
      for (let k = 0; k < 46; k++) {
        const a = (k / 46) * Math.PI * 2 + rng() * 0.08;
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
      roller.position.set(0, 0.3, 2.3);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.9, 16),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, roughness: 0.6 }));
      drum.rotation.z = Math.PI / 2;
      // Darker end caps + a stripe so you can see it spin.
      const capMat = new THREE.MeshStandardMaterial({ color: 0x20253f, metalness: 0.6, roughness: 0.3 });
      for (const sx of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 16), capMat);
        cap.rotation.z = Math.PI / 2;
        cap.position.x = sx * 0.98;
        roller.add(cap);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.85), capMat);
        arm.position.set(sx * 0.98, 0.18, -0.38);
        arm.rotation.x = -0.4;
        roller.add(arm);
      }
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.07, 0.07), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      stripe.position.y = 0.29;
      // The drum and its stripe spin together; the arms and caps stay put.
      const spinner = new THREE.Group();
      spinner.add(drum, stripe);
      roller.add(spinner);
      body.add(roller);

      // Underglow: a flat additive glow on the ground under the car.
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 6.4), new THREE.MeshBasicMaterial({
        map: glowTex(), color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.06;
      mesh.add(glow);

      mesh.userData.m5 = { roller, spinner, glow };
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
      // Tall (portrait) screens have spare height but little width, so look
      // down more steeply: the floor is less squashed and fills more of the screen.
      const portrait = Math.min(1, Math.max(0, (1.2 - this.aspect) / 0.7));
      let cx = 0, cz = 0, rx = half, rz = half, pitch = 0.98 + portrait * 0.3;
      if (this.camMode === "overview" || !count) {
        pitch = 1.22 + portrait * 0.12; // steeper: almost straight down
        rx = half + 4; rz = half + 4;
      } else {
        const margin = 8 + portrait * 4; // keep some floor visible around the cars
        cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
        rx = (maxX - minX) / 2 + margin; rz = (maxZ - minZ) / 2 + margin;
        // Never zoom in so far that the play feels claustrophobic.
        rx = Math.max(rx, 20); rz = Math.max(rz, 16);
        // Lean the look-point toward the arena centre: steadier, shows more floor.
        cx *= 0.6; cz *= 0.6;
      }

      // Find the distance at which all four corners of the box (cx±rx, cz±rz)
      // land inside the screen. Perspective makes the near edge look bigger
      // than the far edge, so we test the real projection rather than guess:
      // a quick binary search over the distance (12 steps, 4 points each).
      const dist = this.fitDistance(cx, cz, rx, rz, pitch);
      // Smooth everything (exponential ease) so the camera never snaps.
      const k = 1 - Math.exp(-(this.camMode === "overview" ? 1.8 : 2.6) * (dt || 0.016));
      this.camTarget.x += (cx - this.camTarget.x) * k;
      this.camTarget.z += (cz - this.camTarget.z) * k;
      this.camDist += (dist - this.camDist) * k;
      this.camPitch += (pitch - this.camPitch) * k;
      this.placeCamera(false, dt);
    }

    fitDistance(cx, cz, rx, rz, pitch) {
      const cam = this._fitCam || (this._fitCam = this.camera.clone());
      cam.fov = this.camera.fov;
      cam.aspect = this.aspect;
      cam.updateProjectionMatrix();
      const v = this._fitV || (this._fitV = new THREE.Vector3());
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      const fits = (d) => {
        cam.position.set(cx, Math.sin(pitch) * d, cz + Math.cos(pitch) * d);
        cam.lookAt(cx, 0, cz);
        cam.updateMatrixWorld();
        for (const [sx, sz] of corners) {
          v.set(cx + sx * rx, 0, cz + sz * rz).project(cam);
          // Leave room at the top for the HUD (score bar) — 0.80 instead of 0.94.
          if (Math.abs(v.x) > 0.96 || v.y > 0.80 || v.y < -0.96 || v.z > 1) return false;
        }
        return true;
      };
      let lo = 10, hi = this.size * 3;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid; else lo = mid;
      }
      return hi;
    }

    placeCamera(snap, dt = 0) {
      const p = this.camPitch, d = this.camDist, t = this.camTarget;
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
      // Underglow stays on the floor even when the car jumps.
      m.glow.position.y = 0.06 - (car.mesh.position.y || 0);
    }

    /* ---------------------------------------------------------------
       Per frame: advance time, redraw the paint texture if the grid changed
       or a sweep/flash is playing, turn the pad rings, tick pickups.
       --------------------------------------------------------------- */
    update(dt) {
      this.time += dt;
      this.floorUniforms.uTime.value = this.time;
      const g = this.grid;

      if (g.dirty) {
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
        const j0 = g.dirtyMin ?? 0, j1 = g.dirtyMax ?? this.n - 1;
        if (this.time < this.animUntil) this.uploadAll(); else this.writeRows(Math.max(0, j0), Math.min(this.n - 1, j1));
        this.animUntil = Math.max(this.animUntil, this.time + LOOK.flashTime);
        g.dirty = false;
        if ("dirtyMin" in g) { g.dirtyMin = this.n; g.dirtyMax = -1; }
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
      if (!on) this.wallMat.color.setHex(LOOK.wall);
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
      TP.M5.on("fill", (e) => this.queueFill(e.player, e.cx, e.cz, e.cellsList));
      TP.M5.on("overdrive", () => this.setOverdrive(true));
      TP.M5.on("roundCountdown", () => { this.setOverdrive(false); this.overview(false); });
      TP.M5.on("roundEnd", () => this.overview(true));
      TP.M5.on("bump", (e) => { if (e.impact > 9) this.shake(0.5); });
      TP.M5.on("pop", () => this.shake(0.35));
      TP.M5.on("land", (e) => { if (e.airtime > 0.8) this.shake(0.25); });
    }

    dispose() {
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

  // Wire up event listening automatically after construction.
  TP.M5.World = class extends World {
    constructor(scene, arena, grid) { super(scene, arena, grid); this.listen(); }
  };
  TP.M5.LOOK = LOOK;
})();
