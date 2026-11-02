// 3D models from the game's own files: scene graph (*.scene.mbin), mesh data
// (*.geometry.data.mbin.<platform>) and each material's diffuse texture.
// Read-only; only fixed (non-procedural) models are decoded, because a
// procedural model's parts are picked by the game from a seed and showing a
// guessed combination would misrepresent the player's ship.

const LIST = 0xaaaaaa01;
const NODE_SIZE = 128;
const MESH_ENTRY = 0x48;
const VERTEX_STRIDE = 16;

const norm = (p) => p.replaceAll('\\', '/').toLowerCase();

function half(u) {
  const s = u >> 15 ? -1 : 1;
  const e = (u >> 10) & 31;
  const f = u & 1023;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

// Scene node: attributes, children, name, type, then rotation (degrees), scale, position.
export function readScene(b) {
  const list = (p) => (b.readUInt32LE(p + 12) === LIST ? { at: p + Number(b.readBigUInt64LE(p)), n: b.readUInt32LE(p + 8) } : { at: 0, n: 0 });
  const vstr = (p) => {
    const l = list(p);
    return l.n ? b.toString('latin1', l.at, l.at + l.n - 1) : '';
  };
  const fstr = (p, n) => b.toString('latin1', p, p + n).split('\0')[0];
  const node = (p) => {
    const a = list(p);
    const c = list(p + 0x10);
    const attrs = {};
    for (let i = 0; i < a.n; i++) attrs[fstr(a.at + i * 32, 16)] = vstr(a.at + i * 32 + 16);
    const t = Array.from({ length: 9 }, (_, i) => b.readFloatLE(p + 0x50 + i * 4));
    const children = [];
    for (let i = 0; i < c.n; i++) children.push(node(c.at + i * NODE_SIZE));
    return { name: vstr(p + 0x30), type: fstr(p + 0x40, 16), t, attrs, children };
  };
  return node(0x20);
}

// Mesh entries by hash: offsets of the full stream (vertices then indices) and the
// position/UV vertex stream, with their byte sizes.
export function readMeshData(b) {
  const list = (p) => ({ at: p + Number(b.readBigUInt64LE(p)), n: b.readUInt32LE(p + 8) });
  const top = list(0x20);
  const out = new Map();
  for (let i = 0; i < top.n; i++) {
    const e = top.at + i * MESH_ENTRY;
    out.set(b.readBigUInt64LE(e + 0x30).toString(), {
      full: list(e + 0x10).at,
      vertices: list(e + 0x20).at,
      indexBytes: b.readUInt32LE(e + 0x38),
      vertexBytes: b.readUInt32LE(e + 0x3c),
    });
  }
  return out;
}

// 4x4 column-major matrix for a node's rotation (degrees, applied X then Y then Z), scale, position.
function nodeMatrix(t) {
  const [rx, ry, rz] = t.slice(0, 3).map((d) => (d * Math.PI) / 180);
  const [sx, sy, sz] = t.slice(3, 6);
  const [cx, sxr, cy, syr, cz, szr] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  // R = Rz * Ry * Rx
  const r = [
    cz * cy, szr * cy, -syr,
    cz * syr * sxr - szr * cx, szr * syr * sxr + cz * cx, cy * sxr,
    cz * syr * cx + szr * sxr, szr * syr * cx - cz * sxr, cy * cx,
  ];
  return [r[0] * sx, r[1] * sx, r[2] * sx, 0, r[3] * sy, r[4] * sy, r[5] * sy, 0, r[6] * sz, r[7] * sz, r[8] * sz, 0, t[6], t[7], t[8], 1];
}

function mul(a, b) {
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
    r[c * 4 + row] = s;
  }
  return r;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Path of the texture bound to a sampler; each sampler record holds the map path before its name.
export function samplerTexture(material, sampler = 'gDiffuseMap') {
  const s = material.toString('latin1');
  const at = s.indexOf(`${sampler}\0`);
  if (at < 0) return null;
  const paths = [...s.slice(0, at).matchAll(/TEXTURES\/[\x20-\x7e]+?\.DDS/gi)];
  return paths.length ? paths.at(-1)[0] : null;
}

export class ModelError extends Error {}

// Decodes the most detailed LOD of a fixed model. Returns per-mesh positions,
// UVs and indices in model space, plus the diffuse texture path per material.
export function loadModel(archives, scenePath) {
  const scene = norm(scenePath);
  if (!/^models\/[a-z0-9_\-/]+\.scene\.mbin$/.test(scene)) throw new ModelError('Not a model path');
  if (!archives.find(scene)) throw new ModelError('Model not found in game data');
  if (archives.find(scene.replace(/\.scene\.mbin$/, '.descriptor.mbin'))) {
    throw new ModelError('Procedurally generated model');
  }
  const root = readScene(archives.read(scene));
  const geometry = norm(root.attrs.GEOMETRY ?? '');
  const dataName = archives.paks.flatMap((p) => [...p.files.keys()]).find((n) => n.startsWith(geometry.replace(/\.mbin$/, '.data.mbin')));
  if (!geometry || !dataName) throw new ModelError('Model geometry not found');
  const data = archives.read(dataName);
  const entries = readMeshData(data);

  const meshes = [];
  const materials = {};
  const walk = (n, parent) => {
    const m = mul(parent, nodeMatrix(n.t));
    if (n.type === 'MESH' && n.attrs.LODLEVEL === '0') meshes.push(decodeMesh(n, m));
    for (const c of n.children) walk(c, m);
  };

  const decodeMesh = (n, m) => {
    const e = entries.get(n.attrs.HASH);
    if (!e) throw new ModelError(`No geometry for ${n.name}`);
    const nV = e.vertexBytes / VERTEX_STRIDE;
    const batch = Number(n.attrs.BATCHCOUNT);
    const indexSize = e.indexBytes / batch;
    if (!Number.isInteger(nV) || (indexSize !== 2 && indexSize !== 4)) throw new ModelError(`Unexpected mesh layout in ${n.name}`);
    const positions = new Float32Array(nV * 3);
    const uvs = new Float32Array(nV * 2);
    for (let i = 0; i < nV; i++) {
      const v = e.vertices + i * VERTEX_STRIDE;
      const [x, y, z] = [0, 2, 4].map((o) => half(data.readUInt16LE(v + o)));
      positions[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      uvs[i * 2] = half(data.readUInt16LE(v + 8));
      uvs[i * 2 + 1] = half(data.readUInt16LE(v + 10));
    }
    checkBounds(n, positions, m);
    const indices = new Uint32Array(batch);
    const at = e.full + e.vertexBytes;
    for (let i = 0; i < batch; i++) {
      indices[i] = indexSize === 2 ? data.readUInt16LE(at + i * 2) : data.readUInt32LE(at + i * 4);
      if (indices[i] >= nV) throw new ModelError(`Index out of range in ${n.name}`);
    }
    const material = norm(n.attrs.MATERIAL ?? '');
    if (material && !(material in materials)) {
      materials[material] = archives.find(material) ? samplerTexture(archives.read(material)) : null;
    }
    return { name: n.name, material, positions, uvs, indices };
  };

  walk(root, IDENTITY);
  if (!meshes.length) throw new ModelError('Model has no meshes');
  const textures = Object.fromEntries(Object.entries(materials).map(([k, v]) => [k, v && norm(v)]));
  return { name: root.name, meshes, textures };
}

// Positions must sit inside the mesh's own bounding box (with a little room for
// half-float rounding), or the vertex layout is not the one this decoder knows.
function checkBounds(n, positions, m) {
  const keys = ['AABBMINX', 'AABBMINY', 'AABBMINZ', 'AABBMAXX', 'AABBMAXY', 'AABBMAXZ'];
  if (!keys.every((k) => k in n.attrs) || m.some((v, i) => v !== IDENTITY[i])) return;
  const [x0, y0, z0, x1, y1, z1] = keys.map((k) => Number(n.attrs[k]));
  const slack = 0.02 * Math.max(x1 - x0, y1 - y0, z1 - z0, 1);
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let i = 0; i < positions.length; i++) {
    const v = positions[i];
    if (!(v >= lo[i % 3] - slack && v <= hi[i % 3] + slack)) throw new ModelError(`Unexpected vertex data in ${n.name}`);
  }
}

// Binary form for the page: u32 header length, JSON header, then 4-byte aligned arrays.
export function packModel(model) {
  const parts = [];
  let offset = 0;
  const add = (arr) => {
    parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    const at = offset;
    offset += arr.byteLength;
    return at;
  };
  const meshes = model.meshes.map((m) => ({
    name: m.name,
    material: m.material,
    vertices: m.positions.length / 3,
    count: m.indices.length,
    positions: add(m.positions),
    uvs: add(m.uvs),
    indices: add(m.indices),
  }));
  let header = Buffer.from(JSON.stringify({ name: model.name, meshes, textures: model.textures }), 'utf8');
  header = Buffer.concat([header, Buffer.alloc((4 - (header.length % 4)) % 4, 0x20)]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  return Buffer.concat([len, header, ...parts]);
}
