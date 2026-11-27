/* =====================================================================
   view.js — everything you SEE in a Car Fighter match: the stage, the
   side-on camera, the two cars' poses, hit effects, and the HUD refresh.

   The contract (DESIGN.md §9):
     TP.FightView.init(scene, fight)   once per match, after TP.Fight.create
     TP.FightView.frame(state)         once per rendered frame
   match.js (Gameplay) owns the loop and calls these. This file only READS
   fight.state and fight.cars. It never changes the fight. It does own the
   car MESHES (it sets car.manualBodyPose and poses the body itself) and the
   renderer.

   Extra helpers for the menu (main.js):
     TP.FightView.backdrop()   the empty stage with a slow orbiting camera,
                               shown behind the menu until a fight starts

   ---------------------------------------------------------------------
   THE STAGE: "Scrapyard Floodlight League"
   A round steel turntable in a junkyard at night. Its plate slowly turns
   under the cars (only the plate's seams and bolts turn; the cars and the
   fighting line don't move with it). Tyre stacks mark the two walls at
   the ends of the fighting line. Behind: piles of crushed cars, four
   crane floodlights with visible light beams, and a bulb scoreboard that
   lights up in the seat colours as rounds are won.

   THE CAMERA (DESIGN.md §2)
   Side-on. It sits on the +Z side looking toward -Z, so screen-right is
   world +X. It looks at the midpoint between the two cars, a little from
   above, and backs off as they separate so both always fit, with headroom
   for juggles. It never rotates during play. Extras: a short push-in on
   heavy hits, a shake from fx-fight.js, and a slow swing around the
   loser on a KO.
   ===================================================================== */
(function () {
  "use strict";
  const { clamp, damp, wrapAngle } = TP.util;

  const DEFAULT_HALF_WIDTH = 14;  // fighting line half-length if fight.js doesn't tell us
  const PIVOT_Y = 0.7;            // body spins/flips around this height (the car's middle)
  const VFOV = 34;                // camera vertical field of view, degrees

  let renderer = null;
  let aspect = 1;

  // Current match (null between matches).
  let M = null;
  // Menu backdrop (null once a fight starts).
  let B = null;

  /* ---------- Renderer: created on first use, shared by everything ---------- */
  function getRenderer() {
    if (renderer) return renderer;
    const canvas = document.getElementById("game");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const resize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      aspect = w / Math.max(1, h);
    };
    window.addEventListener("resize", resize);
    resize();
    return renderer;
  }

  /* ---------- A tiny seeded random, so the junk piles look the same every load ---------- */
  function seeded(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* =====================================================================
     STAGE
     buildStage(scene, halfWidth) adds the whole set to `scene` and returns
     { update(dt), setWins([w1, w2], colors) }.
     ===================================================================== */
  function buildStage(scene, halfWidth) {
    const R = halfWidth + 4;              // turntable radius: a bit past the walls
    const rnd = seeded(7);
    const root = new THREE.Group();
    scene.add(root);

    scene.background = new THREE.Color(0x070b1a);
    scene.fog = new THREE.Fog(0x070b1a, 55, 150);

    /* ----- Lighting -----
       Cool, dim night fill from the sky; one strong key floodlight from the
       camera side (it casts the shadows); two coloured rim lights from
       behind so the cars' outlines pop against the dark junk. decay = 0
       keeps the spotlights from fading with distance (simpler to tune). */
    root.add(new THREE.HemisphereLight(0x8fa8ff, 0x0b0e18, 0.55));
    const key = new THREE.SpotLight(0xfff1d6, 2.4, 0, 0.55, 0.6, 0);
    key.position.set(0, 30, 26);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 10;
    key.shadow.camera.far = 90;
    key.shadow.bias = -0.0006;
    root.add(key, key.target);
    for (const [x, color] of [[-30, 0xffc98a], [30, 0x9cc2ff]]) {
      const rim = new THREE.SpotLight(color, 2.2, 0, 0.5, 0.7, 0);
      rim.position.set(x, 24, -24);
      rim.target.position.set(x * 0.15, 0, 0);
      root.add(rim, rim.target);
    }

    /* ----- Ground: packed dirt around the turntable ----- */
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(420, 420),
      new THREE.MeshStandardMaterial({ color: 0x15191f, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.62;
    ground.receiveShadow = true;
    root.add(ground);

    /* ----- The turntable ----- */
    const steelDark = new THREE.MeshStandardMaterial({ color: 0x262c38, metalness: 0.6, roughness: 0.6 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.6, R + 1.1, 0.6, 64), steelDark);
    base.position.y = -0.32;
    base.receiveShadow = true;
    root.add(base);

    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 0.12, 72),
      new THREE.MeshStandardMaterial({ color: 0x4b5466, metalness: 0.55, roughness: 0.45 })
    );
    plate.position.y = -0.06;                // top of the plate is exactly y = 0
    plate.receiveShadow = true;
    root.add(plate);

    // The parts of the plate that visibly turn: seams, rings and bolts.
    const spin = new THREE.Group();
    spin.position.y = 0.004;
    root.add(spin);
    const seamMat = new THREE.MeshBasicMaterial({ color: 0x2a303c });
    for (const r of [R * 0.32, R * 0.62, R * 0.9]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.07, r + 0.07, 96), seamMat);
      ring.rotation.x = -Math.PI / 2;
      spin.add(ring);
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const seam = new THREE.Mesh(new THREE.PlaneGeometry(0.12, R * 0.68), seamMat);
      seam.rotation.x = -Math.PI / 2;
      seam.rotation.z = a;
      seam.position.set(Math.sin(a) * R * 0.61, 0.001, Math.cos(a) * R * 0.61);
      spin.add(seam);
    }
    const boltGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 8);
    const boltMat = new THREE.MeshStandardMaterial({ color: 0x8a93a6, metalness: 0.8, roughness: 0.3 });
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const bolt = new THREE.Mesh(boltGeo, boltMat);
      bolt.position.set(Math.sin(a) * (R - 0.5), 0.03, Math.cos(a) * (R - 0.5));
      spin.add(bolt);
    }
    // Centre hub: a raised disc with a painted gear-tooth edge (our league badge).
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 2.2, 0.04, 12),
      new THREE.MeshStandardMaterial({ color: 0xb8362a, metalness: 0.3, roughness: 0.6 })
    );
    hub.position.y = 0.02;
    hub.receiveShadow = true;
    spin.add(hub);

    // Hazard rim: alternating yellow and black blocks around the edge.
    const hazY = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 });
    const hazK = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.8 });
    const rimSegs = 64;
    for (let i = 0; i < rimSegs; i++) {
      const a = (i / rimSegs) * Math.PI * 2;
      const len = (2 * Math.PI * R) / rimSegs;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len * 1.02, 0.22, 0.5), i % 2 ? hazY : hazK);
      seg.position.set(Math.sin(a) * R, 0.06, Math.cos(a) * R);
      seg.rotation.y = a + Math.PI / 2;
      root.add(seg);
    }

    /* ----- Walls: tyre stacks at each end of the fighting line -----
       They're the "rail" the design talks about (wall bounces), so they
       sit just past the line's ends at x = ±(halfWidth + 1.4). */
    const tyreGeo = new THREE.TorusGeometry(0.75, 0.36, 10, 20);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.9 });
    const strapMat = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 });
    for (const side of [-1, 1]) {
      const x = side * (halfWidth + 1.4);
      for (const z of [-3.4, -1.7, 0, 1.7, 3.4]) {
        const tall = z === 0 ? 4 : 3;
        for (let k = 0; k < tall; k++) {
          // The second tyre up in every stack is painted hazard yellow, so the
          // wall reads as a wall from far away.
          const tyre = new THREE.Mesh(tyreGeo, k === 1 ? strapMat : tyreMat);
          tyre.rotation.x = Math.PI / 2;              // lie flat
          tyre.position.set(x + (rnd() - 0.5) * 0.15, 0.36 + k * 0.72, z);
          tyre.castShadow = tyre.receiveShadow = true;
          root.add(tyre);
        }
      }
    }

    /* ----- Crushed-car piles behind and to the sides ----- */
    const junkColors = [0x6b3b3b, 0x3b556b, 0x6b6236, 0x3f6b46, 0x5a5a66, 0x7a4a2a, 0x4a3d5c];
    const junkMats = junkColors.map((c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.35, roughness: 0.75 }));
    const junkGeo = new THREE.BoxGeometry(3.4, 1.1, 1.9);
    function pile(px, pz, count) {
      for (let k = 0; k < count; k++) {
        const box = new THREE.Mesh(junkGeo, junkMats[Math.floor(rnd() * junkMats.length)]);
        box.position.set(px + (rnd() - 0.5) * 1.2, -0.05 + k * 1.05, pz + (rnd() - 0.5) * 1.2);
        box.rotation.set((rnd() - 0.5) * 0.12, rnd() * Math.PI, (rnd() - 0.5) * 0.12);
        box.scale.set(0.85 + rnd() * 0.3, 0.8 + rnd() * 0.4, 0.85 + rnd() * 0.3);
        box.castShadow = true;
        root.add(box);
      }
    }
    for (let i = 0; i < 26; i++) {
      const x = -54 + i * 4.3 + (rnd() - 0.5) * 2;
      const z = -(R + 7) - rnd() * 14;
      // Taller piles further out to the sides frame the centre.
      pile(x, z, 2 + Math.floor(rnd() * 3 + Math.abs(x) / 16));
    }
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) pile(side * (R + 9 + rnd() * 10), -8 + i * 5 + rnd() * 2, 2 + Math.floor(rnd() * 4));
    }

    /* ----- Crane floodlights -----
       Each is a mast, a boom arm leaning in, and a lamp head with a grid of
       glowing panels, plus a faint additive "beam" cone toward the stage. */
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x3a3226, metalness: 0.5, roughness: 0.7 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff4cf });
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff1c4, transparent: true, opacity: 0.05, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const lamps = [];
    for (const [mx, mz] of [[-34, -20], [34, -20], [-20, -34], [20, -34]]) {
      const h = 22;
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.9, h, 0.9), mastMat);
      mast.position.set(mx, h / 2 - 0.6, mz);
      root.add(mast);
      // Cross braces up the mast, so it reads as a lattice crane, not a pole.
      for (let y = 2; y < h - 2; y += 3) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.15, 0.15), mastMat);
        brace.position.set(mx, y, mz);
        brace.rotation.z = 0.5;
        root.add(brace);
      }
      // Boom arm leaning toward the stage centre.
      const toC = new THREE.Vector3(-mx, 0, -mz).normalize();
      const head = new THREE.Vector3(mx + toC.x * 5, h + 1.2, mz + toC.z * 5);
      const boom = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 5.6), mastMat);
      boom.position.set((mx + head.x) / 2, h + 0.6, (mz + head.z) / 2);
      boom.lookAt(head.x, h + 1.2, head.z);
      root.add(boom);
      // Lamp head: a dark box with a 3×2 grid of bright panels, aimed at the stage.
      const lamp = new THREE.Group();
      lamp.position.copy(head);
      lamp.lookAt(0, 0, 0);
      const box = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.2, 0.7), mastMat);
      lamp.add(box);
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 3; c++) {
          const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), lampMat);
          panel.position.set(-1 + c, -0.48 + r * 0.96, 0.36);
          lamp.add(panel);
        }
      }
      root.add(lamp);
      lamps.push(lamp);
      // The beam: an open cone, tip at the lamp, widening toward the stage.
      const target = new THREE.Vector3(mx * 0.12, 0, mz * 0.1);
      const len = head.distanceTo(target);
      const beamGeo = new THREE.ConeGeometry(7, len, 24, 1, true);
      beamGeo.rotateX(-Math.PI / 2);         // tip now points along -Z (back at the lamp after lookAt)
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.copy(head).lerp(target, 0.5);
      beam.lookAt(target);
      beam.renderOrder = 2;
      root.add(beam);
    }

    /* ----- Bulb scoreboard behind the stage -----
       A sign painted onto a canvas texture (works offline, no image files),
       with a row of round bulbs under each side. setWins() lights them. */
    const board = new THREE.Group();
    board.position.set(0, 10.5, -(R + 22));
    root.add(board);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(22, 7.4, 0.8), new THREE.MeshStandardMaterial({ color: 0x1b1712, roughness: 0.8 }));
    board.add(frame);
    const signTex = makeSignTexture();
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(20.5, 3.6), new THREE.MeshBasicMaterial({ map: signTex }));
    sign.position.set(0, 1.4, 0.42);
    board.add(sign);
    for (const lx of [-9, 9]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 10, 0.7), mastMat);
      leg.position.set(lx, -8, 0);
      board.add(leg);
    }
    const bulbGeo = new THREE.SphereGeometry(0.46, 14, 10);
    const bulbs = [[], []];
    for (let side = 0; side < 2; side++) {
      for (let k = 0; k < 3; k++) {
        const mat = new THREE.MeshBasicMaterial({ color: 0x2a2620 });
        const bulb = new THREE.Mesh(bulbGeo, mat);
        // P1 bulbs on the left half, P2 on the right, filling from the centre outwards.
        const x = (side === 0 ? -1 : 1) * (2.2 + k * 1.5);
        bulb.position.set(x, -1.9, 0.5);
        board.add(bulb);
        bulbs[side].push(bulb);
      }
    }
    // A strip of small "chaser" bulbs along the top edge for life.
    const chasers = [];
    for (let i = 0; i < 28; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0x3a3020 });
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), m);
      b.position.set(-10.4 + i * 0.77, 3.45, 0.45);
      board.add(b);
      chasers.push(m);
    }

    /* ----- Night sky: a scatter of stars ----- */
    const starGeo = new THREE.BufferGeometry();
    const starPos = [];
    for (let i = 0; i < 360; i++) {
      const a = rnd() * Math.PI * 2, el = 0.12 + rnd() * 0.9, r = 140;
      starPos.push(Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(a) * Math.cos(el) * r - 20);
    }
    starGeo.setAttribute("position", new THREE.Float32BufferAttribute(starPos, 3));
    root.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xc8d4ff, size: 0.7, fog: false })));

    let t = 0;
    return {
      root,
      update(dt) {
        t += dt;
        spin.rotation.y += dt * 0.05;      // the turntable plate turns, very slowly
        // Chaser bulbs: a warm light running along the top of the board.
        const head = Math.floor(t * 9) % chasers.length;
        chasers.forEach((m, i) => m.color.setHex(((i - head + chasers.length) % 7) === 0 ? 0xffe9a8 : 0x3a3020));
      },
      // wins: [p1Rounds, p2Rounds]; colors: [hex, hex]
      setWins(wins, colors) {
        for (let side = 0; side < 2; side++) {
          bulbs[side].forEach((b, k) => b.material.color.setHex(k < (wins[side] || 0) ? colors[side] : 0x2a2620));
        }
      },
    };
  }

  /* The scoreboard sign: our league name, in warm bulb-yellow, drawn
     once onto a canvas. */
  function makeSignTexture() {
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 180;
    const g = c.getContext("2d");
    g.fillStyle = "#120f0b";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#ffcf5a";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "italic 900 78px 'Segoe UI', system-ui, sans-serif";
    g.shadowColor = "#ff9a3c";
    g.shadowBlur = 24;
    g.fillText("SCRAPYARD", c.width / 2, 62);
    g.font = "700 40px 'Segoe UI', system-ui, sans-serif";
    g.fillStyle = "#f2f5ff";
    g.shadowBlur = 10;
    g.fillText("FLOODLIGHT  LEAGUE", c.width / 2, 132);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* =====================================================================
     CARS
     The fight creates both cars (TP.Car, with the shared mesh). We take
     over posing the body: flips, spins, recoil and knockdowns all happen
     on mesh.userData.body, around a pivot at the car's middle.
     ===================================================================== */
  function prepareCar(car) {
    car.manualBodyPose = true;
    const ud = car.mesh.userData;
    // Move the body's pivot from the ground up to the car's middle, so a
    // flip turns the car over around its centre instead of its tyres.
    if (!ud.cfPivot) {
      ud.body.children.forEach((c) => { c.position.y -= PIVOT_Y; });
      ud.body.position.y = PIVOT_Y;
      ud.cfPivot = true;
    }
    if (ud.marker) ud.marker.visible = false;   // the HUD sides say who's who; the arrow would clutter
    return {
      car,
      body: ud.body,
      yaw: null,            // displayed heading (smoothed when they swap sides)
      pitch: 0, roll: 0, spinY: 0,
      squash: 1,
      tumble: 0,            // continuous flip angle while juggled / thrown
      lastState: "",
    };
  }

  // Total length in frames of a move, from Gameplay's move table if it's there.
  function moveLength(moveId) {
    const T = TP.MOVES;
    if (!T || !moveId) return 30;
    const row = Array.isArray(T) ? T.find((m) => m.id === moveId) : T[moveId];
    if (!row) return 30;
    const n = (row.startup || 0) + (row.active || 0) + (row.recovery || 0);
    return n > 0 ? n : (row.frames || 30);
  }

  // Heading that makes the car face along +X (facing > 0) or -X.
  function facingYaw(facing) {
    if (typeof facing !== "number") return Math.PI / 2;
    if (Math.abs(facing) <= 1.0001) return facing >= 0 ? Math.PI / 2 : -Math.PI / 2;
    return facing; // already an angle
  }

  /* Pose one car's body for this frame from its fight state.
     `frozen` is true during hit-stop: nothing animates, the victim shudders. */
  function poseCar(P, s, dt, frozen, victimShake) {
    const m = P.car.mesh;
    const ease = (k) => 1 - Math.pow(1 - k, 3);

    // Position straight from the fight state (the single source of truth).
    m.position.set(s.x || 0, s.y || 0, s.z || 0);
    if (victimShake) {
      m.position.x += (Math.random() - 0.5) * 0.18;
      m.position.y += (Math.random() - 0.5) * 0.08;
    }
    // Facing: turn smoothly (about 0.15 s) when they swap sides.
    const target = facingYaw(s.facing);
    if (P.yaw === null) P.yaw = target;
    if (!frozen) P.yaw += wrapAngle(target - P.yaw) * (1 - Math.exp(-16 * dt));
    m.rotation.y = P.yaw;

    if (frozen) return; // hold the pose exactly during hit-stop

    let pitch = 0, roll = 0, spinY = 0, squash = 1;
    const st = s.state || "idle";
    const move = String(s.move || "").toLowerCase();
    if (st !== P.lastState) { P.tumble = 0; P.lastState = st; }

    if (st === "attack") {
      const k = clamp((s.moveFrame || 0) / moveLength(s.move), 0, 1);
      // Every attack leans into it; some moves add their own spin.
      pitch = 0.16 * Math.sin(k * Math.PI);
      if (move.includes("tailwhip") || move.includes("spinout")) spinY = ease(k) * Math.PI * 2;
      else if (move.includes("grinder") || move.includes("signature")) spinY = ease(k) * Math.PI * 4;
      else if (move.includes("corkscrew")) roll = ease(k) * Math.PI * 2;
      else if (move.includes("flip")) pitch = -ease(k) * Math.PI * 2;
      else if (move.includes("slam") || move.includes("drop")) pitch = 0.6 * Math.sin(k * Math.PI * 0.5);
      else if (move.includes("ram") || move.includes("dash")) { pitch = 0.22 * Math.sin(k * Math.PI); squash = 1 - 0.08 * Math.sin(k * Math.PI); }
    } else if (st === "hitstun") {
      pitch = -0.25 + Math.sin(performance.now() * 0.05) * 0.04; // nose kicked up, rattling
    } else if (st === "blockstun") {
      pitch = 0.1; squash = 0.88;
    } else if (st === "block") {
      pitch = 0.07; squash = 0.92;    // hunkered down on its suspension
    } else if (st === "juggle" || st === "thrown") {
      P.tumble += dt * (st === "thrown" ? 11 : 8);
      pitch = -P.tumble;              // tumbling end over end
    } else if (st === "knockdown") {
      roll = 1.45;                    // lying on its side
    } else if (st === "wakeup") {
      roll = 0.5;
    } else if (st === "ko") {
      if ((s.y || 0) > 0.3) { P.tumble += dt * 7; pitch = -P.tumble; }
      else roll = Math.PI * 0.92;     // upside down, wheels in the air
    } else if (st === "sidestep") {
      roll = (s.vz || 0) > 0 ? -0.35 : 0.35;
    } else if (st === "air") {
      pitch = clamp(-(s.vy || 0) * 0.04, -0.45, 0.45);
    } else if (st === "walk") {
      squash = 1 + Math.sin(performance.now() * 0.02) * 0.015;
    }

    // Continuous spins are set straight away; settled poses ease in.
    const snap = st === "attack" || st === "juggle" || st === "thrown" || (st === "ko" && (s.y || 0) > 0.3);
    const k = snap ? 1 : 1 - Math.exp(-14 * dt);
    P.pitch += (pitch - P.pitch) * k;
    P.roll += (roll - P.roll) * k;
    P.spinY = snap ? spinY : P.spinY + (spinY - P.spinY) * k;
    P.squash += (squash - P.squash) * (1 - Math.exp(-20 * dt));
    P.body.rotation.set(P.pitch, P.spinY, P.roll, "YXZ");
    P.body.scale.set(1, P.squash, 1);
  }

  /* =====================================================================
     CAMERA
     ===================================================================== */
  function makeCamera() {
    return new THREE.PerspectiveCamera(VFOV, aspect, 0.5, 400);
  }

  /* Work out where the side-on camera wants to be for these two cars. */
  function cameraGoal(a, b) {
    const mx = ((a.x || 0) + (b.x || 0)) / 2;
    const mz = ((a.z || 0) + (b.z || 0)) / 2;
    const sep = Math.abs((a.x || 0) - (b.x || 0));
    const topY = Math.max(a.y || 0, b.y || 0);
    const tanV = Math.tan(THREE.MathUtils.degToRad(VFOV / 2));
    // Width that must fit: the gap between the cars plus a car-and-a-bit
    // either side. Height: from the floor to above the higher car + headroom.
    // (On a tall phone screen the width is what's scarce, so the margin
    // shrinks there and the cars can come closer to the screen edges.)
    const halfW = sep / 2 + (aspect < 1 ? 3.4 : 6);
    const height = topY + 6.5;
    const distW = halfW / (tanV * aspect);
    const distH = (height / 2) / tanV;
    const dist = clamp(Math.max(distW, distH), 15, 70);
    const lookY = 1.4 + topY * 0.45;
    return { mx, mz, dist, lookY };
  }

  /* =====================================================================
     PUBLIC: TP.FightView
     ===================================================================== */
  const FightView = {
    /* The empty stage turning slowly behind the menu. */
    backdrop() {
      if (M || B) return;
      const r = getRenderer();
      const scene = new THREE.Scene();
      const stage = buildStage(scene, DEFAULT_HALF_WIDTH);
      stage.setWins([0, 0], [TP.PLAYER_COLORS[0], TP.PLAYER_COLORS[1]]);
      // Two parked cars facing off, for the poster shot.
      const cars = [0, 1].map((i) => {
        const mesh = TP.buildCarMesh(TP.PLAYER_COLORS[i]);
        mesh.userData.marker.visible = false;
        mesh.position.set(i ? 4.2 : -4.2, 0, 0);
        mesh.rotation.y = i ? -Math.PI / 2 : Math.PI / 2;
        scene.add(mesh);
        return mesh;
      });
      const camera = makeCamera();
      let last = performance.now(), t = 0;
      B = { scene, stage, camera, cars, raf: 0 };
      const loop = (now) => {
        if (!B) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        t += dt;
        stage.update(dt);
        // A slow swing across the front of the stage: a 3/4 view that
        // drifts left and right, never round the back.
        const a = Math.sin(t * 0.12) * 0.7;
        camera.position.set(Math.sin(a) * 30, 8.5, Math.cos(a) * 30);
        camera.lookAt(0, 2.2, 0);
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
        r.render(scene, camera);
        B.raf = requestAnimationFrame(loop);
      };
      B.raf = requestAnimationFrame(loop);
    },

    stopBackdrop() {
      if (!B) return;
      cancelAnimationFrame(B.raf);
      TP.disposeScene(B.scene);
      B = null;
    },

    /* Called by match.js once per match, after the fight is created. */
    init(scene, fight) {
      FightView.stopBackdrop();
      if (M) FightView.dispose();
      getRenderer();

      const arena = fight.arena || TP.FIGHT_ARENA || {};
      const halfWidth = Number(arena.halfWidth) || DEFAULT_HALF_WIDTH;
      const colors = [TP.PLAYER_COLORS[0], TP.PLAYER_COLORS[1]];
      const camera = makeCamera();
      const stage = buildStage(scene, halfWidth);
      const fx = new TP.FightFX(scene, camera, colors);
      const cars = (fight.cars || []).map(prepareCar);

      M = {
        scene, fight, camera, stage, fx, cars, colors,
        cam: null,              // smoothed camera goal
        last: performance.now(),
        koT: 0, koVictim: -1,   // KO camera swing
        lastHit: null,
      };

      // Effects, sounds and camera kicks come from fight events.
      if (typeof fight.onEvent === "function") {
        fight.onEvent((ev) => {
          if (!M || M.fight !== fight) return;
          M.fx.onEvent(ev);
          playEventSound(ev);
          if (ev.type === "ko") { M.koT = 0; M.koVictim = ev.victim != null ? ev.victim : ev.attacker === 0 ? 1 : 0; }
        });
      }

      TP.FightUI.startMatch();
      FightView.frame(fight.state);
    },

    /* Called by match.js once per rendered frame: frame(state, dt, fight).
       We time our own animations with the real clock below, so dt and
       fight aren't needed. */
    frame(state) {
      if (!M || !state) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - M.last) / 1000);
      M.last = now;

      const cs = state.cars || [];
      const frozen = state.phase === "hitstop";
      // During hit-stop, the car that got hit shudders on the spot.
      M.cars.forEach((P, i) => {
        const s = cs[i] || {};
        const victimShake = frozen && (s.state === "hitstun" || s.state === "blockstun" || s.state === "juggle");
        poseCar(P, s, dt, frozen, victimShake);
      });

      M.stage.update(dt);
      M.stage.setWins(state.roundWins || [0, 0], M.colors);
      M.fx.update(dt);
      updateCamera(state, dt);

      TP.FightUI.update(state, dt);

      const r = getRenderer();
      M.camera.aspect = aspect;
      M.camera.updateProjectionMatrix();
      r.render(M.scene, M.camera);
    },

    /* Free the current match's GPU memory (before a rematch). */
    dispose() {
      if (!M) return;
      // Only what the view added: the stage set and the effects. The cars
      // and the scene itself belong to the fight / match.js.
      M.fx.dispose();
      M.scene.remove(M.stage.root);
      TP.disposeScene(M.stage.root);
      M = null;
    },

    // For tests and debugging: the live camera and the current match.
    get camera() { return M ? M.camera : B ? B.camera : null; },
    get match() { return M; },
  };

  function updateCamera(state, dt) {
    const cs = state.cars || [];
    if (cs.length < 2) return;
    const goal = cameraGoal(cs[0], cs[1]);
    if (!M.cam) M.cam = Object.assign({}, goal);
    // Smooth follow: quick sideways, slower zoom (zoom changes feel big).
    M.cam.mx = damp(M.cam.mx, goal.mx, 6, dt);
    M.cam.mz = damp(M.cam.mz, goal.mz, 4, dt);
    M.cam.lookY = damp(M.cam.lookY, goal.lookY, 4, dt);
    M.cam.dist = damp(M.cam.dist, goal.dist, goal.dist > M.cam.dist ? 5 : 2.5, dt);

    // Heavy-hit push-in: up to 12% closer, easing back out.
    // Never closer than 15 units, so a push-in can't fill the screen.
    let dist = Math.max(15, M.cam.dist * (1 - 0.12 * M.fx.kick));
    let ang = 0;

    // KO: swing slowly round the loser for a moment while the round ends.
    const koing = state.phase === "roundEnd" && M.koVictim >= 0;
    if (koing) {
      M.koT += dt;
      ang = Math.sin(Math.min(M.koT, 3) * 0.5) * 0.5;
      dist = Math.max(dist, 18);      // a wider shot so the whole wreck is in frame
    } else {
      M.koVictim = -1;
    }
    const cx = M.cam.mx, cz = M.cam.mz;
    const height = dist * 0.2;
    M.camera.position.set(cx + Math.sin(ang) * dist, M.cam.lookY + height, cz + Math.cos(ang) * dist);
    M.camera.lookAt(cx, M.cam.lookY, cz);
    // Shake is applied after aiming, as a small sideways/up jolt.
    const sh = M.fx.shakeOffset();
    M.camera.position.add(sh);
  }

  /* Placeholder sounds from the shared synth (proper fight sounds come in
     sfx-fight.js, M2). Pitch rises with combo length on hits. */
  function playEventSound(ev) {
    if (!TP.sfx) return;
    if (ev.type === "hit" || ev.type === "throw") {
      const tier = TP.FightFX.hitTier(ev);
      if (tier === 0) TP.sfx.play("hit", 0.15 + Math.min(0.5, (ev.combo || 0) * 0.08));
      else TP.sfx.play("bump");
      if (tier === 2) TP.sfx.play("ko");
    } else if (ev.type === "block") {
      TP.sfx.play("tick");
      TP.sfx.play("swing");
    } else if (ev.type === "whiff") {
      TP.sfx.play("swing");
    } else if (ev.type === "ko") {
      TP.sfx.play("ko");
    }
  }

  TP.FightView = FightView;
})();
