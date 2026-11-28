/* =====================================================================
   scene.js — the look of Boost Runner: "Night-shift test range".

   A rocket-test facility at dusk. From back to front:

     1. Sky       a gradient from deep indigo (top) to a warm ember glow
                  at the horizon, with a few stars. It's glued to the
                  camera, so it never scrolls.
     2. Far layer (z ≈ -190) huge pale-purple silhouettes: fuel tanks,
                  launch towers, cranes, rockets on pads, with blinking
                  red aircraft lights on top. Fog makes them hazy.
     3. Mid layer (z ≈ -60) closer, darker structures: scaffolds with
                  lit windows, pipe racks, striped tanks.
     4. Floor     the facility ground far below the track.
     5. Track     (z = 0) steel slabs built from the course data, over
                  a dark truss "fill", with GLOWING CYAN EDGES on every
                  surface you can drive on. Boost pads are gold.

   Because the camera is a real perspective camera, the layers further
   back scroll more slowly: parallax without any extra code.

   Colour rule: the four player colours (blue, orange, green, pink) are
   never used in the scenery, so cars always stand out.

   The track is built from the SAME segment data Gameplay uses for
   collision, so what you see is what you drive on.

   Usage:
     const look = new TP.BRScene();          // look.scene is the THREE.Scene
     look.attachCamera(brCamera.camera);     // sky follows the camera
     look.setCourse(course);                 // whenever a new round starts
     look.update(dt, view, brCamera.camera); // every frame
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- Palette (none of these are player colours) ---------- */
  const PAL = {
    fog: 0x3a2346,        // dusky purple haze, also the horizon colour
    skyTop: 0x0b0a24,     // deep indigo
    skyMid: 0x2a1845,     // violet
    ember: 0xd9735a,      // warm low glow at the horizon
    far: 0x4b3466,        // far silhouettes (fog lightens them further)
    mid: 0x2a2846,        // mid silhouettes (soft, so they read as background)
    window: 0xc99a6a,     // warm lit windows (dimmed: background, not track)
    floor: 0x0e0d1a,
    steel: 0x56607a,      // track slab
    steelDark: 0x2c3244,  // walls, pillars
    edge: 0x35f3ff,       // drivable-edge cyan
    gold: 0xffcc33,       // boost pads (the house accent)
    redLight: 0xff3344,
  };
  const FLOOR_Y = -32;    // the facility ground, far below the track
  const DEPTH = 5;        // how deep (along z) the track slabs are
  const SLAB = 1.2;       // track slab thickness

  /* ---------- Small helpers ---------- */
  // Seeded random from an integer, so a background tile always looks the
  // same however many times it's rebuilt.
  function tileRng(seed) {
    let a = (seed * 2654435761) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Canvas-drawn textures (made in code, so no asset files or licences).
  function stripeTexture(c1, c2, stripes = 8) {
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 32;
    const g = cv.getContext("2d");
    g.fillStyle = c1; g.fillRect(0, 0, 128, 32);
    g.fillStyle = c2;
    const w = 128 / stripes;
    for (let i = -1; i < stripes + 1; i++) {
      // Diagonal bands: a parallelogram per stripe.
      g.beginPath();
      g.moveTo(i * w, 32); g.lineTo(i * w + w / 2, 32);
      g.lineTo(i * w + w / 2 + 16, 0); g.lineTo(i * w + 16, 0);
      g.closePath(); g.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  // The face of the solid ground under the track: dark steel framing
  // with X-bracing, so the "fill" reads as a gantry, not a cliff.
  function trussTexture() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const g = cv.getContext("2d");
    g.fillStyle = "#151827"; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "#2b3147"; g.lineWidth = 6;
    g.strokeRect(3, 3, 122, 122);                       // frame
    g.beginPath(); g.moveTo(6, 6); g.lineTo(122, 122); g.moveTo(122, 6); g.lineTo(6, 122); g.stroke(); // X-brace
    g.fillStyle = "#3a4260";
    for (const [x, y] of [[8, 8], [120, 8], [8, 120], [120, 120]]) { g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); } // bolts
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  function chevronTexture() {
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 64;
    const g = cv.getContext("2d");
    g.fillStyle = "#7a5200"; g.fillRect(0, 0, 128, 64);
    g.strokeStyle = "#fff2b0"; g.lineWidth = 10; g.lineCap = "round";
    for (const x of [24, 76]) {
      g.beginPath(); g.moveTo(x, 10); g.lineTo(x + 24, 32); g.lineTo(x, 54); g.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  class BRScene {
    constructor() {
      const scene = (this.scene = new THREE.Scene());
      scene.background = new THREE.Color(PAL.fog);
      // Fog starts past the track, so the track stays crisp while the
      // scenery fades into the dusk the further back it is.
      scene.fog = new THREE.Fog(PAL.fog, 75, 360);
      this.time = 0;

      // One shared unit box: every slab, pillar and strip is this box,
      // scaled. Cheap, and nothing to clean up per piece.
      this.box = new THREE.BoxGeometry(1, 1, 1);
      this.mats = {
        steel: new THREE.MeshStandardMaterial({ color: PAL.steel, roughness: 0.75, metalness: 0.35 }),
        steelDark: new THREE.MeshStandardMaterial({ color: PAL.steelDark, roughness: 0.85, metalness: 0.3 }),
        grate: new THREE.MeshStandardMaterial({ color: 0x3b4458, roughness: 0.6, metalness: 0.5 }),
        edge: new THREE.MeshBasicMaterial({ color: PAL.edge }),
        edgeGlow: new THREE.MeshBasicMaterial({ color: PAL.edge, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
        far: new THREE.MeshBasicMaterial({ color: PAL.far }),
        mid: new THREE.MeshLambertMaterial({ color: PAL.mid }),
        midStripe: new THREE.MeshLambertMaterial({ map: stripeTexture("#191a2e", "#6b5a2a", 6) }),
        window: new THREE.MeshBasicMaterial({ color: PAL.window }),
        redA: new THREE.MeshBasicMaterial({ color: PAL.redLight }),
        redB: new THREE.MeshBasicMaterial({ color: PAL.redLight }),
        floor: new THREE.MeshLambertMaterial({ color: PAL.floor }),
        rocket: new THREE.MeshBasicMaterial({ color: 0xe8e4f0 }),
        plume: new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
        contrail: new THREE.MeshBasicMaterial({ color: 0xd8b8c8, transparent: true, opacity: 0.35, depthWrite: false }),
      };
      this.chevron = chevronTexture();
      this.mats.fill = new THREE.MeshStandardMaterial({ map: trussTexture(), roughness: 0.9, metalness: 0.2 });
      this.glowGeo = new THREE.PlaneGeometry(1, 1);
      this.mats.boost = new THREE.MeshBasicMaterial({ map: this.chevron });

      this.addLights();
      this.addSky();
      this.addFloor();

      // Background tiles, built as the camera reaches them.
      this.layers = [
        { name: "far", z: -190, tileW: 150, tiles: new Map(), build: (g, r, x0, w) => this.buildFarTile(g, r, x0, w) },
        { name: "mid", z: -70, tileW: 64, tiles: new Map(), build: (g, r, x0, w) => this.buildMidTile(g, r, x0, w) },
      ];
      this.track = new THREE.Group();
      scene.add(this.track);
      this.pieces = [];     // { group, x1 } per course piece, for culling
      this.boostMats = [];  // boost pad materials, to scroll their chevrons
      this.course = null;
      this.built = 0;       // how many of course.segments are built

      this.rocket = null;   // the occasional background launch
      this.nextLaunch = 6;
    }

    /* ---------- Lights ----------
       A cool key light from the front (so the faces we look at are lit)
       and a warm ember rim light from behind (the sunset). */
    addLights() {
      this.scene.add(new THREE.HemisphereLight(0x8f86ff, 0x2a1622, 0.75));
      const key = (this.key = new THREE.DirectionalLight(0xc8d4ff, 1.25));
      key.position.set(-14, 30, 40);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      Object.assign(key.shadow.camera, { left: -45, right: 45, top: 30, bottom: -30, near: 1, far: 140 });
      key.shadow.bias = -0.0008;
      this.scene.add(key, key.target);
      const rim = new THREE.DirectionalLight(0xff8a5c, 0.9);
      rim.position.set(20, 8, -60);
      this.scene.add(rim);
      // Soft fill from straight in front (where the camera is), so the
      // cars' painted sides read clearly in their player colours.
      this.fill = new THREE.DirectionalLight(0xffffff, 0.8);
      this.fill.position.set(0, 4, 60);
      this.scene.add(this.fill, this.fill.target);
    }

    /* ---------- Sky ----------
       A big plane parked far in front of the camera (it's a child of the
       camera, so it moves with it). A tiny shader paints the gradient:
       ember at the horizon (middle of the screen, because the camera
       looks dead level) up through violet to indigo, plus sparse stars. */
    addSky() {
      const mat = new THREE.ShaderMaterial({
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color(PAL.skyTop) },
          mid: { value: new THREE.Color(PAL.skyMid) },
          horizon: { value: new THREE.Color(PAL.fog) },
          ember: { value: new THREE.Color(PAL.ember) },
        },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 ember;
          varying vec2 vUv;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
          void main(){
            float y = vUv.y;                       // 0 bottom .. 1 top, 0.5 = horizon
            vec3 c = mix(horizon, mid, smoothstep(0.5, 0.72, y));
            c = mix(c, top, smoothstep(0.7, 1.0, y));
            // Ember glow hugging the horizon.
            c += ember * 0.55 * exp(-pow((y - 0.5) * 9.0, 2.0));
            // Stars: only high up, and only a few cells light up.
            vec2 cell = floor(vUv * vec2(260.0, 150.0));
            float s = step(0.9965, hash(cell)) * smoothstep(0.66, 0.9, y);
            c += vec3(0.85, 0.85, 1.0) * s * (0.5 + 0.5 * hash(cell + 7.0));
            gl_FragColor = vec4(c, 1.0);
          }`,
      });
      this.sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      this.sky.renderOrder = -10;
      this.sky.frustumCulled = false;
    }
    attachCamera(camera) {
      // The camera must be in the scene for its children (the sky) to draw.
      this.scene.add(camera);
      camera.add(this.sky);
      this.skyCam = camera;
    }

    addFloor() {
      this.floor = new THREE.Mesh(this.box, this.mats.floor);
      this.floor.scale.set(3000, 1, 700);
      this.floor.position.set(0, FLOOR_Y - 0.5, -300);
      this.floor.receiveShadow = false;
      this.scene.add(this.floor);
    }

    // A box from the shared geometry: centre (x, y, z), size (w, h, d).
    block(group, mat, x, y, z, w, h, d, rotZ = 0) {
      const m = new THREE.Mesh(this.box, mat);
      m.position.set(x, y, z);
      m.scale.set(w, h, d);
      if (rotZ) m.rotation.z = rotZ;
      group.add(m);
      return m;
    }

    /* ---------- Far layer: the skyline ----------
       One tile = a stretch of skyline. Pick 2–4 landmarks per tile. */
    buildFarTile(g, r, x0, w) {
      const m = this.mats.far;
      let x = x0 + r() * 20;
      while (x < x0 + w) {
        const kind = r();
        if (kind < 0.3) {
          // Fuel tank farm: fat cylinders with domes.
          const n = 1 + Math.floor(r() * 3);
          for (let i = 0; i < n; i++) {
            const rad = 7 + r() * 6, h = 14 + r() * 16;
            const t = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, h, 18), m);
            t.position.set(x + i * rad * 2.3, FLOOR_Y + h / 2, 0);
            g.add(t);
            const dome = new THREE.Mesh(new THREE.SphereGeometry(rad, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), m);
            dome.scale.y = 0.35;
            dome.position.set(t.position.x, FLOOR_Y + h, 0);
            g.add(dome);
          }
          x += n * 20 + 10;
        } else if (kind < 0.55) {
          // Launch tower: a tall lattice mast with a red light on top.
          const h = 55 + r() * 45;
          this.block(g, m, x, FLOOR_Y + h / 2, 0, 5, h, 5);
          for (let y = 8; y < h; y += 9) this.block(g, m, x + 4, FLOOR_Y + y, 0, 4, 1.2, 4);
          this.light(g, x, FLOOR_Y + h + 1.5, r() < 0.5);
          x += 26 + r() * 20;
        } else if (kind < 0.78) {
          // Rocket on its pad, beside a service tower.
          const h = 45 + r() * 25;
          const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, h, 14), m);
          body.position.set(x, FLOOR_Y + 6 + h / 2, 0);
          g.add(body);
          const nose = new THREE.Mesh(new THREE.ConeGeometry(3.2, 10, 14), m);
          nose.position.set(x, FLOOR_Y + 6 + h + 5, 0);
          g.add(nose);
          this.block(g, m, x, FLOOR_Y + 3, 0, 16, 6, 12);           // pad
          this.block(g, m, x - 9, FLOOR_Y + (h + 14) / 2, 0, 4, h + 14, 4); // service tower
          this.block(g, m, x - 6, FLOOR_Y + h * 0.7, 0, 6, 1.2, 2);  // access arm
          this.light(g, x - 9, FLOOR_Y + h + 15.5, r() < 0.5);
          x += 34 + r() * 20;
        } else {
          // Crane: a mast and a long jib.
          const h = 40 + r() * 30, jib = 30 + r() * 20;
          this.block(g, m, x, FLOOR_Y + h / 2, 0, 3, h, 3);
          this.block(g, m, x + jib * 0.35, FLOOR_Y + h, 0, jib, 1.8, 2);
          this.block(g, m, x + jib * 0.6, FLOOR_Y + h - 8, 0, 0.4, 16, 0.4); // hook cable
          this.light(g, x, FLOOR_Y + h + 2, r() < 0.5);
          x += 30 + r() * 15;
        }
      }
    }

    // Blinking red aircraft-warning light. Two materials blink out of
    // step so the skyline doesn't flash all at once.
    light(g, x, y, alt) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), alt ? this.mats.redB : this.mats.redA);
      s.position.set(x, y, 2);
      s.material.fog = false; // stays bright through the haze
      g.add(s);
    }

    /* ---------- Mid layer: closer industrial clutter ----------
       Kept LOW (tops well below the usual track height) so a building
       roof is never mistaken for something you can land on. */
    buildMidTile(g, r, x0, w) {
      const m = this.mats.mid;
      let x = x0 + r() * 8;
      while (x < x0 + w) {
        const kind = r();
        if (kind < 0.4) {
          // Scaffold block with a grid of lit windows.
          const bw = 10 + r() * 10, bh = 10 + r() * 14;
          this.block(g, m, x + bw / 2, FLOOR_Y + bh / 2, 0, bw, bh, 8);
          for (let wy = 4; wy < bh - 2; wy += 4) {
            for (let wx = 2; wx < bw - 1; wx += 3) {
              if (r() < 0.45) this.block(g, this.mats.window, x + wx, FLOOR_Y + wy, 4.05, 1.3, 1.6, 0.1);
            }
          }
          x += bw + 4 + r() * 6;
        } else if (kind < 0.7) {
          // Tank with a hazard-striped band.
          const rad = 4 + r() * 3, h = 8 + r() * 10;
          const t = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, h, 16), m);
          t.position.set(x + rad, FLOOR_Y + h / 2, 0);
          g.add(t);
          const band = new THREE.Mesh(new THREE.CylinderGeometry(rad + 0.05, rad + 0.05, 1.6, 16), this.mats.midStripe);
          band.position.set(x + rad, FLOOR_Y + h * 0.75, 0);
          g.add(band);
          x += rad * 2 + 5;
        } else {
          // Pipe rack: posts and long horizontal pipes.
          const len = 16 + r() * 14, h = 8 + r() * 8;
          for (let px = 0; px <= len; px += 8) this.block(g, m, x + px, FLOOR_Y + h / 2, 0, 0.8, h, 0.8);
          for (let i = 0; i < 3; i++) {
            const p = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, len, 8), m);
            p.rotation.z = Math.PI / 2;
            p.position.set(x + len / 2, FLOOR_Y + h - i * 1.6, 1.5);
            g.add(p);
          }
          x += len + 5;
        }
      }
    }

    /* Keep background tiles covering what the camera can see at each
       layer's depth, and drop the ones that slid out of view. */
    updateLayers(camera) {
      const aspect = camera.aspect;
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      for (const L of this.layers) {
        const dist = camera.position.z - L.z;
        const halfW = dist * tanHalf * aspect * 1.15;
        const first = Math.floor((camera.position.x - halfW) / L.tileW);
        const last = Math.floor((camera.position.x + halfW) / L.tileW);
        for (let i = first; i <= last; i++) {
          if (L.tiles.has(i)) continue;
          const g = new THREE.Group();
          g.position.z = L.z;
          L.build(g, tileRng(i * 31 + (L.name === "far" ? 7 : 3)), i * L.tileW, L.tileW);
          this.scene.add(g);
          L.tiles.set(i, g);
        }
        for (const [i, g] of L.tiles) {
          if (i < first - 1 || i > last + 1) { this.disposeGroup(g); L.tiles.delete(i); }
        }
      }
    }

    /* ---------- The track ----------
       Built from Gameplay's course data (see js/README.md):
         course.surfaces  polylines you can drive on, left to right. Solid
                          ones are filled down to course.floorY, so a gap
                          is simply where no solid surface covers that x.
                          A repeated x in a polyline is a vertical step.
                          One-way ones are thin platforms.
         course.pads      gold boost pads lying on a surface.
       The course grows while a round runs (course.version goes up), so
       each frame we build any surfaces and pads not built yet. */
    setCourse(course) {
      if (this.course !== course) {
        // New round, new course: clear the old pieces.
        for (const p of this.pieces) this.disposeGroup(p.group);
        this.pieces = [];
        for (const m of this.boostMats) { if (m.map) m.map.dispose(); m.dispose(); }
        this.boostMats = [];
        this.course = course;
        this.builtSurfaces = 0; this.builtPads = 0; this.version = -1;
      }
      if (course && course.version !== this.version) {
        this.version = course.version;
        const floorY = course.floorY ?? FLOOR_Y;
        const S = course.surfaces || [], P = course.pads || [];
        for (; this.builtSurfaces < S.length; this.builtSurfaces++) this.buildSurface(S[this.builtSurfaces], floorY);
        for (; this.builtPads < P.length; this.builtPads++) this.buildPad(P[this.builtPads]);
      }
    }

    /* One solid surface becomes one mesh: a steel top, a steel slab band
       on the front face, a truss-textured fill from under the slab down
       to the floor, end caps, and faces for any vertical steps. */
    solidGeometry(pts, floorY) {
      const pos = [], uv = [], groups = [[], [], []]; // 0 steel, 1 fill, 2 dark
      const h = DEPTH / 2;
      // Push a quad (a b c d, in order round the edge), flipped if needed
      // so its face points along `normal`. UVs come from world position,
      // so the truss texture lines up across pieces.
      const quad = (grp, A, B, C, D, normal, uvOf) => {
        const ab = new THREE.Vector3().subVectors(B, A), ac = new THREE.Vector3().subVectors(C, A);
        const n = new THREE.Vector3().crossVectors(ab, ac);
        const vs = n.dot(normal) >= 0 ? [A, B, C, A, C, D] : [A, C, B, A, D, C];
        groups[grp].push(...vs.map((v) => [v, uvOf(v)]));
      };
      const V = (x, y, z) => new THREE.Vector3(x, y, z);
      const front = (v) => [v.x / 6, v.y / 6], top = (v) => [v.x / 6, v.z / 6], side = (v) => [v.z / 6, v.y / 6];
      const FRONT = V(0, 0, 1), UP = V(0, 1, 0);
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        if (Math.abs(x1 - x0) < 1e-6) {
          // Vertical step: a steel face between the two heights, facing the lower side.
          if (Math.abs(y1 - y0) < 1e-6) continue;
          const lo = Math.min(y0, y1) - SLAB, hi = Math.max(y0, y1);
          quad(0, V(x0, lo, h), V(x0, hi, h), V(x0, hi, -h), V(x0, lo, -h), V(y1 > y0 ? -1 : 1, 0, 0), side);
          continue;
        }
        quad(0, V(x0, y0, h), V(x1, y1, h), V(x1, y1, -h), V(x0, y0, -h), UP, top);                              // top
        quad(0, V(x0, y0 - SLAB, h), V(x1, y1 - SLAB, h), V(x1, y1, h), V(x0, y0, h), FRONT, front);              // slab band
        quad(1, V(x0, floorY, h), V(x1, floorY, h), V(x1, y1 - SLAB, h), V(x0, y0 - SLAB, h), FRONT, front);      // fill
      }
      // End caps, visible at the edges of gaps.
      const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
      quad(2, V(fx, floorY, h), V(fx, fy, h), V(fx, fy, -h), V(fx, floorY, -h), V(-1, 0, 0), side);
      quad(2, V(lx, floorY, h), V(lx, ly, h), V(lx, ly, -h), V(lx, floorY, -h), V(1, 0, 0), side);

      const geo = new THREE.BufferGeometry();
      let start = 0;
      groups.forEach((list, gi) => {
        for (const [v, t] of list) { pos.push(v.x, v.y, v.z); uv.push(t[0], t[1]); }
        geo.addGroup(start, list.length, gi);
        start += list.length;
      });
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.computeVertexNormals();
      return geo;
    }

    buildSurface(surf, floorY) {
      const g = new THREE.Group();
      const pts = surf.pts;
      let maxX = -Infinity;
      if (!surf.oneway) {
        const mesh = new THREE.Mesh(this.solidGeometry(pts, floorY), [this.mats.steel, this.mats.fill, this.mats.steelDark]);
        mesh.castShadow = mesh.receiveShadow = true;
        g.add(mesh);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        maxX = Math.max(maxX, x0, x1);
        const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
        if (Math.abs(dx) < 1e-6 || len < 0.01) continue; // vertical steps get no cyan edge
        const ang = Math.atan2(dy, dx);
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        const nx = Math.sin(ang), ny = -Math.cos(ang); // "down" into the slab

        if (surf.oneway) {
          // Thin grated platform hanging from rods.
          const thick = surf.thickness || 0.6;
          const slab = this.block(g, this.mats.grate, mx + nx * thick / 2, my + ny * thick / 2, 0, len + 0.02, thick, DEPTH, ang);
          slab.castShadow = slab.receiveShadow = true;
          this.block(g, this.mats.steelDark, x0 + 0.5, my + 7, -2, 0.15, 14, 0.15);
          this.block(g, this.mats.steelDark, x1 - 0.5, my + 7, -2, 0.15, 14, 0.15);
        }

        // Cyan edges along the front and back top corners: solid for
        // ground, dashed for one-way platforms. Plus a soft glow strip on
        // the front face so the drivable line reads at a glance.
        for (const ez of [DEPTH / 2, -DEPTH / 2]) {
          if (surf.oneway) {
            const n = Math.max(2, Math.floor(len / 1.2));
            for (let k = 0; k < n; k += 2) {
              const t = (k + 0.5) / n - 0.5;
              this.block(g, this.mats.edge, mx + Math.cos(ang) * t * len, my + Math.sin(ang) * t * len + 0.02, ez, len / n, 0.1, 0.12, ang);
            }
          } else {
            this.block(g, this.mats.edge, mx, my + 0.02, ez, len + 0.02, 0.12, 0.14, ang);
          }
        }
        const glow = new THREE.Mesh(this.glowGeo, this.mats.edgeGlow);
        glow.scale.set(len, 0.9, 1);
        glow.position.set(mx + nx * 0.3, my + ny * 0.3, DEPTH / 2 + 0.03);
        glow.rotation.z = ang;
        g.add(glow);
      }
      this.track.add(g);
      this.pieces.push({ group: g, x1: maxX });
    }

    // Gold boost pad with chevrons that scroll forward.
    buildPad(pad) {
      const g = new THREE.Group();
      const len = pad.x1 - pad.x0;
      const mat = this.mats.boost.clone();
      mat.map = this.chevron.clone();
      mat.map.needsUpdate = true;
      mat.map.repeat.set(Math.max(1, Math.round(len / 2)), 1);
      mat.toneMapped = false;
      this.boostMats.push(mat);
      this.block(g, mat, (pad.x0 + pad.x1) / 2, pad.y + 0.05, 0, len, 0.1, DEPTH * 0.7);
      this.track.add(g);
      this.pieces.push({ group: g, x1: pad.x1 });
    }

    /* ---------- The occasional rocket launch in the background ---------- */
    updateRocket(dt, camera) {
      this.nextLaunch -= dt;
      if (!this.rocket && this.nextLaunch <= 0) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 12, 10), this.mats.rocket);
        const plume = new THREE.Mesh(new THREE.ConeGeometry(1.6, 9, 10), this.mats.plume);
        plume.rotation.x = Math.PI; plume.position.y = -10.5;
                g.add(body, plume);
        const trail = new THREE.Mesh(this.box, this.mats.contrail);
        // Launch well off to one side, never right behind the action.
        const x = camera.position.x + (Math.random() < 0.5 ? -1 : 1) * (70 + Math.random() * 50);
        g.position.set(x, FLOOR_Y, -240);
        trail.position.set(x, FLOOR_Y, -241);
        this.scene.add(g, trail);
        this.rocket = { g, trail, v: 0, x, life: 0, plume };
      }
      if (this.rocket) {
        const R = this.rocket;
        R.life += dt;
        R.v += 14 * dt;                 // accelerates as it climbs
        R.g.position.y += R.v * dt;
        R.plume.scale.set(1, 0.8 + Math.random() * 0.4, 1);
        // The contrail stretches from the pad to the rocket and fades.
        const h = R.g.position.y - FLOOR_Y;
        R.trail.scale.set(1.8 + R.life * 0.4, h, 1);
        R.trail.position.y = FLOOR_Y + h / 2 - 6;
        this.mats.contrail.opacity = Math.max(0, 0.35 - R.life * 0.015);
        if (R.g.position.y > 400) {
          this.scene.remove(R.g, R.trail);
          this.rocket = null;
          this.nextLaunch = 18 + Math.random() * 16;
          this.mats.contrail.opacity = 0.35;
        }
      }
    }

    /* ---------- Every frame ---------- */
    update(dt, view, camera) {
      this.time += dt;
      // Sky plane: far in front of the camera, sized to fill the view.
      if (this.skyCam) {
        const dist = 800;
        const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.1;
        this.sky.position.set(0, 0, -dist);
        this.sky.scale.set(h * camera.aspect * 1.1, h, 1);
      }
      this.floor.position.x = camera.position.x;
      this.updateLayers(camera);

      // Drop track pieces well behind the trailing edge.
      for (let i = this.pieces.length - 1; i >= 0; i--) {
        if (this.pieces[i].x1 < view.left - 80) {
          this.disposeGroup(this.pieces[i].group);
          this.pieces.splice(i, 1);
        }
      }

      // Key light and its shadow follow the view.
      const cx = (view.left + view.right) / 2, cy = (view.top + view.bottom) / 2;
      this.key.position.set(cx - 14, cy + 30, 40);
      this.key.target.position.set(cx, cy, 0);
      this.fill.position.set(cx, cy + 4, 60);
      this.fill.target.position.set(cx, cy, 0);

      // Animated bits: scrolling boost chevrons, blinking red lights.
      for (const m of this.boostMats) if (m.map && m.map.offset) m.map.offset.x -= dt * 1.8;
      const blink = (Math.sin(this.time * 3) > 0.6);
      this.mats.redA.visible = blink;
      this.mats.redB.visible = Math.sin(this.time * 3 + 2.2) > 0.6;

      this.updateRocket(dt, camera);
    }

    // Remove a group from the scene. Background tiles have their own
    // geometries (cylinders, spheres), so free those; the shared box and
    // shared materials are kept.
    disposeGroup(g) {
      if (g.parent) g.parent.remove(g);
      g.traverse((o) => { if (o.isMesh && o.geometry !== this.box && o.geometry !== this.glowGeo) o.geometry.dispose(); });
    }

    dispose() {
      for (const p of this.pieces) this.disposeGroup(p.group);
      for (const L of this.layers) for (const g of L.tiles.values()) this.disposeGroup(g);
      this.box.dispose();
      Object.values(this.mats).forEach((m) => m.dispose());
      for (const m of this.boostMats) { if (m.map) m.map.dispose(); m.dispose(); }
      this.glowGeo.dispose();
    }
  }

  TP.BRScene = BRScene;
  TP.BR_PALETTE = PAL;
})();
