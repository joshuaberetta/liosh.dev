// Magnetized blocks: the page's words, rasterized into local field grids and
// moved as rigid bodies that slide on the paper, collide, attract and repel.
// The sim samples their combined field and treats them as solid.
//
// Units match the sim: CSS pixels and 60 Hz frames.

const G = 1.2;
const MU_S = 0.5;
const MU_K = 0.35;
const K_BLOCK = 300;   // block-to-block magnetic pull/push
const K_HAND = 40;     // how hard the hand magnet pushes blocks around
const RESTITUTION = 0.25;
const CONTACT_FRICTION = 0.3;

function boxBlur(src, gw, gh, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(gw - 1, Math.max(0, x))];
    for (let x = 0; x < gw; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + Math.min(gw - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < gw; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(gh - 1, Math.max(0, y)) * gw + x];
    for (let y = 0; y < gh; y++) {
      out[y * gw + x] = sum * norm;
      sum += tmp[Math.min(gh - 1, y + r + 1) * gw + x] - tmp[Math.max(0, y - r) * gw + x];
    }
  }
  return out;
}

const blur = (src, gw, gh, r) => boxBlur(boxBlur(boxBlur(src, gw, gh, r), gw, gh, r), gw, gh, r);

// Rasterize one element's text, centred in a grid, into a solid mask and an
// outward-pointing field (the gradient of a blurred potential), normalized to 1.
function rasterize(el) {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize);
  // Small words become rounded blocks; filings are bigger than their letters.
  const small = fs < 40;
  const tc = small ? 1 : 3;
  const reach = Math.max(fs, 70);
  const margin = reach * 1.1;
  const W = rect.width + margin * 2, H = rect.height + margin * 2;
  const gw = Math.ceil(W / tc), gh = Math.ceil(H / tc);

  const off = document.createElement("canvas");
  off.width = gw;
  off.height = gh;
  const c = off.getContext("2d", { willReadFrequently: true });
  c.scale(1 / tc, 1 / tc);
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if ("letterSpacing" in c && cs.letterSpacing !== "normal") c.letterSpacing = cs.letterSpacing;
  const text = el.textContent;
  const m = c.measureText(text);
  const asc = m.fontBoundingBoxAscent ?? fs * 0.95, desc = m.fontBoundingBoxDescent ?? fs * 0.25;
  c.fillText(text, margin, margin + (rect.height - asc - desc) / 2 + asc);

  const size = gw * gh;
  const px = c.getImageData(0, 0, gw, gh).data;
  let mask = new Float32Array(size);
  for (let i = 0; i < size; i++) mask[i] = px[i * 4 + 3] / 255;
  if (small) mask = blur(mask, gw, gh, Math.max(1, Math.round((fs * 0.12) / tc)));
  const threshold = small ? 0.12 : 0.5;

  const solid = new Uint8Array(size);
  const solidF = new Float32Array(size);
  let minX = gw, minY = gh, maxX = -1, maxY = -1;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (mask[i] <= threshold) continue;
      solid[i] = 1;
      solidF[i] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const near = blur(solidF, gw, gh, Math.max(2, Math.round((reach * 0.05) / tc)));
  const far = blur(solidF, gw, gh, Math.max(4, Math.round((reach * 0.3) / tc)));
  const bx = new Float32Array(size), by = new Float32Array(size);
  let max = 1e-6;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      bx[i] = near[i - 1] - near[i + 1] + 3 * (far[i - 1] - far[i + 1]);
      by[i] = near[i - gw] - near[i + gw] + 3 * (far[i - gw] - far[i + gw]);
      max = Math.max(max, Math.hypot(bx[i], by[i]));
    }
  }
  for (let i = 0; i < size; i++) bx[i] /= max, by[i] /= max;

  // Collision box: the solid's bounds, relative to the element's centre.
  // Tiny marks like "·" get a minimum size so they aren't featherweight.
  const ox = W / 2, oy = H / 2;
  const sw = maxX < 0 ? rect.width / 2 : ((maxX - minX + 1) * tc) / 2;
  const sh = maxY < 0 ? rect.height / 2 : ((maxY - minY + 1) * tc) / 2;
  const ocx = maxX < 0 ? 0 : (minX * tc + sw) - ox;
  const ocy = maxY < 0 ? 0 : (minY * tc + sh) - oy;
  const hw = Math.max(sw, 8), hh = Math.max(sh, 8);

  return {
    rect, tc, gw, gh, ox, oy, bx, by, solid,
    r2: ox * ox + oy * oy,
    hw, hh, ocx, ocy,
  };
}

// Oriented collision box in world space.
function box(b) {
  const c = b.cos, s = b.sin;
  return {
    cx: b.x + c * b.ocx - s * b.ocy,
    cy: b.y + s * b.ocx + c * b.ocy,
    ux: c, uy: s, vx: -s, vy: c,
    hw: b.hw, hh: b.hh,
  };
}

function corners(o) {
  const pts = [];
  for (const [a, d] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    pts.push([o.cx + o.ux * o.hw * a + o.vx * o.hh * d, o.cy + o.uy * o.hw * a + o.vy * o.hh * d]);
  }
  return pts;
}

function inside(o, px, py) {
  const dx = px - o.cx, dy = py - o.cy;
  return Math.abs(dx * o.ux + dy * o.uy) <= o.hw && Math.abs(dx * o.vx + dy * o.vy) <= o.hh;
}

function applyImpulse(b, jx, jy, rx, ry) {
  if (!b) return;
  b.vx += jx * b.invM;
  b.vy += jy * b.invM;
  b.om += (rx * jy - ry * jx) * b.invI;
}

// Resolve a contact between A and B (either may be null for a wall).
// The normal points from A to B.
function resolve(A, B, nx, ny, px, py, pen) {
  const ia = A ? A.invM : 0, ib = B ? B.invM : 0;
  const iia = A ? A.invI : 0, iib = B ? B.invI : 0;
  const rax = A ? px - A.x : 0, ray = A ? py - A.y : 0;
  const rbx = B ? px - B.x : 0, rby = B ? py - B.y : 0;
  const vax = A ? A.vx - A.om * ray : 0, vay = A ? A.vy + A.om * rax : 0;
  const vbx = B ? B.vx - B.om * rby : 0, vby = B ? B.vy + B.om * rbx : 0;
  const rvx = vbx - vax, rvy = vby - vay;
  const vn = rvx * nx + rvy * ny;

  if (vn < 0) {
    const ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx;
    const j = (-(1 + RESTITUTION) * vn) / (ia + ib + ran * ran * iia + rbn * rbn * iib);
    applyImpulse(A, -j * nx, -j * ny, rax, ray);
    applyImpulse(B, j * nx, j * ny, rbx, rby);

    // Glancing blows set blocks spinning.
    let tx = rvx - vn * nx, ty = rvy - vn * ny;
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-6) {
      tx /= tl; ty /= tl;
      const rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
      const vt = rvx * tx + rvy * ty;
      let jt = -vt / (ia + ib + rat * rat * iia + rbt * rbt * iib);
      jt = Math.max(-CONTACT_FRICTION * j, Math.min(CONTACT_FRICTION * j, jt));
      applyImpulse(A, -jt * tx, -jt * ty, rax, ray);
      applyImpulse(B, jt * tx, jt * ty, rbx, rby);
    }
  }

  const corr = (Math.max(0, pen - 0.3) * 0.8) / (ia + ib);
  if (A) A.x -= nx * corr * ia, A.y -= ny * corr * ia;
  if (B) B.x += nx * corr * ib, B.y += ny * corr * ib;
}

function collide(A, B) {
  const dxc = B.x - A.x, dyc = B.y - A.y;
  const reach = Math.hypot(A.hw, A.hh) + Math.hypot(B.hw, B.hh) + Math.hypot(A.ocx, A.ocy) + Math.hypot(B.ocx, B.ocy);
  if (dxc * dxc + dyc * dyc > reach * reach) return;

  const a = box(A), b = box(B);
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  let best = Infinity, nx = 0, ny = 0;
  for (const [ax, ay] of [[a.ux, a.uy], [a.vx, a.vy], [b.ux, b.uy], [b.vx, b.vy]]) {
    const pa = a.hw * Math.abs(a.ux * ax + a.uy * ay) + a.hh * Math.abs(a.vx * ax + a.vy * ay);
    const pb = b.hw * Math.abs(b.ux * ax + b.uy * ay) + b.hh * Math.abs(b.vx * ax + b.vy * ay);
    const d = dx * ax + dy * ay;
    const pen = pa + pb - Math.abs(d);
    if (pen <= 0) return;
    if (pen < best) {
      best = pen;
      const sgn = d < 0 ? -1 : 1;
      nx = ax * sgn;
      ny = ay * sgn;
    }
  }

  // Contact point: the average of any corners poking into the other box.
  let px = 0, py = 0, k = 0;
  for (const [x, y] of corners(b)) if (inside(a, x, y)) px += x, py += y, k++;
  for (const [x, y] of corners(a)) if (inside(b, x, y)) px += x, py += y, k++;
  if (k) px /= k, py /= k;
  else px = (a.cx + b.cx) / 2, py = (a.cy + b.cy) / 2;
  resolve(A, B, nx, ny, px, py, best);
}

export class Blocks {
  // fieldScale converts a block's magnetization into field strength on filings.
  constructor(elements, fieldScale) {
    this.elements = elements;
    this.fieldScale = fieldScale;
    this.bodies = [];
    this.strength = 1;
    this.held = null;   // { body, lx, ly, tx, ty }
    this.homing = null; // { t, from } while gliding back to rest
  }

  // Measure each word where it sits and rebuild its field. Blocks return to rest.
  build(w, h, strength) {
    this.w = w;
    this.h = h;
    this.bodies = this.elements.map((el) => {
      el.style.transform = "";
      const g = rasterize(el);
      const m = (g.hw * g.hh * 4) / 100;
      const I = (m * (4 * g.hw * g.hw + 4 * g.hh * g.hh)) / 12;
      return {
        ...g,
        el,
        pol: el.dataset.pole === "S" ? -1 : 1,
        restX: g.rect.left + g.rect.width / 2,
        restY: g.rect.top + g.rect.height / 2,
        x: g.rect.left + g.rect.width / 2,
        y: g.rect.top + g.rect.height / 2,
        vx: 0, vy: 0, th: 0, om: 0, cos: 1, sin: 0,
        m, I, invM: 1 / m, invI: 1 / I,
        mag: 0, // signed magnetization: polarity times strength
        k: 0,   // the same, as field strength on filings
      };
    });
    this.calibrate();
    this.setStrength(strength);
  }

  // Scale block-to-block magnetism so that, at strength 1, every word sitting in
  // its resting place feels at most half the pull needed to break friction.
  // Closer layouts (like phones) get gentler magnets, and nothing moves on load.
  calibrate() {
    let worst = 0;
    for (const b of this.bodies) {
      let ax = 0, ay = 0;
      for (const o of this.bodies) {
        if (o === b) continue;
        const dx = b.x - o.x, dy = b.y - o.y;
        const r2 = dx * dx + dy * dy + 100;
        const f = (b.pol * o.pol * Math.sqrt(b.m * o.m)) / (r2 * Math.sqrt(r2) * b.m);
        ax += dx * f;
        ay += dy * f;
      }
      worst = Math.max(worst, Math.hypot(ax, ay));
    }
    this.kBlock = worst > 0 ? Math.min(K_BLOCK, (0.5 * MU_S * G) / worst) : K_BLOCK;
  }

  setStrength(s) {
    this.strength = s;
    for (const b of this.bodies) {
      b.mag = s * b.pol;
      b.k = b.mag * this.fieldScale;
    }
  }

  bodyFor(el) {
    return this.bodies.find((b) => b.el === el);
  }

  // Hold a block at the point you grabbed it, like a spring on a pin.
  grab(body, px, py) {
    this.homing = null;
    const dx = px - body.x, dy = py - body.y;
    this.held = {
      body,
      lx: dx * body.cos + dy * body.sin,
      ly: -dx * body.sin + dy * body.cos,
      tx: px, ty: py,
    };
  }

  dragTo(px, py) {
    if (this.held) this.held.tx = px, this.held.ty = py;
  }

  release() {
    this.held = null;
  }

  // Glide every word back to where it sits in the layout, turning the short way.
  recenter() {
    this.held = null;
    const wrap = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    this.homing = { t: 0, from: this.bodies.map((b) => ({ x: b.x, y: b.y, th: wrap(b.th) })) };
  }

  glide() {
    const hm = this.homing;
    hm.t = Math.min(1, hm.t + 1 / 45);
    const e = hm.t < 0.5 ? 4 * hm.t ** 3 : 1 - (-2 * hm.t + 2) ** 3 / 2;
    this.bodies.forEach((b, i) => {
      const f = hm.from[i];
      b.x = f.x + (b.restX - f.x) * e;
      b.y = f.y + (b.restY - f.y) * e;
      b.th = f.th * (1 - e);
      b.cos = Math.cos(b.th);
      b.sin = Math.sin(b.th);
      b.vx = b.vy = b.om = 0;
    });
    if (hm.t === 1) this.homing = null;
  }

  step({ gx, gy, agitation, hand }) {
    if (this.homing) return this.glide();
    const bodies = this.bodies;
    const gz = Math.sqrt(Math.max(0, G * G - gx * gx - gy * gy));
    const normal = gz * (1 - 0.6 * agitation);
    const held = this.held && this.held.body;

    for (const b of bodies) {
      // A held block is lifted a little: heavier in collisions, no paper friction.
      const lift = b === held ? 0.25 : 1;
      b.invM = lift / b.m;
      b.invI = lift / b.I;
    }

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      let ax = gx, ay = gy;

      // Like poles push apart, opposite poles pull together.
      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        const o = bodies[j];
        const dx = b.x - o.x, dy = b.y - o.y;
        const r2 = dx * dx + dy * dy + 100;
        const f = (this.kBlock * b.mag * o.mag * Math.sqrt(b.m * o.m)) / (r2 * Math.sqrt(r2) * b.m);
        ax += dx * f;
        ay += dy * f;
      }

      if (hand && hand.q) {
        const dx = b.x - hand.x, dy = b.y - hand.y;
        const f = (b.mag * hand.q * K_HAND) / (dx * dx + dy * dy + 400);
        ax += dx * f;
        ay += dy * f;
      }

      if (b === held) {
        const h = this.held;
        const rx = h.lx * b.cos - h.ly * b.sin, ry = h.lx * b.sin + h.ly * b.cos;
        const vax = b.vx - b.om * ry, vay = b.vy + b.om * rx;
        const jx = ((h.tx - (b.x + rx)) * 0.25 - vax * 0.6) * b.m;
        const jy = ((h.ty - (b.y + ry)) * 0.25 - vay * 0.6) * b.m;
        b.vx += jx / b.m + ax;
        b.vy += jy / b.m + ay;
        b.om += (rx * jy - ry * jx) / b.I;
        b.om *= 0.92;
      } else if (Math.hypot(b.vx, b.vy) < 0.05 && Math.hypot(ax, ay) < MU_S * normal) {
        b.vx = b.vy = 0;
      } else {
        b.vx += ax;
        b.vy += ay;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 0) {
          const k = (Math.max(0, sp - MU_K * normal) / sp) * 0.99;
          b.vx *= k;
          b.vy *= k;
        }
      }

      if (b !== held) {
        const spin = Math.abs(b.om);
        const drop = (MU_K * normal * 3) / (b.hw + b.hh);
        b.om = spin < 0.002 ? 0 : Math.sign(b.om) * Math.max(0, spin - drop) * 0.97;
      }

      b.x += b.vx;
      b.y += b.vy;
      b.th += b.om;
      b.cos = Math.cos(b.th);
      b.sin = Math.sin(b.th);
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) collide(bodies[i], bodies[j]);
      }
      for (const b of bodies) this.walls(b);
    }
  }

  // Keep every corner on screen, bouncing off the edges.
  walls(b) {
    const o = box(b);
    for (const [x, y] of corners(o)) {
      if (x < 0) resolve(null, b, 1, 0, x, y, -x);
      else if (x > this.w) resolve(null, b, -1, 0, x, y, x - this.w);
      if (y < 0) resolve(null, b, 0, 1, x, y, -y);
      else if (y > this.h) resolve(null, b, 0, -1, x, y, y - this.h);
    }
  }

  sync() {
    for (const b of this.bodies) {
      b.el.style.transform = `translate(${b.x - b.restX}px, ${b.y - b.restY}px) rotate(${b.th}rad)`;
    }
  }
}
