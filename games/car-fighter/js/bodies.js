/* =====================================================================
   bodies.js — the three fighter car bodies (DESIGN.md §6), made in code.

     Rivet     compact coupe    the all-rounder
     Haulback  box truck        the heavy
     Skitter   low wedge        the light, fast one

   Every body is painted in its PLAYER's seat colour (P1 blue, P2 orange,
   as in every Rocket Rumble mode). What tells the cars apart is the
   SHAPE plus each car's own TRIM colour (bumpers, stripes, wings) and
   SPARK colour (mixed into its hit sparks by fx-fight.js).

   TP.FightBodies.build(id, seatColor) returns:
     {
       body,      Group to put on the car (its origin is the car's middle,
                  PIVOT_Y above the ground, so flips turn around the centre)
       flame,     the boost flame (the shared Car shows/hides it)
       panels,    painted body panels: view.js dents these
       paint,     the paint material: view.js scuffs it as damage builds
       parts,     pieces that fly off: [{ mesh, kind: "bumper" | "spoiler" | "hubcap" }]
       smokeAt,   where smoke comes out (body-local), usually the bonnet
       info,      the BODY_INFO row below
     }
   Car axes (shared car.js): +Z is the nose, +Y up, +X the car's left side.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  const PIVOT_Y = 0.7;

  /* Look data per car. Gameplay's TP.FIGHTERS holds the fight data
     (health, stats, blurb); this is only how each car LOOKS. */
  const BODY_INFO = {
    rivet: {
      body: "Compact coupe",
      trim: 0x2f3542,        // gunmetal bumpers and spoiler
      stripe: 0xf2f5ff,      // twin white racing stripes
      spark: 0xffd84a,       // gold sparks
      signature: "Grinder",
    },
    haulback: {
      body: "Box truck",
      trim: 0xf2c230,        // hazard-yellow bull bar and bands
      stripe: 0x1b1f2a,
      spark: 0xdfe6f2,       // white-hot steel chips
      signature: "Quake Drop",
    },
    skitter: {
      body: "Low wedge",
      trim: 0x29e0ff,        // neon cyan splitter, fins and wing
      stripe: 0x0c0f18,
      spark: 0x7df9ff,       // electric cyan sparks
      signature: "Slipstream",
    },
  };
  const ORDER = ["rivet", "haulback", "skitter"];

  /* ---------- Small builders ---------- */
  function makeMats(seatColor, info) {
    return {
      paint: new THREE.MeshStandardMaterial({ color: seatColor, metalness: 0.35, roughness: 0.4 }),
      trim: new THREE.MeshStandardMaterial({ color: info.trim, metalness: 0.45, roughness: 0.45 }),
      stripe: new THREE.MeshStandardMaterial({ color: info.stripe, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x1b1f2e, metalness: 0.2, roughness: 0.75 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.95 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9fd3ff, metalness: 0.6, roughness: 0.1, emissive: 0x10263f }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xc9d1de, metalness: 0.9, roughness: 0.25 }),
      head: new THREE.MeshBasicMaterial({ color: 0xfff6d5 }),
      tail: new THREE.MeshBasicMaterial({ color: 0xff2a2a }),
      glow: new THREE.MeshBasicMaterial({ color: info.trim }),
    };
  }

  // Box at (x, y, z) in ground coordinates, added to `parent`.
  function box(parent, w, h, d, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  /* Wheels, each with a hubcap on the outside face. Hubcaps are parts
     that fly off at heavy damage. */
  function wheels(shell, mats, spots, r, w, parts) {
    const geo = new THREE.CylinderGeometry(r, r, w, 18);
    geo.rotateZ(Math.PI / 2);                   // lay the cylinder on its side
    const capGeo = new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.06, 12);
    capGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of spots) {
      const wheel = new THREE.Mesh(geo, mats.tyre);
      wheel.position.set(x, r, z);
      shell.add(wheel);
      const cap = new THREE.Mesh(capGeo, mats.chrome);
      cap.position.set(x + Math.sign(x) * (w / 2 + 0.02), r, z);
      shell.add(cap);
      parts.push({ mesh: cap, kind: "hubcap" });
    }
  }

  // Rocket nozzle at the back plus the boost flame (shared Car toggles it).
  function rocket(shell, mats, y, z, radius = 0.3) {
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.85, radius * 1.2, 0.5, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9aa3b8, metalness: 0.8, roughness: 0.3, side: THREE.DoubleSide })
    );
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(0, y, z);
    shell.add(nozzle);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 1.05, 1.4, 10),
      new THREE.MeshBasicMaterial({ color: 0xffa62b, transparent: true, opacity: 0.9 })
    );
    flame.rotation.x = -Math.PI / 2;          // tip points backwards (-Z)
    flame.position.set(0, y, z - 0.5);
    flame.visible = false;
    shell.add(flame);
    return flame;
  }

  /* =====================================================================
     RIVET — compact coupe. Low, tidy, balanced: a short bonnet, a glass
     cabin set back, twin stripes, a small ducktail spoiler.
     ===================================================================== */
  function buildRivet(shell, m, parts, panels) {
    panels.push(box(shell, 1.8, 0.5, 3.0, m.paint, 0, 0.62, 0));                 // tub
    const bonnet = box(shell, 1.7, 0.16, 1.0, m.paint, 0, 0.93, 0.95);
    bonnet.rotation.x = 0.1;
    panels.push(bonnet);
    box(shell, 1.45, 0.46, 1.25, m.glass, 0, 1.1, -0.2);                         // cabin glass
    panels.push(box(shell, 1.5, 0.08, 1.0, m.paint, 0, 1.36, -0.25));            // roof
    panels.push(box(shell, 1.7, 0.2, 0.8, m.paint, 0, 0.95, -1.15));             // boot lid
    for (const sx of [-0.28, 0.28]) box(shell, 0.2, 0.02, 3.02, m.stripe, sx, 0.875, 0);  // twin stripes
    for (const sx of [-0.93, 0.93]) box(shell, 0.07, 0.14, 2.3, m.trim, sx, 0.42, 0);      // side skirts
    // Bumpers (fly off at half health).
    parts.push({ mesh: box(shell, 1.92, 0.26, 0.24, m.trim, 0, 0.47, 1.56), kind: "bumper" });
    parts.push({ mesh: box(shell, 1.92, 0.24, 0.22, m.trim, 0, 0.5, -1.56), kind: "bumper" });
    // Ducktail spoiler: a wing on two short posts, as one flying part.
    const spoiler = new THREE.Group();
    spoiler.position.set(0, 1.12, -1.35);
    box(spoiler, 1.75, 0.07, 0.4, m.trim, 0, 0.12, 0);
    for (const sx of [-0.55, 0.55]) box(spoiler, 0.08, 0.2, 0.08, m.trim, sx, 0, 0);
    shell.add(spoiler);
    parts.push({ mesh: spoiler, kind: "spoiler" });
    for (const sx of [-0.6, 0.6]) {
      box(shell, 0.36, 0.15, 0.06, m.head, sx, 0.66, 1.51);
      box(shell, 0.4, 0.13, 0.06, m.tail, sx, 0.72, -1.51);
    }
    wheels(shell, m, [[-0.95, 1.0], [0.95, 1.0], [-0.95, -1.02], [0.95, -1.02]], 0.42, 0.34, parts);
    return { flame: rocket(shell, m, 0.66, -1.72), smokeAt: new THREE.Vector3(0, 1.05, 0.95) };
  }

  /* =====================================================================
     HAULBACK — box truck. Tall and square: a short cab up front, a big
     painted cargo box, a hazard-yellow bull bar, chrome exhaust stacks,
     roof lights and six wheels.
     ===================================================================== */
  function buildHaulback(shell, m, parts, panels) {
    box(shell, 1.85, 0.38, 3.4, m.dark, 0, 0.62, 0);                             // chassis rail
    panels.push(box(shell, 1.95, 1.0, 1.15, m.paint, 0, 1.28, 1.05));            // cab
    box(shell, 1.75, 0.42, 0.05, m.glass, 0, 1.5, 1.64);                         // windscreen
    for (const sx of [-0.985, 0.985]) box(shell, 0.04, 0.36, 0.6, m.glass, sx, 1.5, 1.15);
    panels.push(box(shell, 2.05, 1.6, 2.15, m.paint, 0, 1.58, -0.67));           // cargo box
    box(shell, 2.09, 0.18, 2.19, m.trim, 0, 1.05, -0.67);                        // hazard band, low
    box(shell, 2.09, 0.1, 2.19, m.stripe, 0, 2.33, -0.67);                       // top rail
    for (const sx of [-1.03, 1.03]) {                                            // cargo door ribs
      for (const z of [-1.4, -0.67, 0.06]) box(shell, 0.03, 1.3, 0.08, m.stripe, sx, 1.62, z);
    }
    // Bull bar: a heavy hoop of bars across the nose (one flying part).
    const bar = new THREE.Group();
    bar.position.set(0, 0.62, 1.78);
    box(bar, 2.0, 0.2, 0.18, m.trim, 0, 0, 0);
    box(bar, 1.6, 0.14, 0.14, m.trim, 0, 0.42, -0.03);
    for (const sx of [-0.7, -0.24, 0.24, 0.7]) box(bar, 0.12, 0.55, 0.12, m.trim, sx, 0.2, 0);
    shell.add(bar);
    parts.push({ mesh: bar, kind: "bumper" });
    parts.push({ mesh: box(shell, 2.0, 0.22, 0.2, m.trim, 0, 0.58, -1.76), kind: "bumper" });
    // Roof air deflector over the cab: Haulback's "spoiler".
    const deflector = box(shell, 1.8, 0.1, 0.7, m.trim, 0, 1.92, 0.9);
    deflector.rotation.x = -0.32;
    parts.push({ mesh: deflector, kind: "spoiler" });
    // Exhaust stacks behind the cab, and amber roof lights.
    const stackGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.4, 10);
    for (const sx of [-0.88, 0.88]) {
      const s = new THREE.Mesh(stackGeo, m.chrome);
      s.position.set(sx, 1.75, 0.42);
      shell.add(s);
    }
    for (const sx of [-0.6, -0.2, 0.2, 0.6]) box(shell, 0.2, 0.1, 0.12, m.glow, sx, 1.83, 1.4);
    for (const sx of [-0.68, 0.68]) {
      box(shell, 0.34, 0.2, 0.06, m.head, sx, 1.0, 1.64);
      box(shell, 0.3, 0.2, 0.06, m.tail, sx, 0.85, -1.76);
    }
    wheels(shell, m, [[-0.98, 1.05], [0.98, 1.05], [-0.98, -0.42], [0.98, -0.42], [-0.98, -1.3], [0.98, -1.3]], 0.48, 0.36, parts);
    return { flame: rocket(shell, m, 0.75, -1.9, 0.34), smokeAt: new THREE.Vector3(0, 1.85, 1.1) };
  }

  /* =====================================================================
     SKITTER — low wedge. A knife-edge nose rising to a high tail, a
     bubble canopy, neon cyan splitter, fins and a tall rear wing, and a
     glow underneath.
     ===================================================================== */
  function buildSkitter(shell, m, parts, panels) {
    // The wedge: a side profile (nose at +Z) extruded across the car's width.
    const shape = new THREE.Shape();
    shape.moveTo(1.8, 0.2);
    shape.lineTo(1.72, 0.38);
    shape.lineTo(-1.15, 0.98);
    shape.lineTo(-1.55, 0.92);
    shape.lineTo(-1.62, 0.3);
    shape.lineTo(-1.45, 0.18);
    shape.lineTo(1.8, 0.2);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.8, bevelEnabled: false });
    geo.rotateY(-Math.PI / 2);   // profile x → car Z, extrusion → car X
    geo.translate(0.9, 0, 0);    // centre it across the width
    const wedge = new THREE.Mesh(geo, m.paint);
    shell.add(wedge);
    panels.push(wedge);
    // Bubble canopy, set back.
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), m.glass);
    canopy.scale.set(0.72, 0.42, 1.25);
    canopy.position.set(0, 0.88, -0.25);
    shell.add(canopy);
    box(shell, 0.16, 0.02, 3.0, m.stripe, 0, 0.7, 0.25).rotation.x = 0.205;      // spine stripe, along the slope
    for (const sx of [-0.92, 0.92]) box(shell, 0.05, 0.3, 1.2, m.trim, sx, 0.62, -0.65);  // side fins
    // Front splitter (its "bumper").
    parts.push({ mesh: box(shell, 1.95, 0.06, 0.45, m.trim, 0, 0.2, 1.7), kind: "bumper" });
    // Tall rear wing on two struts (one flying part).
    const wing = new THREE.Group();
    wing.position.set(0, 1.0, -1.38);
    box(wing, 2.1, 0.07, 0.5, m.trim, 0, 0.38, 0);
    for (const sx of [-0.62, 0.62]) box(wing, 0.07, 0.42, 0.1, m.dark, sx, 0.15, 0);
    shell.add(wing);
    parts.push({ mesh: wing, kind: "spoiler" });
    // Neon underglow (purely for looks).
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.8),
      new THREE.MeshBasicMaterial({ color: BODY_INFO.skitter.trim, transparent: true, opacity: 0.35, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.06;
    shell.add(glow);
    for (const sx of [-0.62, 0.62]) {
      box(shell, 0.34, 0.06, 0.06, m.head, sx, 0.32, 1.74);
      box(shell, 0.42, 0.08, 0.06, m.tail, sx, 0.78, -1.6);
    }
    wheels(shell, m, [[-0.95, 1.1], [0.95, 1.1], [-0.95, -1.05], [0.95, -1.05]], 0.36, 0.3, parts);
    return { flame: rocket(shell, m, 0.55, -1.7, 0.28), smokeAt: new THREE.Vector3(0, 0.7, 0.8) };
  }

  const BUILDERS = { rivet: buildRivet, haulback: buildHaulback, skitter: buildSkitter };

  /* Build one fighter body (see the top of the file for what comes back). */
  function build(id, seatColor) {
    const key = BUILDERS[id] ? id : "rivet";
    const info = BODY_INFO[key];
    const mats = makeMats(seatColor, info);
    const body = new THREE.Group();
    body.position.y = PIVOT_Y;
    // Everything is modelled in ground coordinates inside `shell`, which
    // sits PIVOT_Y below the body's origin. So the body turns around the
    // car's middle while the modelling numbers stay simple.
    const shell = new THREE.Group();
    shell.position.y = -PIVOT_Y;
    body.add(shell);
    const parts = [], panels = [];
    const extra = BUILDERS[key](shell, mats, parts, panels);
    body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    extra.flame.castShadow = false;
    // Remember every part's home, so damage can be undone each round.
    for (const p of parts) {
      p.home = { parent: p.mesh.parent, pos: p.mesh.position.clone(), quat: p.mesh.quaternion.clone(), scale: p.mesh.scale.clone() };
    }
    for (const pm of panels) {
      pm.userData.home = { rot: pm.rotation.clone(), scale: pm.scale.clone() };
    }
    const smokeAt = extra.smokeAt.clone();
    smokeAt.y -= PIVOT_Y;               // body-local (the body origin is at PIVOT_Y)
    return {
      id: key, body, flame: extra.flame, panels, parts, smokeAt, info,
      paint: mats.paint, paintColor: new THREE.Color(seatColor),
    };
  }

  TP.FightBodies = { build, info: (id) => BODY_INFO[id] || BODY_INFO.rivet, ORDER, PIVOT_Y };
})();
