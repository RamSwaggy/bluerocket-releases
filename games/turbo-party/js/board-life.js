/* =====================================================================
   board-life.js — everything that makes the party board feel alive.
   (Phase 2 of the round 2 roadmap: "better-looking maps, more going on".)

   It adds methods to TP.Board (board.js builds the track and the rules;
   this file only dresses the scene and runs the set pieces):

     buildLife()        called once from the Board constructor:
                          • a sky dome whose colours shift from afternoon
                            to dusk to night as the turns pass
                          • grandstands on three sides with a crowd that
                            bobs and does a stadium wave
                          • floodlight beams, billboards, tyre stacks,
                            traffic cones and bunting along the track
                          • the RAMP over the middle of the Risky Shortcut
                          • the SWING GATE at the fork
                          • the SPARK CANNON (the timed board hazard)
     updateLife(dt)     every frame: crowd wave, gate swing, cannon aim,
                          blinking lights
     setTimeOfDay(k)    0 = sunny afternoon … 1 = night (game.js calls it
                          at the start of every turn)

   Everything here is built from Three.js shapes and canvas drawings made
   in code: no image or model files.
   ===================================================================== */
(function () {
  "use strict";
  const { rand, lerp, clamp } = TP.util;

  /* ---------- Time of day ----------
     Three key moments; setTimeOfDay(k) blends between them.
       top/bottom — sky dome colours (zenith and horizon)
       hemi/sun   — light colours and strengths
       fog        — fog colour (matches the horizon so the edge melts away)
       stars      — how visible the stars are
       lamps      — how bright the floodlight beams are */
  const SKY = [
    { top: 0x3f86e0, bottom: 0xbfe3ff, hemi: 0xdfeaff, hemiI: 1.0, sun: 0xffffff, sunI: 1.7, fog: 0xa9d2f5, stars: 0, lamps: 0 },
    { top: 0x3a3f8f, bottom: 0xff9a5c, hemi: 0xffc9a8, hemiI: 0.85, sun: 0xffb36b, sunI: 1.35, fog: 0xc8826a, stars: 0.25, lamps: 0.03 },
    { top: 0x070b24, bottom: 0x1b2552, hemi: 0x8ea6ff, hemiI: 0.6, sun: 0xb9c8ff, sunI: 0.9, fog: 0x141b3d, stars: 1, lamps: 0.07 },
  ];

  // Billboard slogans: made-up sponsors for a made-up sport.
  const ADS = [
    { text: "TURBO FIZZ", sub: "the drink with a boost", bg: "#ff4d6d", fg: "#fff" },
    { text: "ROCKET RUMBLE", sub: "one car · every mode", bg: "#ffcc33", fg: "#1a1300" },
    { text: "BOLT TYRES", sub: "grip you can trust", bg: "#2f6bff", fg: "#fff" },
    { text: "NITRO NOODLES", sub: "ready in 3-2-1", bg: "#22c55e", fg: "#06240f" },
    { text: "SPARKY'S GARAGE", sub: "we fix what you bump", bg: "#a855f7", fg: "#fff" },
    { text: "GO GO GOLD", sub: "coins? we got coins", bg: "#f97316", fg: "#fff" },
  ];

  const CROWD_COLORS = [0xef4444, 0xf97316, 0xfacc15, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899, 0xffffff, 0x94a3b8];

  const P = TP.Board.prototype;

  P.buildLife = function () {
    this.life = { t: 0, crowd: [], lamps: [], bulbs: [], flags: [] };
    this.buildSky();
    this.buildStands();
    this.buildBillboards();
    this.buildProps();
    this.buildRamp();
    this.buildGate();
    this.buildCannon();
    this.setTimeOfDay(0);
  };

  /* ---------- Sky dome ----------
     A huge sphere seen from the inside, painted with a vertical gradient
     by a tiny shader (horizon colour at the bottom, zenith at the top),
     plus a field of stars that fade in at dusk. */
  P.buildSky = function () {
    const uniforms = {
      top: { value: new THREE.Color(SKY[0].top) },
      bottom: { value: new THREE.Color(SKY[0].bottom) },
    };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(320, 32, 16),
      new THREE.ShaderMaterial({
        uniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: `varying float vH;
          void main() { vH = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying float vH;
          void main() { float k = smoothstep(-0.05, 0.6, vH); gl_FragColor = vec4(mix(bottom, top, k), 1.0); }`,
      })
    );
    dome.renderOrder = -1;
    this.scene.add(dome);
    this.scene.background = null;
    this.life.sky = uniforms;

    const pts = [];
    for (let i = 0; i < 700; i++) {
      // Random points on the upper half of a big sphere.
      const a = rand(0, Math.PI * 2), y = rand(0.12, 1);
      const r = Math.sqrt(1 - y * y) * 300;
      pts.push(Math.cos(a) * r, y * 300, Math.sin(a) * r);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.life.stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.scene.add(this.life.stars);

    // Keep handles on the stadium lights so the time of day can tint them.
    this.scene.traverse((o) => {
      if (o.isHemisphereLight) this.life.hemi = o;
      if (o.isDirectionalLight) this.life.sun = o;
    });
  };

  /* ---------- Grandstands with a crowd ----------
     Three stepped stands outside the loop (west, east and south; the north
     side is kept open for the podium). Each fan is one instance of a tiny
     body+head shape in a random shirt colour. The crowd idles with a
     bounce, and a "wave" rolls around the stadium. cheer() makes them all
     jump for a moment (trophy buys, minigame wins). */
  P.buildStands = function () {
    const stands = [
      { x: -66, z: 4, rot: Math.PI / 2, w: 44 },
      { x: 66, z: 4, rot: -Math.PI / 2, w: 44 },
      { x: 0, z: 50, rot: Math.PI, w: 64 },
    ];
    const standMat = new THREE.MeshStandardMaterial({ color: 0x2c365e, roughness: 0.8 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x3e4a7a, roughness: 0.7 });
    const ROWS = 5, STEP_H = 1.2, STEP_D = 2.2;
    const fans = []; // { x, y, z, phase } in world space
    for (const st of stands) {
      const g = new THREE.Group();
      g.position.set(st.x, 0, st.z);
      g.rotation.y = st.rot;
      // Stepped seating: one long box per row, each higher and further back.
      for (let r = 0; r < ROWS; r++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(st.w, STEP_H * (r + 1), STEP_D), r % 2 ? seatMat : standMat);
        step.position.set(0, STEP_H * (r + 1) / 2, -r * STEP_D);
        step.receiveShadow = true;
        g.add(step);
      }
      // Roof on two posts.
      const roof = new THREE.Mesh(new THREE.BoxGeometry(st.w + 2, 0.5, ROWS * STEP_D + 3), new THREE.MeshStandardMaterial({ color: 0xdfe6ff, roughness: 0.4 }));
      roof.position.set(0, STEP_H * ROWS + 6, -(ROWS - 1) * STEP_D / 2 - 1);
      roof.rotation.x = -0.08;
      g.add(roof);
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, STEP_H * ROWS + 6, 8), standMat);
        post.position.set(sx * (st.w / 2 - 0.5), (STEP_H * ROWS + 6) / 2, -(ROWS - 1) * STEP_D - 0.6);
        g.add(post);
      }
      // A string of party bulbs along the front edge of the roof.
      for (let k = 0; k <= 12; k++) {
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), new THREE.MeshBasicMaterial({ color: [0xffcc33, 0xff5fa2, 0x5fb4ff, 0x7cf08a][k % 4] }));
        bulb.position.set(-st.w / 2 + (k / 12) * st.w, STEP_H * ROWS + 5.4, 1.4);
        g.add(bulb);
        this.life.bulbs.push(bulb);
      }
      this.scene.add(g);
      g.updateMatrixWorld(true);

      // Fans: a few per metre on each row, with some empty seats.
      const v = new THREE.Vector3();
      for (let r = 0; r < ROWS; r++) {
        for (let x = -st.w / 2 + 1; x < st.w / 2 - 0.5; x += 1.25) {
          if (Math.random() < 0.18) continue;
          v.set(x + rand(-0.2, 0.2), STEP_H * (r + 1), -r * STEP_D + 0.2);
          g.localToWorld(v);
          fans.push({ x: v.x, y: v.y, z: v.z, rot: st.rot, phase: Math.atan2(v.z, v.x), bob: rand(0, 6) });
        }
      }
    }

    // One instanced mesh for every fan: a capsule-ish body with a head.
    const bodyGeo = new THREE.CylinderGeometry(0.32, 0.4, 1.0, 6);
    bodyGeo.translate(0, 0.5, 0);
    const headGeo = new THREE.SphereGeometry(0.3, 8, 6);
    headGeo.translate(0, 1.3, 0);
    const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), fans.length);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xf1c7a0, roughness: 0.8 }), fans.length);
    const color = new THREE.Color();
    fans.forEach((f, i) => {
      bodies.setColorAt(i, color.setHex(CROWD_COLORS[i % CROWD_COLORS.length]));
      // Mix of skin tones for the heads.
      heads.setColorAt(i, color.setHex([0xf1c7a0, 0xd9a273, 0xa86b45, 0x6e4529][(i * 7) % 4]));
    });
    this.scene.add(bodies, heads);
    this.life.crowd = { fans, bodies, heads, cheer: 0, m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1), p: new THREE.Vector3(), e: new THREE.Euler() };
    this.updateCrowd(0);
  };

  // Make the whole crowd jump and cheer for `seconds`.
  P.crowdCheer = function (seconds = 1.6) {
    if (this.life && this.life.crowd) this.life.crowd.cheer = Math.max(this.life.crowd.cheer, seconds);
  };

  P.updateCrowd = function (dt) {
    const c = this.life.crowd;
    if (!c || !c.fans) return;
    c.cheer = Math.max(0, c.cheer - dt);
    const t = this.life.t;
    // The wave: a bump that travels around the stadium every ~9 seconds.
    const waveAt = (t * 0.7) % (Math.PI * 2) - Math.PI;
    c.fans.forEach((f, i) => {
      let lift = Math.max(0, Math.sin(t * 3 + f.bob)) * 0.12;            // idle bounce
      const d = Math.abs(TP.util.wrapAngle(f.phase - waveAt));
      if (d < 0.35) lift += (1 - d / 0.35) * 0.9;                         // the wave
      if (c.cheer > 0) lift += Math.abs(Math.sin(t * 9 + f.bob)) * 0.8;  // cheering
      c.p.set(f.x, f.y + lift, f.z);
      c.q.setFromEuler(c.e.set(0, f.rot, 0));
      c.m.compose(c.p, c.q, c.s);
      c.bodies.setMatrixAt(i, c.m);
      c.heads.setMatrixAt(i, c.m);
    });
    c.bodies.instanceMatrix.needsUpdate = true;
    c.heads.instanceMatrix.needsUpdate = true;
  };

  /* ---------- Billboards ----------
     Big boards on legs around the outside, each with a made-up sponsor
     painted on a canvas, facing the middle of the board. */
  P.buildBillboards = function () {
    const spots = [[-40, -38], [40, -38], [-74, -24], [74, -24], [-50, 44], [50, 44]];
    spots.forEach(([x, z], i) => {
      const ad = ADS[i % ADS.length];
      const c = document.createElement("canvas");
      c.width = 512; c.height = 192;
      const g = c.getContext("2d");
      g.fillStyle = ad.bg;
      g.fillRect(0, 0, 512, 192);
      g.fillStyle = "rgba(255,255,255,0.18)";
      for (let s = -192; s < 512; s += 48) { g.beginPath(); g.moveTo(s, 192); g.lineTo(s + 24, 192); g.lineTo(s + 216, 0); g.lineTo(s + 192, 0); g.fill(); }
      g.fillStyle = ad.fg;
      g.textAlign = "center";
      g.font = "900 72px Segoe UI, system-ui, sans-serif";
      g.fillText(ad.text, 256, 100, 480);
      g.font = "700 30px Segoe UI, system-ui, sans-serif";
      g.fillText(ad.sub, 256, 152, 480);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const board = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.BoxGeometry(14, 5.25, 0.4), [
        new THREE.MeshStandardMaterial({ color: 0x222a44 }), new THREE.MeshStandardMaterial({ color: 0x222a44 }),
        new THREE.MeshStandardMaterial({ color: 0x222a44 }), new THREE.MeshStandardMaterial({ color: 0x222a44 }),
        new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }),
        new THREE.MeshStandardMaterial({ color: 0x222a44 }),
      ]);
      panel.position.y = 6;
      panel.castShadow = true;
      board.add(panel);
      for (const sx of [-5, 5]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, 0.4), new THREE.MeshStandardMaterial({ color: 0x5b6585 }));
        leg.position.set(sx, 2, 0);
        board.add(leg);
      }
      board.position.set(x, 0, z);
      board.lookAt(0, 0, 0);
      this.scene.add(board);
    });
  };

  /* ---------- Small props: tyre stacks, cones, bunting, floodlight beams ---------- */
  P.buildProps = function () {
    // Tyre stacks and cones dotted just outside the loop.
    const tyreGeo = new THREE.TorusGeometry(0.55, 0.28, 8, 14);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.9 });
    const coneGeo = new THREE.ConeGeometry(0.45, 1.2, 10);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 });
    for (let k = 0; k < 18; k++) {
      const t = (k + 0.5) / 18;
      const p = this.curve.getPointAt(t);
      const out = new THREE.Vector3(p.x, 0, p.z).normalize().multiplyScalar(4.2).add(p);
      if (k % 3 === 0) {
        for (let h = 0; h < 3; h++) {
          const tyre = new THREE.Mesh(tyreGeo, tyreMat);
          tyre.rotation.x = Math.PI / 2;
          tyre.position.set(out.x, 0.28 + h * 0.5, out.z);
          tyre.castShadow = true;
          this.scene.add(tyre);
        }
      } else {
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.set(out.x, 0.6, out.z);
        cone.castShadow = true;
        this.scene.add(cone);
      }
    }

    // Bunting: a string of little triangle flags between the floodlight
    // poles (built in board.js) at about head height of the poles.
    const flagGeo = new THREE.BufferGeometry();
    flagGeo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0, -0.9, 0], 3));
    flagGeo.computeVertexNormals();
    const poles = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      poles.push(new THREE.Vector3(Math.cos(a) * 58, 14, Math.sin(a) * 42));
    }
    for (let k = 0; k < 6; k++) {
      const a = poles[k], b = poles[(k + 1) % 6];
      for (let f = 1; f < 18; f++) {
        const u = f / 18;
        const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: CROWD_COLORS[f % 7], side: THREE.DoubleSide }));
        flag.position.lerpVectors(a, b, u);
        flag.position.y -= Math.sin(u * Math.PI) * 3; // the string sags in the middle
        flag.lookAt(0, flag.position.y, 0);
        this.scene.add(flag);
        this.life.flags.push(flag);
      }
    }

    // Floodlight beams: soft cones of light from each lamp toward the
    // middle. Barely visible by day, glowing at night.
    for (const p of poles) {
      const lampPos = new THREE.Vector3(p.x, 22, p.z);
      const toMid = new THREE.Vector3(0, 0, 0).sub(lampPos);
      const len = toMid.length() * 0.9;
      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(9, len, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false, fog: false })
      );
      // A cone points up its +Y axis; tip at the lamp, opening toward the middle.
      beam.geometry.translate(0, -len / 2, 0);
      beam.position.copy(lampPos);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), toMid.normalize());
      this.scene.add(beam);
      this.life.lamps.push(beam);
    }
  };

  /* ---------- The jump ramp over the middle of the shortcut ----------
     Two short striped wedges between the shortcut's two middle spaces,
     rising toward each other into a hump. Cars driving the shortcut
     launch off it in a big leap with a barrel roll (see the `ramp` case
     in Board.stepForward). */
  P.buildRamp = function () {
    if (this.shortcutFirst === undefined) return;
    // The two middle shortcut spaces (of 8) are where the jump happens.
    const a = this.spaces[this.shortcutFirst + 3], b = this.spaces[this.shortcutFirst + 4];
    this.rampFrom = a.index;
    this.rampTo = b.index;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, emissive: 0x4a2a00 });
    const stripe = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const dir = b.pos.clone().sub(a.pos);
    const heading = Math.atan2(dir.x, dir.z);
    for (const [s, up] of [[a, 1], [b, -1]]) {
      // A wedge: a box, tilted so it rises toward the gap.
      const g = new THREE.Group();
      const wedge = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.3, 1.5), mat);
      wedge.rotation.x = -0.45 * up;
      wedge.position.y = 0.4;
      g.add(wedge);
      for (const sx of [-1.2, 0, 1.2]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.32, 1.52), stripe);
        st.rotation.x = wedge.rotation.x;
        st.position.set(sx, 0.41, 0);
        g.add(st);
      }
      // Place it just beyond the space, toward the gap.
      // Just past the space's rim (radius 1.9), toward the other space.
      const off = dir.clone().normalize().multiplyScalar(2.7 * up);
      g.position.set(s.pos.x + off.x, 0, s.pos.z + off.z);
      g.rotation.y = heading;
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.scene.add(g);
    }
  };

  /* ---------- The swing gate at the fork ----------
     A striped barrier arm on a post at the fork. It swings across one
     road or the other: when it's across the shortcut, the shortcut is
     CLOSED and everyone must take the main road; when it's across the
     main road, the fork is open both ways (the arm parks along the
     verge). It flips at the end of every round (Board.advanceGate). */
  P.buildGate = function () {
    const fork = this.spaces[this.forkIndex];
    const main = this.spaces[fork.next[0]];
    const sc = this.spaces[this.shortcutFirst];
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 3, 10), new THREE.MeshStandardMaterial({ color: 0x9aa3b8, metalness: 0.5 }));
    post.position.y = 1.5;
    g.add(post);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), new THREE.MeshBasicMaterial({ color: 0x34d399 }));
    lamp.position.y = 3.2;
    g.add(lamp);
    // The arm: red and white blocks.
    const arm = new THREE.Group();
    for (let k = 0; k < 6; k++) {
      const blk = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.35), new THREE.MeshStandardMaterial({ color: k % 2 ? 0xffffff : 0xff3b3b }));
      blk.position.set(0.5 + k * 0.7, 0, 0);
      blk.castShadow = true;
      arm.add(blk);
    }
    arm.position.y = 2.4;
    g.add(arm);
    // Post sits on the outside of the fork, between the two roads.
    const mid = main.pos.clone().add(sc.pos).multiplyScalar(0.5);
    const out = mid.clone().sub(fork.pos).normalize();
    g.position.set(fork.pos.x + out.x * 2.6, 0, fork.pos.z + out.z * 2.6);
    this.scene.add(g);
    // Arm angles that point at each road (arm extends along its local +X).
    const angleTo = (p) => -Math.atan2(p.z - g.position.z, p.x - g.position.x);
    this.gate = { group: g, arm, lamp, angleMain: angleTo(main.pos), angleSc: angleTo(sc.pos), open: true, angle: 0 };
    this.gate.angle = this.gate.angleMain + 0.9; // parked: swung clear of the main road
    arm.rotation.y = this.gate.angle;
  };

  // Is the shortcut open right now?
  P.shortcutOpen = function () {
    return !this.gate || this.gate.open;
  };

  // Flip the gate (between rounds). Returns the new state for a message.
  P.advanceGate = function () {
    if (!this.gate) return true;
    this.gate.open = !this.gate.open;
    return this.gate.open;
  };

  /* ---------- The Spark Cannon (board hazard) ----------
     A big rocket cannon on a turntable in the middle of the board. It
     has a countdown (shown on a little screen on its base). Every round
     it ticks down; at zero it fires a fireball at the stretch of track
     it's aiming at, and every car parked in that zone is blasted 3
     spaces BACK. Then it picks a new target and resets. The target zone
     glows red a full round ahead, so players can see it coming. (The
     rules live in Board.fireCannon in board.js; this is the model.) */
  P.buildCannon = function () {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 1.4, 24), new THREE.MeshStandardMaterial({ color: 0x3a4570, metalness: 0.4, roughness: 0.5 }));
    base.position.y = 0.7;
    g.add(base);
    const turret = new THREE.Group();
    turret.position.y = 1.4;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.8, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5b6aa8, metalness: 0.5, roughness: 0.4 }));
    turret.add(dome);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 4.2, 16), new THREE.MeshStandardMaterial({ color: 0xff5a3c, metalness: 0.3, roughness: 0.4 }));
    barrel.rotation.x = Math.PI / 2 - 0.35; // pointing forward and up a bit
    barrel.position.set(0, 1.2, 1.6);
    turret.add(barrel);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.18, 8, 16), new THREE.MeshStandardMaterial({ color: 0xffcc33, metalness: 0.7 }));
    ring.position.set(0, 1.95, 3.55);
    ring.rotation.x = -0.35;
    turret.add(ring);
    g.add(turret);
    // Countdown screen on the base: a canvas texture, redrawn on change.
    const c = document.createElement("canvas");
    c.width = 128; c.height = 64;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
    screen.scale.set(3.2, 1.6, 1);
    screen.position.set(0, 4.8, 0);
    g.add(screen);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    // It sits at the very middle of the shortcut… which is where the ramp
    // gap is, so it's nudged off to the side of the shortcut road.
    const a = this.spaces[this.shortcutFirst + 3].pos, b = this.spaces[this.shortcutFirst + 4].pos;
    const dir = b.clone().sub(a).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    g.position.copy(a.clone().add(b).multiplyScalar(0.5)).addScaledVector(side, 7);
    g.position.y = 0;
    this.scene.add(g);
    this.cannon = { group: g, turret, barrel, canvas: c, tex, aim: 0, aimTarget: 0, count: 0, zone: [], recoil: 0 };
  };

  // Redraw the cannon's countdown screen.
  P.drawCannonScreen = function (text, color = "#ff5a3c") {
    const cn = this.cannon;
    const g = cn.canvas.getContext("2d");
    g.fillStyle = "#0b1020";
    g.fillRect(0, 0, 128, 64);
    g.strokeStyle = color;
    g.lineWidth = 6;
    g.strokeRect(3, 3, 122, 58);
    g.fillStyle = color;
    g.font = "900 40px Segoe UI, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 64, 35);
    cn.tex.needsUpdate = true;
  };

  /* ---------- Time of day ----------
     k = 0 sunny afternoon, 0.5 sunset, 1 night. Blends sky, fog, lights,
     star visibility and floodlight beams. */
  P.setTimeOfDay = function (k) {
    k = clamp(k, 0, 1);
    const i = k < 0.5 ? 0 : 1;
    const u = k < 0.5 ? k / 0.5 : (k - 0.5) / 0.5;
    const a = SKY[i], b = SKY[i + 1];
    const mix = (x, y) => new THREE.Color(x).lerp(new THREE.Color(y), u);
    const L = this.life;
    L.sky.top.value.copy(mix(a.top, b.top));
    L.sky.bottom.value.copy(mix(a.bottom, b.bottom));
    if (this.scene.fog) this.scene.fog.color.copy(mix(a.fog, b.fog));
    if (L.hemi) { L.hemi.color.copy(mix(a.hemi, b.hemi)); L.hemi.intensity = lerp(a.hemiI, b.hemiI, u); }
    if (L.sun) { L.sun.color.copy(mix(a.sun, b.sun)); L.sun.intensity = lerp(a.sunI, b.sunI, u); }
    L.stars.material.opacity = lerp(a.stars, b.stars, u);
    L.lampOpacity = lerp(a.lamps, b.lamps, u);
    // Beams are hidden entirely by day (even faint, they read as haze).
    for (const beam of L.lamps) { beam.material.opacity = L.lampOpacity; beam.visible = L.lampOpacity > 0.005; }
    this.timeOfDay = k;
  };

  /* ---------- Every frame ---------- */
  P.updateLife = function (dt) {
    const L = this.life;
    if (!L) return;
    L.t += dt;
    this.updateCrowd(dt);
    // Bulbs twinkle in a chase pattern.
    L.bulbs.forEach((b, i) => { b.visible = Math.sin(L.t * 4 - i * 0.7) > -0.6; });
    // Bunting flutters.
    L.flags.forEach((f, i) => { f.rotation.z = Math.sin(L.t * 3 + i) * 0.15; });
    // Gate arm swings smoothly to where it should be; lamp shows the state.
    if (this.gate) {
      const gt = this.gate;
      const target = gt.open ? gt.angleMain + 0.9 : gt.angleSc;
      gt.angle = TP.util.damp(gt.angle, target, 3, dt);
      gt.arm.rotation.y = gt.angle;
      gt.lamp.material.color.setHex(gt.open ? 0x34d399 : 0xff3b3b);
    }
    // Cannon turret turns toward its target; barrel recoils after a shot.
    if (this.cannon) {
      const cn = this.cannon;
      const diff = TP.util.wrapAngle(cn.aimTarget - cn.aim);
      cn.aim += diff * (1 - Math.exp(-2.5 * dt));
      cn.turret.rotation.y = cn.aim;
      cn.recoil = Math.max(0, cn.recoil - dt * 2);
      cn.barrel.position.z = 1.6 - Math.sin(Math.min(1, cn.recoil) * Math.PI) * 0.8;
      // The target zone's warning rings pulse (faster on the final count).
      const speed = cn.count <= 1 ? 10 : 5;
      const pulse = Math.sin(L.t * speed) * 0.5 + 0.5;
      for (const ring of cn.rings || []) {
        ring.material.opacity = 0.45 + pulse * 0.5;
        ring.scale.setScalar(1 + pulse * 0.12);
      }
    }
  };
})();
