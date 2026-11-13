import { Sim } from "./lib/sim.js";
import { createRenderer } from "./lib/render.js";
import { Blocks } from "./lib/blocks.js";
import { createFluid } from "./lib/fluid.js";

// Homepage background, in two modes: iron filings with wandering magnets, or
// water streaming past. Every word on the page is a magnetized block you can
// drag, throw and knock around, and both the field and the water respond to it.

const canvas = document.getElementById("field");
const renderer = createRenderer(canvas);
const fluid = createFluid(document.getElementById("water"));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = matchMedia("(pointer: coarse)").matches;

if (renderer) start();

function start() {
  const sim = new Sim();
  const hint = document.getElementById("hint");
  const hand = { x: 0, y: 0, tx: 0, ty: 0, on: false, fade: 0, polarity: 1 };
  let w = 0, h = 0, t = 0;

  // --- Magnetized word blocks ---------------------------------------------

  const TEXT_B = 7; // field strength at a block's surface, at slider 1
  const blocks = new Blocks([...document.querySelectorAll(".block")], TEXT_B);
  const lettersInput = document.getElementById("letters");
  lettersInput.addEventListener("input", () => blocks.setStrength(Number(lettersInput.value)));

  function buildBlocks() {
    blocks.build(w, h, Number(lettersInput.value));
    sim.shapes = blocks.bodies;
    if (fluid) fluid.setBlocks(blocks.bodies);
  }

  // --- Modes -----------------------------------------------------------------

  let mode = "magnetic";
  const modeLabel = document.getElementById("mode");
  const currentInput = document.getElementById("current");
  if (!fluid) document.querySelector('[data-action="mode"]').hidden = true;

  // The current eases in, since an instant start surges around the words.
  let ramp = 0;

  function setMode(next) {
    mode = next;
    ramp = 0;
    document.body.classList.toggle("water", mode === "water");
    modeLabel.textContent = mode;
    hand.on = false;
    setPourMode(false);
  }

  // The current runs left to right, or downhill when the phone (or table) is tilted.
  function stream() {
    ramp = Math.min(1, ramp + 1 / 120);
    const speed = Number(currentInput.value) * 2.2 * ramp * ramp;
    const g = Math.hypot(sim.gx, sim.gy);
    return g > 0.08 ? { x: (sim.gx / g) * speed, y: (sim.gy / g) * speed } : { x: speed, y: 0 };
  }

  // Moving the pointer stirs the water; pressing stirs harder and adds a little foam.
  const stirFrom = new Map();
  function stir(e, pressed) {
    const last = stirFrom.get(e.pointerId);
    stirFrom.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!last) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (!dx && !dy) return;
    const k = pressed ? 0.9 : 0.35;
    fluid.splat(e.clientX, e.clientY, dx * k, dy * k, pressed ? [0.025, 0.035, 0.04] : null);
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
    if (fluid) fluid.resize(nw, nh, dpr);
    if (!sim.n) {
      const scale = Math.max(0.75, Math.min(1.15, Math.min(nw, nh) / 850));
      const count = Math.round(Math.max(2000, Math.min(24000, (nw * nh) / 60)) * (coarse ? 0.8 : 1));
      sim.init(nw, nh, count, scale, Math.round(count * 1.8));
      renderer.setShapes(sim);
      hand.x = hand.tx = nw / 2;
      hand.y = hand.ty = nh / 2;
    } else {
      sim.setBounds(nw, nh);
    }
    w = nw;
    h = nh;
    sim.shapes = [];
    blocks.release();
    Promise.all([
      document.fonts.load("italic 300 100px Fraunces"),
      document.fonts.load("16px 'JetBrains Mono'"),
    ]).finally(buildBlocks);
  }

  // --- Input -----------------------------------------------------------------

  let touchId = null;
  let downAt = null;

  // Grab a word to drag it; let go mid-drag to throw it.
  let held = null;

  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".block");
    const body = el && blocks.bodyFor(el);
    if (!body) return;
    e.stopPropagation();
    requestMotion();
    el.setPointerCapture(e.pointerId);
    held = { el, id: e.pointerId };
    blocks.grab(body, e.clientX, e.clientY);
    hand.on = false;
    document.body.classList.add("dragging");
  }, true);

  document.addEventListener("pointermove", (e) => {
    if (held && e.pointerId === held.id) blocks.dragTo(e.clientX, e.clientY);
  });

  const drop = (e) => {
    if (!held || e.pointerId !== held.id) return;
    held = null;
    blocks.release();
    document.body.classList.remove("dragging");
  };
  document.addEventListener("pointerup", drop);
  document.addEventListener("pointercancel", drop);

  // Pour mode: hold the pointer down to sprinkle more filings onto the paper.
  const pour = { mode: false, active: false, id: null, x: 0, y: 0 };
  const pourButton = document.querySelector('[data-action="pour"]');

  function setPourMode(on) {
    pour.mode = on;
    pour.active = false;
    hand.on = false;
    pourButton.setAttribute("aria-pressed", on);
    document.body.classList.toggle("pour-mode", on);
  }

  window.addEventListener("pointermove", (e) => {
    if (held) return;
    if (mode === "water") {
      if (e.pointerType === "mouse" || e.buttons) stir(e, e.buttons > 0);
      return;
    }
    if (pour.active && e.pointerId === pour.id) pour.x = e.clientX, pour.y = e.clientY;
    if (e.pointerType !== "mouse" && e.pointerId !== touchId) return;
    hand.tx = e.clientX;
    hand.ty = e.clientY;
    hand.on = !pour.mode;
  });

  window.addEventListener("pointerdown", (e) => {
    if (held || e.target.closest("footer")) return;
    if (mode === "water") {
      if (e.pointerType !== "mouse") requestMotion();
      stirFrom.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    if (pour.mode) {
      if (e.pointerType !== "mouse") requestMotion();
      Object.assign(pour, { active: true, id: e.pointerId, x: e.clientX, y: e.clientY });
      return;
    }
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
    if (e.target.closest && e.target.closest(".block")) return;
    if (pour.active && e.pointerId === pour.id) {
      pour.active = false;
      return;
    }
    if (e.pointerType === "mouse") {
      // A click (not a drag) flips the magnet in your hand.
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) flip();
      downAt = null;
      return;
    }
    if (e.pointerId === touchId) touchId = null, hand.on = false;
  });
  window.addEventListener("pointercancel", (e) => {
    if (e.pointerId === pour.id) pour.active = false;
    if (e.pointerId === touchId) touchId = null, hand.on = false;
  });
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
    else if (action === "pour") setPourMode(!pour.mode);
    else if (action === "recenter") blocks.recenter();
    else if (action === "mode") setMode(mode === "water" ? "magnetic" : "water");
    else if (action === "calm") fluid.clear(), ramp = 0;
  });

  // Space taps the paper, arrow keys tilt the table, holding P pours at the
  // cursor, and C recenters the words.
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    if (e.target.closest("input, button")) return;
    if (e.key.startsWith("Arrow")) keys.add(e.key), e.preventDefault();
    else if (e.key === " ") sim.tap(), e.preventDefault();
    else if (e.key === "p") keys.add("p");
    else if (e.key === "c") blocks.recenter();
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

    if (mode === "water") {
      // Afloat, the words slide more easily and the current drags them.
      blocks.step({ gx: sim.gx, gy: sim.gy, agitation: 0, hand: null, friction: 0.35, water: fluid.velocityAt });
    } else {
      blocks.step({
        gx: sim.gx,
        gy: sim.gy,
        agitation: Math.max(0, sim.agitation - sim.restless),
        hand: hand.fade > 0.01 ? { x: hand.x, y: hand.y, q: 1.6 * hand.polarity * hand.fade } : null,
      });
      const s = sim.scale;
      if (pour.active) sim.pour(pour.x, pour.y, 12, 10 * s);
      else if (keys.has("p")) sim.pour(hand.tx, hand.ty, 12, 10 * s);
    }

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
    if (avg > 10 && sim.n > 3000) {
      sim.max = Math.floor(sim.n * 0.82);
      sim.n = sim.max;
    }
  }

  function frame(now) {
    acc = Math.min(acc + (now - last), 50);
    last = now;
    let steps = 0;
    while (acc >= 1000 / 60 && steps < 2) {
      update();
      if (mode === "water") {
        fluid.step(stream(), t);
      } else {
        const t0 = performance.now();
        sim.step();
        adapt(performance.now() - t0);
      }
      acc -= 1000 / 60;
      steps++;
    }
    blocks.sync();
    if (mode === "water") {
      fluid.render([-0.4 + sim.gx * 0.5, 0.6 - sim.gy * 0.5]);
    } else {
      const light = { x: -w * 0.3 + sim.gx * w * 0.6, y: -h * 0.4 + sim.gy * h * 0.6 };
      renderer.draw(sim, current, light);
    }
    requestAnimationFrame(frame);
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  resize();
  update();
  // A gentle constant jostle keeps filings drifting toward the magnets and words.
  sim.restless = reduceMotion ? 0 : 0.15;
  sim.tap(1);
  if (reduceMotion) for (let i = 0; i < 90; i++) sim.step();
  requestAnimationFrame(frame);
}
