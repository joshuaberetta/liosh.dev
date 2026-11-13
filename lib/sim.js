// Iron filings on paper: rigid soft-iron rods magnetized by the field beneath,
// interacting end-to-end as tiny magnets, held in place by friction.
//
// Units are CSS pixels and 60 Hz frames, so velocities are px/frame and
// accelerations px/frame².

const G = 1.2;          // gravity when the paper is tipped vertical
const MU_S = 0.5;       // static friction, iron on paper
const MU_K = 0.35;      // kinetic friction
const Q_MAX = 12;       // saturated pole strength of a filing
const SUSCEPT = 2;      // how quickly filings saturate in a field
const K_MAG = 0.5;      // filing-to-filing magnetic coupling
const K_CORE = 1.2;     // contact stiffness so filings don't pass through each other
const DRAG = 0.88;
const ANG_DRAG = 0.8;
const KICK = 1.6;       // jostle from tapping, px/frame at full agitation
const KICK_SPIN = 0.5;
const V_REST = 0.05;
const W_REST = 0.01;

// Grid cell of a shape under a world point, or -1. Shapes are rotated rigid
// bodies carrying a local grid: { x, y, cos, sin, ox, oy, tc, gw, gh, r2 }.
export function cellIn(sh, px, py) {
  const dx = px - sh.x, dy = py - sh.y;
  if (dx * dx + dy * dy > sh.r2) return -1;
  const lx = dx * sh.cos + dy * sh.sin + sh.ox;
  const ly = -dx * sh.sin + dy * sh.cos + sh.oy;
  if (lx < 0 || ly < 0) return -1;
  const cx = (lx / sh.tc) | 0, cy = (ly / sh.tc) | 0;
  return cx >= sh.gw || cy >= sh.gh ? -1 : cy * sh.gw + cx;
}

export class Sim {
  constructor() {
    this.n = 0;
    this.poles = [];      // { x, y, q } magnets under the paper
    this.gx = 0;          // in-plane gravity from tilting
    this.gy = 0;
    this.agitation = 0;   // 0..1, how hard the paper is being tapped
    this.restless = 0;    // agitation never decays below this
    this.shapes = [];     // magnetized solids, each also with an outward field (bx, by) scaled by k
  }

  // Room is reserved for up to `capacity` filings so more can be poured in later.
  init(width, height, count, scale, capacity = count) {
    const F = () => new Float32Array(capacity);
    this.n = count;
    this.max = capacity;
    this.scale = scale;
    this.x = F(); this.y = F();
    this.vx = F(); this.vy = F();
    this.th = F(); this.om = F();
    this.len = F(); this.wid = F(); this.seed = F();
    this.q = F(); this.hx = F(); this.hy = F(); this.h2 = F();
    this.fx = F(); this.fy = F(); this.tq = F();
    this.kl = F(); this.ka = F();
    this.cellOf = new Int32Array(capacity);
    this.order = new Int32Array(capacity);

    let maxLen = 0;
    for (let i = 0; i < capacity; i++) {
      this.len[i] = (4.5 + Math.random() ** 1.6 * 8) * scale;
      this.wid[i] = Math.max(1, (1 + Math.random() * 0.8) * scale);
      this.seed[i] = Math.random();
      maxLen = Math.max(maxLen, this.len[i]);
    }
    this.maxLen = maxLen;
    this.cell = maxLen + 3 * scale;
    this.setBounds(width, height);
    this.scatter();
  }

  setBounds(width, height) {
    if (this.w) {
      const sx = width / this.w, sy = height / this.h;
      for (let i = 0; i < this.n; i++) this.x[i] *= sx, this.y[i] *= sy;
    }
    this.w = width;
    this.h = height;
    this.S = Math.min(width, height);
    this.C = this.S / 3;
    this.soft = (this.S * 0.02) ** 2;
    this.cols = Math.ceil(width / this.cell);
    this.rows = Math.ceil(height / this.cell);
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cursor = new Int32Array(this.cols * this.rows);
  }

  scatter() {
    for (let i = 0; i < this.n; i++) {
      this.x[i] = Math.random() * this.w;
      this.y[i] = Math.random() * this.h;
      this.th[i] = Math.random() * Math.PI;
      this.vx[i] = this.vy[i] = this.om[i] = 0;
    }
  }

  // Sprinkle filings around a point. They land with a little scatter and spin;
  // once at capacity, random existing filings are picked up and reused.
  pour(px, py, count, radius) {
    const s = this.scale;
    for (let k = 0; k < count; k++) {
      const i = this.n < this.max ? this.n++ : (Math.random() * this.n) | 0;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const kick = Math.random() * 1.5 * s;
      this.x[i] = Math.max(1, Math.min(this.w - 1, px + Math.cos(a) * r));
      this.y[i] = Math.max(1, Math.min(this.h - 1, py + Math.sin(a) * r));
      this.th[i] = Math.random() * Math.PI;
      this.vx[i] = Math.cos(a) * kick;
      this.vy[i] = Math.sin(a) * kick;
      this.om[i] = (Math.random() - 0.5) * 0.6;
    }
  }

  tap(amount = 0.7) {
    this.agitation = Math.min(1, this.agitation + amount);
  }

  // Field of the magnets: each pole is a 2D source, softened near its centre.
  field(px, py, out, o) {
    let bx = 0, by = 0;
    for (const p of this.poles) {
      const dx = px - p.x, dy = py - p.y;
      const k = (p.q * this.C) / (dx * dx + dy * dy + this.soft);
      bx += dx * k;
      by += dy * k;
    }
    for (const sh of this.shapes) {
      const c = cellIn(sh, px, py);
      if (c < 0) continue;
      const fx = sh.bx[c] * sh.k, fy = sh.by[c] * sh.k;
      bx += fx * sh.cos - fy * sh.sin;
      by += fx * sh.sin + fy * sh.cos;
    }
    out[o] = bx;
    out[o + 1] = by;
  }

  step() {
    const { n, x, y, vx, vy, th, om, len, q, hx, hy, h2, fx, fy, tq, kl, ka } = this;
    const b = this._b || (this._b = new Float32Array(4));

    // 1. Magnetize each filing and apply the external field's force and torque.
    for (let i = 0; i < n; i++) {
      const h = len[i] / 2;
      const ux = Math.cos(th[i]), uy = Math.sin(th[i]);
      const ex = ux * h, ey = uy * h;
      hx[i] = ex; hy[i] = ey; h2[i] = h * h;

      this.field(x[i] + ex, y[i] + ey, b, 0);
      this.field(x[i] - ex, y[i] - ey, b, 2);
      const bcx = (b[0] + b[2]) / 2, bcy = (b[1] + b[3]) / 2;

      // Long thin rods magnetize along their axis; the tip facing the field becomes north.
      const qi = Q_MAX * Math.tanh(SUSCEPT * (bcx * ux + bcy * uy));
      q[i] = qi;

      // Tip carries +q, tail -q: the field gradient pulls, the field itself twists.
      const dbx = b[0] - b[2], dby = b[1] - b[3];
      fx[i] = qi * dbx;
      fy[i] = qi * dby;
      tq[i] = qi * (ex * (b[1] + b[3]) - ey * (b[0] + b[2]));
      const aq = Math.abs(qi);
      kl[i] = (aq * Math.hypot(dbx, dby)) / (2 * h);
      ka[i] = 2 * h * aq * Math.hypot(bcx, bcy);
    }

    // 2. Bin filings into a grid so neighbours are cheap to find.
    const { cols, rows, cell, cellStart, cursor, cellOf, order } = this;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, (x[i] / cell) | 0));
      const cy = Math.min(rows - 1, Math.max(0, (y[i] / cell) | 0));
      const c = cx + cy * cols;
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < cols * rows; c++) cellStart[c + 1] += cellStart[c];
    cursor.set(cellStart.subarray(0, cols * rows));
    for (let i = 0; i < n; i++) order[cursor[cellOf[i]]++] = i;

    // 3. Filing-filing forces: each end is a pole, opposite ends attract into
    //    chains and like ends repel, which spaces the field lines apart.
    const s = this.scale;
    const cut = cell * 0.9, cut2 = cut * cut;
    const reach = this.maxLen + cut, reach2 = reach * reach;
    const eps2 = (1.2 * s) ** 2;
    const core = 1.4 * s, core2 = core * core;
    const eCore = 1.2 * s, eCore2 = eCore * eCore;

    const ends = (i, j, si, sj) => {
      const ax = x[i] + si * hx[i], ay = y[i] + si * hy[i];
      const rx = ax - x[j] - sj * hx[j], ry = ay - y[j] - sj * hy[j];
      const r2 = rx * rx + ry * ry;
      if (r2 > cut2) return;
      const inv = 1 / (r2 + eps2);
      const fall = (1 - r2 / cut2) ** 2;
      const qq = si * q[i] * sj * q[j];
      let f = K_MAG * qq * inv * Math.sqrt(inv) * fall;
      let k = Math.abs(f) * 2;
      if (r2 < eCore2) {
        const r = Math.sqrt(r2) + 1e-6;
        f += (K_CORE * (eCore - r)) / r;
        k += K_CORE;
      }
      const Fx = f * rx, Fy = f * ry;
      fx[i] += Fx; fy[i] += Fy;
      tq[i] += si * (hx[i] * Fy - hy[i] * Fx);
      fx[j] -= Fx; fy[j] -= Fy;
      tq[j] -= sj * (hx[j] * Fy - hy[j] * Fx);
      kl[i] += k; kl[j] += k;
      ka[i] += k * h2[i]; ka[j] += k * h2[j];
    };

    const pair = (i, j) => {
      const dx = x[j] - x[i], dy = y[j] - y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > reach2) return;
      if (d2 < core2) {
        const d = Math.sqrt(d2) + 1e-6;
        const f = (K_CORE * (core - d)) / d;
        fx[i] -= dx * f; fy[i] -= dy * f;
        fx[j] += dx * f; fy[j] += dy * f;
        kl[i] += K_CORE; kl[j] += K_CORE;
      }
      if (Math.abs(q[i] * q[j]) < 0.01) return;
      ends(i, j, 1, 1);
      ends(i, j, 1, -1);
      ends(i, j, -1, 1);
      ends(i, j, -1, -1);
    };

    // Visit each pair once: own cell, then the four "forward" neighbour cells.
    const fwd = [[1, 0], [-1, 1], [0, 1], [1, 1]];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cx + cy * cols;
        const start = cellStart[c], end = cellStart[c + 1];
        for (let a = start; a < end; a++) {
          const i = order[a];
          for (let bIdx = a + 1; bIdx < end; bIdx++) pair(i, order[bIdx]);
          for (const [ox, oy] of fwd) {
            const nx = cx + ox, ny = cy + oy;
            if (nx < 0 || nx >= cols || ny >= rows) continue;
            const nc = nx + ny * cols;
            for (let bIdx = cellStart[nc], bEnd = cellStart[nc + 1]; bIdx < bEnd; bIdx++) pair(i, order[bIdx]);
          }
        }
      }
    }

    // 4. Integrate with friction. Stiff terms are damped implicitly for stability.
    const agit = this.agitation;
    const gz = Math.sqrt(Math.max(0, G * G - this.gx * this.gx - this.gy * this.gy));
    const normal = gz * (1 - 0.9 * agit); // bouncing filings are briefly airborne
    const vMax = 3 * s;
    const { w, h: H } = this;

    for (let i = 0; i < n; i++) {
      const L = len[i];
      const m = L;
      const I = (m * L * L) / 12;

      const ax = fx[i] / m + this.gx, ay = fy[i] / m + this.gy;
      let vxi = vx[i], vyi = vy[i];
      if (Math.hypot(vxi, vyi) < V_REST && Math.hypot(ax, ay) < MU_S * normal) {
        vxi = vyi = 0;
      } else {
        vxi += ax;
        vyi += ay;
        const sp = Math.hypot(vxi, vyi);
        if (sp > 0) {
          const k = (Math.max(0, sp - MU_K * normal) / sp) * DRAG / (1 + kl[i] / m);
          vxi *= k;
          vyi *= k;
          const sp2 = sp * k;
          if (sp2 > vMax) vxi *= vMax / sp2, vyi *= vMax / sp2;
        }
      }

      // Rotational friction: torque from friction over the rod's length, divided by I.
      const alpha = tq[i] / I;
      const muRot = (3 * normal) / L;
      let omi = om[i];
      if (Math.abs(omi) < W_REST && Math.abs(alpha) < MU_S * muRot) {
        omi = 0;
      } else {
        omi += alpha;
        const sw = Math.abs(omi);
        omi *= (Math.max(0, sw - MU_K * muRot) / (sw || 1)) * ANG_DRAG / (1 + ka[i] / I);
        if (omi > 0.5) omi = 0.5;
        else if (omi < -0.5) omi = -0.5;
      }

      if (agit > 0.01) {
        vxi += (Math.random() - 0.5) * agit * KICK * s;
        vyi += (Math.random() - 0.5) * agit * KICK * s;
        omi += (Math.random() - 0.5) * agit * KICK_SPIN;
      }

      let xi = x[i] + vxi, yi = y[i] + vyi;
      // Filings pile against solid shapes but can't pass into them, and a shape
      // that moves onto them shoves them back out, away from its surface.
      if (this.shapes.length) {
        let hit = null, hc = -1;
        for (const sh of this.shapes) {
          const c = cellIn(sh, x[i], y[i]);
          if (c >= 0 && sh.solid[c]) { hit = sh; hc = c; break; }
        }
        if (hit) {
          const lx = hit.bx[hc], ly = hit.by[hc];
          const ox = lx * hit.cos - ly * hit.sin, oy = lx * hit.sin + ly * hit.cos;
          const om = Math.hypot(ox, oy) || 1;
          xi = x[i] + (ox / om) * 4 * s;
          yi = y[i] + (oy / om) * 4 * s;
          vxi = vyi = 0;
        } else {
          for (const sh of this.shapes) {
            const c = cellIn(sh, xi, yi);
            if (c >= 0 && sh.solid[c]) {
              xi = x[i]; yi = y[i];
              vxi = vyi = 0;
              break;
            }
          }
        }
      }
      if (xi < 1) xi = 1, vxi = 0;
      else if (xi > w - 1) xi = w - 1, vxi = 0;
      if (yi < 1) yi = 1, vyi = 0;
      else if (yi > H - 1) yi = H - 1, vyi = 0;

      x[i] = xi; y[i] = yi;
      vx[i] = vxi; vy[i] = vyi;
      th[i] += omi;
      om[i] = omi;
    }

    this.agitation = Math.max(this.restless, this.agitation * 0.965);
    if (this.agitation < 0.005) this.agitation = 0;
  }
}
