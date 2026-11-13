import { Sim } from "./sim.js";
import { createRenderer } from "./render.js";

const canvas = document.getElementById("view");
const renderer = createRenderer(canvas);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = matchMedia("(pointer: coarse)").matches;

if (!renderer) {
  document.body.classList.add("no-gl");
} else {
  start();
}

function start() {
  const sim = new Sim();
  const ui = {
    layout: document.getElementById("layout"),
    pole: document.getElementById("pole"),
    motion: document.querySelector('[data-action="motion"]'),
    hint: document.getElementById("hint"),
  };

  const bar = (cx, cy, a, half, q) => [
    { x: cx + Math.cos(a) * half, y: cy + Math.sin(a) * half, q },
    { x: cx - Math.cos(a) * half, y: cy - Math.sin(a) * half, q: -q },
  ];

  // Magnets beneath the paper, laid out along the screen's long axis.
  const LAYOUTS = [
    ["bar", (w, h, S, a) => bar(w / 2, h / 2, a, S * 0.13, 1)],
    ["attract", (w, h, S, a) => [
      ...bar(w / 2 - Math.cos(a) * S * 0.3, h / 2 - Math.sin(a) * S * 0.3, a, S * 0.1, 1),
      ...bar(w / 2 + Math.cos(a) * S * 0.3, h / 2 + Math.sin(a) * S * 0.3, a, S * 0.1, 1),
    ]],
    ["repel", (w, h, S, a) => [
      ...bar(w / 2 - Math.cos(a) * S * 0.3, h / 2 - Math.sin(a) * S * 0.3, a, S * 0.1, 1),
      ...bar(w / 2 + Math.cos(a) * S * 0.3, h / 2 + Math.sin(a) * S * 0.3, a + Math.PI, S * 0.1, 1),
    ]],
    ["horseshoe", (w, h, S, a) => bar(w / 2, h / 2, a, S * 0.07, 1.4)],
    ["quad", (w, h, S) => [
      { x: w / 2 - S * 0.2, y: h / 2 - S * 0.2, q: 1 },
      { x: w / 2 + S * 0.2, y: h / 2 - S * 0.2, q: -1 },
      { x: w / 2 + S * 0.2, y: h / 2 + S * 0.2, q: 1 },
      { x: w / 2 - S * 0.2, y: h / 2 + S * 0.2, q: -1 },
    ]],
    ["none", () => []],
  ];
  let layoutIndex = 0;
  let fixed = [];

  // The magnet you hold: follows the cursor or a finger.
  const hand = { x: 0, y: 0, tx: 0, ty: 0, on: false, fade: 0, polarity: 1, strength: 1.4 };

  let w = 0, h = 0;

  function layout() {
    const [name, build] = LAYOUTS[layoutIndex];
    fixed = build(w, h, Math.min(w, h), w >= h ? 0 : Math.PI / 2);
    ui.layout.textContent = name;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nw = window.innerWidth, nh = window.innerHeight;
    renderer.resize(nw, nh, dpr);
    if (!sim.n) {
      const scale = Math.max(0.75, Math.min(1.15, Math.min(nw, nh) / 850));
      const count = Math.round(Math.max(2000, Math.min(26000, (nw * nh) / 55)) * (coarse ? 0.8 : 1));
      sim.init(nw, nh, count, scale);
      renderer.setShapes(sim);
      hand.x = hand.tx = nw / 2;
      hand.y = hand.ty = nh / 2;
    } else {
      sim.setBounds(nw, nh);
    }
    w = nw; h = nh;
    layout();
  }

  // --- Input ---------------------------------------------------------------

  const onUi = (e) => e.target.closest("button, a");
  let touchId = null;
  let downAt = null;

  window.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" && e.pointerId !== touchId) return;
    hand.tx = e.clientX;
    hand.ty = e.clientY;
    hand.on = true;
    dismissHint();
  });

  window.addEventListener("pointerdown", (e) => {
    if (onUi(e)) return;
    dismissHint();
    if (e.pointerType === "mouse") {
      downAt = { x: e.clientX, y: e.clientY };
      return;
    }
    if (touchId !== null) return;
    touchId = e.pointerId;
    hand.x = hand.tx = e.clientX;
    hand.y = hand.ty = e.clientY;
    hand.on = true;
  });

  window.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") {
      // A click (not a drag) flips the hand magnet.
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5 && !onUi(e)) flip();
      downAt = null;
      return;
    }
    if (e.pointerId === touchId) touchId = null, hand.on = false;
  });
  window.addEventListener("pointercancel", (e) => { if (e.pointerId === touchId) touchId = null, hand.on = false; });
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) hand.on = false; });

  window.addEventListener("wheel", (e) => {
    hand.strength = Math.max(0.3, Math.min(4, hand.strength * Math.exp(-e.deltaY * 0.0015)));
  }, { passive: true });

  function flip() {
    hand.polarity *= -1;
    ui.pole.textContent = hand.polarity > 0 ? "N" : "S";
  }

  // Arrow keys tilt the table on desktop.
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    if (e.key.startsWith("Arrow")) keys.add(e.key), e.preventDefault();
    else if (e.key === " ") sim.tap(), e.preventDefault();
    else if (e.key === "m") nextLayout();
    else if (e.key === "f") flip();
    else if (e.key === "r") sim.scatter(), sim.tap(1);
    else return;
    dismissHint();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key));

  function nextLayout() {
    layoutIndex = (layoutIndex + 1) % LAYOUTS.length;
    layout();
  }

  document.querySelector(".controls").addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.action;
    if (action === "tap") sim.tap();
    else if (action === "layout") nextLayout();
    else if (action === "flip") flip();
    else if (action === "scatter") sim.scatter(), sim.tap(1);
    else if (action === "motion") enableMotion();
  });

  // --- Device motion: tilt slides filings, shaking taps the paper ------------

  let tilt = null;      // in-plane gravity from the device, relative to how it was first held
  let baseline = null;
  let lastAccel = null;
  let motionOn = false;

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!baseline) baseline = { beta: e.beta, gamma: e.gamma };
    const rad = Math.PI / 180;
    const clamp = (v) => Math.max(-80, Math.min(80, v));
    const dx = Math.sin(clamp(e.gamma - baseline.gamma) * rad);
    const dy = Math.sin(clamp(e.beta - baseline.beta) * rad);
    // Rotate device axes into screen axes when the phone is held sideways.
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
    motionOn = true;
    if (coarse) ui.motion.hidden = false, ui.motion.textContent = "level";
  }

  const needsPermission = typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function";

  function enableMotion() {
    if (motionOn) {
      baseline = null; // re-level to however the phone is held now
      return;
    }
    const asks = [DeviceMotionEvent.requestPermission()];
    if (typeof DeviceOrientationEvent.requestPermission === "function") asks.push(DeviceOrientationEvent.requestPermission());
    Promise.all(asks)
      .then((states) => { if (states.every((s) => s === "granted")) listenMotion(); })
      .catch(() => {});
  }

  if (needsPermission) {
    ui.motion.hidden = !coarse;
  } else if (typeof DeviceOrientationEvent !== "undefined") {
    listenMotion();
  }
  window.addEventListener("orientationchange", () => { baseline = null; });

  // --- Hints ----------------------------------------------------------------

  ui.hint.textContent = coarse
    ? "drag a magnet under the paper · shake to tap · tilt to slide"
    : "move a magnet under the paper · scroll for strength · click to flip · space to tap · arrows to tilt";
  let hintTimer = setTimeout(dismissHint, 9000);
  function dismissHint() {
    clearTimeout(hintTimer);
    ui.hint.classList.add("gone");
  }

  // --- Loop -----------------------------------------------------------------

  const G_TILT = 1.2;
  let poles = [];
  let last = performance.now();
  let acc = 0;
  let simMs = 0, frames = 0;

  function updateControls() {
    hand.x += (hand.tx - hand.x) * 0.35;
    hand.y += (hand.ty - hand.y) * 0.35;
    hand.fade += ((hand.on ? 1 : 0) - hand.fade) * 0.12;

    poles = fixed.slice();
    if (hand.fade > 0.01) poles.push({ x: hand.x, y: hand.y, q: hand.polarity * hand.strength * hand.fade });
    sim.poles = poles;

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
      updateControls();
      const t0 = performance.now();
      sim.step();
      adapt(performance.now() - t0);
      acc -= 1000 / 60;
      steps++;
    }
    // The light sits off the top-left; tilting the phone swings it around.
    const light = { x: -w * 0.3 + sim.gx * w * 0.6, y: -h * 0.4 + sim.gy * h * 0.6 };
    renderer.draw(sim, poles, light);
    requestAnimationFrame(frame);
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  resize();
  updateControls();
  if (reduceMotion) {
    // Settle out of sight rather than animating the initial snap into place.
    sim.tap(1);
    for (let i = 0; i < 90; i++) sim.step();
  } else {
    sim.tap(1);
  }
  requestAnimationFrame(frame);
}
