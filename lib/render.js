// WebGL2 renderer: one instanced capsule per filing, drawn twice (shadow, then
// metal), over a dark paper background that hints at the magnets beneath.

const MAX_POLES = 8;

const FILING_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aState;   // x, y, angle
layout(location = 2) in vec3 aShape;   // length, width, seed
uniform vec2 uRes;
uniform vec2 uOffset;
uniform float uGrow;
uniform vec2 uLight;
out vec2 vLocal;
out float vHalf;
out float vRad;
out float vSeed;
out float vGlint;
void main() {
  float halfLen = aShape.x * 0.5;
  float rad = aShape.y * 0.5 * uGrow;
  vec2 u = vec2(cos(aState.z), sin(aState.z));
  vec2 n = vec2(-u.y, u.x);
  vec2 local = aCorner * vec2(halfLen + rad + 1.0, rad + 1.0);
  vec2 pos = aState.xy + u * local.x + n * local.y + uOffset;
  // A rod glints when it lies across the direction to the light.
  vec2 toLight = normalize(uLight - aState.xy);
  vGlint = 1.0 - abs(dot(u, toLight));
  vLocal = local;
  vHalf = halfLen;
  vRad = rad;
  vSeed = aShape.z;
  vec2 clip = pos / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FILING_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vHalf;
in float vRad;
in float vSeed;
in float vGlint;
uniform float uShadow;
uniform float uPx;
out vec4 outColor;
void main() {
  // Filings are ragged slivers, not perfect rods.
  float wobble = 1.0 + 0.3 * sin(vLocal.x * 1.7 + vSeed * 40.0) * sin(vLocal.x * 0.6 + vSeed * 13.0);
  float r = vRad * wobble;
  float along = max(abs(vLocal.x) - max(vHalf - r, 0.0), 0.0);
  float d = length(vec2(along, vLocal.y)) - r;

  if (uShadow > 0.5) {
    float a = smoothstep(r + 0.8, -r, d) * 0.55;
    if (a <= 0.0) discard;
    outColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }

  float a = clamp(0.5 - d / uPx, 0.0, 1.0);
  if (a <= 0.0) discard;
  float t = clamp(vLocal.y / max(r, 0.001), -1.0, 1.0);
  float nz = sqrt(1.0 - t * t);
  float glint = pow(vGlint, 10.0) * pow(nz, 3.0);
  vec3 base = mix(vec3(0.40, 0.41, 0.45), vec3(0.50, 0.37, 0.29), step(0.95, vSeed));
  base *= 0.85 + 0.3 * fract(vSeed * 7.13);
  vec3 col = base * (0.45 + 0.55 * nz) + vec3(1.0, 0.97, 0.92) * glint;
  outColor = vec4(col * a, a);
}`;

const BG_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BG_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uDpr;
uniform float uSize;
uniform vec4 uPoles[${MAX_POLES}];
uniform int uPoleCount;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = gl_FragCoord.xy / uDpr;
  p.y = uRes.y - p.y;
  vec3 col = vec3(0.047, 0.043, 0.072);
  col += (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.014;
  vec2 c = p / uRes - 0.5;
  col *= 1.0 - dot(c, c) * 0.7;
  // Magnets glow faintly through the paper: coral for north, teal for south.
  for (int i = 0; i < ${MAX_POLES}; i++) {
    if (i >= uPoleCount) break;
    vec4 pole = uPoles[i];
    vec2 d = p - pole.xy;
    float g = exp(-dot(d, d) / (uSize * uSize * 0.01)) * min(abs(pole.z), 2.0) * 0.07;
    col += (pole.z > 0.0 ? vec3(1.0, 0.48, 0.35) : vec3(0.25, 0.82, 0.79)) * g;
  }
  outColor = vec4(col, 1.0);
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
  const uniforms = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, uniforms };
}

export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, alpha: false });
  if (!gl) return null;

  const filing = compile(gl, FILING_VS, FILING_FS);
  const bg = compile(gl, BG_VS, BG_FS);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const stateBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);

  const shapeBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, shapeBuf);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  const poleData = new Float32Array(MAX_POLES * 4);
  let state = new Float32Array(0);
  let w = 1, h = 1, dpr = 1;

  return {
    resize(width, height, ratio) {
      w = width; h = height; dpr = ratio;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
    },

    // Per-filing shape never changes, so upload it once for the sim's full capacity.
    setShapes(sim) {
      const cap = sim.max;
      const shape = new Float32Array(cap * 3);
      for (let i = 0; i < cap; i++) {
        shape[i * 3] = sim.len[i];
        shape[i * 3 + 1] = sim.wid[i];
        shape[i * 3 + 2] = sim.seed[i];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, shapeBuf);
      gl.bufferData(gl.ARRAY_BUFFER, shape, gl.STATIC_DRAW);
      state = new Float32Array(cap * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
      gl.bufferData(gl.ARRAY_BUFFER, state.byteLength, gl.DYNAMIC_DRAW);
    },

    draw(sim, poles, light) {
      const n = sim.n;
      for (let i = 0; i < n; i++) {
        state[i * 3] = sim.x[i];
        state[i * 3 + 1] = sim.y[i];
        state[i * 3 + 2] = sim.th[i];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state, 0, n * 3);

      gl.disable(gl.BLEND);
      gl.useProgram(bg.prog);
      const count = Math.min(MAX_POLES, poles.length);
      poleData.fill(0);
      for (let i = 0; i < count; i++) {
        poleData[i * 4] = poles[i].x;
        poleData[i * 4 + 1] = poles[i].y;
        poleData[i * 4 + 2] = poles[i].q;
      }
      gl.uniform2f(bg.uniforms.uRes, w, h);
      gl.uniform1f(bg.uniforms.uDpr, dpr);
      gl.uniform1f(bg.uniforms.uSize, Math.min(w, h));
      gl.uniform4fv(bg.uniforms.uPoles, poleData);
      gl.uniform1i(bg.uniforms.uPoleCount, count);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(filing.prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(filing.uniforms.uRes, w, h);
      gl.uniform2f(filing.uniforms.uLight, light.x, light.y);
      gl.uniform1f(filing.uniforms.uPx, 1 / dpr);

      gl.uniform1f(filing.uniforms.uShadow, 1);
      gl.uniform2f(filing.uniforms.uOffset, 0.8, 1.3);
      gl.uniform1f(filing.uniforms.uGrow, 1.8);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);

      gl.uniform1f(filing.uniforms.uShadow, 0);
      gl.uniform2f(filing.uniforms.uOffset, 0, 0);
      gl.uniform1f(filing.uniforms.uGrow, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    },
  };
}
