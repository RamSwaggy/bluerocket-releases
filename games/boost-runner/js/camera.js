/* =====================================================================
   camera.js — the side-on follow camera (Art and UI).

   The RULE for what's on screen lives in Gameplay's view.js: every
   physics step it works out a rectangle { left, right, top, bottom } in
   world units on the play plane (z = 0). Cars outside it get KO'd.

   This file only has to make that rectangle fill the screen EXACTLY, so
   what you see is the rule. How:

     • It's a perspective camera with a narrow (35°) field of view,
       looking straight down the -Z axis at the play plane.
     • For a vertical field of view `fov`, a camera at distance d sees a
       slice of the plane that is 2·d·tan(fov/2) tall. Solve for d and
       we get the distance that makes the rectangle's height fit:
           d = (height / 2) / tan(fov / 2)
     • Put the camera at the rectangle's centre (x, y), d units back.
     • Use the rectangle's own aspect ratio. If the browser window has a
       different shape, we draw into a centred "letterbox" area of the
       window (BRCamera.viewport) instead of stretching or cropping, so
       the edges of the picture are always the edges of the rule.

   Scenery behind the play plane (z < 0) is further away, so it scrolls
   more slowly: the parallax comes for free from the perspective.

   Shake is added AFTER the fit, by nudging the camera a little. It never
   touches the view rectangle, so it can't change who gets KO'd.

   Usage:
     const cam = new TP.BRCamera();
     cam.resize(window.innerWidth, window.innerHeight, viewAspect);
     cam.fit(view, dt);       // every frame
     cam.shake(0.6);          // on a KO
     renderer.setViewport(...cam.viewport) etc. (see main.js)
     cam.toStage(x, y)        // world point → pixel inside the viewport
   ===================================================================== */
(function () {
  "use strict";

  const FOV = 35; // degrees, vertical

  class BRCamera {
    constructor() {
      this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.5, 900);
      this.tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
      // Viewport inside the window, in CSS pixels: x, y (from top), w, h.
      this.viewport = { x: 0, y: 0, w: 1, h: 1 };
      this.view = { left: -16, right: 16, top: 9, bottom: -9 };
      this.trauma = 0;        // 0..1 shake amount, fades out on its own
      this.time = 0;
    }

    /* Work out the letterbox: the biggest area of the window that has
       the same shape as the view rectangle, centred. */
    resize(winW, winH, aspect) {
      this.aspect = aspect || 16 / 9;
      let w = winW, h = winW / this.aspect;
      if (h > winH) { h = winH; w = winH * this.aspect; }
      this.viewport = { x: Math.round((winW - w) / 2), y: Math.round((winH - h) / 2), w: Math.round(w), h: Math.round(h) };
      this.camera.aspect = this.aspect;
      this.camera.updateProjectionMatrix();
    }

    /* Place the camera so `view` exactly fills the picture at z = 0. */
    fit(view, dt) {
      this.view = view;
      this.time += dt;
      const width = view.right - view.left;
      const height = view.top - view.bottom;
      // If Gameplay's rectangle shape ever changes, follow it.
      const a = width / height;
      if (Math.abs(a - this.aspect) > 0.001) this.resize(window.innerWidth, window.innerHeight, a);

      const cx = (view.left + view.right) / 2;
      const cy = (view.top + view.bottom) / 2;
      const d = height / 2 / this.tanHalf;

      // Shake: smooth wobble (two sine waves at odd rates, so it doesn't
      // look like a regular buzz), scaled by trauma². Squaring makes small
      // knocks subtle and big KOs punchy. It's in world units relative to
      // the view height, so it looks the same at any zoom.
      this.trauma = Math.max(0, this.trauma - dt * 1.6);
      const k = this.trauma * this.trauma * height * 0.02;
      const t = this.time * 38;
      const sx = (Math.sin(t) + Math.sin(t * 1.7 + 1.3) * 0.5) * k;
      const sy = (Math.sin(t * 1.3 + 2.1) + Math.sin(t * 2.3) * 0.5) * k;

      this.camera.position.set(cx + sx, cy + sy, d);
      this.camera.lookAt(cx + sx, cy + sy, 0);
      this.camera.far = d + 700; // always reach the sky and back scenery
      this.camera.updateProjectionMatrix();
    }

    // Add camera shake (0..1). Stacks, but caps at 1.
    shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }

    /* World point on the play plane → pixel position inside the viewport
       (0,0 = top-left of the picture). Uses the rule rectangle, not the
       shaken camera, so HUD markers stay steady. */
    toStage(x, y) {
      const v = this.view;
      return {
        x: ((x - v.left) / (v.right - v.left)) * this.viewport.w,
        y: ((v.top - y) / (v.top - v.bottom)) * this.viewport.h,
      };
    }
  }

  TP.BRCamera = BRCamera;
})();
