// Water: a GPU "stable fluids" solver on a grid (semi-Lagrangian advection,
// vorticity confinement, Jacobi pressure projection) with the word blocks as
// moving solid obstacles, a steady current, and dye streaming in to show the flow.
//
// Velocities are CSS px per 60 Hz frame, in GL orientation (y up).

const PRESSURE_ITERATIONS = 20;
const VMAX = 12;          // range of the velocity readback, px/frame
const READ_W = 64;        // readback width; height follows the aspect ratio

const BASE_VS = `#version 300 es
precision highp float;
uniform vec2 uTexel;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
`;

const ADVECT_FS = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uPxToUv;
uniform float uDissipation;
void main() {
  vec2 coord = vUv - texture(uVelocity, vUv).xy * uPxToUv;
  outColor = texture(uSource, coord) * uDissipation;
}`;

// Relax toward the free-stream current (strongly at the screen edges, so they act
// as inflow and outflow), and make solids move with their block.
const FORCE_FS = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform vec2 uStream;
uniform float uRelax;
void main() {
  vec2 v = texture(uVelocity, vUv).xy;
  float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float relax = uRelax + (1.0 - smoothstep(0.0, 0.04, edge)) * 0.25;
  v += (uStream - v) * relax;
  vec4 o = texture(uObstacle, vUv);
  v = mix(v, o.gb, o.r);
  outColor = vec4(v, 0.0, 1.0);
}`;

const SPLAT_FS = HEAD + `
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform vec3 uValue;
uniform float uRadius;
uniform float uAspect;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec4 base = texture(uTarget, vUv);
  outColor = vec4(base.xyz + exp(-dot(p, p) / uRadius) * uValue, 1.0);
}`;

const CURL_FS = HEAD + `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

const VORTICITY_FS = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uStrength;
void main() {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uStrength * C;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + force;
  outColor = vec4(clamp(v, -${VMAX.toFixed(1)}, ${VMAX.toFixed(1)}), 0.0, 1.0);
}`;

// Solid neighbours contribute their own (block) velocity.
const DIVERGENCE_FS = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
vec2 vel(vec2 uv) {
  vec4 o = texture(uObstacle, uv);
  return mix(texture(uVelocity, uv).xy, o.gb, step(0.5, o.r));
}
void main() {
  float L = vel(vL).x;
  float R = vel(vR).x;
  float T = vel(vT).y;
  float B = vel(vB).y;
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const CLEAR_FS = HEAD + `
uniform sampler2D uTexture;
uniform float uValue;
void main() {
  outColor = uValue * texture(uTexture, vUv);
}`;

// Solid neighbours mirror the centre pressure: no flow through walls.
const PRESSURE_FS = HEAD + `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform sampler2D uObstacle;
void main() {
  float C = texture(uPressure, vUv).x;
  float L = mix(texture(uPressure, vL).x, C, step(0.5, texture(uObstacle, vL).r));
  float R = mix(texture(uPressure, vR).x, C, step(0.5, texture(uObstacle, vR).r));
  float T = mix(texture(uPressure, vT).x, C, step(0.5, texture(uObstacle, vT).r));
  float B = mix(texture(uPressure, vB).x, C, step(0.5, texture(uObstacle, vB).r));
  float div = texture(uDivergence, vUv).x;
  outColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS = HEAD + `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
void main() {
  float C = texture(uPressure, vUv).x;
  float L = mix(texture(uPressure, vL).x, C, step(0.5, texture(uObstacle, vL).r));
  float R = mix(texture(uPressure, vR).x, C, step(0.5, texture(uObstacle, vR).r));
  float T = mix(texture(uPressure, vT).x, C, step(0.5, texture(uObstacle, vT).r));
  float B = mix(texture(uPressure, vB).x, C, step(0.5, texture(uObstacle, vB).r));
  vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B) * 0.5;
  vec4 o = texture(uObstacle, vUv);
  outColor = vec4(mix(v, o.gb, o.r), 0.0, 1.0);
}`;

// Bands of dye stream in from whichever edges the current flows in through.
const INFLOW_FS = HEAD + `
uniform sampler2D uDye;
uniform vec2 uDir;
uniform vec2 uRes;
uniform float uFill;
uniform float uTime;
void main() {
  vec2 px = vUv * uRes;
  float w = 0.0;
  float band = 22.0;
  w = max(w, max(0.0, uDir.x) * (1.0 - smoothstep(0.0, band, px.x)));
  w = max(w, max(0.0, -uDir.x) * (1.0 - smoothstep(0.0, band, uRes.x - px.x)));
  w = max(w, max(0.0, uDir.y) * (1.0 - smoothstep(0.0, band, px.y)));
  w = max(w, max(0.0, -uDir.y) * (1.0 - smoothstep(0.0, band, uRes.y - px.y)));
  w = max(w, uFill);
  vec2 perp = vec2(-uDir.y, uDir.x);
  float s = dot(px, perp) / 34.0 + sin(uTime * 0.7 + dot(px, uDir) * 0.01) * 0.25;
  float stripe = smoothstep(0.32, 0.5, abs(fract(s) - 0.5));
  float fine = smoothstep(0.42, 0.5, abs(fract(s * 3.0 + 0.5) - 0.5));
  vec3 deep = vec3(0.05, 0.22, 0.34);
  vec3 teal = vec3(0.16, 0.62, 0.64);
  vec3 foam = vec3(0.78, 0.9, 0.92);
  vec3 col = mix(deep, teal, stripe) + foam * fine * 0.35;
  vec4 d = texture(uDye, vUv);
  outColor = vec4(mix(d.rgb, col, w), 1.0);
}`;

const DISPLAY_FS = HEAD + `
uniform sampler2D uDye;
uniform vec2 uDyeTexel;
uniform vec2 uLight;
void main() {
  vec3 c = texture(uDye, vUv).rgb;
  const vec3 lum = vec3(0.3, 0.6, 0.1);
  float lL = dot(texture(uDye, vUv - vec2(uDyeTexel.x, 0.0)).rgb, lum);
  float lR = dot(texture(uDye, vUv + vec2(uDyeTexel.x, 0.0)).rgb, lum);
  float lB = dot(texture(uDye, vUv - vec2(0.0, uDyeTexel.y)).rgb, lum);
  float lT = dot(texture(uDye, vUv + vec2(0.0, uDyeTexel.y)).rgb, lum);
  // Treat the dye as a gently rippled surface and catch a highlight off it.
  vec3 n = normalize(vec3((lL - lR) * 6.0, (lB - lT) * 6.0, 1.0));
  vec3 h = normalize(normalize(vec3(uLight, 0.8)) + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 60.0);
  vec3 col = vec3(0.02, 0.035, 0.07) + min(c, vec3(1.0)) * 0.85 + spec * 0.35;
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.6;
  outColor = vec4(col, 1.0);
}`;

// The words, drawn into the obstacle field with the velocity of each point on them.
const OBSTACLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform vec2 uRot;
uniform vec2 uRes;
out vec2 vMaskUv;
out vec2 vArm;
void main() {
  vec2 local = aCorner * uHalf;
  vec2 arm = vec2(local.x * uRot.x - local.y * uRot.y, local.x * uRot.y + local.y * uRot.x);
  vec2 world = uCenter + arm;
  vMaskUv = aCorner * 0.5 + 0.5;
  vArm = arm;
  gl_Position = vec4(world.x / uRes.x * 2.0 - 1.0, 1.0 - world.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const OBSTACLE_FS = `#version 300 es
precision highp float;
uniform sampler2D uMask;
uniform vec2 uVel;
uniform float uSpin;
in vec2 vMaskUv;
in vec2 vArm;
out vec4 outColor;
void main() {
  if (texture(uMask, vMaskUv).r < 0.5) discard;
  vec2 v = uVel + uSpin * vec2(-vArm.y, vArm.x);
  outColor = vec4(1.0, v.x, -v.y, 0.0);
}`;

const ENCODE_FS = HEAD + `
uniform sampler2D uVelocity;
void main() {
  vec2 v = clamp(texture(uVelocity, vUv).xy / ${VMAX.toFixed(1)}, -1.0, 1.0) * 0.5 + 0.5;
  outColor = vec4(v, 0.0, 1.0);
}`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    u[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u };
}

export function createFluid(canvas) {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  // Rendering into half-float textures needs one of these.
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return null;
  gl.getExtension("OES_texture_float_linear");

  const p = {
    advect: compile(gl, BASE_VS, ADVECT_FS),
    force: compile(gl, BASE_VS, FORCE_FS),
    splat: compile(gl, BASE_VS, SPLAT_FS),
    curl: compile(gl, BASE_VS, CURL_FS),
    vorticity: compile(gl, BASE_VS, VORTICITY_FS),
    divergence: compile(gl, BASE_VS, DIVERGENCE_FS),
    clear: compile(gl, BASE_VS, CLEAR_FS),
    pressure: compile(gl, BASE_VS, PRESSURE_FS),
    gradient: compile(gl, BASE_VS, GRADIENT_FS),
    inflow: compile(gl, BASE_VS, INFLOW_FS),
    display: compile(gl, BASE_VS, DISPLAY_FS),
    encode: compile(gl, BASE_VS, ENCODE_FS),
    obstacle: compile(gl, OBSTACLE_VS, OBSTACLE_FS),
  };

  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const emptyVao = gl.createVertexArray();

  function target(w, h, internal, format, type, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }

  function double(...args) {
    let a = target(...args), b = target(...args);
    return {
      get read() { return a; },
      get write() { return b; },
      swap() { [a, b] = [b, a]; },
    };
  }

  let W = 1, H = 1, dpr = 1;
  let velocity, pressure, dye, divergence, curl, obstacle, readTarget;
  let simTexel, dyeTexel, readH = 1;
  let readBuf = new Uint8Array(4).fill(128);
  let masks = [];
  let splats = [];
  let frame = 0;
  let fillNext = true;

  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    return unit;
  }

  function run(prog, dest, uniforms) {
    gl.useProgram(prog.prog);
    let unit = 0;
    for (const [name, value] of Object.entries(uniforms)) {
      const loc = prog.u[name];
      if (loc == null) continue;
      if (value && value.tex) gl.uniform1i(loc, bindTex(unit++, value.tex));
      else if (typeof value === "number") gl.uniform1f(loc, value);
      else if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
    }
    if (dest) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo);
      gl.viewport(0, 0, dest.w, dest.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const api = {
    resize(width, height, ratio) {
      W = width; H = height; dpr = Math.min(ratio, 1.5);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const small = Math.min(W, H) < 600;
      const simShort = small ? 128 : 170, dyeShort = small ? 512 : 768;
      const aspect = W / H;
      const size = (short) => (aspect >= 1 ? [Math.round(short * aspect), short] : [short, Math.round(short / aspect)]);
      const [sw, sh] = size(simShort), [dw, dh] = size(dyeShort);
      const { RGBA16F, RG16F, R16F, RGBA, RG, RED, HALF_FLOAT, LINEAR, NEAREST } = gl;
      velocity = double(sw, sh, RG16F, RG, HALF_FLOAT, LINEAR);
      pressure = double(sw, sh, R16F, RED, HALF_FLOAT, NEAREST);
      divergence = target(sw, sh, R16F, RED, HALF_FLOAT, NEAREST);
      curl = target(sw, sh, R16F, RED, HALF_FLOAT, NEAREST);
      obstacle = target(sw, sh, RGBA16F, RGBA, HALF_FLOAT, LINEAR);
      dye = double(dw, dh, RGBA16F, RGBA, HALF_FLOAT, LINEAR);
      readH = Math.max(1, Math.round(READ_W / aspect));
      readTarget = target(READ_W, readH, gl.RGBA8, RGBA, gl.UNSIGNED_BYTE, NEAREST);
      // Mid-grey decodes as still water until the first readback arrives.
      readBuf = new Uint8Array(READ_W * readH * 4).fill(128);
      simTexel = [1 / sw, 1 / sh];
      dyeTexel = [1 / dw, 1 / dh];
      fillNext = true;
    },

    // Upload each word's solid mask once; positions are updated every frame.
    setBlocks(bodies) {
      for (const m of masks) gl.deleteTexture(m.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      masks = bodies.map((b) => {
        const data = new Uint8Array(b.solid.length);
        for (let i = 0; i < data.length; i++) data[i] = b.solid[i] * 255;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, b.gw, b.gh, 0, gl.RED, gl.UNSIGNED_BYTE, data);
        return { tex, body: b };
      });
    },

    // Stir: push the water at a point (DOM coords and velocities), optionally adding dye.
    splat(x, y, dx, dy, color = null, radius = 0.0012) {
      splats.push({ x, y, dx, dy, color, radius });
    },

    clear() {
      fillNext = true;
      for (const t of [velocity.read, velocity.write, pressure.read, pressure.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.viewport(0, 0, t.w, t.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    },

    // stream: free-stream current in DOM coords (px/frame).
    step(stream, time) {
      const sv = [stream.x, -stream.y];
      const speed = Math.hypot(stream.x, stream.y);
      const dir = speed > 0.01 ? [sv[0] / speed, sv[1] / speed] : [1, 0];
      const pxToUv = [1 / W, 1 / H];

      // Obstacles: clear, then draw every word at its current pose.
      gl.bindFramebuffer(gl.FRAMEBUFFER, obstacle.fbo);
      gl.viewport(0, 0, obstacle.w, obstacle.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(p.obstacle.prog);
      gl.bindVertexArray(quadVao);
      gl.uniform2f(p.obstacle.u.uRes, W, H);
      gl.uniform1i(p.obstacle.u.uMask, 0);
      for (const { tex, body: b } of masks) {
        bindTex(0, tex);
        gl.uniform2f(p.obstacle.u.uCenter, b.x, b.y);
        gl.uniform2f(p.obstacle.u.uHalf, b.ox, b.oy);
        gl.uniform2f(p.obstacle.u.uRot, b.cos, b.sin);
        gl.uniform2f(p.obstacle.u.uVel, b.vx, b.vy);
        gl.uniform1f(p.obstacle.u.uSpin, b.om);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      run(p.curl, curl, { uTexel: simTexel, uVelocity: velocity.read });
      run(p.vorticity, velocity.write, { uTexel: simTexel, uVelocity: velocity.read, uCurl: curl, uStrength: 0.08 });
      velocity.swap();
      run(p.force, velocity.write, { uTexel: simTexel, uVelocity: velocity.read, uObstacle: obstacle, uStream: sv, uRelax: 0.004 });
      velocity.swap();

      for (const s of splats) {
        const point = [s.x / W, 1 - s.y / H];
        run(p.splat, velocity.write, {
          uTexel: simTexel, uTarget: velocity.read, uPoint: point,
          uValue: [s.dx, -s.dy, 0], uRadius: s.radius, uAspect: W / H,
        });
        velocity.swap();
        if (s.color) {
          run(p.splat, dye.write, {
            uTexel: dyeTexel, uTarget: dye.read, uPoint: point,
            uValue: s.color, uRadius: s.radius, uAspect: W / H,
          });
          dye.swap();
        }
      }
      splats = [];

      run(p.divergence, divergence, { uTexel: simTexel, uVelocity: velocity.read, uObstacle: obstacle });
      run(p.clear, pressure.write, { uTexel: simTexel, uTexture: pressure.read, uValue: 0.8 });
      pressure.swap();
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        run(p.pressure, pressure.write, { uTexel: simTexel, uPressure: pressure.read, uDivergence: divergence, uObstacle: obstacle });
        pressure.swap();
      }
      run(p.gradient, velocity.write, { uTexel: simTexel, uPressure: pressure.read, uVelocity: velocity.read, uObstacle: obstacle });
      velocity.swap();

      run(p.advect, velocity.write, { uTexel: simTexel, uVelocity: velocity.read, uSource: velocity.read, uPxToUv: pxToUv, uDissipation: 0.999 });
      velocity.swap();
      run(p.advect, dye.write, { uTexel: dyeTexel, uVelocity: velocity.read, uSource: dye.read, uPxToUv: pxToUv, uDissipation: 0.9985 });
      dye.swap();
      run(p.inflow, dye.write, { uTexel: dyeTexel, uDye: dye.read, uDir: dir, uRes: [W, H], uFill: fillNext ? 1 : 0, uTime: time });
      dye.swap();
      fillNext = false;

      // Every few frames, read back a small copy of the flow for the CPU side.
      if (frame++ % 3 === 0) {
        run(p.encode, readTarget, { uTexel: simTexel, uVelocity: velocity.read });
        gl.readPixels(0, 0, READ_W, readH, gl.RGBA, gl.UNSIGNED_BYTE, readBuf);
      }
    },

    // Water velocity at a DOM point, in DOM coords (px/frame), from the last readback.
    velocityAt(x, y) {
      const cx = Math.min(READ_W - 1, Math.max(0, ((x / W) * READ_W) | 0));
      const cy = Math.min(readH - 1, Math.max(0, ((1 - y / H) * readH) | 0));
      const i = (cy * READ_W + cx) * 4;
      return [((readBuf[i] - 127.5) / 127.5) * VMAX, -((readBuf[i + 1] - 127.5) / 127.5) * VMAX];
    },

    render(light) {
      run(p.display, null, { uTexel: dyeTexel, uDye: dye.read, uDyeTexel: dyeTexel, uLight: light });
    },
  };
  return api;
}
