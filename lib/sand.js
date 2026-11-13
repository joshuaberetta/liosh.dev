// Sand on a vibrating plate (a Chladni plate). The plate rings in a mix of its
// standing-wave modes, each weighted by how close the drive frequency is to its
// resonance. Grains bounce where the plate moves and come to rest where it
// doesn't, so they gather on the nodal lines.
//
// Units are CSS pixels and 60 Hz frames, like the filings. The plate spans the
// screen: plate coordinates u, v run 0..1 across its width and height.

import { cellIn } from "./sim.js";
import { compile } from "./render.js";

const F0 = 24;          // Hz per unit of m² + n²: plate frequencies go as wavenumber squared
const SPLIT = 0.035;    // the free edges split each ± pair of modes apart in frequency
const MAX_ORDER = 10;   // highest mode number; finer patterns get lost on a phone
const Q = 150;          // quality factor: how sharp each resonance is
const TOUCH = 0.25;     // extra damping a fingertip adds to modes that move under it
const THRESHOLD = 0.1;  // amplitude (of a full resonance) below which grains stay put
const HOP = 2.6;        // launch speed off the plate at full amplitude, px/frame
const KICK = 1.4;       // sideways scatter of a hop, px/frame
const DRIFT = 0.6;      // bias of a hop down the amplitude slope, toward the nodes
const CREEP = 0.5;      // below the hop threshold, grains still jiggle downhill, px/frame
const LINE = 2.5;       // grains come to rest up to this far either side of a node, px
const GZ = 0.32;        // gravity on a hopping grain, px/frame²
const G = 1.2;          // gravity when the plate is tipped vertical (as in sim.js)
const MU_S = 0.55;      // static friction, sand on steel
const MU_K = 0.4;
const V_REST = 0.05;
const CELL = 4;         // amplitude grid spacing, px

export const F_MIN = 20, F_MAX = 5000;

// The plate's modes: the classic Chladni forms for a square plate with free
// edges, cos(mπu)cos(nπv) ± cos(nπu)cos(mπv), normalized to peak at 1.
const CANDIDATES = [];
for (let m = 1; m <= MAX_ORDER; m++) {
  for (let n = 0; n <= m; n++) {
    const f = F0 * (m * m + n * n);
    if (m === n) CANDIDATES.push({ m, n, s: 0, f });
    else CANDIDATES.push({ m, n, s: 1, f: f * (1 + SPLIT) }, { m, n, s: -1, f: f * (1 - SPLIT) });
  }
}
CANDIDATES.sort((a, b) => a.f - b.f);

// Two modes ringing at almost the same frequency are out of phase, so neither
// one's nodes stay still and the lines break up. Keep modes far enough apart
// that each resonance is a single clean pattern.
const MIN_GAP = 1.03;
const MODES = [];
for (const md of CANDIDATES) {
  const last = MODES[MODES.length - 1];
  if (!last || md.f / last.f > MIN_GAP) MODES.push(md);
}
const RESONANCES = MODES.map((md) => md.f);

const fract = (v) => v - Math.floor(v);

function phi(md, u, v) {
  const a = Math.cos(md.m * Math.PI * u) * Math.cos(md.n * Math.PI * v);
  if (!md.s) return a;
  return 0.5 * (a + md.s * Math.cos(md.n * Math.PI * u) * Math.cos(md.m * Math.PI * v));
}

const PLATE_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Brushed steel, glowing faintly coral where the plate is moving hardest.
const PLATE_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uDpr;
uniform vec2 uGrid;
uniform sampler2D uAmp;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = gl_FragCoord.xy / uDpr;
  p.y = uRes.y - p.y;
  float brush = hash(vec2(floor(p.y * uDpr), floor(p.x / 90.0))) * 0.6 + hash(vec2(floor(p.y * uDpr * 0.5), 7.0)) * 0.4;
  vec3 col = vec3(0.064, 0.063, 0.078) + (brush - 0.5) * 0.012;
  col += (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.01;
  vec2 c = p / uRes - 0.5;
  col *= 1.0 - dot(c, c) * 0.7;
  float a = texture(uAmp, p / uGrid).r;
  col += vec3(1.0, 0.48, 0.35) * a * a * 0.06;
  outColor = vec4(col, 1.0);
}`;

const GRAIN_VS = `#version 300 es
layout(location = 0) in vec4 aGrain; // x, y, height, seed
uniform vec2 uRes;
uniform float uDpr;
uniform float uShadow;
out float vSeed;
out float vSize;
out float vAlpha;
out float vLift;
void main() {
  float z = aGrain.z;
  float size = (1.4 + aGrain.w * 1.1) * (1.0 + z * 0.03);
  vec2 pos = aGrain.xy;
  vAlpha = 1.0;
  if (uShadow > 0.5) {
    // Airborne grains cast a softer shadow that falls further away.
    pos += vec2(0.5, 0.8) + vec2(0.35, 0.5) * z;
    size *= 1.5 + z * 0.04;
    vAlpha = 0.5 / (1.0 + z * 0.15);
  }
  vSeed = aGrain.w;
  vSize = size * uDpr;
  vLift = min(z / 10.0, 1.0);
  vec2 clip = pos / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = vSize + 1.0;
}`;

const GRAIN_FS = `#version 300 es
precision highp float;
in float vSeed;
in float vSize;
in float vAlpha;
in float vLift;
uniform float uShadow;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * (vSize + 1.0);
  float r = vSize * 0.5;
  float d = length(q);
  if (uShadow > 0.5) {
    float a = smoothstep(r, r * 0.2, d) * vAlpha;
    if (a <= 0.0) discard;
    outColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  float a = clamp(r - d + 0.5, 0.0, 1.0);
  if (a <= 0.0) discard;
  // Pale quartz with darker grains mixed in, lit from the top left.
  float tone = fract(vSeed * 7.13);
  vec3 base = mix(vec3(0.88, 0.81, 0.66), vec3(0.58, 0.48, 0.37), tone * tone * tone);
  float light = 0.8 + 0.35 * clamp(-(q.x + q.y) / max(r, 0.5) * 0.5, -1.0, 1.0);
  vec3 col = base * light * (1.0 + vLift * 0.15);
  outColor = vec4(col * a, a);
}`;

export function createSand(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, alpha: false });
  if (!gl) return null;

  let plate, grain;
  try {
    plate = compile(gl, PLATE_VS, PLATE_FS);
    grain = compile(gl, GRAIN_VS, GRAIN_FS);
  } catch {
    return null;
  }

  const vao = gl.createVertexArray();
  const grainBuf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, grainBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const ampTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, ampTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let w = 0, h = 0, dpr = 1;
  let gw = 0, gh = 0;
  let amp = new Float32Array(0), ampBytes = new Uint8Array(0);
  let cosU = new Float32Array(0), cosV = new Float32Array(0);
  let dirty = true;
  let freq = RESONANCES[0];
  let touch = null;  // { u, v } where a finger rests on the plate
  let shapes = [];

  // Grains, in flat arrays. Height z > 0 means airborne.
  let n = 0, max = 0;
  let x, y, z, vx, vy, vz, seed, state;
  // Settled grains sleep until something could move them again.
  let asleep, wake = true;

  function initGrains(count, capacity) {
    const F = () => new Float32Array(capacity);
    n = count;
    max = capacity;
    x = F(); y = F(); z = F(); vx = F(); vy = F(); vz = F(); seed = F();
    asleep = new Uint8Array(capacity);
    for (let i = 0; i < capacity; i++) seed[i] = Math.random();
    state = new Float32Array(capacity * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, grainBuf);
    gl.bufferData(gl.ARRAY_BUFFER, state.byteLength, gl.DYNAMIC_DRAW);
    scatter();
  }

  function scatter() {
    wake = true;
    for (let i = 0; i < n; i++) {
      x[i] = Math.random() * w;
      y[i] = Math.random() * h;
      z[i] = vx[i] = vy[i] = vz[i] = 0;
    }
  }

  // The driven plate's displacement amplitude on the grid. Each mode responds
  // like a damped oscillator, 1 / (1 − r² + i·r/Q) with r = f/fₙ, peaking at Q
  // on resonance. Responses are taken in phase with the strongest mode: the
  // small out-of-phase part of its neighbours would only blur its nodes into
  // dotted lines. Amplitude is relative to a full single-mode resonance, so it
  // is near zero between resonances and the sand lies still.
  function computeField() {
    dirty = false;
    wake = true;
    let active = [];
    for (const md of MODES) {
      let damp = 1 / Q;
      if (touch) {
        const p = phi(md, touch.u, touch.v);
        damp += TOUCH * p * p;
      }
      const r = freq / md.f;
      const re = 1 - r * r, im = r * damp;
      const d = re * re + im * im;
      const mag = 1 / Math.sqrt(d);
      if (mag > 0.01 * Q) active.push({ md, re: re / d / Q, im: -im / d / Q, mag });
    }
    active = active.sort((a, b) => b.mag - a.mag).slice(0, 8);
    const lead = active[0];
    const pc = lead ? lead.re / (lead.mag / Q) : 1, ps = lead ? lead.im / (lead.mag / Q) : 0;
    for (const e of active) e.c = e.re * pc + e.im * ps;

    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        let sum = 0;
        for (const { md, c } of active) {
          let p = cosU[md.m * gw + i] * cosV[md.n * gh + j];
          if (md.s) p = 0.5 * (p + md.s * cosU[md.n * gw + i] * cosV[md.m * gh + j]);
          sum += c * p;
        }
        // Kept signed so interpolation puts the node exactly where it crosses zero.
        amp[j * gw + i] = sum;
        ampBytes[j * gw + i] = Math.min(1, Math.abs(sum)) * 255;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, ampTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gw, gh, 0, gl.RED, gl.UNSIGNED_BYTE, ampBytes);
  }

  // Plate amplitude at a page point, interpolated from the signed grid.
  function ampAt(px, py) {
    const fx = Math.max(0, Math.min(gw - 1.001, px / CELL - 0.5));
    const fy = Math.max(0, Math.min(gh - 1.001, py / CELL - 0.5));
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const k = iy * gw + ix;
    const top = amp[k] + (amp[k + 1] - amp[k]) * tx;
    const bot = amp[k + gw] + (amp[k + gw + 1] - amp[k + gw]) * tx;
    return Math.min(1, Math.abs(top + (bot - top) * ty));
  }

  function solidAt(px, py) {
    for (const sh of shapes) {
      const c = cellIn(sh, px, py);
      if (c >= 0 && sh.solid[c]) return { sh, c };
    }
    return null;
  }

  function step(gx = 0, gy = 0) {
    if (dirty) computeField();
    const gz = Math.sqrt(Math.max(0.05, G * G - gx * gx - gy * gy));
    const fall = GZ * gz / G;              // airborne grains fall, and drift downhill
    const ax = GZ * gx / G, ay = GZ * gy / G;
    const normal = gz;
    const gTilt = Math.hypot(gx, gy);
    // Sliding downhill or a moving word can disturb any grain, so check them all.
    const all = gTilt >= MU_S * normal || shapes.some((sh) => sh.vx || sh.vy || sh.om);
    if (wake) asleep.fill(0), wake = false;
    let moving = 0;

    for (let i = 0; i < n; i++) {
      if (asleep[i] && !all) continue;
      let xi = x[i], yi = y[i], vxi = vx[i], vyi = vy[i];
      let restless = z[i] > 0;
      if (z[i] > 0) {
        vxi += ax;
        vyi += ay;
        vz[i] -= fall;
        z[i] += vz[i];
        if (z[i] <= 0) {
          // Landing scuffs off most of the sideways speed.
          z[i] = vz[i] = 0;
          vxi *= 0.3;
          vyi *= 0.3;
        }
      } else {
        const a = ampAt(xi, yi);
        const excess = (a - THRESHOLD) / (1 - THRESHOLD);
        restless = excess > 0;
        if (excess > 0 && Math.random() < 0.15 + excess) {
          // The plate throws the grain up and sideways, and its slope near a
          // node tips the throw toward the node.
          const e = Math.sqrt(excess);
          vz[i] = HOP * e * (0.5 + 0.5 * Math.random());
          z[i] = vz[i];
          const dir = Math.random() * Math.PI * 2, sp = KICK * excess * Math.random();
          const sx = ampAt(xi + 2, yi) - ampAt(xi - 2, yi);
          const sy = ampAt(xi, yi + 2) - ampAt(xi, yi - 2);
          const sl = Math.hypot(sx, sy) || 1;
          vxi = Math.cos(dir) * sp - (sx / sl) * DRIFT * e;
          vyi = Math.sin(dir) * sp - (sy / sl) * DRIFT * e;
        } else if (a > 0.001 && gTilt < MU_S * normal) {
          // Too quiet to hop, but the jiggle still walks grains onto the node
          // itself (and no further), so lines come out thin and single.
          const sx = ampAt(xi + 1, yi) - ampAt(xi - 1, yi);
          const sy = ampAt(xi, yi + 1) - ampAt(xi, yi - 1);
          const sl = Math.hypot(sx, sy);
          // Each grain stops its own small distance short, as a pile has width.
          const gap = sl > 1e-5 ? (2 * a) / sl - LINE * fract(seed[i] * 13.7) : 0;
          const c = gap > 0 ? Math.min(CREEP * Math.sqrt(a / THRESHOLD) * Math.random(), gap) : 0;
          vxi = c ? (-sx / sl) * c : 0;
          vyi = c ? (-sy / sl) * c : 0;
        } else if (Math.hypot(vxi, vyi) < V_REST && gTilt < MU_S * normal) {
          vxi = vyi = 0;
        } else {
          // Sliding on the plate: tilt against kinetic friction.
          vxi += gx;
          vyi += gy;
          const sp = Math.hypot(vxi, vyi);
          const k = sp > 0 ? Math.max(0, sp - MU_K * normal) / sp : 0;
          vxi *= k;
          vyi *= k;
        }
      }

      if (vxi || vyi) {
        let nx = xi + vxi, ny = yi + vyi;
        if (shapes.length && solidAt(nx, ny)) nx = xi, ny = yi, vxi = vyi = 0;
        xi = nx;
        yi = ny;
      }
      // A word moved onto a grain shoves it out, away from its surface.
      if (shapes.length) {
        const hit = solidAt(xi, yi);
        if (hit) {
          const { sh, c } = hit;
          const ox = sh.bx[c] * sh.cos - sh.by[c] * sh.sin, oy = sh.bx[c] * sh.sin + sh.by[c] * sh.cos;
          const om = Math.hypot(ox, oy) || 1;
          xi += (ox / om) * 4;
          yi += (oy / om) * 4;
          vxi = vyi = 0;
        }
      }
      if (xi < 1) xi = 1, vxi = Math.abs(vxi) * 0.3;
      else if (xi > w - 1) xi = w - 1, vxi = -Math.abs(vxi) * 0.3;
      if (yi < 1) yi = 1, vyi = Math.abs(vyi) * 0.3;
      else if (yi > h - 1) yi = h - 1, vyi = -Math.abs(vyi) * 0.3;
      x[i] = xi; y[i] = yi; vx[i] = vxi; vy[i] = vyi;
      if (restless || vxi || vyi || z[i] > 0) moving++;
      else asleep[i] = 1;
    }
    return moving;
  }

  // Index of the resonance nearest a frequency, on a log scale.
  function nearest(f) {
    let best = 0;
    for (let i = 1; i < RESONANCES.length; i++) {
      if (Math.abs(Math.log(RESONANCES[i] / f)) < Math.abs(Math.log(RESONANCES[best] / f))) best = i;
    }
    return best;
  }

  return {
    resize(width, height, ratio) {
      const old = w ? { w, h } : null;
      w = width; h = height; dpr = ratio;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);

      gw = Math.ceil(width / CELL) + 1;
      gh = Math.ceil(height / CELL) + 1;
      amp = new Float32Array(gw * gh);
      ampBytes = new Uint8Array(gw * gh);
      const M = MAX_ORDER + 1;
      cosU = new Float32Array(M * gw);
      cosV = new Float32Array(M * gh);
      for (let k = 0; k < M; k++) {
        for (let i = 0; i < gw; i++) cosU[k * gw + i] = Math.cos((k * Math.PI * (i + 0.5) * CELL) / width);
        for (let j = 0; j < gh; j++) cosV[k * gh + j] = Math.cos((k * Math.PI * (j + 0.5) * CELL) / height);
      }
      dirty = true;
      wake = true;

      if (!max) {
        const count = Math.round(Math.max(6000, Math.min(32000, (width * height) / 36)));
        initGrains(count, Math.round(count * 1.5));
      } else if (old) {
        const sx = width / old.w, sy = height / old.h;
        for (let i = 0; i < n; i++) x[i] *= sx, y[i] *= sy;
      }
    },

    setBlocks(bodies) { shapes = bodies; wake = true; },

    get frequency() { return freq; },
    setFrequency(f) {
      freq = Math.max(F_MIN, Math.min(F_MAX, f));
      dirty = true;
      return freq;
    },
    // Snap to a resonance if the frequency is already close to one.
    snap() {
      const r = RESONANCES[nearest(freq)];
      if (Math.abs(Math.log(r / freq)) < 0.025) freq = r, dirty = true;
      return freq;
    },
    // Step to the next resonance up (dir 1) or down (dir -1), wrapping around.
    resonance(dir) {
      let i = nearest(freq);
      if (Math.abs(Math.log(RESONANCES[i] / freq)) < 0.002 || (dir > 0) === (RESONANCES[i] < freq)) i += dir;
      freq = RESONANCES[(i + RESONANCES.length) % RESONANCES.length];
      dirty = true;
      return freq;
    },
    resonanceAt(i) { return RESONANCES[Math.max(0, Math.min(RESONANCES.length - 1, i))]; },

    // A finger on the plate damps every mode that moves under it, so the plate
    // favours patterns with a node there.
    touch(px, py) {
      const next = px == null ? null : { u: px / w, v: py / h };
      if (!next && !touch) return;
      touch = next;
      dirty = true;
    },

    // Knock the plate: every resting grain jumps.
    tap(amount = 0.7) {
      wake = true;
      for (let i = 0; i < n; i++) {
        if (z[i] > 0) continue;
        const dir = Math.random() * Math.PI * 2, sp = KICK * amount * Math.random();
        vz[i] = z[i] = HOP * amount * (0.3 + 0.7 * Math.random());
        vx[i] = Math.cos(dir) * sp;
        vy[i] = Math.sin(dir) * sp;
      }
    },

    // Sprinkle sand around a point. It falls onto the plate from a little above;
    // once at capacity, random existing grains are picked up and reused.
    pour(px, py, count, radius) {
      for (let k = 0; k < count; k++) {
        const i = n < max ? n++ : (Math.random() * n) | 0;
        asleep[i] = 0;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius;
        x[i] = Math.max(1, Math.min(w - 1, px + Math.cos(a) * r));
        y[i] = Math.max(1, Math.min(h - 1, py + Math.sin(a) * r));
        z[i] = 4 + Math.random() * 8;
        vz[i] = 0;
        vx[i] = Math.cos(a) * Math.random() * 0.6;
        vy[i] = Math.sin(a) * Math.random() * 0.6;
      }
    },

    scatter,
    step,

    // Jump straight to the settled pattern, for reduced motion: rather than
    // replay the bouncing, walk each grain down the amplitude slope to where it
    // would come to rest beside a node.
    settle() {
      if (dirty) computeField();
      for (let i = 0; i < n; i++) {
        let xi = x[i], yi = y[i];
        for (let k = 0; k < 160; k++) {
          const a = ampAt(xi, yi);
          const sx = ampAt(xi + 1, yi) - ampAt(xi - 1, yi);
          const sy = ampAt(xi, yi + 1) - ampAt(xi, yi - 1);
          const sl = Math.hypot(sx, sy);
          if (sl < 1e-5) {
            if (a < THRESHOLD) break;
            xi += Math.random() - 0.5, yi += Math.random() - 0.5; // balanced on an antinode
            continue;
          }
          const gap = (2 * a) / sl - LINE * fract(seed[i] * 13.7);
          if (gap < 0.05) break;
          const d = Math.min(gap, 8);
          const nx = Math.max(1, Math.min(w - 1, xi - (sx / sl) * d));
          const ny = Math.max(1, Math.min(h - 1, yi - (sy / sl) * d));
          if (shapes.length && solidAt(nx, ny)) break;
          xi = nx;
          yi = ny;
        }
        x[i] = xi; y[i] = yi;
        z[i] = vz[i] = vx[i] = vy[i] = 0;
      }
      wake = true;
    },

    render() {
      for (let i = 0; i < n; i++) {
        state[i * 4] = x[i];
        state[i * 4 + 1] = y[i];
        state[i * 4 + 2] = z[i];
        state[i * 4 + 3] = seed[i];
      }
      if (dirty) computeField();

      gl.disable(gl.BLEND);
      gl.useProgram(plate.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ampTex);
      gl.uniform1i(plate.uniforms.uAmp, 0);
      gl.uniform2f(plate.uniforms.uRes, w, h);
      gl.uniform1f(plate.uniforms.uDpr, dpr);
      gl.uniform2f(plate.uniforms.uGrid, gw * CELL, gh * CELL);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindBuffer(gl.ARRAY_BUFFER, grainBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state, 0, n * 4);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(grain.prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(grain.uniforms.uRes, w, h);
      gl.uniform1f(grain.uniforms.uDpr, dpr);
      gl.uniform1f(grain.uniforms.uShadow, 1);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.uniform1f(grain.uniforms.uShadow, 0);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.bindVertexArray(null);
    },
  };
}
