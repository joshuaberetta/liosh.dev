import { Sim } from "./lib/sim.js";
import { createRenderer } from "./lib/render.js";

// Homepage background: the iron filings simulation with wandering magnets, and the
// title itself a magnetized solid that filings gather on and that can be dragged.

const canvas = document.getElementById("field");
const renderer = createRenderer(canvas);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = matchMedia("(pointer: coarse)").matches;

if (renderer) start();

function start() {
  const sim = new Sim();
  const hint = document.getElementById("hint");
  const title = document.querySelector("h1");
  const hand = { x: 0, y: 0, tx: 0, ty: 0, on: false, fade: 0, polarity: 1 };
  let w = 0, h = 0, t = 0;

  // --- The magnetized title ------------------------------------------------

  const TC = 3;       // field grid cell, px
  const TEXT_B = 7;   // field strength at the letters' edges

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

  const lettersInput = document.getElementById("letters");
  let letterStrength = Number(lettersInput.value);
  lettersInput.addEventListener("input", () => {
    letterStrength = Number(lettersInput.value);
    if (sim.shape) sim.shape.strength = letterStrength;
  });

  // Where the title has been dragged to, relative to its resting place.
  const drag = { x: 0, y: 0, active: false, id: null, from: null };
  let origin = { x: 0, y: 0 };

  // Rasterize the title into a grid around it and blur it into a potential.
  // Its gradient is the letters' field: it points straight out of the glyphs
  // and reaches out to pull filings in. The glyphs themselves are solid.
  // The grid is anchored to the title, so dragging the title drags its field.
  function buildTitle() {
    title.style.transform = "";
    const rect = title.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(title).fontSize);
    const margin = fs * 1.1;
    origin = { x: rect.left - margin, y: rect.top - margin };
    const gw = Math.ceil((rect.width + margin * 2) / TC);
    const gh = Math.ceil((rect.height + margin * 2) / TC);
    const off = document.createElement("canvas");
    off.width = gw;
    off.height = gh;
    const c = off.getContext("2d", { willReadFrequently: true });
    c.scale(1 / TC, 1 / TC);
    c.font = `italic 300 ${fs}px Fraunces, Georgia, serif`;
    if ("letterSpacing" in c) c.letterSpacing = `${-0.03 * fs}px`;
    c.textAlign = "center";
    const m = c.measureText(title.textContent);
    const asc = m.fontBoundingBoxAscent ?? fs * 0.95, desc = m.fontBoundingBoxDescent ?? fs * 0.25;
    c.fillText(title.textContent, margin + rect.width / 2, margin + (rect.height - asc - desc) / 2 + asc);

    // One extra cell past the end stands in for "outside the grid": no field, not solid.
    const size = gw * gh;
    const px = c.getImageData(0, 0, gw, gh).data;
    const mask = new Float32Array(size);
    const solid = new Uint8Array(size + 1);
    for (let i = 0; i < size; i++) {
      mask[i] = px[i * 4 + 3] / 255;
      solid[i] = mask[i] > 0.5 ? 1 : 0;
    }
    const near = blur(mask, gw, gh, Math.max(2, Math.round((fs * 0.05) / TC)));
    const far = blur(mask, gw, gh, Math.max(4, Math.round((fs * 0.3) / TC)));

    const bx = new Float32Array(size + 1), by = new Float32Array(size + 1);
    let max = 1e-6;
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x;
        bx[i] = near[i - 1] - near[i + 1] + 3 * (far[i - 1] - far[i + 1]);
        by[i] = near[i - gw] - near[i + gw] + 3 * (far[i - gw] - far[i + gw]);
        max = Math.max(max, Math.hypot(bx[i], by[i]));
      }
    }
    for (let i = 0; i < size; i++) bx[i] *= TEXT_B / max, by[i] *= TEXT_B / max;

    sim.shape = {
      bx, by, solid,
      strength: letterStrength,
      index(x, y) {
        const cx = ((x - origin.x - drag.x) / TC) | 0;
        const cy = ((y - origin.y - drag.y) / TC) | 0;
        return cx < 0 || cy < 0 || cx >= gw || cy >= gh ? size : cy * gw + cx;
      },
    };
    moveTitle(drag.x, drag.y);
  }

  // Keep at least part of the title on screen.
  function moveTitle(x, y) {
    const rect = title.getBoundingClientRect();
    const left = rect.left - drag.x, top = rect.top - drag.y;
    drag.x = Math.max(80 - left - rect.width, Math.min(w - 80 - left, x));
    drag.y = Math.max(40 - top - rect.height, Math.min(h - 40 - top, y));
    title.style.transform = `translate(${drag.x}px, ${drag.y}px)`;
  }

  // --- Magnets ---------------------------------------------------------------

  // Two bar magnets wander slowly beneath the paper, plus the one in your hand.
  function poles() {
    const S = Math.min(w, h);
    const list = [];
    const bar = (cx, cy, a) => {
      const s = S * 0.11;
      list.push({ x: cx + Math.cos(a) * s, y: cy + Math.sin(a) * s, q: 1 });
      list.push({ x: cx - Math.cos(a) * s, y: cy - Math.sin(a) * s, q: -1 });
    };
    bar(w * (0.24 + Math.sin(t * 0.13) * 0.08), h * (0.3 + Math.cos(t * 0.11) * 0.1), t * 0.07);
    bar(w * (0.76 + Math.cos(t * 0.09) * 0.08), h * (0.7 + Math.sin(t * 0.12) * 0.1), Math.PI / 2 - t * 0.05);
    if (hand.fade > 0.01) list.push({ x: hand.x, y: hand.y, q: 1.6 * hand.polarity * hand.fade });
    return list;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nw = window.innerWidth, nh = window.innerHeight;
    renderer.resize(nw, nh, dpr);
    if (!sim.n) {
      const scale = Math.max(0.75, Math.min(1.15, Math.min(nw, nh) / 850));
      const count = Math.round(Math.max(2000, Math.min(24000, (nw * nh) / 60)) * (coarse ? 0.8 : 1));
      sim.init(nw, nh, count, scale);
      renderer.setShapes(sim);
      hand.x = hand.tx = nw / 2;
      hand.y = hand.ty = nh / 2;
    } else {
      sim.setBounds(nw, nh);
    }
    w = nw;
    h = nh;
    drag.x = drag.y = 0;
    sim.shape = null;
    document.fonts.load("italic 300 100px Fraunces").finally(buildTitle);
  }

  // --- Input -----------------------------------------------------------------

  let touchId = null;
  let downAt = null;

  // Grab the title to drag the magnetized letters across the paper.
  title.addEventListener("pointerdown", (e) => {
    if (!sim.shape) return;
    e.stopPropagation();
    requestMotion();
    title.setPointerCapture(e.pointerId);
    drag.active = true;
    drag.id = e.pointerId;
    drag.from = { x: e.clientX - drag.x, y: e.clientY - drag.y };
    hand.on = false;
    document.body.classList.add("dragging");
  });

  title.addEventListener("pointermove", (e) => {
    if (drag.active && e.pointerId === drag.id) moveTitle(e.clientX - drag.from.x, e.clientY - drag.from.y);
  });

  const drop = (e) => {
    if (e.pointerId !== drag.id) return;
    drag.active = false;
    drag.id = null;
    document.body.classList.remove("dragging");
  };
  title.addEventListener("pointerup", drop);
  title.addEventListener("pointercancel", drop);

  window.addEventListener("pointermove", (e) => {
    if (drag.active) return;
    if (e.pointerType !== "mouse" && e.pointerId !== touchId) return;
    hand.tx = e.clientX;
    hand.ty = e.clientY;
    hand.on = true;
  });

  window.addEventListener("pointerdown", (e) => {
    if (e.target.closest("footer")) return;
    if (e.pointerType === "mouse") {
      downAt = { x: e.clientX, y: e.clientY };
      return;
    }
    requestMotion();
    if (touchId !== null) return;
    touchId = e.pointerId;
    hand.x = hand.tx = e.clientX;
    hand.y = hand.ty = e.clientY;
    hand.on = true;
  });

  window.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") {
      // A click (not a drag) flips the magnet in your hand.
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) flip();
      downAt = null;
      return;
    }
    if (e.pointerId === touchId) touchId = null, hand.on = false;
  });
  window.addEventListener("pointercancel", (e) => { if (e.pointerId === touchId) touchId = null, hand.on = false; });
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) hand.on = false; });

  function flip() {
    hand.polarity *= -1;
    pole.textContent = hand.polarity > 0 ? "N" : "S";
  }

  const pole = document.getElementById("pole");
  document.querySelector(".controls").addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.action;
    if (action === "tap") sim.tap();
    else if (action === "flip") flip();
    else if (action === "scatter") sim.scatter(), sim.tap(1);
  });

  // Space taps the paper; arrow keys tilt the table.
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    if (e.target.closest("input, button")) return;
    if (e.key.startsWith("Arrow")) keys.add(e.key), e.preventDefault();
    else if (e.key === " ") sim.tap(), e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key));

  // Phone tilt slides the filings; a shake taps the paper.
  let tilt = null;
  let baseline = null;
  let lastAccel = null;

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!baseline) baseline = { beta: e.beta, gamma: e.gamma };
    const rad = Math.PI / 180;
    const clamp = (v) => Math.max(-80, Math.min(80, v));
    const dx = Math.sin(clamp(e.gamma - baseline.gamma) * rad);
    const dy = Math.sin(clamp(e.beta - baseline.beta) * rad);
    const a = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * rad;
    tilt = { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
  }

  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    if (lastAccel) {
      const jerk = Math.hypot(g.x - lastAccel.x, g.y - lastAccel.y, g.z - lastAccel.z);
      if (jerk > 4) sim.tap(Math.min(0.5, (jerk - 4) * 0.05));
    }
    lastAccel = { x: g.x, y: g.y, z: g.z };
  }

  function listenMotion() {
    window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("devicemotion", onMotion);
  }

  const needsPermission = typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function";
  let asked = false;

  function requestMotion() {
    if (!needsPermission || asked) return;
    asked = true;
    const asks = [DeviceMotionEvent.requestPermission()];
    if (typeof DeviceOrientationEvent.requestPermission === "function") asks.push(DeviceOrientationEvent.requestPermission());
    Promise.all(asks)
      .then((states) => { if (states.every((s) => s === "granted")) listenMotion(); })
      .catch(() => {})
      .finally(() => { hint.hidden = true; });
  }

  if (needsPermission) hint.hidden = !coarse;
  else if (typeof DeviceOrientationEvent !== "undefined") listenMotion();
  window.addEventListener("orientationchange", () => { baseline = null; });

  // --- Loop ------------------------------------------------------------------

  const G_TILT = 1.2;
  let current = [];
  let last = performance.now();
  let acc = 0;
  let simMs = 0, frames = 0;

  function update() {
    if (!reduceMotion) t += 1 / 60;
    hand.x += (hand.tx - hand.x) * 0.35;
    hand.y += (hand.ty - hand.y) * 0.35;
    hand.fade += ((hand.on ? 1 : 0) - hand.fade) * 0.12;
    current = poles();
    sim.poles = current;

    let tx = 0, ty = 0;
    if (tilt) tx = tilt.x, ty = tilt.y;
    if (keys.has("ArrowLeft")) tx -= 0.5;
    if (keys.has("ArrowRight")) tx += 0.5;
    if (keys.has("ArrowUp")) ty -= 0.5;
    if (keys.has("ArrowDown")) ty += 0.5;
    sim.gx += (tx * G_TILT - sim.gx) * 0.2;
    sim.gy += (ty * G_TILT - sim.gy) * 0.2;
  }

  // Drop filings if this device can't keep up.
  function adapt(ms) {
    simMs += ms;
    if (++frames < 90) return;
    const avg = simMs / frames;
    simMs = frames = 0;
    if (avg > 10 && sim.n > 3000) sim.n = Math.floor(sim.n * 0.82);
  }

  function frame(now) {
    acc = Math.min(acc + (now - last), 50);
    last = now;
    let steps = 0;
    while (acc >= 1000 / 60 && steps < 2) {
      update();
      const t0 = performance.now();
      sim.step();
      adapt(performance.now() - t0);
      acc -= 1000 / 60;
      steps++;
    }
    const light = { x: -w * 0.3 + sim.gx * w * 0.6, y: -h * 0.4 + sim.gy * h * 0.6 };
    renderer.draw(sim, current, light);
    requestAnimationFrame(frame);
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  resize();
  update();
  // A gentle constant jostle keeps filings drifting toward the magnets and letters.
  sim.restless = reduceMotion ? 0 : 0.15;
  sim.tap(1);
  if (reduceMotion) for (let i = 0; i < 90; i++) sim.step();
  requestAnimationFrame(frame);
}
