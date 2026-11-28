/* =====================================================================
   assets.js — loading real files (3D models, textures, sounds, data)
   with a proper loading screen, plus GPU warm-up so the game doesn't
   stutter the first time something new appears.

   Needs: three.min.js and vendor/three-addons.min.js (for GLTFLoader).

   Typical use in a mode:

     const manifest = {
       hero:    { type: "gltf",    url: "assets/hero-car.glb" },
       grass:   { type: "texture", url: "assets/grass.png", srgb: true },
       crowd:   { type: "audio",   url: "assets/crowd.ogg" },
       level1:  { type: "json",    url: "assets/level1.json" },
     };
     await TP.Assets.loadAll(manifest, { title: "Boost Runner" });
     const car = TP.Assets.cloneModel("hero");      // a fresh copy each time
     const tex = TP.Assets.get("grass");
     ...build the scene...
     await TP.Assets.warmUp(renderer, scene, camera); // compile shaders up front
     TP.Loading.hide();

   URLs are relative to the page (the mode's index.html).

   Real files only load in the desktop app (or any local web server).
   If someone double-clicks index.html in a browser, loading fails, and
   the loading screen says how to open the game properly instead of
   just hanging.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  /* =====================================================================
     Loading screen. Injected into the page, so no mode needs extra HTML.
     ===================================================================== */
  let el = null;

  function ensureLoadingEl() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "rr-loading";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML = `
      <style>
        #rr-loading {
          position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 18px;
          background: radial-gradient(ellipse at 50% 40%, #1a2150 0%, #070b1a 70%);
          color: #f2f5ff; font-family: "Segoe UI", system-ui, sans-serif;
          transition: opacity .35s ease;
        }
        #rr-loading.hide { opacity: 0; pointer-events: none; }
        #rr-loading .brand { font-size: 14px; letter-spacing: .3em; color: #9aa6c8; }
        #rr-loading .title { font-size: clamp(34px, 7vw, 64px); font-weight: 900; font-style: italic; }
        #rr-loading .bar { width: min(420px, 80vw); height: 10px; border-radius: 999px; background: #1a2148; overflow: hidden; }
        #rr-loading .fill { height: 100%; width: 0%; border-radius: 999px;
          background: linear-gradient(90deg, #ffcc33, #ff5a3c); transition: width .15s linear; }
        #rr-loading .note { font-size: 14px; color: #9aa6c8; min-height: 1.3em; text-align: center; max-width: 80vw; }
        #rr-loading .note.err { color: #fca5a5; }
        @media (prefers-reduced-motion: reduce) { #rr-loading, #rr-loading .fill { transition: none; } }
      </style>
      <div class="brand">ROCKET RUMBLE</div>
      <div class="title"></div>
      <div class="bar" aria-hidden="true"><div class="fill"></div></div>
      <div class="note"></div>`;
    document.body.appendChild(el);
    return el;
  }

  TP.Loading = {
    show(title = "Loading", note = "") {
      const e = ensureLoadingEl();
      e.classList.remove("hide");
      e.style.display = "flex";
      e.querySelector(".title").textContent = title;
      TP.Loading.progress(0, note);
    },
    // k = 0..1
    progress(k, note) {
      const e = ensureLoadingEl();
      e.querySelector(".fill").style.width = `${Math.round(Math.max(0, Math.min(1, k)) * 100)}%`;
      if (note !== undefined) {
        const n = e.querySelector(".note");
        n.textContent = note;
        n.classList.remove("err");
      }
    },
    error(message) {
      const e = ensureLoadingEl();
      const n = e.querySelector(".note");
      n.textContent = message;
      n.classList.add("err");
    },
    // Fade out, then remove from layout.
    hide() {
      if (!el) return;
      el.classList.add("hide");
      setTimeout(() => { if (el && el.classList.contains("hide")) el.style.display = "none"; }, 400);
    },
  };

  /* =====================================================================
     Asset cache and loaders
     ===================================================================== */
  const cache = {};        // key → loaded thing
  const inFlight = {};     // url → Promise, so the same file loads once

  // Opened by double-click? Real files can't load there.
  const onFileProtocol = () => location.protocol === "file:";

  function loadGLTF(url) {
    if (!THREE.GLTFLoader) throw new Error("GLTFLoader missing: add shared/vendor/three-addons.min.js before assets.js");
    return new Promise((resolve, reject) => {
      new THREE.GLTFLoader().load(url, (gltf) => {
        // Models cast and receive shadows by default, like everything else.
        gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        resolve(gltf);
      }, undefined, reject);
    });
  }

  function loadTexture(url, item) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, (tex) => {
        if (item.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace; // colour images
        if (item.repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(item.repeat[0], item.repeat[1]); }
        if (item.pixelated) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; }
        resolve(tex);
      }, undefined, reject);
    });
  }

  async function loadBytes(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} for ${url}`);
    return r.arrayBuffer();
  }

  async function loadOne(item) {
    const key = `${item.type}:${item.url}`;
    if (!inFlight[key]) {
      inFlight[key] = (async () => {
        switch (item.type) {
          case "gltf": return loadGLTF(item.url);
          case "texture": return loadTexture(item.url, item);
          case "json": { const r = await fetch(item.url); if (!r.ok) throw new Error(`${r.status} for ${item.url}`); return r.json(); }
          // Raw bytes; decode later with TP.sfx.decode() once audio is unlocked.
          case "audio": return loadBytes(item.url);
          case "bytes": return loadBytes(item.url);
          default: throw new Error(`Unknown asset type "${item.type}" (${item.url})`);
        }
      })();
    }
    return inFlight[key];
  }

  TP.Assets = {
    /* Load everything in a manifest ({ key: { type, url, ... } }).
       Shows the loading screen with a progress bar unless opts.screen === false.
       Resolves when all are loaded; rejects (and shows a readable
       message) if any fail. The screen stays up so the caller can warm
       up the GPU before hiding it. */
    async loadAll(manifest, opts = {}) {
      const keys = Object.keys(manifest);
      const showScreen = opts.screen !== false;
      if (showScreen) TP.Loading.show(opts.title || "Loading", "Loading…");
      let done = 0;
      try {
        await Promise.all(keys.map(async (k) => {
          cache[k] = await loadOne(manifest[k]);
          done++;
          if (showScreen) TP.Loading.progress(done / keys.length * 0.9, `Loading… ${done} / ${keys.length}`);
        }));
      } catch (err) {
        const msg = onFileProtocol()
          ? "This needs the Rocket Rumble desktop app. Browsers can't load game files from a double-clicked page. See desktop/README.md."
          : `Couldn't load a game file: ${err && err.message ? err.message : err}`;
        if (showScreen) TP.Loading.error(msg);
        throw err;
      }
      return cache;
    },

    get(key) {
      if (!(key in cache)) throw new Error(`Asset "${key}" isn't loaded`);
      return cache[key];
    },

    has(key) { return key in cache; },

    /* A fresh, independent copy of a loaded model's scene, safe to add
       many times (and safe for skinned/animated models too). */
    cloneModel(key) {
      const gltf = TP.Assets.get(key);
      return THREE.SkeletonUtils ? THREE.SkeletonUtils.clone(gltf.scene) : gltf.scene.clone(true);
    },

    // The animation clips that came with a model (for THREE.AnimationMixer).
    animations(key) { return TP.Assets.get(key).animations || []; },

    /* GPU warm-up: compile every shader the scene needs, and upload
       textures, before play starts. Without this the first explosion,
       the first new material, and so on can cause a visible hitch.
       Call it with the scene fully built (including things that start
       hidden, temporarily made visible) while the loading screen is up. */
    async warmUp(renderer, scene, camera) {
      TP.Loading.progress(0.95, "Warming up…");
      // Make hidden things visible for the compile pass, then restore.
      const hidden = [];
      scene.traverse((o) => { if (o.visible === false) { hidden.push(o); o.visible = true; } });
      try {
        if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
        else renderer.compile(scene, camera);
        // One real frame uploads textures and geometry buffers to the GPU.
        renderer.render(scene, camera);
      } finally {
        hidden.forEach((o) => { o.visible = false; });
      }
      TP.Loading.progress(1, "Ready!");
    },

    // Forget everything (e.g. when leaving a mode that loaded big files).
    clear() {
      for (const k of Object.keys(cache)) delete cache[k];
      for (const k of Object.keys(inFlight)) delete inFlight[k];
    },
  };
})();
