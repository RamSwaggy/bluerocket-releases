/* =====================================================================
   controls-menu.js: the Controls screen (rebind keys and buttons).
   Modelled on RocketBonk's controls menu, adapted to Rocket Rumble's
   couch setup: one tab per keyboard player, one shared Controller tab.

   Opened by TP.Controls.openMenu() (input.js loads this file on first
   use), by any [data-open-controls] button, or the pad's View/Back
   button on any menu.

   Layout: tabs (Controller · Keyboard 1 · Keyboard 2), a hint line, one
   row per action: label, two binding slots, × to clear the row. The
   Controller tab adds Deadzone and Steering Sensitivity sliders. Each tab
   has "Reset <tab> to defaults". Done (or B / Esc) closes it.

   Rebind flow: pick a slot → it reads "Press a key…" / "Press a button
   or move a stick…" → the next key / NEW button / stick push is stored.
   Esc (or Start on a pad) cancels. Duplicates are allowed, like
   RocketBonk (keyboard Up already doubles as gas and aim-up by design).
   Everything saves immediately (localStorage "rumble.controls.v1").

   Controller: D-pad moves, A selects, B closes, LB / RB switch tabs,
   ← → adjust a slider. Keyboard: arrows, Enter, Esc, Q / E for tabs.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";
  const C = TP.Controls;
  const TABS = [
    { id: "pad", label: "Controller", actions: C.PAD_ACTIONS, device: "pad" },
    { id: "kb1", label: "Keyboard 1", actions: C.KB_ACTIONS, device: "key" },
    { id: "kb2", label: "Keyboard 2", actions: C.KB_ACTIONS, device: "key" },
  ];
  const SLIDERS = [
    { key: "deadzone", label: "Stick deadzone", min: 0.02, max: 0.4, step: 0.02 },
    { key: "steerSensitivity", label: "Steering sensitivity", min: 0.5, max: 2, step: 0.1 },
  ];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const play = (n) => { if (TP.sfx) TP.sfx.play(n); };

  let root = null, nav = null, tab = 0, listening = null, loopOn = false;

  function ensureStyle() {
    if (document.getElementById("rr-controls-style")) return;
    const st = document.createElement("style");
    st.id = "rr-controls-style";
    st.textContent = `
      #rr-controls { position: fixed; inset: 0; z-index: 9999; background: rgba(7,11,26,.94); color: #e8ecff;
        font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; overflow-y: auto; padding: 24px 16px; box-sizing: border-box; }
      #rr-controls .panel { max-width: 760px; margin: 0 auto; }
      #rr-controls h2 { margin: 0 0 12px; font-size: 28px; letter-spacing: .04em; }
      #rr-controls h2 span { color: #ffcc33; }
      #rr-controls .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
      #rr-controls .tab { background: #1a2148; color: #c8d0f0; border: 0; border-radius: 10px; padding: 8px 14px; font: inherit; cursor: pointer; }
      #rr-controls .tab.on { background: #ffcc33; color: #070b1a; font-weight: 700; }
      #rr-controls .note { color: #9aa6d6; font-size: 13px; margin: 0 0 12px; min-height: 1.4em; }
      #rr-controls .row { display: grid; grid-template-columns: 1fr 150px 150px 40px; gap: 8px; align-items: center; padding: 5px 0;
        border-bottom: 1px solid rgba(255,255,255,.06); }
      #rr-controls .bind, #rr-controls .clr, #rr-controls .act { background: #232c5c; color: #fff; border: 1px solid #34407a; border-radius: 8px;
        padding: 7px 8px; font: inherit; cursor: pointer; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #rr-controls .bind.unbound { color: #6c7699; font-style: italic; }
      #rr-controls .bind.listen { background: #ffcc33; color: #070b1a; font-weight: 700; }
      #rr-controls .clr { padding: 7px 0; color: #ff8a73; }
      #rr-controls .slider { display: grid; grid-template-columns: 1fr 200px 50px; gap: 8px; align-items: center; padding: 6px 0; }
      #rr-controls input[type=range] { width: 100%; accent-color: #ffcc33; }
      #rr-controls .foot { display: flex; gap: 10px; justify-content: space-between; margin-top: 16px; flex-wrap: wrap; }
      #rr-controls .act.done { background: #ffcc33; color: #070b1a; font-weight: 700; border: 0; padding: 9px 22px; }
      @media (max-width: 560px) { #rr-controls .row { grid-template-columns: 1fr 1fr 1fr 34px; } #rr-controls .row .lbl { grid-column: 1 / -1; } }`;
    document.head.appendChild(st);
  }

  function padNote() {
    const id = C.firstPadId();
    const ps = C.isPlayStation(id);
    const keys = ps ? "✕ select · ○ back · L1/R1 tabs" : "A select · B back · LB/RB tabs";
    return id ? `Connected: ${esc(id.replace(/\s*\(.*$/, ""))} · ${keys}. While picking: press the new button or push a stick; Start cancels.`
              : "No controller detected: press any button on it.";
  }

  function render() {
    const t = TABS[tab];
    const prof = C.get()[t.id];
    const focusedKey = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const rows = t.actions.map((a) => {
      const slots = prof.bindings[a.id];
      const cell = (i) => {
        const isL = listening && listening.action === a.id && listening.slot === i;
        const b = slots[i];
        const txt = isL ? (t.device === "pad" ? "Press a button or move a stick…" : "Press a key…") : C.label(b);
        return `<button class="bind ${b ? "" : "unbound"} ${isL ? "listen" : ""}" data-k="b:${a.id}:${i}" data-bind="${a.id}:${i}">${esc(txt)}</button>`;
      };
      return `<div class="row"><span class="lbl">${esc(a.label)}</span>${cell(0)}${cell(1)}
        <button class="clr" data-k="c:${a.id}" data-clear="${a.id}" aria-label="Clear ${esc(a.label)}">×</button></div>`;
    }).join("");
    const sliders = t.id !== "pad" ? "" : SLIDERS.map((s) => `
      <label class="slider"><span>${s.label}</span>
        <input type="range" data-k="s:${s.key}" data-slider="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${prof[s.key]}">
        <span>${Number(prof[s.key]).toFixed(2)}</span></label>`).join("");
    const note = t.id === "pad" ? padNote() : "Select a binding, then press the key. Esc cancels. Up/Down also aim in modes that aim.";
    root.querySelector(".panel").innerHTML = `
      <h2><span>CONTROLS</span></h2>
      <div class="tabs">${TABS.map((x, i) => `<button class="tab ${i === tab ? "on" : ""}" data-k="t:${i}" data-tab="${i}">${x.label}</button>`).join("")}</div>
      <p class="note">${note}</p>
      ${rows}${sliders}
      <div class="foot">
        <button class="act" data-k="reset" data-reset>Reset ${t.label} to defaults</button>
        <button class="act done" data-k="done" data-nav-primary data-done>Done</button>
      </div>`;
    const again = focusedKey && root.querySelector(`[data-k="${focusedKey}"]`);
    if (nav) nav.focus(again || root.querySelector("[data-bind]"));
  }

  function setTab(i) {
    if (C.capturing) C.cancelCapture();
    listening = null;
    tab = (i + TABS.length) % TABS.length;
    play("tick");
    render();
  }

  function onClick(e) {
    const el = e.target.closest("button");
    if (!el || !root.contains(el)) return;
    const t = TABS[tab];
    if (el.dataset.tab !== undefined) return setTab(Number(el.dataset.tab));
    if (el.dataset.done !== undefined) return close();
    if (el.dataset.reset !== undefined) { C.reset(t.id); play("coin"); return render(); }
    if (el.dataset.clear) { C.setBinding(t.id, el.dataset.clear, 0, null); C.setBinding(t.id, el.dataset.clear, 1, null); return render(); }
    if (el.dataset.bind) {
      const [action, slot] = el.dataset.bind.split(":");
      listening = { action, slot: Number(slot) };
      render();
      // Wait a frame so the press that picked this slot isn't captured itself.
      requestAnimationFrame(() => C.capture(t.device, (binding) => {
        if (binding !== undefined) { C.setBinding(t.id, action, Number(slot), binding); play("coin"); }
        listening = null;
        render();
      }));
    }
  }

  function onInput(e) {
    const s = e.target.dataset && e.target.dataset.slider;
    if (!s) return;
    C.setValue("pad", s, Number(e.target.value));
    e.target.nextElementSibling.textContent = Number(e.target.value).toFixed(2);
  }

  // Q / E and LB / RB switch tabs (not while picking a binding).
  function onKey(e) {
    if (!root || C.capturing) return;
    if (e.code === "KeyQ") setTab(tab - 1);
    else if (e.code === "KeyE") setTab(tab + 1);
  }
  const held = { lb: true, rb: true };
  function loop() {
    if (!root) { loopOn = false; return; }
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const lb = pads.some((g) => g.buttons[4] && g.buttons[4].pressed);
    const rb = pads.some((g) => g.buttons[5] && g.buttons[5].pressed);
    if (!C.capturing) {
      if (lb && !held.lb) setTab(tab - 1);
      if (rb && !held.rb) setTab(tab + 1);
    }
    held.lb = lb; held.rb = rb;
    requestAnimationFrame(loop);
  }

  function open() {
    if (root) return;
    ensureStyle();
    // Open on the tab for whatever was used last: a pad if one's connected.
    tab = C.firstPadId() ? 0 : 1;
    root = document.createElement("div");
    root.id = "rr-controls";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Controls");
    root.innerHTML = `<div class="panel"></div>`;
    document.body.appendChild(root);
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    window.addEventListener("keydown", onKey);
    TP.MenuNav.modal = root;
    nav = TP.MenuNav.attach(root, { onBack: close });
    render();
    held.lb = held.rb = true;
    if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
    play("tick");
  }

  function close() {
    if (!root) return;
    if (C.capturing) C.cancelCapture();
    listening = null;
    if (nav) nav.detach();
    nav = null;
    window.removeEventListener("keydown", onKey);
    root.remove();
    root = null;
    TP.MenuNav.modal = null;
    // Hint text elsewhere (hub key table) may want to refresh.
    window.dispatchEvent(new Event("rumble-controls-changed"));
  }

  TP.ControlsMenu = { open, close, get isOpen() { return !!root; } };
})();
