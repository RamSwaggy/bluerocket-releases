/* =====================================================================
   fx-fight.js — Car Fighter's hit effects (first versions, M1).

   What a hit looks like, from the inside out:
     • SPARKS   chunky little boxes in the ATTACKER's seat colour (plus
                white-hot ones), thrown out from the contact point. These
                reuse the shared particle system (TP.FX in shared/js/fx.js).
     • RING     a flat white shock ring that opens fast and fades, facing
                the camera, so even a tiny hit reads from across the stage.
     • FLASH    for a BLOCKED hit, instead of sparks: a flat blue square
                "guard plate" that pops up in front of the blocker and
                fades. Blocks look dull and solid on purpose; hits look hot.
     • SHAKE    a camera shake amount (0..1) that the view reads every
                frame. Heavy hits shake, light hits barely do.
     • KICK     a short camera push-in (0..1) on heavy hits.

   The view (view.js) creates one TP.FightFX for the fight scene, feeds it
   fight events, and calls update(dt) once per rendered frame. Nothing in
   here touches the fight state: effects are purely cosmetic.

   The Director may later move the good parts of this into shared/fx.js.
   ===================================================================== */
(function () {
  "use strict";
  const { rand } = TP.util;

  // Moves that count as "heavy" for effects even if their damage is low.
  // Names follow DESIGN.md §4; matching is loose (lower case, contains).
  const HEAVY_WORDS = ["ram", "corkscrew", "tailwhip", "dash", "slam", "drop", "tow", "throw"];
  const SUPER_WORDS = ["signature", "grinder", "quake", "slipstream", "super"];

  /* How strong a hit event is, for effects only: 0 = light, 1 = heavy,
     2 = signature/super. Uses the move name first, then damage size
     (health is ~1000, so a light hit is a few dozen, a heavy ~100+). */
  function hitTier(ev) {
    const m = String(ev.move || "").toLowerCase();
    if (SUPER_WORDS.some((w) => m.includes(w))) return 2;
    if (HEAVY_WORDS.some((w) => m.includes(w))) return 1;
    const d = Number(ev.damage) || 0;
    if (d >= 160) return 2;
    if (d >= 80) return 1;
    return 0;
  }

  class FightFX {
    /* scene    — the fight scene
       camera   — used so rings and flashes face the viewer
       colors   — the two seat colours as hex numbers [p1, p2] */
    constructor(scene, camera, colors) {
      this.scene = scene;
      this.camera = camera;
      this.colors = colors;
      this.parts = new TP.FX(scene);     // shared spark/debris particles
      this.live = [];                    // rings and flashes currently showing
      this.shake = 0;                    // 0..1, decays every frame
      this.kick = 0;                     // 0..1 camera push-in, decays
      // One shared ring shape and one shared square shape; each effect gets
      // its own material so it can fade on its own.
      this.ringGeo = new THREE.RingGeometry(0.7, 1.0, 40);
      this.plateGeo = new THREE.PlaneGeometry(1, 1);
      this.plateEdgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    }

    /* React to one fight event (see DESIGN.md §9 for the event shape). */
    onEvent(ev) {
      if (!ev) return;
      const pos = new THREE.Vector3(Number(ev.x) || 0, (Number(ev.y) || 0) + 0.9, Number(ev.z) || 0);
      const atk = ev.attacker === 1 ? 1 : 0;
      const seat = this.colors[atk];

      if (ev.type === "hit" || ev.type === "throw") {
        const tier = ev.type === "throw" ? 1 : hitTier(ev);
        this.sparks(pos, seat, tier);
        this.ring(pos, tier === 0 ? 0xffffff : 0xfff3c4, 1.2 + tier * 1.1, 0.22 + tier * 0.08);
        if (tier >= 1) this.ring(pos, seat, 0.8 + tier * 0.8, 0.3 + tier * 0.1, 0.06);
        // Light hits only twitch the camera; heavier ones shake and push in.
        this.addShake([0.12, 0.45, 0.8][tier]);
        if (tier >= 1) this.kick = Math.max(this.kick, tier === 2 ? 1 : 0.6);
      } else if (ev.type === "block") {
        this.blockFlash(pos, atk);
        this.addShake(0.08);
      } else if (ev.type === "ko") {
        // A KO burst: bigger than a heavy hit, but not a full explosion
        // (the car isn't destroyed, it's knocked out).
        this.sparks(pos, seat, 2);
        this.parts.burst(pos, [0xffe14d, 0xff7a1a, 0x2a2f3a], { count: 18, speed: 10, life: 0.8, size: 0.32, up: 5 });
        this.ring(pos, 0xffffff, 3, 0.45);
        this.addShake(1);
        this.kick = 1;
      }
    }

    addShake(a) { this.shake = Math.min(1, Math.max(this.shake, a)); }

    /* Sparks: mostly the attacker's colour, some white-hot, a few dark
       bits of grit. More and faster for heavier hits. */
    sparks(pos, seatColor, tier) {
      const count = [12, 22, 36][tier];
      const speed = [7, 11, 15][tier];
      this.parts.burst(pos, [seatColor, 0xffffff, seatColor, 0xfff1a8], {
        count, speed, life: 0.45 + tier * 0.15, size: 0.2 + tier * 0.05, up: 2, gravity: 26,
      });
      if (tier >= 1) this.parts.burst(pos, [0x2a2f3a, 0x5b6170], { count: 6 * tier, speed: 6, life: 0.9, size: 0.3, up: 4 });
    }

    /* A flat ring that faces the camera, grows from 0 to `size` and fades
       out over `life` seconds. `delay` lets a second ring trail the first. */
    ring(pos, color, size, life, delay = 0) {
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.position.copy(pos);
      mesh.quaternion.copy(this.camera.quaternion); // billboard: face the viewer
      mesh.scale.setScalar(0.01);
      mesh.renderOrder = 5;
      mesh.visible = delay <= 0;
      this.scene.add(mesh);
      this.live.push({ kind: "ring", mesh, t: -delay, life, size });
    }

    /* Block: a blue square "guard plate" in front of the blocker, between
       them and the attacker. It pops to full size instantly and fades. */
    blockFlash(pos, attackerIndex) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x5ab8ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
      });
      const plate = new THREE.Mesh(this.plateGeo, mat);
      const edgeMat = new THREE.LineBasicMaterial({ color: 0xd6f0ff, transparent: true, opacity: 1 });
      const edge = new THREE.LineSegments(this.plateEdgeGeo, edgeMat);
      plate.add(edge);
      plate.position.copy(pos);
      plate.quaternion.copy(this.camera.quaternion);
      plate.scale.setScalar(2.2);
      plate.renderOrder = 6;
      this.scene.add(plate);
      this.live.push({ kind: "plate", mesh: plate, mats: [mat, edgeMat], t: 0, life: 0.22 });
      // A few pale chips instead of hot sparks.
      this.parts.burst(pos, [0xbfe3ff, 0x8fb7d9], { count: 6, speed: 5, life: 0.35, size: 0.16, up: 1 });
    }

    update(dt) {
      this.parts.update(dt);
      for (let i = this.live.length - 1; i >= 0; i--) {
        const e = this.live[i];
        e.t += dt;
        if (e.t < 0) continue;              // still waiting for its delay
        e.mesh.visible = true;
        const k = Math.min(1, e.t / e.life);
        if (e.kind === "ring") {
          // Fast ease-out growth so it "snaps" open, then fades.
          e.mesh.scale.setScalar(Math.max(0.01, e.size * (1 - Math.pow(1 - k, 3))));
          e.mesh.material.opacity = 0.95 * (1 - k);
        } else {
          // Guard plate: tiny overshoot then shrink back while fading.
          e.mesh.scale.setScalar(2.2 * (1 + 0.15 * Math.sin(k * Math.PI)));
          e.mats[0].opacity = 0.55 * (1 - k);
          e.mats[1].opacity = 1 - k;
        }
        if (k >= 1) {
          this.scene.remove(e.mesh);
          e.mesh.material.dispose();
          if (e.mats) e.mats.forEach((m) => m.dispose());
          this.live.splice(i, 1);
        }
      }
      // Shake and kick fade out quickly (about a quarter second).
      this.shake = Math.max(0, this.shake - dt * 3.2);
      this.kick = Math.max(0, this.kick - dt * 2.2);
    }

    /* Random camera offset for this frame, scaled by the shake amount.
       Squared so small shakes are really small. */
    shakeOffset() {
      const s = this.shake * this.shake * 0.55;
      return new THREE.Vector3(rand(-s, s), rand(-s, s), 0);
    }

    dispose() {
      for (const e of this.live) this.scene.remove(e.mesh);
      this.live.length = 0;
      this.parts.dispose();
      this.ringGeo.dispose();
      this.plateGeo.dispose();
      this.plateEdgeGeo.dispose();
    }
  }

  FightFX.hitTier = hitTier;
  TP.FightFX = FightFX;
})();
