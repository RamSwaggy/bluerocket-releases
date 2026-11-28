/* =====================================================================
   arena.js — how the Deflect Duel arena LOOKS (Art and UI owns this).

   Gameplay does all collisions in duel.js from the same config
   (TP.DUEL_CFG), so this file draws ONLY from those numbers. If the
   config says the play area is 44 × 28 with a pillar of radius 2 at
   (8, 0), that is exactly where the wall faces and the pillar surface
   end up here. Nothing in this file affects physics.

   Usage:
     const arena = TP.DuelArena.build(scene, TP.DUEL_CFG);
     arena.update(dt);                              // every frame
     arena.flashWall(pos, normal, "#ff4fd8");       // ball bounced here
     arena.dispose();                               // when leaving the mode

   Layout (top-down): X runs along the long side (-arenaW/2 .. +arenaW/2),
   Z along the short side (-arenaD/2 .. +arenaD/2), Y is up, the floor
   is at y = 0 and the serve spot is the centre (0, 0).

   Everything here is built in code (geometry, materials and a floor
   texture painted on a canvas), so there are no third-party assets.
   ===================================================================== */
(function () {
  "use strict";

  // The look: a dark navy floor with neon pink/cyan markings, matching
  // the mode's pink/yellow accent from index.html.
  const COL = {
    floor: 0x10152e,
    apron: 0x080a18,      // the ground outside the walls
    wall: 0x1a2048,
    neonA: 0xff4fd8,      // pink: wall tops, centre line
    neonB: 0x38e1ff,      // cyan: border line, pillar rings
    serve: 0xffe14d,      // yellow: the serve circle
    pillar: 0x232a5c,
  };

  /* Paint the floor texture on a canvas: a soft grid of tiles plus a
     faint vignette so the middle reads brighter than the edges. One
     texture pixel ≈ 1/16 of a unit, so grid lines land on whole units. */
  function floorTexture(w, d) {
    const PX = 16;
    const cw = Math.min(2048, Math.round(w * PX));
    const ch = Math.min(2048, Math.round(d * PX));
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    const g = c.getContext("2d");
    const sx = cw / w, sz = ch / d;   // texture pixels per world unit

    // Base colour with a radial glow in the middle.
    g.fillStyle = "#10152e";
    g.fillRect(0, 0, cw, ch);
    const rad = g.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, Math.max(cw, ch) * 0.6);
    rad.addColorStop(0, "rgba(80,90,190,0.35)");
    rad.addColorStop(1, "rgba(0,0,0,0.35)");
    g.fillStyle = rad;
    g.fillRect(0, 0, cw, ch);

    // Grid: a thin line every 2 units, measured out from the centre so
    // the pattern is symmetrical whatever the arena size.
    g.strokeStyle = "rgba(140,160,255,0.10)";
    g.lineWidth = 1.5;
    for (let x = 0; x <= w / 2; x += 2) {
      for (const sgn of [-1, 1]) {
        const px = cw / 2 + sgn * x * sx;
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, ch); g.stroke();
      }
    }
    for (let z = 0; z <= d / 2; z += 2) {
      for (const sgn of [-1, 1]) {
        const pz = ch / 2 + sgn * z * sz;
        g.beginPath(); g.moveTo(0, pz); g.lineTo(cw, pz); g.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  /* A see-through grid tile for the box's walls and ceiling: thin lines
     around the edge of a transparent square, repeated every 2 units. */
  function gridTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(160,175,255,0.9)";
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, 125, 125);
    // A tiny dot in each corner where lines cross, like rivets.
    g.fillStyle = "rgba(255,120,230,0.9)";
    for (const [x, y] of [[0, 0], [128, 0], [0, 128], [128, 128]]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  /* A flat glowing strip lying on the floor, used for neon markings.
     (WebGL lines are always 1 pixel thick, so strips look better.) */
  function floorStrip(len, width, color, opacity) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(len, width),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  // A flat ring on the floor (serve circle, pillar bases).
  function floorRing(inner, outer, color, opacity) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  function build(scene, cfg, duel) {
    cfg = cfg || {};
    // Fall back to the agreed design numbers if a field is missing, so a
    // half-filled config still draws something sensible.
    const W = cfg.arenaW ?? 44;
    const D = cfg.arenaD ?? 28;
    // Wall height: up to the ceiling in the closed box (v2), else the low v1 walls.
    const H = cfg.arenaH || cfg.wallH || 1.4;
    const pillars = cfg.pillars ? (cfg.pillarList || []) : [];
    const T = 1.0;                       // wall thickness (all of it sits OUTSIDE the play area)

    const group = new THREE.Group();
    group.name = "DuelArena";
    const disposables = [];              // geometries/materials/textures to free later
    const keep = (o) => { disposables.push(o); return o; };

    // Night-time backdrop so the neon reads. Only set if the scene has
    // none yet, so main.js can still choose its own.
    if (!scene.background) scene.background = new THREE.Color(0x05060f);
    if (!scene.fog) scene.fog = new THREE.Fog(0x05060f, 70, 140);

    // Shared stadium lighting (same in every mode). Added to our group
    // so dispose() removes it along with the arena.
    TP.addStadiumLights(group, Math.max(W, D));

    /* ---------- Ground ---------- */
    // Big dark apron under everything, so the arena doesn't float in space.
    const apron = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W * 4, D * 4)),
      keep(new THREE.MeshStandardMaterial({ color: COL.apron, roughness: 1 }))
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.02;
    apron.receiveShadow = true;
    group.add(apron);

    // The play floor itself: exactly W × D.
    const floorTex = keep(floorTexture(W, D));
    const floor = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(W, D)),
      keep(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.55, metalness: 0.15 }))
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);

    /* ---------- Neon floor markings ---------- */
    const Y = 0.012; // just above the floor so they don't flicker into it
    // Border line, inset 0.6 from the walls.
    const inset = 0.6, bw = 0.12;
    for (const sz of [-1, 1]) {
      const s = floorStrip(W - inset * 2, bw, COL.neonB, 0.7);
      s.position.set(0, Y, sz * (D / 2 - inset));
      group.add(s);
    }
    for (const sx of [-1, 1]) {
      const s = floorStrip(D - inset * 2, bw, COL.neonB, 0.7);
      s.rotation.z = Math.PI / 2;
      s.position.set(sx * (W / 2 - inset), Y, 0);
      group.add(s);
    }
    // Centre line across the short side, split around the serve circle.
    const SERVE_R = 2.4;
    const halfLine = D / 2 - inset - SERVE_R - 0.4;
    for (const sz of [-1, 1]) {
      const s = floorStrip(halfLine, 0.14, COL.neonA, 0.55);
      s.rotation.z = Math.PI / 2;
      s.position.set(0, Y, sz * (SERVE_R + 0.4 + halfLine / 2));
      group.add(s);
    }
    // Serve circle (pulses gently in update()) plus a centre dot.
    const serveRing = floorRing(SERVE_R - 0.16, SERVE_R, COL.serve, 0.8);
    serveRing.position.y = Y + 0.002;
    group.add(serveRing);
    const serveGlow = floorRing(0, SERVE_R - 0.16, COL.serve, 0.06);
    serveGlow.position.y = Y + 0.001;
    group.add(serveGlow);
    const dot = floorRing(0, 0.3, COL.serve, 0.9);
    dot.position.y = Y + 0.003;
    group.add(dot);
    // Small corner chevrons (decorative arcs in each corner).
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const arc = new THREE.Mesh(
        new THREE.RingGeometry(2.6, 2.75, 24, 1, 0, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: COL.neonA, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide })
      );
      arc.rotation.x = -Math.PI / 2;
      arc.position.set(sx * (W / 2 - inset), Y, sz * (D / 2 - inset));
      // The ring piece starts as a quarter circle covering world +x/-z.
      // Spin it so it opens INTO the arena from its corner: e.g. the
      // (+x, +z) corner needs the quarter covering -x/-z, a quarter turn.
      arc.rotation.z = sx > 0 ? (sz > 0 ? Math.PI / 2 : Math.PI) : (sz > 0 ? 0 : -Math.PI / 2);
      group.add(arc);
    }

    /* ---------- Walls ----------
       Two looks, picked by the config:
         • Low walls (v1, no cfg.arenaH): four solid boxes, pink neon on top.
         • A closed box (v2, cfg.arenaH = ceiling height): walls run up to
           the ceiling. The far wall is solid, the side walls are tinted
           glass, and the NEAR wall (the side the broadcast camera looks
           through, +Z) is just a faint grid, so it never blocks the view.
           Glowing strips trace every edge of the box, and the ceiling is
           a light see-through grid.
       Either way the INNER faces sit exactly on the play-area edge
       (x = ±W/2, z = ±D/2, ceiling at y = arenaH); thickness goes outwards. */
    const BOX = !!cfg.arenaH;
    const wallMat = keep(new THREE.MeshStandardMaterial({ color: COL.wall, roughness: 0.5, metalness: 0.3, emissive: 0x0a0c22 }));
    const topMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonA }));
    const baseMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonB, transparent: true, opacity: 0.6 }));
    if (!BOX) {
      const walls = [
        // [centre x, centre z, length along x, length along z]
        [0, -(D / 2 + T / 2), W + T * 2, T],
        [0, D / 2 + T / 2, W + T * 2, T],
        [-(W / 2 + T / 2), 0, T, D],
        [W / 2 + T / 2, 0, T, D],
      ];
      for (const [cx, cz, lx, lz] of walls) {
        const wall = new THREE.Mesh(keep(new THREE.BoxGeometry(lx, H, lz)), wallMat);
        wall.position.set(cx, H / 2, cz);
        wall.castShadow = true;
        wall.receiveShadow = true;
        group.add(wall);
        const top = new THREE.Mesh(keep(new THREE.BoxGeometry(lx + 0.02, 0.12, lz + 0.02)), topMat);
        top.position.set(cx, H + 0.06, cz);
        group.add(top);
        const base = new THREE.Mesh(keep(new THREE.BoxGeometry(lx + 0.03, 0.08, lz + 0.03)), baseMat);
        base.position.set(cx, 0.05, cz);
        group.add(base);
      }
    } else {
      const gridTex = keep(gridTexture());
      // A grid panel: the texture repeats once every 2 units, whatever the size.
      const gridPanel = (w, h, opacity) => {
        const geo = keep(new THREE.PlaneGeometry(w, h));
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 2, uv.getY(i) * h / 2);
        return new THREE.Mesh(geo, keep(new THREE.MeshBasicMaterial({
          map: gridTex, color: 0x8fa0ff, transparent: true, opacity, depthWrite: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        })));
      };

      // Far wall (z = -D/2): solid and dark, so the action reads against it.
      const far = new THREE.Mesh(keep(new THREE.BoxGeometry(W + T * 2, H, T)), wallMat);
      far.position.set(0, H / 2, -(D / 2 + T / 2));
      far.receiveShadow = true;
      group.add(far);
      const farGrid = gridPanel(W, H, 0.55);
      farGrid.position.set(0, H / 2, -D / 2 + 0.02);
      group.add(farGrid);

      // Side walls (x = ±W/2): tinted glass with the grid on it.
      const glassMat = keep(new THREE.MeshStandardMaterial({
        color: 0x1a2260, transparent: true, opacity: 0.32, roughness: 0.2, metalness: 0.5,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      for (const sx of [-1, 1]) {
        const glass = new THREE.Mesh(keep(new THREE.PlaneGeometry(D, H)), glassMat);
        glass.rotation.y = sx * -Math.PI / 2;
        glass.position.set(sx * W / 2, H / 2, 0);
        group.add(glass);
        const g = gridPanel(D, H, 0.4);
        g.rotation.y = sx * -Math.PI / 2;
        g.position.set(sx * (W / 2 - 0.02), H / 2, 0);
        group.add(g);
      }

      // Near wall (z = +D/2): only a faint grid, the camera looks through it.
      const near = gridPanel(W, H, 0.08);
      near.position.set(0, H / 2, D / 2);
      group.add(near);

      // Ceiling (y = H): a see-through grid, a little brighter than the near wall.
      const ceil = gridPanel(W, D, 0.22);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(0, H, 0);
      group.add(ceil);

      // Glowing edges on all 12 edges of the box: cyan along the floor,
      // pink everywhere else (ceiling edges and the four corners).
      const edge = (lx, ly, lz, x, y, z, mat) => {
        const m = new THREE.Mesh(keep(new THREE.BoxGeometry(lx, ly, lz)), mat);
        m.position.set(x, y, z);
        group.add(m);
      };
      const e = 0.14;
      for (const sz of [-1, 1]) {
        edge(W, 0.08, e, 0, 0.05, sz * D / 2, baseMat);
        edge(W, e, e, 0, H, sz * D / 2, topMat);
      }
      for (const sx of [-1, 1]) {
        edge(e, 0.08, D, sx * W / 2, 0.05, 0, baseMat);
        edge(e, e, D, sx * W / 2, H, 0, topMat);
        for (const sz of [-1, 1]) edge(e, H, e, sx * W / 2, H / 2, sz * D / 2, topMat);
      }
      // A low glowing kick-strip along the bottom of the near side, so its
      // edge still reads even though the wall itself is see-through.
      edge(W, 0.3, 0.06, 0, 0.15, D / 2, keep(new THREE.MeshBasicMaterial({ color: COL.neonB, transparent: true, opacity: 0.35 })));
    }

    /* ---------- Pillars ----------
       Round posts at the exact {x, z, r} from the config. Dark body, a
       glowing cyan ring on the floor at the base, and a lit band. In the
       closed box they run floor to ceiling (with a halo on the ceiling
       too). Their glow brightens for a moment when the ball bounces off. */
    const pillarFx = [];   // per pillar: { x, z, r, capMat, ringMat, pulse }
    const pillarH = BOX ? H : H + 1.2;
    for (const p of pillars) {
      // Every mesh of this pillar, so a moving pillar can carry them all.
      const parts = [];
      const addPart = (m) => { m.userData.bx = m.position.x; m.userData.bz = m.position.z; parts.push(m); group.add(m); };
      const body = new THREE.Mesh(
        keep(new THREE.CylinderGeometry(p.r, p.r, pillarH, 40)),
        keep(new THREE.MeshStandardMaterial({ color: COL.pillar, roughness: 0.4, metalness: 0.4, emissive: 0x0b0e2a }))
      );
      body.position.set(p.x, pillarH / 2, p.z);
      body.castShadow = !BOX;   // tall pillars would throw huge shadows across the box
      body.receiveShadow = true;
      addPart(body);

      // Glowing bands (and a lit cap when the pillar has a top you can see).
      // Transparent so the glow can dim along with the body (pillar x-ray).
      const capMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonB, transparent: true }));
      const bandGeo = keep(new THREE.CylinderGeometry(p.r + 0.03, p.r + 0.03, 0.14, 40, 1, true));
      const bandYs = BOX ? [1.2, H * 0.5, H - 1.2] : [pillarH - 0.35];
      for (const y of bandYs) {
        const band = new THREE.Mesh(bandGeo, capMat);
        band.position.set(p.x, y, p.z);
        addPart(band);
      }
      if (!BOX) {
        const cap = new THREE.Mesh(keep(new THREE.CylinderGeometry(p.r * 0.7, p.r * 0.7, 0.06, 32)), capMat);
        cap.position.set(p.x, pillarH + 0.03, p.z);
        addPart(cap);
      }

      // Halo ring on the floor around the base (and on the ceiling in the box).
      const ring = floorRing(p.r + 0.05, p.r + 0.55, COL.neonB, 0.35);
      ring.position.set(p.x, Y + 0.004, p.z);
      addPart(ring);
      if (BOX) {
        const top = new THREE.Mesh(ring.geometry, ring.material);
        top.rotation.x = Math.PI / 2;
        top.position.set(p.x, H - 0.01, p.z);
        addPart(top);
      }

      // The body can fade to see-through when it blocks the camera's view
      // (see updatePillarFade). Transparent from the start so fading never
      // needs a shader rebuild mid-match.
      body.material.transparent = true;
      pillarFx.push({ x: p.x, z: p.z, bx: p.x, bz: p.z, r: p.r, body, parts, fade: 1, capMat, ringMat: ring.material, pulse: 0, color: new THREE.Color(COL.neonB) });
    }

    /* ---------- Bounce pads (Low Deck) ----------
       Glowing discs on the floor at cfg.pads. They breathe gently and
       flare when something bounces off them (padPulse). */
    const padFx = [];
    for (const pd of cfg.pads || []) {
      const disc = floorRing(0, pd.r, COL.neonA, 0.22);
      disc.position.set(pd.x, Y + 0.006, pd.z);
      group.add(disc);
      const rim = floorRing(pd.r - 0.25, pd.r, 0xffe14d, 0.8);
      rim.position.set(pd.x, Y + 0.008, pd.z);
      group.add(rim);
      const arrow = floorRing(pd.r * 0.25, pd.r * 0.45, 0xffe14d, 0.6);
      arrow.position.set(pd.x, Y + 0.009, pd.z);
      group.add(arrow);
      padFx.push({ pd, disc, rim, arrow, pulse: 0 });
    }

    /* ---------- Stand blocks outside the walls (decoration) ----------
       Low dark steps with a dotted light strip, so the edge of the screen
       isn't just empty ground. Purely visual, well outside the walls. */
    const standMat = keep(new THREE.MeshStandardMaterial({ color: 0x121636, roughness: 0.9 }));
    const dotMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonA, transparent: true, opacity: 0.7 }));
    // The dots are the CROWD: they bounce and glow when the action heats up
    // (see cheer() and the crowd part of update()).
    const crowdDots = [];
    let crowd = 0;                               // excitement, 0..1, decays
    const crowdColor = new THREE.Color(COL.neonA);
    const dotGeo = keep(new THREE.SphereGeometry(0.12, 8, 6));
    const STAND = 3;
    for (const sz of [-1, 1]) {
      const s = new THREE.Mesh(keep(new THREE.BoxGeometry(W + 10, 0.9, STAND)), standMat);
      s.position.set(0, 0.45, sz * (D / 2 + T + 1 + STAND / 2));
      s.receiveShadow = true;
      group.add(s);
      for (let x = -W / 2 - 4; x <= W / 2 + 4; x += 2) {
        const d = new THREE.Mesh(dotGeo, dotMat);
        d.position.set(x, 0.95, sz * (D / 2 + T + 1 + 0.3));
        d.userData.phase = Math.random() * Math.PI * 2;
        crowdDots.push(d);
        group.add(d);
      }
    }
    for (const sx of [-1, 1]) {
      const s = new THREE.Mesh(keep(new THREE.BoxGeometry(STAND, 0.9, D + 2 * (T + 1))), standMat);
      s.position.set(sx * (W / 2 + T + 1 + STAND / 2), 0.45, 0);
      s.receiveShadow = true;
      group.add(s);
    }

    /* ---------- Bounce flashes ----------
       When the ball bounces, a bright patch blooms on the surface at the
       contact point and fades out. Patches are pooled and reused. */
    const flashGeo = keep(new THREE.PlaneGeometry(1, 1));
    const flashes = [];   // { mesh, life, max }
    function getFlash() {
      let f = flashes.find((q) => q.life <= 0);
      if (!f) {
        const mesh = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }));
        disposables.push(mesh.material);
        mesh.visible = false;
        group.add(mesh);
        f = { mesh, life: 0, max: 1 };
        flashes.push(f);
      }
      return f;
    }

    /* flashWall(pos, normal, css)
         pos    — where the ball touched (world space)
         normal — the surface normal pointing back INTO the arena
                  ({x, z} for walls; a big y means the floor or ceiling)
         css    — colour string (e.g. the ball owner's "#3b82f6")
       If the touch is on a pillar, that pillar's glow also flares. */
    function flashWall(pos, normal, css) {
      const color = new THREE.Color(css || "#ffffff");
      const n = new THREE.Vector3(normal ? normal.x || 0 : 0, normal ? normal.y || 0 : 0, normal ? normal.z || 0 : 1);
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      n.normalize();
      // Patch height on a tall wall: centred on the ball, kept on the wall.
      const py = BOX ? Math.max(1.6, Math.min(H - 1.6, pos.y ?? H / 2)) : H / 2;
      const ph = BOX ? 3.2 : H * 1.1;

      const f = getFlash();
      f.life = f.max = 0.45;
      f.mesh.material.color.copy(color);
      f.mesh.material.opacity = 1;
      f.mesh.visible = true;

      // Floor or ceiling bounce (normal mostly up or down).
      if (Math.abs(n.y) > Math.abs(n.x) && Math.abs(n.y) > Math.abs(n.z)) {
        const y = n.y > 0 ? 0.04 : (BOX ? H - 0.04 : 0.04);
        f.mesh.position.set(pos.x, y, pos.z);
        f.mesh.lookAt(pos.x, y + (n.y > 0 ? 1 : -1), pos.z);
        f.baseScale = 3.2;
        f.mesh.scale.set(f.baseScale * 0.6, 3.2, 1);
        f.heightScale = 3.2;
        return;
      }

      // Pillar hit? (contact point close to a pillar's surface)
      let onPillar = null;
      for (const p of pillarFx) {
        const dist = Math.hypot(pos.x - p.x, pos.z - p.z);
        if (dist < p.r + 2.0) { onPillar = p; break; }
      }
      if (onPillar) {
        // Snap the patch onto the pillar surface, facing outwards.
        const dx = pos.x - onPillar.x, dz = pos.z - onPillar.z;
        const len = Math.hypot(dx, dz) || 1;
        const y = BOX ? py : H * 0.6;
        f.mesh.position.set(onPillar.x + (dx / len) * (onPillar.r + 0.04), y, onPillar.z + (dz / len) * (onPillar.r + 0.04));
        f.mesh.lookAt(f.mesh.position.x + dx, y, f.mesh.position.z + dz);
        f.baseScale = Math.min(2.2, onPillar.r * 1.4);
        onPillar.pulse = 1;
        onPillar.color.copy(color);
      } else {
        // Snap onto the nearest wall face so the patch never floats.
        let x = pos.x, z = pos.z;
        if (Math.abs(n.x) > Math.abs(n.z)) x = n.x > 0 ? -W / 2 + 0.03 : W / 2 - 0.03;
        else z = n.z > 0 ? -D / 2 + 0.03 : D / 2 - 0.03;
        f.mesh.position.set(x, py, z);
        f.mesh.lookAt(x + n.x, py, z + n.z);
        f.baseScale = 3.2;
      }
      f.heightScale = ph;
      f.mesh.scale.set(f.baseScale * 0.6, ph, 1);
    }

    /* ---------- Pillar x-ray ----------
       From the broadcast camera a pillar can stand right between you and
       the ball. When it hides the ball or a car, it fades to faint glass
       (its glowing bands stay, so you still see where it is). */
    function updatePillarFade(dt) {
      if (!duel || !duel.camera || !pillarFx.length) return;
      const cam = duel.camera.position;
      // Things worth seeing: the ball and every car on the field.
      const targets = [];
      if (duel.ball) targets.push(duel.ball.pos);
      (duel.players || []).forEach((p, i) => { if (!p.out && p.dead <= 0 && duel.cars[i]) targets.push(duel.cars[i].pos); });
      for (const p of pillarFx) {
        let hides = false;
        for (const tg of targets) {
          // Top-down: how close does the camera→target line pass the pillar's centre?
          const dx = tg.x - cam.x, dz = tg.z - cam.z;
          const len2 = dx * dx + dz * dz || 1;
          const u = ((p.x - cam.x) * dx + (p.z - cam.z) * dz) / len2;   // 0 at camera, 1 at target
          if (u <= 0 || u >= 1) continue;                                // pillar not between them
          const px = cam.x + dx * u - p.x, pz = cam.z + dz * u - p.z;
          if (px * px + pz * pz < (p.r + 1.3) * (p.r + 1.3)) { hides = true; break; }
        }
        const want = hides ? 0.16 : 1;
        p.fade += (want - p.fade) * (1 - Math.exp(-dt * 10));
        p.body.material.opacity = p.fade;
        p.body.material.depthWrite = p.fade > 0.95;   // see-through: don't hide what's behind
      }
    }

    /* ---------- Per-frame animation ---------- */
    let t = 0;
    let serveFlash = 0;   // set to 1 by flashServe()
    function update(dt) {
      t += dt;
      // Serve circle breathes slowly.
      // A fresh serve makes it flare up and settle (serveFlash 1 → 0).
      serveFlash = Math.max(0, serveFlash - dt * 1.6);
      serveRing.material.opacity = Math.min(1, 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2.2)) + serveFlash);
      serveGlow.material.opacity = 0.04 + 0.04 * (0.5 + 0.5 * Math.sin(t * 2.2)) + serveFlash * 0.25;
      serveRing.scale.setScalar(1 + serveFlash * 0.25);

      // Moving pillars (Shifting Pillars): follow the rules' live positions.
      if (duel && duel.pillars) {
        pillarFx.forEach((p, k) => {
          const live = duel.pillars[k];
          if (!live || (live.x === p.x && live.z === p.z)) return;
          p.x = live.x; p.z = live.z;
          const dx = live.x - p.bx, dz = live.z - p.bz;
          for (const m of p.parts) { m.position.x = m.userData.bx + dx; m.position.z = m.userData.bz + dz; }
        });
      }
      // Bounce pads: a gentle breathe, plus a flare after each bounce.
      for (const f of padFx) {
        f.pulse = Math.max(0, f.pulse - dt * 2.2);
        const b = 0.5 + 0.5 * Math.sin(t * 3 + f.pd.x);
        f.disc.material.opacity = 0.16 + 0.08 * b + 0.5 * f.pulse;
        f.rim.material.opacity = 0.6 + 0.2 * b + 0.4 * f.pulse;
        f.arrow.scale.setScalar(1 + 0.25 * b + 0.8 * f.pulse);
      }
      updatePillarFade(dt);
      // Pillars: idle shimmer, plus a flare (in the ball's colour) that fades.
      for (const p of pillarFx) {
        p.pulse = Math.max(0, p.pulse - dt * 2.5);
        const base = new THREE.Color(COL.neonB);
        p.capMat.color.copy(base).lerp(p.color, p.pulse).multiplyScalar(1 + p.pulse * 0.6);
        // When the pillar is see-through (it's in front of the action), its
        // cap, bands and floor halo dim too, so nothing bright sits in the
        // foreground. They keep a faint outline so you still see the pillar.
        const dim = 0.2 + 0.8 * p.fade;
        p.capMat.opacity = dim;
        p.ringMat.opacity = (0.3 + 0.08 * Math.sin(t * 3 + p.x) + p.pulse * 0.6) * (0.15 + 0.85 * p.fade);
        p.ringMat.color.copy(base).lerp(p.color, p.pulse);
      }

      // The crowd: excitement decays; while it's up the dots jump (each
      // with its own rhythm), grow and glow, tinted toward the colour of
      // whoever caused the cheer.
      crowd = Math.max(0, crowd - dt * 0.35);
      dotMat.opacity = 0.55 + 0.45 * crowd;
      dotMat.color.setHex(COL.neonA).lerp(crowdColor, Math.min(1, crowd * 1.2));
      for (const d of crowdDots) {
        const j = Math.max(0, Math.sin(t * (6 + 4 * crowd) + d.userData.phase));
        d.position.y = 0.95 + j * crowd * 0.9;
        d.scale.setScalar(1 + crowd * 0.8);
      }

      // Wall flashes: grow out a little and fade.
      for (const f of flashes) {
        if (f.life <= 0) continue;
        f.life -= dt;
        const k = Math.max(0, f.life / f.max);        // 1 → 0
        f.mesh.material.opacity = k * k;
        f.mesh.scale.x = f.baseScale * (0.6 + (1 - k) * 0.8);
        if (f.life <= 0) f.mesh.visible = false;
      }
    }

    // Remove everything this arena added and free GPU memory.
    function dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if (o.geometry && !disposables.includes(o.geometry)) o.geometry.dispose();
        if (o.material && !disposables.includes(o.material)) o.material.dispose();
      });
      disposables.forEach((d) => d.dispose && d.dispose());
      if (effects) effects.dispose();
    }

    scene.add(group);

    /* The match's moment-to-moment effects (ball glow, swings, hits,
       KOs, camera shake) live in buildEffects() below. They only exist
       when a duel is passed in (the scratch preview has none). */
    const effects = duel ? buildEffects(scene, group, cfg, duel, { flashServe: () => { serveFlash = 1; } }) : null;

    return {
      group,
      update(dt) { update(dt); if (effects) effects.update(dt); },
      // A bounce pad was used: make it flare.
      padPulse(pd) { const f = padFx.find((q) => q.pd.x === pd.x && q.pd.z === pd.z); if (f) f.pulse = 1; },
      // The crowd reacts: amount 0..1 (a big moment = 1), css tints it.
      cheer(amount, css) {
        crowd = Math.min(1, Math.max(crowd, amount));
        if (css) crowdColor.set(css);
      },
      flashWall,
      dispose,
      // duel.js copies these onto duel.hooks.
      hooks: effects ? effects.hooks : undefined,
    };
  }

  /* =====================================================================
     MATCH EFFECTS — everything that makes a hit feel like a hit.
     (Camera framing, shake and zoom are in camera.js.)

     Built once per match by build() when it's given the duel. Nothing in
     here changes the rules: it only READS TP.duel (ball, players, cars,
     freezeLeft) and draws. The rules call our hooks at the right moments:

       onHit(car, ball, speedFrac, smash)  flash, shockwave, sparks, shake
       onSwing(car)                        (the swipe itself is drawn per frame)
       onKO(victim, owner)                 explosion, screen flash, slow-mo
       onClash(carA, carB, ball)           the biggest flash: both colours, "CLASH!"
       onBunt(car, ball)                   flip reset: soft thunk, ring, under-wheel glow
       onBounce(pos, normal)               sparks (v2: floor, walls, ceiling, pillars)
       onWallBounce(pos, normal)           the same, under its v1 name
       onServe()                           serve circle flares, trail resets
       onRespawn(car)                      a light beam where the car appears
       onMatchEnd(result)                  confetti over the winner

     "Speed fraction" (frac) below always means 0 at the base hit speed
     and 1 at the top speed, so every effect scales the same way.
     ===================================================================== */

  // One soft round glow texture (white centre fading to clear), painted
  // in code and shared by every glow sprite.
  let glowTex = null;
  function getGlowTexture() {
    if (glowTex) return glowTex;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    glowTex = new THREE.CanvasTexture(c);
    return glowTex;
  }

  // Glowing materials add light on top of what's behind them (additive
  // blending), so they never look like flat stickers.
  const glowMat = (color, opacity, extra) => new THREE.MeshBasicMaterial(Object.assign({
    color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  }, extra || {}));

  function buildEffects(scene, group, cfg, duel, arenaApi) {
    const C = cfg;
    const disposables = [];
    const keep = (o) => { disposables.push(o); return o; };
    const fx = new TP.FX(scene);                 // shared particle system (sparks, explosions, confetti)
    const tmpColor = new THREE.Color();
    const WHITE = new THREE.Color(0xffffff);

    // Colour helpers: a car's colour comes from its seat (car.index).
    const carColor = (car) => TP.PLAYER_COLORS[car.index] ?? 0xffffff;
    const carCss = (car) => TP.PLAYER_CSS[car.index] ?? "#ffffff";
    const playerOf = (car) => duel.players[duel.cars.indexOf(car)];
    // 0 at base speed, 1 at max speed (0 for a neutral ball).
    const speedFrac = () => {
      const b = duel.ball;
      if (!b || b.neutral) return 0;
      return Math.max(0, Math.min(1, (b.speed - C.baseSpeed) / (C.maxSpeed - C.baseSpeed)));
    };

    /* ---------- Effect clock ----------
       During a hit-freeze the RULES stand still. The effects keep moving,
       but slowly, so a hit "hangs" for a moment and then bursts. After a
       KO the slow-down is stronger: a short slow-motion beat, entirely
       inside the KO pause the rules already have (no extra game time). */
    let koSlow = false;
    const fxTimeScale = () => {
      if (duel.freezeLeft > 0) return koSlow ? 0.22 : 0.35;
      koSlow = false;
      return 1;
    };

    /* =================== The ball =================== */
    const R = C.ballR ?? 0.9;
    const ballY = C.ballY ?? 1.1;
    // A glowing shell around the ball (child of the rules' ball mesh, so
    // it follows the ball and blinks with it while a serve waits).
    const shell = new THREE.Mesh(keep(new THREE.SphereGeometry(R * 1.32, 24, 16)), keep(glowMat(0xffffff, 0.3)));
    // A soft halo sprite that always faces the camera.
    const halo = new THREE.Sprite(keep(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xffffff, transparent: true, opacity: 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })));
    let ballAttached = false;
    function attachToBall() {
      if (ballAttached || !duel.ballMesh) return;
      duel.ballMesh.add(shell);
      duel.ballMesh.add(halo);
      ballAttached = true;
    }

    // A ring and a soft glow on the floor under the ball: shows exactly
    // where the ball is, even when it's fast or a car is in front of it.
    const floorRingB = new THREE.Mesh(keep(new THREE.RingGeometry(R * 0.95, R * 1.25, 40)), keep(glowMat(0xffffff, 0.7, { side: THREE.DoubleSide })));
    floorRingB.rotation.x = -Math.PI / 2;
    floorRingB.position.y = 0.035;
    group.add(floorRingB);
    const floorGlow = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(glowMat(0xffffff, 0.35, { map: getGlowTexture() })));
    floorGlow.rotation.x = -Math.PI / 2;
    floorGlow.position.y = 0.03;
    group.add(floorGlow);
    // A soft dark disc right under the ball: a "shadow" that works at any height.
    const shadow = new THREE.Mesh(keep(new THREE.CircleGeometry(1, 32)), keep(new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false,
    })));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.025;
    shadow.renderOrder = -1;
    group.add(shadow);
    // A faint line from the floor up to a high ball (1 unit tall, scaled to fit).
    const heightLine = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 1, true)), keep(glowMat(0xffffff, 0.2)));
    heightLine.visible = false;
    group.add(heightLine);
    /* Speed streak: a stretched glow along the ball's velocity, so a very
       fast ball reads as a bolt rather than a dot. During a hit-freeze a
       thin "lead line" also shows which way the ball is about to fly. */
    const streak = new THREE.Mesh(keep(new THREE.SphereGeometry(1, 16, 10)), keep(glowMat(0xffffff, 0)));
    streak.visible = false;
    group.add(streak);
    const leadLine = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.07, 0.07, 1, 6, 1, true)), keep(glowMat(0xffffff, 0)));
    leadLine.visible = false;
    group.add(leadLine);
    const velDir = new THREE.Vector3();
    const Y_AXIS = new THREE.Vector3(0, 1, 0);

    /* The trail: a flat ribbon through the ball's recent positions,
       brightest at the ball and fading to nothing. Points older than the
       trail's lifetime drop off, so a faster ball leaves a LONGER trail. */
    const TRAIL_N = 48;
    const trail = [];   // newest first: { x, y, z, age }
    const trailGeo = keep(new THREE.BufferGeometry());
    const tPos = new Float32Array(TRAIL_N * 2 * 3);
    const tCol = new Float32Array(TRAIL_N * 2 * 3);
    trailGeo.setAttribute("position", new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
    trailGeo.setAttribute("color", new THREE.BufferAttribute(tCol, 3).setUsage(THREE.DynamicDrawUsage));
    const tIdx = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2, b2 = a + 1, c = a + 2, d = a + 3;
      tIdx.push(a, b2, c, b2, d, c);
    }
    trailGeo.setIndex(tIdx);
    const trailMesh = new THREE.Mesh(trailGeo, keep(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })));
    trailMesh.frustumCulled = false; // its bounds change every frame
    group.add(trailMesh);

    const segDir = new THREE.Vector3(), toCam = new THREE.Vector3(), side = new THREE.Vector3();
    function updateTrail(dt, frozen, color, frac) {
      const b = duel.ball;
      /* Trail length in world units grows with speed but is capped, so a
         200+ ball leaves a long clean streak instead of a line across the
         whole arena. Point lifetime = length ÷ speed. */
      const spd = Math.max(1, b.speed || 0);
      const lenWanted = Math.min(22, 3 + spd * 0.12);
      // (At least 3 frames' worth, so a slow computer still draws a streak.)
      const life = Math.max(0.05, 3 * dt, Math.min(0.4, lenWanted / spd));
      // The ball jumped further than it could ever move in a frame (a
      // serve, or a test placing it): start a fresh trail, no streak.
      if (trail.length && Math.hypot(trail[0].x - b.pos.x, trail[0].y - b.pos.y, trail[0].z - b.pos.z) > 5) trail.length = 0;
      if (!frozen) {
        for (const p of trail) p.age += dt;
        while (trail.length && trail[trail.length - 1].age > life) trail.pop();
        const head = trail[0];
        if (!head || Math.hypot(head.x - b.pos.x, head.y - b.pos.y, head.z - b.pos.z) > 0.08) {
          trail.unshift({ x: b.pos.x, y: b.pos.y, z: b.pos.z, age: 0 });
          if (trail.length > TRAIL_N) trail.pop();
        }
      }
      const n = trail.length;
      const show = !b.neutral && b.speed > 1 && n > 1;
      trailMesh.visible = show;
      if (!show) return;
      // Width: almost the ball's size at the head, tapering to a point.
      const w0 = R * (0.75 + 0.45 * frac);
      const bright = 0.8 + 0.6 * frac;
      const camPos = duel.camera ? duel.camera.position : null;
      for (let i = 0; i < n; i++) {
        // Direction of the ribbon here (from the next older point).
        const p = trail[i];
        const q = trail[Math.min(n - 1, i + 1)], o = trail[Math.max(0, i - 1)];
        segDir.set(o.x - q.x, o.y - q.y, o.z - q.z);
        if (segDir.lengthSq() < 1e-8) segDir.set(1, 0, 0);
        segDir.normalize();
        // The ribbon's width points across the travel direction AND across
        // the line to the camera, so it always faces the viewer (never
        // edge-on), whichever way the ball flies in 3D.
        if (camPos) toCam.set(camPos.x - p.x, camPos.y - p.y, camPos.z - p.z).normalize();
        else toCam.set(0, 1, 0);
        side.crossVectors(segDir, toCam);
        if (side.lengthSq() < 1e-6) side.set(-segDir.z, 0, segDir.x);
        side.normalize();
        const k = i / (n - 1);                        // 0 at the ball → 1 at the tail
        side.multiplyScalar(w0 * (1 - k));
        const j = i * 6;
        tPos[j] = p.x + side.x; tPos[j + 1] = p.y + side.y; tPos[j + 2] = p.z + side.z;
        tPos[j + 3] = p.x - side.x; tPos[j + 4] = p.y - side.y; tPos[j + 5] = p.z - side.z;
        const f = Math.pow(1 - k, 1.6) * bright;      // fade (additive: darker = more see-through)
        for (const off of [j, j + 3]) {
          tCol[off] = color.r * f; tCol[off + 1] = color.g * f; tCol[off + 2] = color.b * f;
        }
      }
      trailGeo.setDrawRange(0, (n - 1) * 6);
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.attributes.color.needsUpdate = true;
    }

    let ballFlash = 0;   // 1 right after a hit, fading to 0

    function updateBall(dt, rawDt, frozen) {
      attachToBall();
      const b = duel.ball;
      if (!b || !duel.ballMesh) return;
      const frac = speedFrac();
      const neutral = b.neutral;
      /* "Heat": 1 for a freshly struck ball, sliding to 0 as an owned ball
         cools back into a neutral one (v2 rules). The glow softens and the
         colour drifts towards white as it cools. Read from ball.heat if the
         rules provide it; otherwise owned = 1, neutral = 0. */
      const heat = neutral ? 0 : Math.max(0, Math.min(1, b.heat ?? 1));
      // Owner colour, or white for a neutral ball.
      if (b.owner === null || b.owner === undefined) tmpColor.copy(WHITE);
      else tmpColor.setHex(TP.PLAYER_COLORS[duel.players[b.owner].seat]).lerp(WHITE, neutral ? 1 : 0.6 * (1 - heat));
      // Neutral ball pulses gently so it reads as "anyone's"; a cooling
      // ball starts to pulse too, as a warning that it's about to go neutral.
      const pulse = neutral ? 0.6 + 0.4 * Math.sin(t * 6) : 1 - 0.35 * (1 - heat) * (0.5 + 0.5 * Math.sin(t * 10));

      ballFlash = Math.max(0, ballFlash - rawDt * 4);
      // The rules' ball mesh: brighter with speed, white-hot right after a hit.
      const m = duel.ballMesh.material;
      m.emissiveIntensity = (0.45 + 0.7 * frac * (0.4 + 0.6 * heat)) * pulse + ballFlash * 2.5;
      if (!neutral && heat < 1) m.color.lerp(WHITE, 0.6 * (1 - heat));
      if (ballFlash > 0) m.color.lerp(WHITE, ballFlash * 0.8);
      duel.ballMesh.scale.setScalar(1 + ballFlash * 0.35);

      shell.material.color.copy(tmpColor);
      shell.material.opacity = (0.22 + 0.33 * frac) * pulse + ballFlash * 0.4;
      shell.scale.setScalar(1 + 0.15 * frac);
      halo.material.color.copy(tmpColor);
      halo.material.opacity = (0.45 + 0.4 * frac) * pulse + ballFlash * 0.5;
      halo.scale.setScalar(R * (3.4 + 3 * frac + ballFlash * 3));

      /* Reading the ball's height: a ring and glow on the floor straight
         below it (they grow and fade as the ball rises, like a shadow), a
         dark shadow disc, and a faint vertical line once it's up high. */
      const h = Math.max(0, b.pos.y - R);          // gap between the ball and the floor
      const lift = Math.min(1, h / 8);             // 0 on the floor → 1 at 8 units up
      floorRingB.position.x = floorGlow.position.x = shadow.position.x = b.pos.x;
      floorRingB.position.z = floorGlow.position.z = shadow.position.z = b.pos.z;
      floorRingB.material.color.copy(tmpColor);
      floorRingB.material.opacity = (0.55 * pulse + 0.25 * frac) * (1 - 0.4 * lift);
      floorRingB.scale.setScalar(1 + 0.6 * lift);
      floorGlow.material.color.copy(tmpColor);
      floorGlow.material.opacity = (0.3 + 0.35 * frac) * (1 - 0.6 * lift);
      floorGlow.scale.setScalar(R * (4 + 3 * frac) * (1 + 0.5 * lift));
      shadow.material.opacity = 0.5 * (1 - 0.6 * lift);
      shadow.scale.setScalar(R * 2.2 * (1 + 0.8 * lift));
      const showLine = h > 2.5;
      heightLine.visible = showLine;
      if (showLine) {
        heightLine.position.set(b.pos.x, (b.pos.y - R) / 2, b.pos.z);
        heightLine.scale.set(1, b.pos.y - R, 1);
        heightLine.material.color.copy(tmpColor);
        heightLine.material.opacity = 0.22 * Math.min(1, (h - 2.5) / 2);
      }

      // Streak and lead line along the velocity.
      const v = b.vel;
      const spd = b.speed || (v ? v.length() : 0);
      const showStreak = !neutral && v && spd > 30;
      streak.visible = !!showStreak;
      leadLine.visible = false;
      if (showStreak) {
        velDir.copy(v).normalize();
        const len = R + spd * 0.028;                 // 210 → about 6.8 units long
        // Stretch a sphere along its Y axis, turned to point along the velocity,
        // and slide it back so it trails behind the ball.
        streak.quaternion.setFromUnitVectors(Y_AXIS, velDir);
        streak.scale.set(R * 0.9, len / 2, R * 0.9);
        streak.position.copy(b.pos).addScaledVector(velDir, -len / 2 + R * 0.5);
        streak.material.color.copy(tmpColor);
        streak.material.opacity = (0.25 + 0.35 * Math.min(1, spd / 150)) * (0.4 + 0.6 * heat);
        if (duel.freezeLeft > 0.15) {
          // The standoff: show where it's going.
          const ll = 6 + spd * 0.06;
          leadLine.visible = true;
          leadLine.quaternion.copy(streak.quaternion);
          leadLine.scale.set(1, ll, 1);
          leadLine.position.copy(b.pos).addScaledVector(velDir, ll / 2 + R);
          leadLine.material.color.copy(tmpColor);
          leadLine.material.opacity = 0.35 + 0.25 * Math.sin(t * 18);
        }
      }

      updateTrail(dt, frozen, tmpColor, frac);
    }

    /* =================== Pooled one-shot effects =================== */
    // Flat expanding rings (shockwaves), pooled.
    const waveGeo = keep(new THREE.RingGeometry(0.82, 1, 56));
    const waves = [];   // { mesh, t, dur, r0, r1, op }
    /* shockwave(pos, color, startRadius, endRadius, seconds, opacity, floorY)
       With floorY it's a flat ring lying at that height (KOs, serves,
       respawns). Without, it stands up facing the camera at the ball's
       height (hits), so it reads as a burst whichever way the ball flies. */
    function shockwave(pos, color, r0, r1, dur, op, y) {
      let w = waves.find((q) => q.t >= q.dur);
      if (!w) {
        const mesh = new THREE.Mesh(waveGeo, glowMat(0xffffff, 0, { side: THREE.DoubleSide }));
        disposables.push(mesh.material);
        mesh.rotation.x = -Math.PI / 2;
        group.add(mesh);
        w = { mesh, t: 0, dur: 1 };
        waves.push(w);
      }
      Object.assign(w, { t: 0, dur, r0, r1, op });
      w.mesh.material.color.set(color);
      // A standing ring is bigger than the ball is high, so its lower half
      // would vanish under the floor: let it draw over everything instead.
      w.mesh.material.depthTest = y !== undefined;
      w.mesh.renderOrder = y !== undefined ? 0 : 5;
      if (y !== undefined) {
        w.mesh.position.set(pos.x, y, pos.z);
        w.mesh.rotation.set(-Math.PI / 2, 0, 0);
      } else {
        w.mesh.position.set(pos.x, pos.y ?? ballY, pos.z);
        if (duel.camera) w.mesh.quaternion.copy(duel.camera.quaternion);
      }
      w.mesh.scale.setScalar(r0);
      w.mesh.visible = true;
    }

    // Bright flash sprites (the "pop" at the moment of impact), pooled.
    const pops = [];    // { sprite, t, dur, s0, s1 }
    function pop(pos, color, s0, s1, dur) {
      let p = pops.find((q) => q.t >= q.dur);
      if (!p) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: getGlowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        disposables.push(sprite.material);
        group.add(sprite);
        p = { sprite, t: 0, dur: 1 };
        pops.push(p);
      }
      Object.assign(p, { t: 0, dur, s0, s1 });
      p.sprite.material.color.set(color);
      p.sprite.position.set(pos.x, pos.y ?? ballY, pos.z);
      p.sprite.visible = true;
    }

    // Vertical light beams (respawn, winner), pooled.
    const beamGeo = keep(new THREE.CylinderGeometry(1, 1, 1, 32, 1, true));
    const beams = [];   // { mesh, t, dur, follow }
    function beam(car, color, dur, radius, height) {
      let bm = beams.find((q) => q.t >= q.dur);
      if (!bm) {
        const mesh = new THREE.Mesh(beamGeo, glowMat(0xffffff, 0, { side: THREE.DoubleSide }));
        disposables.push(mesh.material);
        group.add(mesh);
        bm = { mesh, t: 0, dur: 1 };
        beams.push(bm);
      }
      Object.assign(bm, { t: 0, dur, car, radius, height });
      bm.mesh.material.color.set(color);
      bm.mesh.visible = true;
    }

    function updatePools(fdt) {
      for (const w of waves) {
        if (w.t >= w.dur) continue;
        w.t += fdt;
        const k = Math.min(1, w.t / w.dur);
        const ease = 1 - Math.pow(1 - k, 3);          // fast out, slow settle
        w.mesh.scale.setScalar(w.r0 + (w.r1 - w.r0) * ease);
        w.mesh.material.opacity = w.op * (1 - k);
        if (k >= 1) w.mesh.visible = false;
      }
      for (const p of pops) {
        if (p.t >= p.dur) continue;
        p.t += fdt;
        const k = Math.min(1, p.t / p.dur);
        p.sprite.scale.setScalar(p.s0 + (p.s1 - p.s0) * k);
        p.sprite.material.opacity = (1 - k) * (1 - k);
        if (k >= 1) p.sprite.visible = false;
      }
      for (const bm of beams) {
        if (bm.t >= bm.dur) continue;
        bm.t += fdt;
        const k = Math.min(1, bm.t / bm.dur);
        const pos = bm.car.pos;
        // Tall and thin at first, then it narrows and fades out.
        const r = bm.radius * (1 - 0.6 * k);
        bm.mesh.scale.set(r, bm.height, r);
        bm.mesh.position.set(pos.x, bm.height / 2, pos.z);
        bm.mesh.material.opacity = 0.55 * (1 - k);
        if (k >= 1) bm.mesh.visible = false;
      }
    }

    /* =================== Per-car extras: swing swipe, shield =================== */
    const carFx = new Map();   // car → { pivot, arcA, arcB, reach, shield }
    const arcGeoA = keep(new THREE.RingGeometry((C.hitRange ?? 3.6) - 1.1, (C.hitRange ?? 3.6) + 0.1, 28, 1, 0, Math.PI * 0.55));
    const arcGeoB = keep(new THREE.RingGeometry((C.hitRange ?? 3.6) - 0.7, (C.hitRange ?? 3.6), 28, 1, 0, Math.PI * 0.9));
    const reachGeo = keep(new THREE.RingGeometry((C.hitRange ?? 3.6) - 0.08, (C.hitRange ?? 3.6), 64));
    const shieldGeo = keep(new THREE.RingGeometry(1.95, 2.2, 48));
    const resetGeo = keep(new THREE.PlaneGeometry(2.4, 3.6));
    function getCarFx(car) {
      let f = carFx.get(car);
      if (f) return f;
      const color = carColor(car);
      const flat = (geo, op) => {
        const m = new THREE.Mesh(geo, glowMat(color, op, { side: THREE.DoubleSide }));
        disposables.push(m.material);
        m.rotation.x = -Math.PI / 2;
        return m;
      };
      // The swipe spins on a pivot just above the floor, under the car.
      const pivot = new THREE.Group();
      pivot.position.y = 0.12;
      const arcA = flat(arcGeoA, 0);   // bright leading blade
      const arcB = flat(arcGeoB, 0);   // dimmer smear behind it
      const reach = flat(reachGeo, 0); // faint circle: how far a swing reaches
      pivot.add(arcA, arcB, reach);
      pivot.visible = false;
      car.mesh.add(pivot);
      const shield = flat(shieldGeo, 0);
      shield.position.y = 0.1;
      shield.visible = false;
      car.mesh.add(shield);
      // Flip-reset cue: a glowing pad under the wheels. It sits in the
      // car BODY's group so it tilts with the car in the air.
      const resetGlow = flat(resetGeo, 0);
      resetGlow.position.y = 0.05;
      resetGlow.visible = false;
      ((car.mesh.userData && car.mesh.userData.body) || car.mesh).add(resetGlow);
      f = { pivot, arcA, arcB, reach, shield, resetGlow, resetT: 0 };
      carFx.set(car, f);
      return f;
    }

    let frameDt = 0;
    function updateCars() {
      duel.players.forEach((p, i) => {
        const car = duel.cars[i];
        const f = getCarFx(car);
        // Hide the rules' placeholder ring: we draw the swipe instead.
        const placeholder = car.mesh.userData.swingRing;
        if (placeholder) placeholder.visible = false;

        const swinging = p.swingT > 0 && !p.out && p.dead <= 0;
        f.pivot.visible = swinging;
        if (swinging) {
          // One full spin over the swing: k goes 0 → 1.
          const k = 1 - p.swingT / (C.swingTime || 0.28);
          const fade = Math.min(1, (1 - k) * 2.2);
          f.arcA.rotation.z = -k * Math.PI * 2;
          f.arcB.rotation.z = -k * Math.PI * 2 + 0.55;
          f.arcA.material.opacity = 0.95 * fade;
          f.arcB.material.opacity = 0.35 * fade;
          f.reach.material.opacity = 0.35 * fade;
        }
        // Flip reset: the under-wheel glow flickers bright, then fades.
        if (f.resetT > 0) {
          f.resetT = Math.max(0, f.resetT - frameDt * 1.4);
          f.resetGlow.visible = f.resetT > 0;
          f.resetGlow.material.opacity = 0.85 * f.resetT * (0.75 + 0.25 * Math.sin(t * 40));
        }
        // Invulnerable after a respawn: a pulsing ring around the car.
        const safe = p.invuln > 0 && !p.out && p.dead <= 0;
        f.shield.visible = safe;
        if (safe) {
          f.shield.material.opacity = 0.35 + 0.35 * Math.sin(t * 14);
          f.shield.scale.setScalar(1 + 0.06 * Math.sin(t * 7));
        }
      });
    }

    /* =================== Camera: shake and zoom ===================
       The shake ("trauma") and the zoom punch live in camera.js
       (TP.DuelCamera), together with the broadcast framing. These two
       helpers just pass our big moments on to it. */
    const addShake = (amount) => { if (TP.DuelCamera) TP.DuelCamera.shake(duel.camera, amount); };
    const punch = (amount) => { if (TP.DuelCamera) TP.DuelCamera.punch(duel.camera, amount); };

    // Sparks where the ball touched a wall, the floor, the ceiling or a pillar.
    function bounceSparks(pos) {
      const b = duel.ball;
      // Put the exact bounce point into the trail, so a fast ball's streak
      // bends at the wall instead of cutting through it between frames.
      if (trail.length) trail.unshift({ x: pos.x, y: pos.y ?? ballY, z: pos.z, age: 0 });
      const frac = speedFrac();
      const color = b.owner === null || b.owner === undefined ? 0xffffff : TP.PLAYER_COLORS[duel.players[b.owner].seat];
      const at = new THREE.Vector3(pos.x, pos.y ?? ballY, pos.z);
      fx.burst(at, [color, 0xffffff], { count: Math.round(5 + 10 * frac), speed: 5 + 8 * frac, up: 1, gravity: 18, life: 0.4, size: 0.18 });
      if (frac > 0.25) addShake(0.08 + 0.25 * frac);
    }

    /* The standoff: a long hit-freeze (fast balls) pushes the camera in on
       the striker and rolls the speed readout up over the freeze. Short
       freezes (slow balls) skip the push-in. */
    let lastStandoffAt = -1;
    function standoff(car, seconds) {
      if (!(seconds > 0)) return;
      if (TP.HUD.rollSpeed) TP.HUD.rollSpeed(Math.min(1.1, Math.max(0.15, seconds * 0.85)));
      const k = Math.max(0, Math.min(1, (seconds - 0.15) / 0.8));
      if (k > 0 && TP.DuelCamera) TP.DuelCamera.focus(duel.camera, car, k);
      lastStandoffAt = t;
    }

    /* =================== Hooks (called by the rules) =================== */
    const hooks = {
      // A strike connected. frac: 0 at base speed → 1 at max. smash: struck while boosting.
      onHit(car, ball, frac, smash, info) {
        const color = carColor(car);
        const pos = ball.pos;
        ballFlash = 1;
        // Freeze length: from the rules if they pass it (info.freeze), else
        // read it straight off the duel (the rules set it just before this hook).
        standoff(car, (info && info.freeze) ?? duel.freezeLeft);
        // Impact pop and a shockwave standing up to face the camera.
        pop(pos, 0xffffff, R * 2, R * (6 + 5 * frac), 0.22);
        shockwave(pos, color, R, R * (4 + 5 * frac), 0.45, 0.9);
        // Sparks in the hitter's colour, more and faster with speed.
        fx.burst(pos, [color, 0xffffff], {
          count: Math.round(12 + 20 * frac), speed: 9 + 12 * frac, up: 1.5, gravity: 16, life: 0.5, size: 0.22,
        });
        addShake(0.25 + 0.55 * frac);
        if (smash) {
          // A Smash: a second, much bigger white ring, a ring across the
          // floor below, more sparks, a punch-in zoom and a light screen flash.
          shockwave(pos, 0xffffff, R * 1.5, R * (10 + 6 * frac), 0.6, 1);
          shockwave(pos, color, R, R * 14, 0.8, 0.6, 0.05);
          pop(pos, color, R * 4, R * 14, 0.35);
          fx.burst(pos, [color, 0xffe14d, 0xffffff], { count: 30, speed: 20, up: 3, gravity: 14, life: 0.7, size: 0.3 });
          addShake(0.5);
          punch(1);
          if (TP.HUD.flash) TP.HUD.flash(carCss(car), 0.18);
        }
      },

      onSwing() { /* the swipe is drawn every frame from swingT (updateCars) */ },

      // If the rules announce a freeze separately: (seconds, car).
      onFreeze(seconds, car) {
        if (t - lastStandoffAt < 0.05) return;   // onHit already handled this one
        standoff(car || null, seconds);
      },

      // Two strikes landed together: both cars bounce off, the ball stays put.
      // The biggest flash in the game, in BOTH strikers' colours.
      onClash(carA, carB, ball) {
        const pos = (ball && ball.pos) || duel.ball.pos;
        const cA = carA ? carColor(carA) : 0xffffff;
        const cB = carB ? carColor(carB) : 0xffffff;
        ballFlash = 1;
        pop(pos, 0xffffff, R * 3, R * 20, 0.45);
        pop(pos, 0xffe14d, R * 2, R * 12, 0.3);
        shockwave(pos, cA, R, R * 10, 0.6, 0.9);
        shockwave(pos, cB, R * 0.6, R * 7.5, 0.5, 0.9);
        shockwave(pos, 0xffffff, R * 2, R * 14, 0.8, 0.6);
        fx.burst(pos, [cA, cB, 0xffffff, 0xffe14d], { count: 50, speed: 22, up: 2, gravity: 12, life: 0.8, size: 0.3 });
        addShake(0.9);
        punch(0.6);
        if (TP.HUD.flash) TP.HUD.flash("#ffffff", 0.4);
        TP.HUD.toast("CLASH!", "#ffe14d", 0.9);
      },

      /* A bunt = a WHEELS-TOUCH FLIP RESET: the car's underside touched
         the ball, and its jump and flip are back. No hit-freeze, so this is
         deliberately soft: a dull thunk, a small ring at the contact, and a
         glow under the car's wheels telling its driver "you can jump again". */
      onBunt(car, ball) {
        const pos = (ball && ball.pos) || duel.ball.pos;
        const color = car ? carColor(car) : 0xffffff;
        ballFlash = 0.35;
        shockwave(pos, color, R * 0.8, R * 3.2, 0.35, 0.55);
        fx.burst(pos, [color, 0xffffff], { count: 8, speed: 3, up: 2, gravity: 9, life: 0.45, size: 0.14 });
        if (car) {
          const f = getCarFx(car);
          f.resetT = 1;             // the under-wheel glow, fading over ~0.7 s
        }
        if (TP.sfx) TP.sfx.play("bump");   // a soft thunk (shared sound)
      },

      // v2: any bounce (floor, walls, ceiling, pillars). The coloured patch
      // on the surface itself comes from arena.flashWall, which the rules
      // call separately; this adds the sparks.
      onBounce(pos) { bounceSparks(pos); },
      // v1 name for the same thing.
      onWallBounce(pos) { bounceSparks(pos); },

      onKO(victim, owner) {
        const vColor = carColor(victim);
        const oColor = owner ? carColor(owner) : 0xffffff;
        const pos = victim.pos.clone();
        pos.y = Math.max(0.8, pos.y + 0.6);   // the car may be in the air
        // The car blows apart in its own colour, with the owner's colour mixed in.
        fx.explosion(pos, vColor);
        fx.burst(pos, [oColor, 0xffffff], { count: 22, speed: 15, up: 5, life: 0.9, size: 0.34 });
        // Rings across the floor below it, plus a burst facing the camera.
        shockwave(pos, oColor, 1, 13, 0.9, 0.9, 0.06);
        shockwave(pos, vColor, 0.5, 7, 0.6, 1, 0.08);
        shockwave(pos, 0xffffff, 1, 9, 0.5, 0.8);
        pop(pos, 0xffffff, 3, 16, 0.4);
        addShake(1.0);
        punch(0.7);
        koSlow = true;           // the KO pause plays as slow motion
        if (TP.HUD.flash) TP.HUD.flash(owner ? carCss(owner) : "#ffffff", 0.32);
      },

      onServe() {
        trail.length = 0;        // the ball teleported: don't streak across the arena
        ballFlash = 0;
        arenaApi.flashServe();
        shockwave({ x: 0, z: 0 }, 0xffe14d, 1, 5, 0.6, 0.7, 0.05);
      },

      onRespawn(car) {
        beam(car, carColor(car), 0.7, 1.6, 9);
        shockwave(car.pos, carColor(car), 0.5, 4, 0.5, 0.9, 0.06);
      },

      onMatchEnd(result) {
        const car = result && duel.cars[result.winner];
        if (!car) return;
        const pos = car.pos.clone();
        pos.y = Math.max(1, pos.y + 1);
        fx.confetti(pos);
        fx.confetti(pos, { count: 40 });
        beam(car, carColor(car), 2.5, 2.2, 14);
      },
    };

    /* =================== Shader warm-up ===================
       The first time a new kind of glowing material is drawn, the GPU
       compiles it, which can hitch the very first hit. So for the first
       couple of frames every pooled effect is drawn once, invisibly
       (opacity 0), to get that out of the way during the countdown. */
    shockwave({ x: 0, y: 1, z: 0 }, 0xffffff, 1, 1, 0.05, 0);
    pop({ x: 0, y: 1, z: 0 }, 0xffffff, 0.01, 0.01, 0.05);
    let warmFrames = 2;

    /* =================== Every frame =================== */
    let t = 0;
    function update(rawDt) {
      t += rawDt;
      const frozen = duel.freezeLeft > 0 || duel.countdown > 0;
      const fdt = rawDt * fxTimeScale();
      if (warmFrames > 0) {
        warmFrames--;
        // Keep the warm-up meshes on screen (invisible) for these frames.
        for (const w of waves) w.mesh.material.opacity = 0;
        for (const p of pops) p.sprite.material.opacity = 0;
      }
      updateBall(fdt, rawDt, frozen);
      frameDt = rawDt;
      updateCars();
      updatePools(fdt);
      fx.update(fdt);
      // The broadcast camera. main.js should call TP.DuelCamera.update()
      // itself; until it does, this keeps the camera working (and stands
      // aside automatically once main.js takes over).
      if (TP.DuelCamera) TP.DuelCamera.auto(duel.camera, duel, rawDt);
    }

    function dispose() {
      fx.dispose();
      disposables.forEach((d) => d && d.dispose && d.dispose());
    }

    return { hooks, update, dispose };
  }

  TP.DuelArena = { build };
})();
