// 3D model viewer: plain WebGL2, no libraries. Drag to rotate, wheel or pinch to zoom.
// Models arrive packed by the server (u32 header length, JSON header, arrays).

const VS = `#version 300 es
in vec3 p; in vec2 t; uniform mat4 mvp; out vec3 wp; out vec2 uv;
void main() { wp = p; uv = t; gl_Position = mvp * vec4(p, 1.0); }`;

// Flat shading from screen-space derivatives, so no normals are needed.
const FS = `#version 300 es
precision highp float;
in vec3 wp; in vec2 uv; uniform sampler2D tex; uniform int useTex; uniform vec3 eye; out vec4 o;
void main() {
  vec3 n = normalize(cross(dFdx(wp), dFdy(wp)));
  if (dot(n, eye - wp) < 0.0) n = -n;
  float l = 0.3 + 0.55 * max(dot(n, normalize(vec3(0.4, 0.8, 0.5))), 0.0) + 0.2 * max(dot(n, normalize(eye - wp)), 0.0);
  vec3 base = useTex == 1 ? texture(tex, uv).rgb : vec3(0.62, 0.65, 0.7);
  o = vec4(base * l, 1.0);
}`;

function unpack(buf) {
  const len = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
  const base = 4 + len;
  return {
    ...header,
    meshes: header.meshes.map((m) => ({
      ...m,
      positions: new Float32Array(buf, base + m.positions, m.vertices * 3),
      uvs: new Float32Array(buf, base + m.uvs, m.vertices * 2),
      indices: new Uint32Array(buf, base + m.indices, m.count),
    })),
  };
}

function multiply(a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
    r[c * 4 + row] = s;
  }
  return r;
}

// Loads a model into the canvas. Returns a function that releases the GL context.
export async function showModel(canvas, scene, parts = []) {
  const res = await fetch(`/models/${encodeURIComponent(scene)}.bin${parts.length ? `?parts=${parts.map(encodeURIComponent).join(',')}` : ''}`);
  if (!res.ok) throw new Error(res.status === 422 ? await res.text() : 'Could not load the model');
  const model = unpack(await res.arrayBuffer());

  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) throw new Error('This browser has no WebGL2');
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const u = (n) => gl.getUniformLocation(prog, n);

  // Frame the model from its bounds.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const m of model.meshes) for (let i = 0; i < m.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], m.positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], m.positions[i]);
  }
  const target = lo.map((v, i) => (v + hi[i]) / 2);
  const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
  let yaw = 2.4;
  let pitch = 0.4;
  let dist = radius * 2.6;

  const textures = {};
  let frame = 0;
  const draw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  };
  for (const [material, path] of Object.entries(model.textures)) {
    if (!path) continue;
    const img = new Image();
    img.onload = () => {
      if (gl.isContextLost()) return;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      textures[material] = t;
      draw();
    };
    img.src = `/textures/${path.split('/').map(encodeURIComponent).join('/')}.png`;
  }

  const draws = model.meshes.map((m) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const attrib = (name, data, size) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attrib('p', m.positions, 3);
    attrib('t', m.uvs, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    return { vao, count: m.count, material: m.material };
  });

  function render() {
    if (gl.isContextLost()) return;
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    const f = 1 / Math.tan(0.4);
    const near = radius / 50;
    const far = radius * 20;
    const proj = new Float32Array([f / (w / h), 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    const eye = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const norm = (v) => v.map((x) => x / Math.hypot(...v));
    const z = norm(eye.map((v, i) => v - target[i]));
    const x = norm([z[2], 0, -z[0]]);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const dot = (a) => -(a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2]);
    const view = new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, dot(x), dot(y), dot(z), 1]);
    gl.uniformMatrix4fv(u('mvp'), false, multiply(proj, view));
    gl.uniform3fv(u('eye'), eye);
    for (const d of draws) {
      const t = textures[d.material];
      gl.uniform1i(u('useTex'), t ? 1 : 0);
      if (t) gl.bindTexture(gl.TEXTURE_2D, t);
      gl.bindVertexArray(d.vao);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, 0);
    }
  }

  let drag = null;
  canvas.onpointerdown = (e) => {
    drag = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    yaw -= (e.clientX - drag[0]) * 0.01;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag[1]) * 0.01));
    drag = [e.clientX, e.clientY];
    draw();
  };
  canvas.onpointerup = () => (drag = null);
  canvas.onwheel = (e) => {
    e.preventDefault();
    dist = Math.max(radius * 0.6, Math.min(radius * 10, dist * (1 + e.deltaY * 0.001)));
    draw();
  };
  const resize = new ResizeObserver(draw);
  resize.observe(canvas);
  draw();

  return () => {
    resize.disconnect();
    cancelAnimationFrame(frame);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
}
