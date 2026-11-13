// Liquid-metal ferrofluid: a forced, damped heightfield rendered as chrome.
// It is a surface model, not a volumetric fluid or a Navier–Stokes solver.
//
// Solid word rectangles are rasterized without measuring DOM elements. A CPU
// Euclidean distance transform preserves their rotated coordinate transforms;
// localized super-Gaussian tips supply the narrow magnetic needles. The GPU
// owns ping-ponged R16F physical state and RGBA16F linear HDR shading. Every
// pass binds its inputs explicitly and writes to a different texture.
// Page-space positions are y-down; texture rows and shader UVs are y-up.

const VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
`;

const SETTLE = HEAD + `
uniform sampler2D uField;
void main() {
  outColor = vec4(texture(uField, vUv).r, 0.0, 0.0, 1.0);
}`;


const POTENTIAL = HEAD + `
uniform sampler2D uDistance;
uniform sampler2D uTips;
void main() {
  vec4 d = texture(uDistance, vUv);
  float outside = max(d.g, 0.0);
  // The solid itself is a low pool; the visible needles come from localized
  // tips, not from raising the entire rectangular solid into a slab.
  float core = d.r * 0.018 + exp(-outside / 38.0) * 0.035;
  outColor = vec4(core + texture(uTips, vUv).r, 0.0, 0.0, 1.0);
}`;

const STATIC_FIELD = HEAD + `
uniform sampler2D uPotential;
uniform vec2 uTexel;
void main() {
  float p = texture(uPotential, vUv).r;
  float gradient = length(vec2(
    texture(uPotential, vUv + vec2(uTexel.x, 0.0)).r - texture(uPotential, vUv - vec2(uTexel.x, 0.0)).r,
    texture(uPotential, vUv + vec2(0.0, uTexel.y)).r - texture(uPotential, vUv - vec2(0.0, uTexel.y)).r
  ));
  float target = min(1.7, pow(max(p, 0.0) * 1.35, 1.18) * 0.88 + gradient * 0.16);
  outColor = vec4(target, 0.0, 0.0, 1.0);
}`;

const DYNAMIC_FIELD = HEAD + `
uniform vec2 uHand;
uniform float uStrength;
uniform float uRadius;
uniform vec2 uAspect;
void main() {
  vec2 d = (vUv - uHand) * uAspect / max(uRadius, 0.005);
  float r2 = dot(d, d);
  // A narrow needle over a much weaker, wider skirt.
  float needle = exp(-r2 * 22.0) * 1.1;
  float skirt = exp(-r2 * 4.0) * 0.22;
  outColor = vec4(uStrength * (needle + skirt), 0.0, 0.0, 1.0);
}`;

const TOTAL_FIELD = HEAD + `
uniform sampler2D uStatic;
uniform sampler2D uDynamic;
void main() {
  outColor = vec4(texture(uStatic, vUv).r + texture(uDynamic, vUv).r, 0.0, 0.0, 1.0);
}`;

const IMPULSE = HEAD + `
uniform sampler2D uPrevious;
uniform vec4 uImpulses[8];
uniform int uCount;
uniform vec2 uAspect;
uniform float uDelta;
void main() {
  float source = texture(uPrevious, vUv).r * exp(-uDelta * 2.7);
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    vec4 impulse = uImpulses[i];
    float radius = length((vUv - impulse.xy) * uAspect);
    float front = impulse.z * 0.29;
    float width = 0.014 + impulse.z * 0.004;
    float ring = exp(-pow((radius - front) / width, 2.0));
    float wake = exp(-pow((radius - front + 0.035) / (width * 1.7), 2.0));
    // A signed front/wake pair creates a clean shock ring instead of a growing
    // positive-energy spiral. Successive impulses remain independent.
    source += impulse.w * (ring - wake * 0.6) * exp(-impulse.z * 1.8) * uDelta * 5.0;
  }
  outColor = vec4(source, 0.0, 0.0, 1.0);
}`;

const VELOCITY = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uHeight;
uniform sampler2D uField;
uniform sampler2D uImpulse;
uniform vec2 uTexel;
uniform float uDelta;
void main() {
  float h = texture(uHeight, vUv).r;
  float velocity = texture(uVelocity, vUv).r;
  float laplacian = texture(uHeight, vUv + vec2(uTexel.x, 0.0)).r
                  + texture(uHeight, vUv - vec2(uTexel.x, 0.0)).r
                  + texture(uHeight, vUv + vec2(0.0, uTexel.y)).r
                  + texture(uHeight, vUv - vec2(0.0, uTexel.y)).r - 4.0 * h;
  float spring = (texture(uField, vUv).r - h) * 82.0;
  float wave = laplacian * 58.0;
  float drag = 7.2 + max(h, 0.0) * 2.5;
  float impulse = texture(uImpulse, vUv).r * 22.0;
  velocity += (spring + wave + impulse - velocity * drag) * uDelta;
  outColor = vec4(clamp(velocity, -10.0, 10.0), 0.0, 0.0, 1.0);
}`;

const HEIGHT = HEAD + `
uniform sampler2D uHeight;
uniform sampler2D uVelocity;
uniform float uDelta;
void main() {
  float h = texture(uHeight, vUv).r + texture(uVelocity, vUv).r * uDelta;
  outColor = vec4(clamp(h, -0.35, 1.8), 0.0, 0.0, 1.0);
}`;

const BLOOM = HEAD + `
uniform sampler2D uColor;
uniform vec2 uTexel;
uniform vec2 uDirection;
void main() {
  vec3 c = texture(uColor, vUv).rgb * 0.227027;
  c += texture(uColor, vUv + uDirection * uTexel * 1.384615).rgb * 0.316216;
  c += texture(uColor, vUv - uDirection * uTexel * 1.384615).rgb * 0.316216;
  c += texture(uColor, vUv + uDirection * uTexel * 3.230769).rgb * 0.070270;
  c += texture(uColor, vUv - uDirection * uTexel * 3.230769).rgb * 0.070270;
  outColor = vec4(c, 1.0);
}`;

const TONEMAP = HEAD + `
uniform sampler2D uColor;
uniform sampler2D uBloom;
uniform float uExposure;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  // Bloom is added in linear radiance, before ACES and display encoding.
  vec3 color = texture(uColor, vUv).rgb + texture(uBloom, vUv).rgb * 0.1;
  color = aces(color * uExposure);
  color = pow(color, vec3(1.0 / 2.2));
  outColor = vec4(color, 1.0);
}`;

const SCENE = HEAD + `
uniform sampler2D uHeight;
uniform vec2 uTexel;
uniform vec2 uAspect;
uniform vec2 uLight;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Linear HDR environment: a neutral softbox plus restrained coral/teal rims.
vec3 environment(vec3 r) {
  float horizon = exp(-abs(r.y + 0.06) * 12.0);
  vec3 env = mix(vec3(0.008, 0.012, 0.022), vec3(0.08, 0.12, 0.18), smoothstep(-0.4, 0.85, r.y));
  env += vec3(0.2, 0.52, 0.56) * pow(max(0.0, -r.x), 5.0) * 0.65;
  env += vec3(0.72, 0.18, 0.08) * pow(max(0.0, r.x), 6.0) * 0.65;
  env += vec3(0.32, 0.42, 0.56) * horizon * 0.35;
  float softbox = smoothstep(0.91, 0.975, dot(r, normalize(vec3(-0.32, 0.8, 0.5))));
  env += vec3(1.8, 1.72, 1.58) * softbox;
  return env;
}

void main() {
  float h = texture(uHeight, vUv).r;
  float hx = texture(uHeight, vUv + vec2(uTexel.x, 0.0)).r - texture(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
  float hy = texture(uHeight, vUv + vec2(0.0, uTexel.y)).r - texture(uHeight, vUv - vec2(0.0, uTexel.y)).r;
  vec3 normal = normalize(vec3(-hx * 62.0 * uAspect.x, hy * 62.0 * uAspect.y, 1.0));
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 reflection = reflect(-view, normal);
  float slope = length(vec2(hx, hy));
  float relief = smoothstep(0.008, 0.15, slope * 38.0 + max(h, 0.0) * 0.12);
  float fresnel = 0.12 + 0.88 * pow(1.0 - max(normal.z, 0.0), 3.0);
  vec3 chrome = mix(vec3(0.18, 0.22, 0.29), vec3(0.78, 0.84, 0.92), fresnel);
  vec3 background = vec3(0.003, 0.005, 0.011);
  vec3 color = background + environment(reflection) * chrome * (0.08 + relief * 0.8);
  vec3 light = normalize(vec3(uLight * 0.7, 1.4));
  vec3 halfway = normalize(light + view);
  float specular = pow(max(0.0, dot(normal, halfway)), 110.0);
  color += vec3(1.1, 1.03, 0.93) * specular * relief;
  // No specular or bloom-sized highlight on a level pool: only raised slopes
  // catch the softbox. This is what keeps the resting background dark.
  float grain = hash(floor(vUv / uTexel));
  color *= 0.985 + grain * 0.03;
  float occlusion = 1.0 / (1.0 + max(h, 0.0) * 0.22);
  color *= 0.72 + 0.28 * occlusion;
  color += vec3(0.025, 0.06, 0.09) * max(h, 0.0) * 0.025;
  outColor = vec4(color, 1.0);
}`;

// Exact squared Euclidean distance transform, O(width * height), two passes.
// The input is 0 at seed pixels and infinity elsewhere.
function distanceTransform(seed, width, height) {
  const size = width * height;
  const f = new Float32Array(Math.max(width, height));
  const d = new Float32Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float32Array(Math.max(width, height) + 1);
  const out = new Float32Array(size);
  const inf = 1e12;

  function row(n) {
    let k = 0;
    v[0] = 0;
    z[0] = -inf;
    z[1] = inf;
    for (let q = 1; q < n; q++) {
      let s = 0;
      while (k >= 0) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = inf;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = seed[y * width + x] ? 0 : inf;
    row(width);
    for (let x = 0; x < width; x++) out[y * width + x] = d[x];
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x];
    row(height);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  return out;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Ferrofluid shader: ${error}`);
  }
  return shader;
}

export function createFerrofluid(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;

  const programs = new Map();
  const targets = [];
  let failed = false;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  function program(name, fragment) {
    try {
      const p = gl.createProgram();
      const vertex = compile(gl, gl.VERTEX_SHADER, VERT);
      const pixel = compile(gl, gl.FRAGMENT_SHADER, fragment);
      gl.attachShader(p, vertex);
      gl.attachShader(p, pixel);
      gl.linkProgram(p);
      gl.deleteShader(vertex);
      gl.deleteShader(pixel);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      programs.set(name, { p, uniforms: new Map(), integers: new Set(["uCount", "uSettle"]) });
    } catch (error) {
      failed = true;
      console.error(error);
    }
  }

  function target(name, width, height, rgba = false) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, rgba ? gl.RGBA16F : gl.R16F, width, height, 0, rgba ? gl.RGBA : gl.RED, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      failed = true;
      console.error(`Incomplete ferrofluid target: ${name}`);
    }
    const result = { name, texture, fbo, width, height };
    targets.push(result);
    return result;
  }

  function run(name, destination, uniforms = {}) {
    const item = programs.get(name);
    if (!item || failed) return;
    gl.useProgram(item.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination ? destination.fbo : null);
    gl.viewport(0, 0, destination ? destination.width : canvas.width, destination ? destination.height : canvas.height);
    let unit = 0;
    for (const [key, value] of Object.entries(uniforms)) {
      const uniformName = key === "uImpulses" ? "uImpulses[0]" : key;
      let location = item.uniforms.get(uniformName);
      if (location === undefined) {
        location = gl.getUniformLocation(item.p, uniformName);
        item.uniforms.set(uniformName, location);
      }
      if (location === null) continue;
      if (value && value.texture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value.texture);
        gl.uniform1i(location, unit++);
      } else if (typeof value === "number") {
        if (item.integers.has(key)) gl.uniform1i(location, value);
        else gl.uniform1f(location, value);
      } else if (value.length === 2) gl.uniform2fv(location, value);
      else if (value.length === 3) gl.uniform3fv(location, value);
      else if (value.length === 4) gl.uniform4fv(location, value);
      else gl.uniform4fv(location, value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  for (const [name, source] of Object.entries({ potential: POTENTIAL, settle: SETTLE, staticField: STATIC_FIELD, dynamic: DYNAMIC_FIELD, total: TOTAL_FIELD, impulse: IMPULSE, velocity: VELOCITY, height: HEIGHT, scene: SCENE, bloom: BLOOM, tonemap: TONEMAP })) {
    program(name, source);
  }
  if (failed) return null;

  let width = 0, height = 0, gridWidth = 0, gridHeight = 0;
  let distance, tips, potential, staticField, dynamic, total;
  let impulse = [], velocity = [], surface = [], scene, bloom = [];
  let bodies = [];
  let dirty = true;
  let hand = { x: 0, y: 0, strength: 0, radius: 0.06 };
  let light = [-0.4, 0.6];
  let pending = [];
  let settleRemaining = 0;
  let settlePending = false;
  let reducedMotion = false;
  let active = [];
  let time = 0;

  function clear(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function resize(w, h, dpr) {
    width = w;
    height = h;
    canvas.width = Math.max(1, Math.round(w * Math.min(dpr, 1.5)));
    canvas.height = Math.max(1, Math.round(h * Math.min(dpr, 1.5)));
    const aspect = w / h;
    gridWidth = Math.max(64, Math.round(240 * Math.sqrt(aspect)));
    gridHeight = Math.max(64, Math.round(gridWidth / aspect));
    for (const t of targets) {
      gl.deleteTexture(t.texture);
      gl.deleteFramebuffer(t.fbo);
    }
    targets.length = 0;
    distance = target("distance", gridWidth, gridHeight, true);
    tips = target("tips", gridWidth, gridHeight);
    potential = target("potential", gridWidth, gridHeight);
    staticField = target("staticField", gridWidth, gridHeight);
    dynamic = target("dynamic", gridWidth, gridHeight);
    total = target("total", gridWidth, gridHeight);
    impulse = [target("impulse0", gridWidth, gridHeight), target("impulse1", gridWidth, gridHeight)];
    velocity = [target("velocity0", gridWidth, gridHeight), target("velocity1", gridWidth, gridHeight)];
    surface = [target("surface0", gridWidth, gridHeight), target("surface1", gridWidth, gridHeight)];
    scene = target("scene", canvas.width, canvas.height, true);
    const bw = Math.max(1, Math.round(gridWidth / 2));
    const bh = Math.max(1, Math.round(gridHeight / 2));
    bloom = [target("bloom0", bw, bh, true), target("bloom1", bw, bh, true)];
    for (const t of targets) clear(t);
    dirty = true;
    pending = [];
    active = [];
    time = 0;
    settleRemaining = 0;
    settlePending = false;
  }

  // Rasterize exact oriented collision rectangles into top-down masks. No
  // layout measurements: only the body's x/y/rotation and collision half extents.
  function rasterize() {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = gridWidth;
    maskCanvas.height = gridHeight;
    const ctx = maskCanvas.getContext("2d", { willReadFrequently: true });
    const distanceData = new Float32Array(gridWidth * gridHeight * 4);
    const tipData = new Float32Array(gridWidth * gridHeight);
    const pixelWidth = width / gridWidth;
    const pixelHeight = height / gridHeight;

    for (const body of bodies) {
      ctx.clearRect(0, 0, gridWidth, gridHeight);
      ctx.save();
      ctx.translate((body.x / width) * gridWidth, (body.y / height) * gridHeight);
      ctx.rotate(body.th);
      ctx.fillStyle = "#fff";
      ctx.fillRect((-body.hw / width) * gridWidth, (-body.hh / height) * gridHeight, (body.hw * 2 / width) * gridWidth, (body.hh * 2 / height) * gridHeight);
      ctx.restore();
      const pixels = ctx.getImageData(0, 0, gridWidth, gridHeight).data;
      const solid = new Uint8Array(gridWidth * gridHeight);
      const boundary = [];
      for (let y = 0; y < gridHeight; y++) {
        for (let x = 0; x < gridWidth; x++) {
          const i = y * gridWidth + x;
          solid[i] = pixels[i * 4 + 3] > 127 ? 1 : 0;
          if (!solid[i]) continue;
          if (x === 0 || y === 0 || x === gridWidth - 1 || y === gridHeight - 1 || !solid[i - 1] || !solid[i + 1] || !solid[i - gridWidth] || !solid[i + gridWidth]) {
            boundary.push({ x, y, angle: Math.atan2(y - (body.y / height) * gridHeight, x - (body.x / width) * gridWidth) });
          }
        }
      }
      const outside = distanceTransform(solid, gridWidth, gridHeight);
      const empty = new Uint8Array(solid.length);
      for (let i = 0; i < empty.length; i++) empty[i] = solid[i] ? 0 : 1;
      const inside = distanceTransform(empty, gridWidth, gridHeight);
      for (let y = 0; y < gridHeight; y++) {
        for (let x = 0; x < gridWidth; x++) {
          const source = y * gridWidth + x;
          const destination = ((gridHeight - 1 - y) * gridWidth + x) * 4;
          const signed = solid[source] ? -Math.sqrt(inside[source]) : Math.sqrt(outside[source]);
          distanceData[destination] = solid[source];
          distanceData[destination + 1] = Math.max(-80, Math.min(80, signed));
          distanceData[destination + 2] = 0;
          distanceData[destination + 3] = 0;
        }
      }

      // Boundary points are sampled from the actual rasterized solid. Their
      // angular ordering gives an even, deterministic set of magnetic needles.
      boundary.sort((a, b) => a.angle - b.angle);
      const count = Math.min(38, Math.max(8, Math.round((body.hw + body.hh) / 13)));
      const strength = Math.abs(body.mag);
      for (let n = 0; n < count && boundary.length; n++) {
        const point = boundary[Math.floor((n + 0.5) / count * boundary.length) % boundary.length];
        const tx = (point.x + 0.5) / gridWidth * width + Math.sin(n * 2.17) * 2.0;
        const ty = (point.y + 0.5) / gridHeight * height + Math.cos(n * 1.71) * 2.0;
        const radius = Math.max(3.5, Math.min(6.5, Math.min(pixelWidth, pixelHeight) * 1.1));
        const minX = Math.max(0, Math.floor((tx - radius * 3) / width * gridWidth));
        const maxX = Math.min(gridWidth - 1, Math.ceil((tx + radius * 3) / width * gridWidth));
        const minY = Math.max(0, Math.floor((1 - (ty + radius * 3) / height) * gridHeight));
        const maxY = Math.min(gridHeight - 1, Math.ceil((1 - (ty - radius * 3) / height) * gridHeight));
        for (let y = minY; y <= maxY; y++) {
          const py = (1 - (y + 0.5) / gridHeight) * height;
          for (let x = minX; x <= maxX; x++) {
            const px = (x + 0.5) / gridWidth * width;
            const r = Math.hypot(px - tx, py - ty) / radius;
            if (r > 3.5) continue;
            const spike = Math.exp(-Math.pow(r, 0.85) * 2.8) * 0.92;
            const skirt = Math.exp(-r * 1.9) * 0.035;
            tipData[y * gridWidth + x] += (spike + skirt) * strength;
          }
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, distance.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gridWidth, gridHeight, 0, gl.RGBA, gl.FLOAT, distanceData);
    gl.bindTexture(gl.TEXTURE_2D, tips.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, gridWidth, gridHeight, 0, gl.RED, gl.FLOAT, tipData);
    run("potential", potential, { uDistance: distance, uTips: tips });
    run("staticField", staticField, { uPotential: potential, uTexel: [1 / gridWidth, 1 / gridHeight] });
  }

  function step(delta = 1 / 60) {
    const dt = Math.min(Math.max(delta, 0), 1 / 30);
    time += dt;
    if (settlePending) {
      settlePending = false;
      settleRemaining = 1;
      for (const t of [...velocity, ...surface, ...impulse]) clear(t);
    }
    if (dirty) {
      rasterize();
      dirty = false;
    }
    run("dynamic", dynamic, { uHand: [hand.x / width, 1 - hand.y / height], uStrength: hand.strength, uRadius: hand.radius, uAspect: [width / height, 1] });
    run("total", total, { uStatic: staticField, uDynamic: dynamic });
    if (settleRemaining > 0) {
      settleRemaining--;
      run("settle", surface[1], { uField: total });
      surface.reverse();
      return;
    }
    for (const impulse of pending.splice(0, 8)) active.push(impulse);
    active = active.filter((impulse) => time - impulse.time < 3.5);
    const values = [];
    for (const impulse of active.slice(-8)) {
      values.push(impulse.x / width, 1 - impulse.y / height, time - impulse.time, impulse.strength);
    }
    while (values.length < 32) values.push(0, 0, 99, 0);

    run("impulse", impulse[1], { uPrevious: impulse[0], uImpulses: values, uCount: Math.min(8, active.length), uAspect: [width / height, 1], uDelta: dt });
    impulse.reverse();
    run("velocity", velocity[1], { uVelocity: velocity[0], uHeight: surface[0], uField: total, uImpulse: impulse[0], uTexel: [1 / gridWidth, 1 / gridHeight], uDelta: dt });
    velocity.reverse();
    run("height", surface[1], { uHeight: surface[0], uVelocity: velocity[0], uDelta: dt });
    surface.reverse();
  }

  function render() {
    run("scene", scene, { uHeight: surface[0], uTexel: [1 / gridWidth, 1 / gridHeight], uAspect: [width / height, 1], uLight: light });
    run("bloom", bloom[0], { uColor: scene, uTexel: [1 / scene.width, 1 / scene.height], uDirection: [1, 0] });
    run("bloom", bloom[1], { uColor: bloom[0], uTexel: [1 / bloom[0].width, 1 / bloom[0].height], uDirection: [0, 1] });
    run("tonemap", null, { uColor: scene, uBloom: bloom[1], uExposure: 0.95 });
  }

  return {
    resize,
    setBlocks(next) {
      bodies = next;
      dirty = true;
      if (reducedMotion) settlePending = true;
    },
    setReducedMotion(value) {
      reducedMotion = value;
      if (value) settlePending = true;
      else settleRemaining = 0;
    },
    setHand(x, y, strength, radius = 0.06) {
      // Reduced motion still permits direct manipulation, but has no ambient
      // waves. Explicit impulses also temporarily leave the settled state.
      if (x !== hand.x || y !== hand.y) settleRemaining = 0;
      hand = { x, y, strength, radius };
    },
    setLight(x, y) { light = [x, y]; },
    disturb(x, y, strength = 0.18) {
      settleRemaining = 0;
      pending.push({ x, y, strength, time });
    },
    calm() {
      for (const t of [...velocity, ...surface, ...impulse, dynamic]) clear(t);
      pending = [];
      active = [];
      if (reducedMotion) settlePending = true;
    },
    step,
    render,
  };
}
