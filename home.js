import { Sim } from "./lib/sim.js";
import { createRenderer } from "./lib/render.js";
import { Blocks } from "./lib/blocks.js";
import { createFluid } from "./lib/fluid.js";
import { createFerrofluid } from "./lib/ferrofluid.js";
import { createSand, F_MIN, F_MAX } from "./lib/sand.js";

// Four backgrounds: iron filings, water, magnetically peaked ferrofluid, and
// sand on a vibrating plate. Every word is a draggable rigid body shared by all
// four simulations.

const canvas = document.getElementById("field");
const renderer = createRenderer(canvas);
const fluid = createFluid(document.getElementById("water"));
const ferrofluid = createFerrofluid(document.getElementById("ferrofluid"));
const sand = createSand(document.getElementById("sand"));
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
    if (ferrofluid) {
      ferrofluid.setReducedMotion(reduceMotion);
      ferrofluid.setBlocks(blocks.bodies);
    }
    if (sand) {
      sand.setBlocks(blocks.bodies);
      if (reduceMotion && mode === "sand") sand.settle();
    }
  }

  // --- Modes -----------------------------------------------------------------

  let mode = "magnetic";
  const SAND_START = 14; // the resonance the plate starts on
  const modes = ["magnetic", ...(fluid ? ["water"] : []), ...(ferrofluid ? ["ferrofluid"] : []), ...(sand ? ["sand"] : [])];
  const modeLabel = document.getElementById("mode");
  const currentInput = document.getElementById("current");
  const pullInput = document.getElementById("pull");
  if (modes.length < 2) document.querySelector('[data-action="mode"]').hidden = true;
  let ferroPull = 1;
  let ferroTouchId = null;
  let ferroHasPosition = false;
  let ferroShockTimer = 0;
  let ferroMaskFrame = 0;
  let ferroMaskSignature = "";
  let ferroMotion = null;
  const lastFerroSpeed = new Map();
  const ferroHand = { x: 0, y: 0, active: false, strength: 0, lastX: 0, lastY: 0 };
  let plateTouch = null; // { id } of a finger resting on the sand plate
  pullInput.addEventListener("input", () => { ferroPull = Number(pullInput.value); });

  // The current eases in, since an instant start surges around the words.
  let ramp = 0;

  function setMode(next) {
    mode = next;
    ramp = 0;
    document.body.classList.toggle("water", mode === "water");
    document.body.classList.toggle("ferrofluid", mode === "ferrofluid");
    document.body.classList.toggle("sand", mode === "sand");
    if (mode === "sand" && reduceMotion) sand.settle();
    if (ferrofluid) {
      ferrofluid.setReducedMotion(reduceMotion);
      ferrofluid.setHand(ferroHand.x, ferroHand.y, 0);
      ferroHand.active = false;
      ferroHand.strength = 0;
    }
    modeLabel.textContent = mode;
    hand.on = false;
    plateTouch = null;
    sand?.touch(null);
    setPourMode(false);
  }

  // The frequency slider is logarithmic, like a tone generator's dial. Letting
  // go near a resonance snaps onto it.
  const freqInput = document.getElementById("freq");
  const hzLabel = document.getElementById("hz");
  const sliderFor = (f) => Math.round((1000 * Math.log(f / F_MIN)) / Math.log(F_MAX / F_MIN));
  function showFrequency(f) {
    freqInput.value = sliderFor(f);
    hzLabel.textContent = `${Math.round(f)} Hz`;
    if (reduceMotion && mode === "sand") sand.settle();
  }
  if (sand) {
    sand.setFrequency(sand.resonanceAt(SAND_START));
    showFrequency(sand.frequency);
    freqInput.addEventListener("input", () => {
      const f = sand.setFrequency(F_MIN * (F_MAX / F_MIN) ** (Number(freqInput.value) / 1000));
      hzLabel.textContent = `${Math.round(f)} Hz`;
    });
    freqInput.addEventListener("change", () => showFrequency(sand.snap()));
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
    if (ferrofluid) {
      ferrofluid.resize(nw, nh, dpr);
      ferrofluid.setReducedMotion(reduceMotion);
    }
    if (sand) sand.resize(nw, nh, dpr);
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
    sand?.setBlocks([]);
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
    if (held && e.pointerId === held.id) {
      blocks.dragTo(e.clientX, e.clientY);
      ferroHand.x = ferroHand.lastX = e.clientX;
      ferroHand.y = ferroHand.lastY = e.clientY;
      ferroHasPosition = true;
      ferroHand.active = false;
    }
  });

  const drop = (e) => {
    if (!held || e.pointerId !== held.id) return;
    held = null;
    blocks.release();
    document.body.classList.remove("dragging");
    if (reduceMotion && mode === "sand") sand.settle();
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
    if (mode === "ferrofluid" && ferrofluid) {
      if (e.pointerType === "mouse" || e.pointerId === ferroTouchId) {
        ferroHand.lastX = ferroHasPosition ? ferroHand.x : e.clientX;
        ferroHand.lastY = ferroHasPosition ? ferroHand.y : e.clientY;
        ferroHand.x = e.clientX;
        ferroHand.y = e.clientY;
        ferroHasPosition = true;
        ferroHand.active = true;
      }
      return;
    }
    if (pour.active && e.pointerId === pour.id) pour.x = e.clientX, pour.y = e.clientY;
    if (mode === "sand") {
      hand.tx = e.clientX;
      hand.ty = e.clientY;
      if (e.pointerId === plateTouch?.id) sand.touch(e.clientX, e.clientY);
      return;
    }
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
    if (mode === "ferrofluid" && ferrofluid) {
      if (e.pointerType !== "mouse") requestMotion();
      ferroHand.x = ferroHand.lastX = e.clientX;
      ferroHand.y = ferroHand.lastY = e.clientY;
      ferroHasPosition = true;
      ferroHand.active = true;
      ferroTouchId = e.pointerType === "mouse" ? null : e.pointerId;
      downAt = { x: e.clientX, y: e.clientY, ferro: true, id: e.pointerId };
      return;
    }
    if (pour.mode) {
      if (e.pointerType !== "mouse") requestMotion();
      Object.assign(pour, { active: true, id: e.pointerId, x: e.clientX, y: e.clientY });
      return;
    }
    if (mode === "sand") {
      // Resting a finger on the plate damps it there.
      if (e.pointerType !== "mouse") requestMotion();
      plateTouch = { id: e.pointerId };
      sand.touch(e.clientX, e.clientY);
      if (reduceMotion) sand.settle();
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

  function releaseFerro(e) {
    if (e.pointerId !== ferroTouchId && e.pointerType !== "mouse") return;
    if (downAt?.ferro && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) {
      ferrofluid?.disturb(e.clientX, e.clientY, 0.4);
    }
    if (e.pointerId === ferroTouchId) ferroTouchId = null;
    ferroHand.active = false;
    ferroHand.lastX = ferroHand.x = e.clientX;
    ferroHand.lastY = ferroHand.y = e.clientY;
    ferroHasPosition = true;
    downAt = null;
  }
  window.addEventListener("pointerup", (e) => {
    if (mode === "ferrofluid") releaseFerro(e);
    if (e.pointerId === plateTouch?.id) liftFinger();
    if (e.target.closest && e.target.closest(".block")) return;
    if (pour.active && e.pointerId === pour.id) {
      pour.active = false;
      if (reduceMotion && mode === "sand") sand.settle();
      return;
    }
    if (e.pointerType === "mouse" && mode !== "ferrofluid") {
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) flip();
      downAt = null;
      return;
    }
    if (e.pointerId === touchId) touchId = null, hand.on = false;
  });
  window.addEventListener("pointercancel", (e) => {
    if (mode === "ferrofluid") releaseFerro(e);
    if (e.pointerId === plateTouch?.id) liftFinger();
    if (e.pointerId === pour.id) pour.active = false;
    if (e.pointerId === touchId) touchId = null, hand.on = false;
  });
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) hand.on = false;
    if (!e.relatedTarget) ferroHand.active = false;
  });

  function liftFinger() {
    plateTouch = null;
    sand.touch(null);
    if (reduceMotion) sand.settle();
  }

  function flip() {
    hand.polarity *= -1;
    pole.textContent = hand.polarity > 0 ? "N" : "S";
  }

  const pole = document.getElementById("pole");
  document.querySelector(".controls").addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.action;
    if (action === "tap") sim.tap();
    else if (action === "flip") flip();
    else if (action === "scatter" && mode === "sand") {
      sand.scatter();
      if (reduceMotion) sand.settle();
    }
    else if (action === "scatter") sim.scatter(), sim.tap(1);
    else if (action === "resonance") showFrequency(sand.resonance(1));
    else if (action === "pour") setPourMode(!pour.mode);
    else if (action === "recenter") blocks.recenter();
    else if (action === "mode") setMode(modes[(modes.indexOf(mode) + 1) % modes.length]);
    else if (action === "shock") {
      ferrofluid?.disturb(w * 0.5, h * 0.5, 0.65);
      ferrofluid?.disturb(w * 0.5, h * 0.5, -0.24);
    }
    else if (action === "calm") {
      if (mode === "water") fluid.clear(), ramp = 0;
      else if (mode === "ferrofluid") ferrofluid?.calm();
    }
  });

  // Space taps the paper (or knocks the plate), arrow keys tilt the table,
  // holding P pours at the cursor, [ and ] step between the plate's
  // resonances, and C recenters the words.
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    if (e.target.closest("input, button")) return;
    if (e.key.startsWith("Arrow")) keys.add(e.key), e.preventDefault();
    else if (e.key === " ") {
      if (mode === "ferrofluid") ferrofluid?.disturb(ferroHand.x || w / 2, ferroHand.y || h / 2, 0.5);
      else if (mode === "sand") { if (!reduceMotion) sand.tap(); }
      else sim.tap();
      e.preventDefault();
    }
    else if (e.key === "p") keys.add("p");
    else if ((e.key === "[" || e.key === "]") && mode === "sand") showFrequency(sand.resonance(e.key === "]" ? 1 : -1));
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
      const knock = Math.min(0.5, (jerk - 4) * 0.05);
      if (jerk > 4 && mode !== "sand") sim.tap(knock);
      else if (jerk > 4 && !reduceMotion) sand.tap(knock);
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

    if (mode === "water" || mode === "ferrofluid") {
      // Afloat, words slide more easily. Ferrofluid keeps the same rigid-body
      // state as water, while its visual field reacts to those exact positions.
      blocks.step({ gx: sim.gx, gy: sim.gy, agitation: 0, hand: null, friction: 0.35, water: mode === "water" ? fluid.velocityAt : null });
    } else if (mode === "sand") {
      // The words sit heavily on the plate and hold still while it rings.
      blocks.step({ gx: sim.gx, gy: sim.gy, agitation: 0, hand: null });
      if (pour.active) sand.pour(pour.x, pour.y, 16, 10);
      else if (keys.has("p")) sand.pour(hand.tx, hand.ty, 16, 10);
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

    if (mode === "ferrofluid" && ferrofluid) {
      const strengthTarget = ferroHand.active ? ferroPull : 0;
      ferroHand.strength += (strengthTarget - ferroHand.strength) * 0.13;
      const speed = Math.hypot(ferroHand.x - ferroHand.lastX, ferroHand.y - ferroHand.lastY);
      ferrofluid.setHand(ferroHand.x, ferroHand.y, ferroHand.strength * 1.15, 0.05);
      ferrofluid.setLight((ferroHand.x / w - 0.5) * 1.6, (0.5 - ferroHand.y / h) * 1.6);
      if (speed > 22 && ferroShockTimer <= 0) {
        ferrofluid.disturb(ferroHand.x, ferroHand.y, Math.min(0.4, speed * 0.009));
        ferroShockTimer = 0.16;
      }
      ferroShockTimer = Math.max(0, ferroShockTimer - 1 / 60);
      for (const b of blocks.bodies) {
        const old = lastFerroSpeed.get(b) || 0;
        const nowSpeed = Math.hypot(b.vx, b.vy);
        if (nowSpeed - old > 2.5) ferrofluid.disturb(b.x, b.y, Math.min(0.55, nowSpeed * 0.1));
        lastFerroSpeed.set(b, nowSpeed);
      }
      const signature = blocks.bodies.map((b) => `${Math.round(b.x * 2)},${Math.round(b.y * 2)},${Math.round(b.th * 100)}`).join("|");
      if (signature !== ferroMaskSignature && ++ferroMaskFrame % 2 === 0) {
        ferrofluid.setBlocks(blocks.bodies);
        ferroMaskSignature = signature;
      }
      ferrofluid.step();
      ferroHand.lastX = ferroHand.x;
      ferroHand.lastY = ferroHand.y;
    }
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
      } else if (mode === "sand") {
        // Reduced motion jumps to the settled pattern instead, but pouring and
        // dragging words still animate since they're direct.
        if (!reduceMotion || pour.active || keys.has("p") || held) sand.step(sim.gx, sim.gy);
      } else if (mode !== "ferrofluid") {
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
    } else if (mode === "ferrofluid") {
      ferrofluid?.render();
    } else if (mode === "sand") {
      sand.render();
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
