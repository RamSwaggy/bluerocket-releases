/* =====================================================================
   camera.js — the Deflect Duel "broadcast" camera (Art and UI owns this).

   It looks across the arena from one long side (the +Z side), a little
   above the floor, like a TV camera at a match. Every frame it works out
   a frame that fits every live car AND the ball (including how high the
   ball is), then eases towards it, so the shot glides instead of jumping.
   On top of that framing it adds:
     • shake — "trauma" that big moments add and that drains away. The
       shake is trauma², so small bumps barely move and big ones rattle.
       It nudges the camera sideways/up in screen space (never tilts).
     • punch — a quick zoom-in (narrower field of view) for a Smash or KO.

   Usage (main.js, once per frame, after duel.update(dt), before render):
     TP.DuelCamera.update(duel.camera, duel, dt);

   Effects (arena.js) call:
     TP.DuelCamera.shake(duel.camera, 0.4);   // add trauma (0..1-ish)
     TP.DuelCamera.punch(duel.camera, 1);     // zoom punch (0..1)

   Safety net: if main.js doesn't call update(), arena.js calls
   TP.DuelCamera.auto() every frame instead, so the camera still works.
   As soon as main.js calls update() itself, auto() stands aside.

   Nothing here touches the rules; it only reads TP.duel.
   ===================================================================== */
(function () {
  "use strict";

  // The look of the shot. Angles in degrees, distances in world units.
  const SHOT = {
    pitchDeg: 17,      // how far the camera looks down (low = more "side-on")
    yawDeg: 0,         // 0 = straight across from the +Z side
    minDist: 24,       // closest it will push in
    maxDist: 60,       // furthest it will pull out (whole arena fits)
    margin: 5,         // empty space kept around the action (units)
    ease: 2.6,         // how quickly the framing follows (per second)
    easeFrozen: 0,     // during a hit-freeze the framing holds still
    ballWeight: 1.6,   // the ball counts a bit more than a car when centring
    baseFov: 42,       // vertical field of view (degrees)
    punchFov: 7,       // degrees narrower at full zoom punch
  };

  const tmp = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();

  // Per-camera state lives on the camera itself, so several cameras (or
  // a new match with a new camera) never share it by accident.
  function state(camera) {
    if (!camera.userData.duelCam) {
      camera.userData.duelCam = {
        target: null,          // eased look-at point
        dist: null,            // eased distance
        trauma: 0,
        zoom: 0,
        t: 0,
        explicitAt: -1e9,      // when main.js last called update() (ms)
      };
    }
    return camera.userData.duelCam;
  }

  /* Work out where the shot WANTS to be: the look-at point and distance
     that fit all live cars and the ball. */
  function desiredFrame(camera, duel) {
    const C = duel.cfg || TP.DUEL_CFG || {};
    const W = C.arenaW ?? 44, D = C.arenaD ?? 28, H = C.arenaH ?? 0;
    let minX = Infinity, maxX = -Infinity, minY = 0, maxY = 2;
    let minZ = Infinity, maxZ = -Infinity;
    let sx = 0, sy = 0, sz = 0, wsum = 0;
    const add = (x, y, z, w) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      maxY = Math.max(maxY, y);
      sx += x * w; sy += y * w; sz += z * w; wsum += w;
    };
    (duel.players || []).forEach((p, i) => {
      if (p.out || p.dead > 0) return;
      const car = duel.cars && duel.cars[i];
      const pos = car ? car.pos : p.pos;
      if (pos) add(pos.x, pos.y + 1.2, pos.z, 1);
    });
    const b = duel.ball;
    if (b && b.pos) add(b.pos.x, b.pos.y + (C.ballR ?? 0.9), b.pos.z, SHOT.ballWeight);
    if (!wsum) add(0, 1, 0, 1); // nothing live: look at the middle

    // Centre: a blend of the weighted average and the box middle, so one
    // straggler doesn't drag the whole shot sideways.
    const cx = 0.5 * (sx / wsum) + 0.25 * (minX + maxX);
    const cz = 0.5 * (sz / wsum) + 0.25 * (minZ + maxZ);
    // Look a bit above the floor, and higher when the ball is up high.
    const cy = Math.max(1.5, 0.35 * maxY + 0.3 * (sy / wsum));

    // How far back to stand so everything fits, horizontally and vertically.
    const vfov = (SHOT.baseFov * Math.PI) / 180;
    const aspect = camera.aspect || 16 / 9;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const spanX = (maxX - minX) + SHOT.margin * 2;
    // Seen from the side, depth (z) shows up as screen height too.
    const pitch = (SHOT.pitchDeg * Math.PI) / 180;
    const spanY = (maxY - minY) + (maxZ - minZ) * Math.sin(pitch) + SHOT.margin * 1.4;
    let dist = Math.max(spanX / 2 / Math.tan(hfov / 2), spanY / 2 / Math.tan(vfov / 2));
    // Depth matters too: things on the near side (closer to the camera)
    // look wider, so step back a little more for them.
    dist += Math.max(0, maxZ - cz) * 0.6;
    dist = Math.min(SHOT.maxDist, Math.max(SHOT.minDist, dist));

    // Keep the look-at point inside the arena (and below the ceiling).
    const tx = Math.max(-W / 2, Math.min(W / 2, cx));
    const tz = Math.max(-D / 2, Math.min(D / 2, cz));
    const ty = H ? Math.min(H - 2, cy) : cy;
    return { target: new THREE.Vector3(tx, ty, tz), dist };
  }

  // Place the camera from a look-at point and a distance.
  function place(camera, target, dist, s) {
    const pitch = (SHOT.pitchDeg * Math.PI) / 180;
    const yaw = (SHOT.yawDeg * Math.PI) / 180;
    // Direction from the target back towards the camera: up a little, and
    // out towards the +Z side.
    tmp.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    camera.position.copy(target).addScaledVector(tmp, dist);
    camera.lookAt(target);

    // Shake: move along the camera's own right/up axes (screen space).
    const k = s.trauma * s.trauma;
    if (k > 0) {
      camera.updateMatrix(); // lookAt only set the rotation; refresh the matrix we read axes from
      right.setFromMatrixColumn(camera.matrix, 0);
      up.setFromMatrixColumn(camera.matrix, 1);
      const amp = 0.9 * k * (dist / 40);    // further away → bigger move to look the same
      const t = s.t;
      camera.position.addScaledVector(right, amp * (Math.sin(t * 61) + 0.5 * Math.sin(t * 97)));
      camera.position.addScaledVector(up, amp * 0.7 * (Math.sin(t * 73 + 1.3) + 0.5 * Math.sin(t * 89)));
    }

    // Zoom punch: ease in/out so it feels like a hit, not a jump cut.
    const z = s.zoom * s.zoom * (3 - 2 * s.zoom);
    camera.fov = SHOT.baseFov - SHOT.punchFov * z;
    camera.updateProjectionMatrix();
  }

  function step(camera, duel, dt) {
    const s = state(camera);
    s.t += dt;
    s.trauma = Math.max(0, s.trauma - dt * 1.6);
    s.zoom = Math.max(0, s.zoom - dt * 2.2);

    const want = desiredFrame(camera, duel);
    if (!s.target) {
      // First frame: snap straight to the shot.
      s.target = want.target.clone();
      s.dist = want.dist;
    } else {
      const frozen = duel.freezeLeft > 0;
      const rate = frozen ? SHOT.easeFrozen : SHOT.ease;
      const k = 1 - Math.exp(-rate * dt);   // frame-rate independent easing
      s.target.lerp(want.target, k);
      s.dist += (want.dist - s.dist) * k;
    }
    place(camera, s.target, s.dist, s);
  }

  TP.DuelCamera = {
    SHOT,

    // main.js: call once per frame. dt in seconds.
    update(camera, duel, dt) {
      if (!camera || !duel) return;
      state(camera).explicitAt = performance.now();
      step(camera, duel, dt);
    },

    // arena.js safety net: only runs if main.js hasn't been calling update().
    auto(camera, duel, dt) {
      if (!camera || !duel) return;
      if (performance.now() - state(camera).explicitAt < 250) return;
      step(camera, duel, dt);
    },

    // Add shake (trauma). About 0.2 for a tap, 1 for a KO.
    shake(camera, amount) {
      if (!camera) return;
      const s = state(camera);
      s.trauma = Math.min(1.2, s.trauma + amount);
    },

    // Zoom punch, 0..1.
    punch(camera, amount = 1) {
      if (!camera) return;
      const s = state(camera);
      s.zoom = Math.max(s.zoom, Math.min(1, amount));
    },

    // Jump straight to the shot next frame (e.g. after a rematch).
    snap(camera) {
      if (camera && camera.userData.duelCam) camera.userData.duelCam.target = null;
    },
  };
})();
