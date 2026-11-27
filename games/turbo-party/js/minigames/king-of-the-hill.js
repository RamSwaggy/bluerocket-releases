/* =====================================================================
   King of the Hill — 40 seconds.
   A glowing zone sits somewhere in the arena. Score a point for every
   second you're the ONLY car inside it. If two or more cars are in the
   zone, nobody scores — so shove them out! The zone jumps to a new spot
   every 8 seconds. Most points wins.
   ===================================================================== */
(function () {
  "use strict";
  const { rand, dist2D } = TP.util;

  const HALF = 20;
  const ZONE_R = 4.5;
  const MOVE_EVERY = 8;   // seconds between zone moves

  class KingOfTheHill extends TP.Arena {
    constructor(game) {
      super(game, { title: "King of the Hill", duration: 40, size: HALF, camera: { y: 38, z: 32, lookZ: 2 }, tuning: { bumpScale: 1.2 } });
      this.score = this.players.map(() => 0);
      this.moveTimer = MOVE_EVERY;
      this.inZone = [];
      this.placeZone(0, 0);
    }

    build() {
      this.buildBoxArena(HALF, 0x24304f, 0x3b3f7a);

      // The zone: a flat glowing disc, a rim, and a tall light column.
      const g = new THREE.Group();
      this.zoneMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(ZONE_R, 48), this.zoneMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.03;
      g.add(disc);
      this.rimMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const rim = new THREE.Mesh(new THREE.TorusGeometry(ZONE_R, 0.15, 8, 48), this.rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.1;
      g.add(rim);
      this.beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(ZONE_R, ZONE_R, 14, 32, 1, true), this.beamMat);
      beam.position.y = 7;
      g.add(beam);
      this.zone = g;
      this.scene.add(g);
    }

    spawn(i) {
      const c = [[-1, -1], [1, -1], [-1, 1], [1, 1]][i];
      const x = c[0] * 13, z = c[1] * 13;
      return { x, z, heading: Math.atan2(-x, -z) };
    }

    clampCar(car) { this.clampToBox(car, HALF); }

    placeZone(x, z) {
      this.zx = x; this.zz = z;
      this.zone.position.set(x, 0, z);
      this.fx.burst(new THREE.Vector3(x, 0.5, z), 0xffffff, { count: 20, speed: 7 });
    }

    tick(dt) {
      // Move the zone on a timer, always a decent distance away.
      this.moveTimer -= dt;
      if (this.moveTimer <= 0) {
        let x, z, tries = 0;
        do {
          x = rand(-HALF + 6, HALF - 6);
          z = rand(-HALF + 6, HALF - 6);
        } while (dist2D(x, z, this.zx, this.zz) < 16 && ++tries < 30);
        this.placeZone(x, z);
        this.moveTimer = MOVE_EVERY;
        TP.UI.toast("The zone moved!");
        TP.sfx.play("go");
      }

      // Who's inside? (Airborne cars over the zone still count.)
      this.inZone = this.cars.filter((c) => dist2D(c.pos.x, c.pos.z, this.zx, this.zz) < ZONE_R);
      if (this.inZone.length === 1) {
        const c = this.inZone[0];
        const before = Math.floor(this.score[c.index]);
        this.score[c.index] += dt;
        if (Math.floor(this.score[c.index]) > before && c.player.controller !== "bot") TP.sfx.play("tick");
      }
    }

    animate() {
      // Zone colour: white when empty, the owner's colour when held,
      // flickering red when contested.
      let color = 0xffffff;
      if (this.inZone.length === 1) color = this.inZone[0].player.color;
      else if (this.inZone.length > 1) color = Math.sin(performance.now() * 0.02) > 0 ? 0xff3b3b : 0x661111;
      this.zoneMat.color.setHex(color);
      this.rimMat.color.setHex(color);
      this.beamMat.color.setHex(color);
      // Pulse faster just before it moves.
      const warn = this.moveTimer < 2 ? 0.5 + 0.5 * Math.sin(performance.now() * 0.03) : 1;
      this.zoneMat.opacity = 0.25 * warn + 0.05;
    }

    botControls(car) {
      const me = dist2D(car.pos.x, car.pos.z, this.zx, this.zz);
      // Inside with company → ram the nearest intruder out.
      if (me < ZONE_R && this.inZone.length > 1) {
        let t = null, best = Infinity;
        for (const o of this.inZone) {
          if (o === car) continue;
          const d = dist2D(car.pos.x, car.pos.z, o.pos.x, o.pos.z);
          if (d < best) { best = d; t = o; }
        }
        if (t) {
          const ctrl = TP.ai.driveTo(car, t.pos.x, t.pos.z, { boostDist: 0 });
          ctrl.boost = best < 6 && car.boost > 20;
          return ctrl;
        }
      }
      // Otherwise get to the middle of the zone and hold position.
      return TP.ai.driveTo(car, this.zx, this.zz, { boostDist: 10, arrive: 3 });
    }

    // One decimal so near-ties still rank correctly but read cleanly.
    scores() { return this.score.map((s) => Math.round(s * 10) / 10); }
    chips() {
      return this.players.map((p, i) => ({ name: p.name, css: p.css, value: "👑 " + Math.floor(this.score[i]) }));
    }
  }

  TP.MINIGAMES.push({
    id: "king-of-the-hill",
    name: "King of the Hill",
    cls: KingOfTheHill,
    blurb: "Score a point every second you're the ONLY car in the glowing zone. Two or more inside? Nobody scores — shove them out! The zone moves every 8 seconds.",
  });
})();
