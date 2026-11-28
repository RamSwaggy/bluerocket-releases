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

  function build(scene, cfg) {
    cfg = cfg || {};
    // Fall back to the agreed design numbers if a field is missing, so a
    // half-filled config still draws something sensible.
    const W = cfg.arenaW ?? 44;
    const D = cfg.arenaD ?? 28;
    const H = cfg.wallH ?? 1.4;
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
       Four boxes whose INNER faces sit exactly on the play-area edge
       (x = ±W/2, z = ±D/2). The thickness goes outwards. Each wall has a
       pink neon strip along the top and a softer cyan strip at the base. */
    const wallMat = keep(new THREE.MeshStandardMaterial({ color: COL.wall, roughness: 0.5, metalness: 0.3, emissive: 0x0a0c22 }));
    const topMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonA }));
    const baseMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonB, transparent: true, opacity: 0.6 }));
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

    /* ---------- Pillars ----------
       Round posts at the exact {x, z, r} from the config. Dark body, a
       glowing cyan ring on the floor at the base, and a lit cap. Their
       glow brightens for a moment when the ball bounces off them. */
    const pillarFx = [];   // per pillar: { x, z, r, capMat, ringMat, pulse }
    const pillarH = H + 1.2;
    for (const p of pillars) {
      const body = new THREE.Mesh(
        keep(new THREE.CylinderGeometry(p.r, p.r, pillarH, 40)),
        keep(new THREE.MeshStandardMaterial({ color: COL.pillar, roughness: 0.4, metalness: 0.4, emissive: 0x0b0e2a }))
      );
      body.position.set(p.x, pillarH / 2, p.z);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      // Glowing band near the top and a lit cap.
      const capMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonB }));
      const band = new THREE.Mesh(keep(new THREE.CylinderGeometry(p.r + 0.03, p.r + 0.03, 0.14, 40, 1, true)), capMat);
      band.position.set(p.x, pillarH - 0.35, p.z);
      group.add(band);
      const cap = new THREE.Mesh(keep(new THREE.CylinderGeometry(p.r * 0.7, p.r * 0.7, 0.06, 32)), capMat);
      cap.position.set(p.x, pillarH + 0.03, p.z);
      group.add(cap);

      // Halo ring on the floor around the base.
      const ring = floorRing(p.r + 0.05, p.r + 0.55, COL.neonB, 0.35);
      ring.position.set(p.x, Y + 0.004, p.z);
      group.add(ring);

      pillarFx.push({ x: p.x, z: p.z, r: p.r, capMat, ringMat: ring.material, pulse: 0, color: new THREE.Color(COL.neonB) });
    }

    /* ---------- Stand blocks outside the walls (decoration) ----------
       Low dark steps with a dotted light strip, so the edge of the screen
       isn't just empty ground. Purely visual, well outside the walls. */
    const standMat = keep(new THREE.MeshStandardMaterial({ color: 0x121636, roughness: 0.9 }));
    const dotMat = keep(new THREE.MeshBasicMaterial({ color: COL.neonA, transparent: true, opacity: 0.7 }));
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
        group.add(d);
      }
    }
    for (const sx of [-1, 1]) {
      const s = new THREE.Mesh(keep(new THREE.BoxGeometry(STAND, 0.9, D + 2 * (T + 1))), standMat);
      s.position.set(sx * (W / 2 + T + 1 + STAND / 2), 0.45, 0);
      s.receiveShadow = true;
      group.add(s);
    }

    /* ---------- Wall flashes ----------
       When the ball bounces, a bright patch blooms on the wall at the
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
         pos    — where the ball touched (world space, any y)
         normal — the surface normal pointing back INTO the arena
         css    — colour string (e.g. the ball owner's "#3b82f6")
       If the touch is on a pillar, that pillar's glow also flares. */
    function flashWall(pos, normal, css) {
      const color = new THREE.Color(css || "#ffffff");
      const n = new THREE.Vector3(normal ? normal.x : 0, 0, normal ? normal.z : 1);
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      n.normalize();

      // Pillar hit? (contact point close to a pillar's surface)
      let onPillar = null;
      for (const p of pillarFx) {
        const dist = Math.hypot(pos.x - p.x, pos.z - p.z);
        if (dist < p.r + 2.0) { onPillar = p; break; }
      }

      const f = getFlash();
      f.life = f.max = 0.45;
      f.mesh.material.color.copy(color);
      f.mesh.material.opacity = 1;
      f.mesh.visible = true;
      if (onPillar) {
        // Snap the patch onto the pillar surface, facing outwards.
        const dx = pos.x - onPillar.x, dz = pos.z - onPillar.z;
        const len = Math.hypot(dx, dz) || 1;
        f.mesh.position.set(onPillar.x + (dx / len) * (onPillar.r + 0.04), H * 0.6, onPillar.z + (dz / len) * (onPillar.r + 0.04));
        f.mesh.lookAt(f.mesh.position.x + dx, f.mesh.position.y, f.mesh.position.z + dz);
        f.baseScale = Math.min(2.2, onPillar.r * 1.4);
        onPillar.pulse = 1;
        onPillar.color.copy(color);
      } else {
        // Snap onto the nearest wall face so the patch never floats.
        let x = pos.x, z = pos.z;
        if (Math.abs(n.x) > Math.abs(n.z)) x = n.x > 0 ? -W / 2 + 0.03 : W / 2 - 0.03;
        else z = n.z > 0 ? -D / 2 + 0.03 : D / 2 - 0.03;
        f.mesh.position.set(x, H / 2, z);
        f.mesh.lookAt(x + n.x, H / 2, z + n.z);
        f.baseScale = 3.2;
      }
      f.mesh.scale.set(f.baseScale * 0.6, H * 1.1, 1);
    }

    /* ---------- Per-frame animation ---------- */
    let t = 0;
    function update(dt) {
      t += dt;
      // Serve circle breathes slowly.
      serveRing.material.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2.2));
      serveGlow.material.opacity = 0.04 + 0.04 * (0.5 + 0.5 * Math.sin(t * 2.2));

      // Pillars: idle shimmer, plus a flare (in the ball's colour) that fades.
      for (const p of pillarFx) {
        p.pulse = Math.max(0, p.pulse - dt * 2.5);
        const base = new THREE.Color(COL.neonB);
        p.capMat.color.copy(base).lerp(p.color, p.pulse).multiplyScalar(1 + p.pulse * 0.6);
        p.ringMat.opacity = 0.3 + 0.08 * Math.sin(t * 3 + p.x) + p.pulse * 0.6;
        p.ringMat.color.copy(base).lerp(p.color, p.pulse);
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
    }

    scene.add(group);
    return { group, update, flashWall, dispose };
  }

  TP.DuelArena = { build };
})();
