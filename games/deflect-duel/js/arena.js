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

  function build(scene, cfg, duel) {
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
    let serveFlash = 0;   // set to 1 by flashServe()
    function update(dt) {
      t += dt;
      // Serve circle breathes slowly.
      // A fresh serve makes it flare up and settle (serveFlash 1 → 0).
      serveFlash = Math.max(0, serveFlash - dt * 1.6);
      serveRing.material.opacity = Math.min(1, 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2.2)) + serveFlash);
      serveGlow.material.opacity = 0.04 + 0.04 * (0.5 + 0.5 * Math.sin(t * 2.2)) + serveFlash * 0.25;
      serveRing.scale.setScalar(1 + serveFlash * 0.25);

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
      flashWall,
      dispose,
      // duel.js copies these onto duel.hooks.
      hooks: effects ? effects.hooks : undefined,
    };
  }

  /* =====================================================================
     MATCH EFFECTS — everything that makes a hit feel like a hit.

     Built once per match by build() when it's given the duel. Nothing in
     here changes the rules: it only READS TP.duel (ball, players, cars,
     freezeLeft) and draws. The rules call our hooks at the right moments:

       onHit(car, ball, speedFrac, smash)  flash, shockwave, sparks, shake
       onSwing(car)                        (the swipe itself is drawn per frame)
       onKO(victim, owner)                 explosion, screen flash, slow-mo
       onWallBounce(pos, normal)           small sparks, a little shake
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

    /* The trail: a flat ribbon through the ball's recent positions,
       brightest at the ball and fading to nothing. Points older than the
       trail's lifetime drop off, so a faster ball leaves a LONGER trail. */
    const TRAIL_N = 48;
    const trail = [];   // newest first: { x, z, age }
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

    function updateTrail(dt, frozen, color, frac) {
      const b = duel.ball;
      const life = 0.12 + 0.28 * frac;                 // seconds a point lives
      // The ball jumped further than it could ever move in a frame (a
      // serve, or a test placing it): start a fresh trail, no streak.
      if (trail.length && Math.hypot(trail[0].x - b.pos.x, trail[0].z - b.pos.z) > 5) trail.length = 0;
      if (!frozen) {
        for (const p of trail) p.age += dt;
        while (trail.length && trail[trail.length - 1].age > life) trail.pop();
        const head = trail[0];
        if (!head || Math.hypot(head.x - b.pos.x, head.z - b.pos.z) > 0.08) {
          trail.unshift({ x: b.pos.x, z: b.pos.z, age: 0 });
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
      for (let i = 0; i < n; i++) {
        // Direction of the ribbon here (from the next older point).
        const p = trail[i];
        const q = trail[Math.min(n - 1, i + 1)], o = trail[Math.max(0, i - 1)];
        let dx = o.x - q.x, dz = o.z - q.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const k = i / (n - 1);                        // 0 at the ball → 1 at the tail
        const w = w0 * (1 - k);
        const px = -dz * w, pz = dx * w;              // sideways from the travel direction
        const j = i * 6;
        tPos[j] = p.x + px; tPos[j + 1] = ballY; tPos[j + 2] = p.z + pz;
        tPos[j + 3] = p.x - px; tPos[j + 4] = ballY; tPos[j + 5] = p.z - pz;
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
      // Owner colour, or white for a neutral ball.
      if (neutral || b.owner === null) tmpColor.copy(WHITE);
      else tmpColor.setHex(TP.PLAYER_COLORS[duel.players[b.owner].seat]);
      // Neutral ball pulses gently so it reads as "anyone's".
      const pulse = neutral ? 0.6 + 0.4 * Math.sin(t * 6) : 1;

      ballFlash = Math.max(0, ballFlash - rawDt * 4);
      // The rules' ball mesh: brighter with speed, white-hot right after a hit.
      const m = duel.ballMesh.material;
      m.emissiveIntensity = (0.45 + 0.7 * frac) * pulse + ballFlash * 2.5;
      if (ballFlash > 0) m.color.lerp(WHITE, ballFlash * 0.8);
      duel.ballMesh.scale.setScalar(1 + ballFlash * 0.35);

      shell.material.color.copy(tmpColor);
      shell.material.opacity = (0.22 + 0.33 * frac) * pulse + ballFlash * 0.4;
      shell.scale.setScalar(1 + 0.15 * frac);
      halo.material.color.copy(tmpColor);
      halo.material.opacity = (0.45 + 0.4 * frac) * pulse + ballFlash * 0.5;
      halo.scale.setScalar(R * (3.4 + 3 * frac + ballFlash * 3));

      floorRingB.position.x = floorGlow.position.x = b.pos.x;
      floorRingB.position.z = floorGlow.position.z = b.pos.z;
      floorRingB.material.color.copy(tmpColor);
      floorRingB.material.opacity = 0.55 * pulse + 0.25 * frac;
      floorGlow.material.color.copy(tmpColor);
      floorGlow.material.opacity = 0.3 + 0.35 * frac;
      floorGlow.scale.setScalar(R * (4 + 3 * frac));

      updateTrail(dt, frozen, tmpColor, frac);
    }

    /* =================== Pooled one-shot effects =================== */
    // Flat expanding rings (shockwaves), pooled.
    const waveGeo = keep(new THREE.RingGeometry(0.82, 1, 56));
    const waves = [];   // { mesh, t, dur, r0, r1, op }
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
      w.mesh.position.set(pos.x, y ?? ballY, pos.z);
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
      p.sprite.position.set(pos.x, ballY, pos.z);
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
      f = { pivot, arcA, arcB, reach, shield };
      carFx.set(car, f);
      return f;
    }

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
       "Trauma" goes up on big moments and drains away; the shake is
       trauma squared, so small bumps barely move and big ones really
       rattle. The camera is nudged sideways (not turned), so the arena
       never tilts. Zoom narrows the field of view for a smash or KO. */
    let trauma = 0, zoom = 0, base = null;
    const addShake = (amount) => { trauma = Math.min(1.2, trauma + amount); };
    function updateCamera(rawDt) {
      const cam = duel.camera;
      if (!cam) return;
      if (!base) base = { pos: cam.position.clone(), fov: cam.fov };
      trauma = Math.max(0, trauma - rawDt * 1.6);
      zoom = Math.max(0, zoom - rawDt * 2.2);
      const s = trauma * trauma * 1.1;
      cam.position.set(
        base.pos.x + s * (Math.sin(t * 61) + 0.5 * Math.sin(t * 97)) * 0.6,
        base.pos.y + s * Math.sin(t * 73) * 0.3,
        base.pos.z + s * (Math.sin(t * 53 + 1.3) + 0.5 * Math.sin(t * 89)) * 0.6
      );
      // Ease in/out so the zoom feels like a punch, not a jump.
      const z = zoom * zoom * (3 - 2 * zoom);
      cam.fov = base.fov - 6 * z;
      cam.updateProjectionMatrix();
    }

    /* =================== Hooks (called by the rules) =================== */
    const hooks = {
      onHit(car, ball, frac, smash) {
        const color = carColor(car);
        const pos = ball.pos;
        ballFlash = 1;
        // Impact pop and a shockwave on the floor plane at ball height.
        pop(pos, 0xffffff, R * 2, R * (6 + 5 * frac), 0.22);
        shockwave(pos, color, R, R * (4 + 5 * frac), 0.45, 0.9);
        // Sparks in the hitter's colour, more and faster with speed.
        fx.burst(pos, [color, 0xffffff], {
          count: Math.round(12 + 20 * frac), speed: 9 + 12 * frac, up: 1.5, gravity: 16, life: 0.5, size: 0.22,
        });
        addShake(0.25 + 0.55 * frac);
        if (smash) {
          // A Smash: a second, much bigger white ring, more sparks, a punch-in zoom.
          shockwave(pos, 0xffffff, R * 1.5, R * (10 + 6 * frac), 0.6, 1);
          shockwave(pos, color, R, R * 14, 0.8, 0.6, 0.05);
          pop(pos, color, R * 4, R * 14, 0.35);
          fx.burst(pos, [color, 0xffe14d, 0xffffff], { count: 30, speed: 20, up: 3, gravity: 14, life: 0.7, size: 0.3 });
          addShake(0.5);
          zoom = 1;
          if (TP.HUD.flash) TP.HUD.flash(carCss(car), 0.18);
        }
      },

      onSwing() { /* the swipe is drawn every frame from swingT (updateCars) */ },

      onKO(victim, owner) {
        const vColor = carColor(victim);
        const oColor = owner ? carColor(owner) : 0xffffff;
        const pos = victim.pos.clone();
        pos.y = 0.8;
        // The car blows apart in its own colour, with the owner's colour mixed in.
        fx.explosion(pos, vColor);
        fx.burst(pos, [oColor, 0xffffff], { count: 22, speed: 15, up: 5, life: 0.9, size: 0.34 });
        shockwave(pos, oColor, 1, 13, 0.9, 0.9, 0.06);
        shockwave(pos, vColor, 0.5, 7, 0.6, 1, 0.08);
        pop(pos, 0xffffff, 3, 16, 0.4);
        addShake(1.0);
        zoom = Math.max(zoom, 0.7);
        koSlow = true;           // the KO pause plays as slow motion
        if (TP.HUD.flash) TP.HUD.flash(owner ? carCss(owner) : "#ffffff", 0.32);
      },

      onWallBounce(pos, normal) {
        const b = duel.ball;
        const frac = speedFrac();
        const color = b.owner === null ? 0xffffff : TP.PLAYER_COLORS[duel.players[b.owner].seat];
        const at = new THREE.Vector3(pos.x, ballY, pos.z);
        fx.burst(at, [color, 0xffffff], { count: Math.round(5 + 10 * frac), speed: 5 + 8 * frac, up: 1, gravity: 18, life: 0.4, size: 0.18 });
        if (frac > 0.25) addShake(0.08 + 0.25 * frac);
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
        pos.y = 1;
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
    shockwave({ x: 0, z: 0 }, 0xffffff, 1, 1, 0.05, 0);
    pop({ x: 0, z: 0 }, 0xffffff, 0.01, 0.01, 0.05);
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
      updateCars();
      updatePools(fdt);
      fx.update(fdt);
      updateCamera(rawDt);
    }

    function dispose() {
      fx.dispose();
      disposables.forEach((d) => d && d.dispose && d.dispose());
    }

    return { hooks, update, dispose };
  }

  TP.DuelArena = { build };
})();
