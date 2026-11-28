/* =====================================================================
   paint.js — TP.M5.PaintGrid: the painted floor, which is also the score.

   The floor is a GRID × GRID board of cells. For every cell we keep:
     owner[c]    0 = unpainted, 1..4 = painted by player 0..3
     wet[c]      0 = dry, or 1..4 = part of that player's WET TRAIL
                 (a wet cell is always owned by the same player)
     blocked[c]  1 = can't be painted (pillar, ramp, outside the walls)

   Cell index c = j * GRID + i, where i counts along X and j along Z.
   Cell (0, 0) is the corner at x = -half, z = -half.

   Teams (2v2): setTeams([0, 1, 0, 1]) makes teammates "friendly": their
   dry turf counts as home for closing a loop and as wall for the flood
   fill, your paint never covers theirs, and you can't pop each other.

   For world.js: `n` is the same as N, and `dirty` is set true on every
   change (clear it after drawing), alongside the per-row dirtyRows.

   The grid doesn't know about cars or time: match.js decides WHEN to
   paint, close a loop, dry or pop a trail, and this file does the cell
   work and keeps the counts right. The look side reads `owner`, `wet`
   and `blocked` to draw the floor; `dirtyRows` marks rows that changed
   (set to 1) so a texture only needs re-uploading where needed. Whoever
   draws the floor clears them with clearDirty(). `version` goes up on
   every change, as a cheap "did anything change?" check.
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";

  class PaintGrid {
    constructor(arena, size = TP.M5.CFG.GRID) {
      this.N = size;
      this.n = size;          // the name world.js uses
      this.teams = null;      // or [team of player 0, 1, 2, 3]
      const n = size * size;
      this.owner = new Uint8Array(n);
      this.wet = new Uint8Array(n);
      this.blocked = new Uint8Array(n);
      this.dirtyRows = new Uint8Array(size);
      // Scratch space for the flood fill, allocated once.
      this._seen = new Uint8Array(n);
      this._queue = new Int32Array(n);
      this._mark = new Uint8Array(n);   // scratch for the bots' loop estimate
      this.reset(arena);
    }

    /* Wipe the floor for a new round (possibly on a new arena). */
    reset(arena) {
      this.arena = arena;
      this.half = arena.half;
      this.cs = (arena.half * 2) / this.N;   // cell size in world units
      this.owner.fill(0);
      this.wet.fill(0);
      this.counts = [0, 0, 0, 0];             // painted cells per player
      this.wetCount = [0, 0, 0, 0];           // wet trail cells per player
      // Each player's trail as a list of cell indices. It can contain
      // stale entries (a cell somebody painted over), so code walking it
      // always re-checks wet[c] first.
      this.trail = [[], [], [], []];

      // Mark the unpaintable cells by asking the arena about each centre.
      const N = this.N;
      this.paintable = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const b = arena.cellBlocked(this.cellX(i), this.cellZ(j)) ? 1 : 0;
          this.blocked[j * N + i] = b;
          if (!b) this.paintable++;
        }
      }
      this.dirtyRows.fill(1);
      this.dirty = true;
      this.version = (this.version || 0) + 1;
    }

    /* Teams: pass [team of each player] (e.g. [0, 1, 0, 1]) or null. */
    setTeams(teams) { this.teams = teams ? teams.slice() : null; }

    /* Is owner code `code` (1..4, or 0) on player p's side: p's own
       paint or a teammate's? */
    friendly(code, p) {
      if (!code) return false;
      if (code === p + 1) return true;
      return !!this.teams && this.teams[code - 1] === this.teams[p];
    }

    /* ---------- Coordinates ---------- */
    // World X / Z of the centre of column i / row j.
    cellX(i) { return -this.half + (i + 0.5) * this.cs; }
    cellZ(j) { return -this.half + (j + 0.5) * this.cs; }
    // World centre of cell index c.
    centerOf(c) { return { x: this.cellX(c % this.N), z: this.cellZ((c / this.N) | 0) }; }

    // Cell index under world point (x, z), or -1 if outside the floor.
    cellAt(x, z) {
      const i = Math.floor((x + this.half) / this.cs);
      const j = Math.floor((z + this.half) / this.cs);
      if (i < 0 || j < 0 || i >= this.N || j >= this.N) return -1;
      return j * this.N + i;
    }

    // Is cell c this player's own DRY turf (painted by them, not a trail)?
    isOwnDry(c, p) { return c >= 0 && this.owner[c] === p + 1 && this.wet[c] === 0; }
    // Is cell c "home" for p: dry turf of p or (in teams) a teammate?
    isHome(c, p) { return c >= 0 && this.wet[c] === 0 && this.friendly(this.owner[c], p); }
    hasTrail(p) { return this.wetCount[p] > 0; }

    // Score: share of the paintable floor this player owns, 0..100.
    pct(p) { return this.paintable ? (this.counts[p] / this.paintable) * 100 : 0; }

    clearDirty() { this.dirtyRows.fill(0); this.dirty = false; }

    /* ---------- The one place cells change ----------
       Sets cell c to owner code o (0..4) and wet code w (0 or o), keeping
       every count and trail list correct. Returns true if anything
       changed. */
    _set(c, o, w) {
      const oldO = this.owner[c], oldW = this.wet[c];
      if (oldO === o && oldW === w) return false;
      if (oldO) this.counts[oldO - 1]--;
      if (o) this.counts[o - 1]++;
      if (oldW) this.wetCount[oldW - 1]--;
      if (w) {
        this.wetCount[w - 1]++;
        if (oldW !== w) this.trail[w - 1].push(c);
      }
      this.owner[c] = o;
      this.wet[c] = w;
      this.dirtyRows[(c / this.N) | 0] = 1;
      this.dirty = true;
      this.version++;
      return true;
    }

    /* =====================================================================
       paintCircle — paint every cell whose centre is within r cells of
       world point (x, z), in player p's colour.

       wet = true means "the car is out of its own turf": the new paint
       becomes part of p's wet trail. Cells that are already p's dry turf
       stay dry (driving through your own turf never makes it wet).
       wet = false paints plain dry turf.

       Painting always takes the cell, whoever owned it before. If the
       circle touched another player's WET trail, that player's bit is set
       in the returned `hitWet` mask (bit q = player q), and match.js
       decides whether that pops them.

       Returns { gained, hitWet }, where gained = cells that weren't p's
       before (for stats).
       ===================================================================== */
    paintCircle(x, z, r, p, wet = false) {
      const code = p + 1;
      const N = this.N, cs = this.cs;
      // Work in cell units: (fx, fz) is the point in grid coordinates.
      const fx = (x + this.half) / cs, fz = (z + this.half) / cs;
      const i0 = Math.max(0, Math.floor(fx - r)), i1 = Math.min(N - 1, Math.ceil(fx + r));
      const j0 = Math.max(0, Math.floor(fz - r)), j1 = Math.min(N - 1, Math.ceil(fz + r));
      const r2 = r * r;
      let gained = 0, hitWet = 0;

      for (let j = j0; j <= j1; j++) {
        const dz = j + 0.5 - fz;
        for (let i = i0; i <= i1; i++) {
          const dx = i + 0.5 - fx;
          if (dx * dx + dz * dz > r2) continue;
          const c = j * N + i;
          if (this.blocked[c]) continue;
          const oldO = this.owner[c], oldW = this.wet[c];
          // A teammate's paint is left alone (it already counts for us).
          if (oldO && oldO !== code && this.friendly(oldO, p)) continue;
          if (oldW && oldW !== code) hitWet |= 1 << (oldW - 1);
          // Own dry turf stays dry; everything else follows `wet`.
          const w = wet && !(oldO === code && oldW === 0) ? code : 0;
          if (this._set(c, code, w) && oldO !== code) gained++;
        }
      }
      return { gained, hitWet };
    }

    /* =====================================================================
       closeLoop — player p drove back into their own dry turf.

       1) Their wet trail dries into normal turf.
       2) Flood fill: everything the player's colour now walls off from
          the outside becomes theirs. "Outside" = any cell we can reach
          from the arena's edge by stepping up/down/left/right without
          crossing p's colour. Whatever we can't reach is enclosed.

       Unpaintable cells (pillars, ramps) can be walked through by the
       search (so a pillar doesn't act as part of your wall) but are never
       painted. Rival cells inside the loop are taken, trails included.

       In teams, a teammate's paint walls off the outside too.

       Returns { cells, cx, cz, list }: cells filled (not counting the
       trail drying), the world centre of the filled area, and the list of
       filled cell indices (for the fill-sweep effect).
       ===================================================================== */
    closeLoop(p) {
      const code = p + 1;
      this.dryTrail(p);

      const N = this.N, owner = this.owner, seen = this._seen, q = this._queue;
      let head = 0, tail = 0;
      // "Wall" = p's colour (or a teammate's). Mark it seen up front so
      // the search treats it as solid.
      if (this.teams) for (let c = 0; c < N * N; c++) seen[c] = this.friendly(owner[c], p) ? 1 : 0;
      else for (let c = 0; c < N * N; c++) seen[c] = owner[c] === code ? 1 : 0;
      // Seed the search with every edge cell that isn't wall.
      const seed = (c) => { if (!seen[c]) { seen[c] = 2; q[tail++] = c; } };
      for (let k = 0; k < N; k++) {
        seed(k);                   // bottom row
        seed((N - 1) * N + k);     // top row
        seed(k * N);               // left column
        seed(k * N + N - 1);       // right column
      }
      // Breadth-first: spread to neighbours that aren't p's colour.
      while (head < tail) {
        const c = q[head++];
        const i = c % N;
        if (i > 0) seed(c - 1);
        if (i < N - 1) seed(c + 1);
        if (c >= N) seed(c - N);
        if (c < N * (N - 1)) seed(c + N);
      }

      // Everything not reached (seen still 0: not wall, not outside) and
      // paintable fills.
      let cells = 0, sx = 0, sz = 0;
      const list = [];
      for (let c = 0; c < N * N; c++) {
        if (seen[c] || this.blocked[c]) continue;
        this._set(c, code, 0);
        list.push(c);
        cells++;
        sx += c % N;
        sz += (c / N) | 0;
      }
      return cells
        ? { cells, cx: this.cellX(sx / cells), cz: this.cellZ(sz / cells), list }
        : { cells: 0, cx: 0, cz: 0, list };
    }

    /* The trail dries in place: still p's paint, just no longer wet.
       Returns how many cells dried. */
    dryTrail(p) {
      const code = p + 1;
      let n = 0;
      for (const c of this.trail[p]) if (this.wet[c] === code && this._set(c, code, 0)) n++;
      this.trail[p] = [];
      return n;
    }

    /* Someone ran over p's trail: every remaining wet cell of it becomes
       the popper's (dry) paint. Returns { cells, cx, cz } like closeLoop. */
    popTrail(p, by) {
      const code = p + 1;
      let cells = 0, sx = 0, sz = 0;
      for (const c of this.trail[p]) {
        if (this.wet[c] !== code) continue;
        this._set(c, by + 1, 0);
        cells++;
        sx += c % this.N;
        sz += (c / this.N) | 0;
      }
      this.trail[p] = [];
      return cells
        ? { cells, cx: this.cellX(sx / cells), cz: this.cellZ(sz / cells) }
        : { cells: 0, cx: 0, cz: 0 };
    }

    /* =====================================================================
       estimateLoop — for bots: "if player p drove this path (a list of
       world points) and then closed the loop, how much would it gain?"

       It draws the path as a 3-cell-wide stroke on a scratch copy of the
       board, runs the same edge flood fill closeLoop uses, and adds up
       what the stroke plus the enclosed area would take: unpainted floor
       counts 1 per cell, a rival's floor 1.4 (stealing hurts them too),
       our own (or a teammate's) floor 0. Doesn't change the real board.
       ===================================================================== */
    estimateLoop(p, pts) {
      const N = this.N, owner = this.owner, seen = this._seen, mark = this._mark, q = this._queue;
      mark.fill(0);
      // Rasterise each segment: step half a cell, mark a plus-shape.
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        const fx0 = (a.x + this.half) / this.cs, fz0 = (a.z + this.half) / this.cs;
        const fx1 = (b.x + this.half) / this.cs, fz1 = (b.z + this.half) / this.cs;
        const steps = Math.max(1, Math.ceil(Math.hypot(fx1 - fx0, fz1 - fz0) * 2));
        for (let s = 0; s <= steps; s++) {
          const i = Math.floor(fx0 + (fx1 - fx0) * (s / steps)), j = Math.floor(fz0 + (fz1 - fz0) * (s / steps));
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const c = j * N + i;
          mark[c] = 1;
          if (i > 0) mark[c - 1] = 1;
          if (i < N - 1) mark[c + 1] = 1;
          if (j > 0) mark[c - N] = 1;
          if (j < N - 1) mark[c + N] = 1;
        }
      }
      // Wall = our side's paint or the stroke; flood from the edges.
      for (let c = 0; c < N * N; c++) seen[c] = mark[c] || this.friendly(owner[c], p) ? 1 : 0;
      let head = 0, tail = 0;
      const seed = (c) => { if (!seen[c]) { seen[c] = 2; q[tail++] = c; } };
      for (let k = 0; k < N; k++) { seed(k); seed((N - 1) * N + k); seed(k * N); seed(k * N + N - 1); }
      while (head < tail) {
        const c = q[head++], i = c % N;
        if (i > 0) seed(c - 1);
        if (i < N - 1) seed(c + 1);
        if (c >= N) seed(c - N);
        if (c < N * (N - 1)) seed(c + N);
      }
      // Gain: stroke cells and enclosed cells that aren't already ours.
      let gain = 0;
      for (let c = 0; c < N * N; c++) {
        if (seen[c] === 2 || this.blocked[c]) continue;
        const o = owner[c];
        if (this.friendly(o, p)) continue;
        gain += o ? 1.4 : 1;
      }
      return gain;
    }

    /* Nearest cell to world (x, z) that passes test(c), searching outward
       in square rings up to maxR cells. Returns the cell index or -1.
       Used by bots ("where's my nearest turf?"). */
    nearest(x, z, test, maxR = this.N) {
      const N = this.N;
      const ci = Math.floor((x + this.half) / this.cs), cj = Math.floor((z + this.half) / this.cs);
      let best = -1, bestD = Infinity;
      for (let r = 0; r <= maxR; r++) {
        // Once we have a hit, one more ring can't beat it by much; stop
        // when the ring is farther than the best distance found.
        if (best !== -1 && r > Math.sqrt(bestD) + 1) break;
        for (let j = cj - r; j <= cj + r; j++) {
          if (j < 0 || j >= N) continue;
          const edgeRow = j === cj - r || j === cj + r;
          for (let i = ci - r; i <= ci + r; i += edgeRow ? 1 : 2 * r || 1) {
            if (i < 0 || i >= N) continue;
            const c = j * N + i;
            if (!test(c)) continue;
            const d = (i - ci) * (i - ci) + (j - cj) * (j - cj);
            if (d < bestD) { bestD = d; best = c; }
          }
        }
      }
      return best;
    }
  }

  TP.M5.PaintGrid = PaintGrid;
})();
