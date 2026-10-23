/**
 * Unity asset bundle reader for the Tabletop Simulator models loaded live from the Steam
 * CDN (rubble, fire steps, operatives). Enough of the format to pull out what a TTS
 * "Custom_Assetbundle" shows: UnityFS container (raw, LZ4 or LZMA blocks), serialized
 * files read through their own type trees, meshes and their main textures.
 *
 * readBundle() mirrors read_bundle() in tools/model_pack.py: every MeshRenderer's mesh,
 * baked into the prefab root's space (plus the root's rotation and scale, as TTS keeps
 * them; the terrain bundles' roots are identity), triangles reversed to counter-clockwise,
 * with the material's _MainTex decoded to RGBA (rows bottom-up, as Unity stores them).
 */

import { lzmaDecode } from './lzma.js';

// Unity's shared type-tree strings (offsets with the top bit set), from UnityPy's TPK
// (MIT, K0lb3/UnityPy). Offsets are cumulative: each string plus its terminating NUL.
const COMMON = ["AABB", "AnimationClip", "AnimationCurve", "AnimationState", "Array", "Base", "BitField", "bitset", "bool", "char", "ColorRGBA", "Component", "data", "deque", "double", "dynamic_array", "FastPropertyName", "first", "float", "Font", "GameObject", "Generic Mono", "GradientNEW", "GUID", "GUIStyle", "int", "list", "long long", "map", "Matrix4x4f", "MdFour", "MonoBehaviour", "MonoScript", "m_ByteSize", "m_Curve", "m_EditorClassIdentifier", "m_EditorHideFlags", "m_Enabled", "m_ExtensionPtr", "m_GameObject", "m_Index", "m_IsArray", "m_IsStatic", "m_MetaFlag", "m_Name", "m_ObjectHideFlags", "m_PrefabInternal", "m_PrefabParentObject", "m_Script", "m_StaticEditorFlags", "m_Type", "m_Version", "Object", "pair", "PPtr<Component>", "PPtr<GameObject>", "PPtr<Material>", "PPtr<MonoBehaviour>", "PPtr<MonoScript>", "PPtr<Object>", "PPtr<Prefab>", "PPtr<Sprite>", "PPtr<TextAsset>", "PPtr<Texture>", "PPtr<Texture2D>", "PPtr<Transform>", "Prefab", "Quaternionf", "Rectf", "RectInt", "RectOffset", "second", "set", "short", "size", "SInt16", "SInt32", "SInt64", "SInt8", "staticvector", "string", "TextAsset", "TextMesh", "Texture", "Texture2D", "Transform", "TypelessData", "UInt16", "UInt32", "UInt64", "UInt8", "unsigned int", "unsigned long long", "unsigned short", "vector", "Vector2f", "Vector3f", "Vector4f", "m_ScriptingClassIdentifier", "Gradient", "Type*", "int2_storage", "int3_storage", "BoundsInt", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "FileSize", "Hash128", "RenderingLayerMask", "fixed_array", "EntityId", "LoadableObjectId", "LoadableSceneId"];
const COMMON_AT = new Map();
for (let i = 0, off = 0; i < COMMON.length; off += COMMON[i].length + 1, i++) COMMON_AT.set(off, COMMON[i]);

const td = new TextDecoder();
class Reader {
  constructor(u8, little) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.pos = 0; this.le = little; }
  u8_() { return this.dv.getUint8(this.pos++); }
  i8() { return this.dv.getInt8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, this.le); this.pos += 2; return v; }
  i16() { const v = this.dv.getInt16(this.pos, this.le); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, this.le); this.pos += 4; return v; }
  i32() { const v = this.dv.getInt32(this.pos, this.le); this.pos += 4; return v; }
  i64() { const v = this.dv.getBigInt64(this.pos, this.le); this.pos += 8; return v; }
  u64() { const v = this.dv.getBigUint64(this.pos, this.le); this.pos += 8; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, this.le); this.pos += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.pos, this.le); this.pos += 8; return v; }
  bytes(n) { const b = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  cstr() { const s = this.pos; while (this.pos < this.u8.length && this.u8[this.pos] !== 0) this.pos++; return td.decode(this.u8.subarray(s, this.pos++)); }
  align(n, base = 0) { const r = (this.pos - base) % n; if (r) this.pos += n - r; }
}

// LZ4 block format (no frame): what UnityFS uses for compression types 2 and 3 (LZ4HC)
export function lz4Block(src, outSize) {
  const out = new Uint8Array(outSize);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    out.set(src.subarray(s, s + lit), d); s += lit; d += lit;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8); s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    for (let i = 0; i < len; i++, d++) out[d] = out[d - offset];
  }
  return out;
}
function decompress(data, flags, size) {
  const kind = flags & 0x3f;
  if (kind === 0) return data;
  if (kind === 1) return lzmaDecode(data, size);
  if (kind === 2 || kind === 3) return lz4Block(data, size);
  throw new Error("unknown bundle compression " + kind);
}

// UnityFS container -> { files: {name: Uint8Array}, engine: "2019.4.40f1" }
export function readContainer(buf) {
  const r = new Reader(new Uint8Array(buf), false);
  const sig = r.cstr();
  if (sig !== "UnityFS") throw new Error("not a UnityFS bundle: " + sig);
  const version = r.u32(); r.cstr(); const engine = r.cstr();
  r.i64(); const cSize = r.u32(), uSize = r.u32(), flags = r.u32();
  if (version >= 7) r.align(16);
  const infoAtEnd = flags & 0x80;
  let infoBytes;
  if (infoAtEnd) infoBytes = r.u8.subarray(r.u8.length - cSize);
  else infoBytes = r.bytes(cSize);
  const info = new Reader(decompress(infoBytes, flags, uSize), false);
  info.pos = 16;                                   // uncompressed data hash
  const blocks = [];
  for (let n = info.i32(); n > 0; n--) blocks.push({ u: info.u32(), c: info.u32(), flags: info.u16() });
  const nodes = [];
  for (let n = info.i32(); n > 0; n--) nodes.push({ offset: Number(info.i64()), size: Number(info.i64()), flags: info.u32(), path: info.cstr() });
  if (flags & 0x200) r.align(16);                   // block data padded to 16
  const total = blocks.reduce((a, b) => a + b.u, 0), data = new Uint8Array(total);
  let d = 0;
  for (const b of blocks) { data.set(decompress(r.bytes(b.c), b.flags, b.u), d); d += b.u; }
  const files = {};
  for (const n of nodes) files[n.path] = data.subarray(n.offset, n.offset + n.size);
  return { files, engine };
}

// Serialized file: its types (with type trees) and objects
function readSerialized(u8) {
  const r = new Reader(u8, false);
  let metaSize = r.u32(), fileSize = r.u32();
  const version = r.u32();
  let dataOffset = r.u32();
  if (version < 9) throw new Error("serialized file version " + version + " is too old");
  const big = r.u8_(); r.pos += 3;
  if (version >= 22) { metaSize = r.u32(); fileSize = Number(r.i64()); dataOffset = Number(r.i64()); r.i64(); }
  r.le = big === 0;
  const unityVersion = r.cstr();
  r.i32();                                          // target platform
  const typeTrees = version >= 13 ? r.u8_() !== 0 : true;
  const types = [];
  for (let n = r.i32(); n > 0; n--) {
    const t = { classID: r.i32() };
    if (version >= 16) r.u8_();                     // stripped
    if (version >= 17) r.i16();                     // script type index
    if (version >= 13) {
      if ((version < 16 && t.classID < 0) || (version >= 16 && t.classID === 114)) r.pos += 16;
      r.pos += 16;                                  // old type hash
    }
    if (typeTrees) {
      const count = r.i32(), strSize = r.i32(), raw = [];
      for (let i = 0; i < count; i++) {
        raw.push({ level: (r.u16(), r.u8_()), flags: r.u8_(), typeOff: r.u32(), nameOff: r.u32(), size: r.i32(), index: r.i32(), meta: r.i32() });
        if (version >= 19) r.pos += 8;
      }
      const strs = r.bytes(strSize);
      const str = off => (off & 0x80000000) ? (COMMON_AT.get(off & 0x7fffffff) || "?" + off)
        : td.decode(strs.subarray(off, strs.indexOf(0, off)));
      const flat = raw.map(n => ({ level: n.level, flags: n.flags, type: str(n.typeOff), name: str(n.nameOff), size: n.size, meta: n.meta, children: [] }));
      const stack = [];
      for (const n of flat) {
        while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop();
        if (stack.length) stack[stack.length - 1].children.push(n);
        stack.push(n);
      }
      t.tree = flat[0];
      if (version >= 21) { const deps = r.i32(); r.pos += 4 * deps; }   // type dependencies
    }
    types.push(t);
  }
  if (version >= 7 && version < 14) r.i32();
  const objects = [];
  for (let n = r.i32(); n > 0; n--) {
    if (version >= 14) r.align(4);
    const pathID = version >= 14 ? r.i64() : BigInt(r.i32());
    const start = (version >= 22 ? Number(r.i64()) : r.u32()) + dataOffset;
    const size = r.u32(), typeIndex = r.i32();
    const type = version >= 16 ? types[typeIndex] : types.find(t => t.classID === typeIndex);
    objects.push({ pathID: String(pathID), start, size, type });
  }
  return { u8, little: r.le, unityVersion, objects, byPath: new Map(objects.map(o => [o.pathID, o])) };
}

// Read one object through its type tree into plain JS values
const PRIM = {
  bool: r => r.u8_() !== 0, SInt8: r => r.i8(), UInt8: r => r.u8_(), char: r => r.u8_(),
  SInt16: r => r.i16(), short: r => r.i16(), UInt16: r => r.u16(), "unsigned short": r => r.u16(),
  SInt32: r => r.i32(), int: r => r.i32(), UInt32: r => r.u32(), "unsigned int": r => r.u32(), "Type*": r => r.u32(),
  SInt64: r => r.i64(), "long long": r => r.i64(), UInt64: r => r.u64(), "unsigned long long": r => r.u64(), FileSize: r => r.u64(),
  float: r => r.f32(), double: r => r.f64(),
};
const BYTEY = new Set(["UInt8", "SInt8", "char"]);
function readNode(r, node, base) {
  let v;
  const arr = node.children.length === 1 && (node.children[0].flags & 1) ? node.children[0]
    : (node.flags & 1) ? node : null;
  if (node.type === "string") {
    const n = r.i32(); v = td.decode(r.bytes(n));
    if (node.meta & 0x4000 || (node.children[0] && node.children[0].meta & 0x4000)) r.align(4, base);
    return v;
  }
  if (node.type === "TypelessData") { v = r.bytes(r.i32()); if (node.meta & 0x4000) r.align(4, base); return v; }
  if (PRIM[node.type] && !node.children.length) v = PRIM[node.type](r);
  else if (arr) {
    const n = r.i32(), elem = arr.children[1];
    if (BYTEY.has(elem.type) && !elem.children.length) v = r.bytes(n);
    else { v = new Array(n); for (let i = 0; i < n; i++) v[i] = readNode(r, elem, base); }
    if (arr.meta & 0x4000) r.align(4, base);
  } else {
    v = {};
    for (const c of node.children) v[c.name] = readNode(r, c, base);
  }
  if (node.meta & 0x4000) r.align(4, base);
  return v;
}
function readObject(sf, obj) {
  if (!obj.type.tree) throw new Error("bundle has no type trees");
  const r = new Reader(sf.u8, sf.little);
  r.pos = obj.start;
  return readNode(r, obj.type.tree, obj.start);
}

/* ---------- meshes ---------- */
const half = h => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
};
// vertex formats: [byte size, reader(DataView, offset)]
function formatOf(fmt, major) {
  const F = (n, get) => [n, get];
  if (major >= 2019) return [
    F(4, (dv, o) => dv.getFloat32(o, true)), F(2, (dv, o) => half(dv.getUint16(o, true))),
    F(1, (dv, o) => dv.getUint8(o) / 255), F(1, (dv, o) => Math.max(dv.getInt8(o) / 127, -1)),
    F(2, (dv, o) => dv.getUint16(o, true) / 65535), F(2, (dv, o) => Math.max(dv.getInt16(o, true) / 32767, -1)),
    F(1, (dv, o) => dv.getUint8(o)), F(1, (dv, o) => dv.getInt8(o)), F(2, (dv, o) => dv.getUint16(o, true)),
    F(2, (dv, o) => dv.getInt16(o, true)), F(4, (dv, o) => dv.getUint32(o, true)), F(4, (dv, o) => dv.getInt32(o, true)),
  ][fmt];
  return [   // 2017–2018: Float, Float16, Color, Byte, UInt32
    F(4, (dv, o) => dv.getFloat32(o, true)), F(2, (dv, o) => half(dv.getUint16(o, true))),
    F(1, (dv, o) => dv.getUint8(o) / 255), F(1, (dv, o) => dv.getUint8(o)), F(4, (dv, o) => dv.getUint32(o, true)),
  ][fmt];
}
function resource(bundle, sd) {
  if (!sd || !sd.size || !sd.path) return null;
  const name = sd.path.split("/").pop();
  const f = bundle.files[name];
  if (!f) throw new Error("missing resource " + name);
  return f.subarray(Number(sd.offset), Number(sd.offset) + Number(sd.size));
}
function decodeMesh(bundle, major, m) {
  const vd = m.m_VertexData, n = vd.m_VertexCount, ch = vd.m_Channels;
  if (m.m_CompressedMesh && m.m_CompressedMesh.m_Vertices && m.m_CompressedMesh.m_Vertices.m_NumItems)
    throw new Error("compressed meshes are not supported yet");
  const raw = resource(bundle, m.m_StreamData) || vd.m_DataSize;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  // stream layout as Unity packs it: channels interleaved per stream, streams 16-aligned
  const streams = [];
  let offset = 0;
  for (let s = 0; s <= Math.max(...ch.map(c => c.stream)); s++) {
    let stride = 0;
    for (const c of ch) if (c.stream === s && c.dimension) stride += (c.dimension & 15) * formatOf(c.format, major)[0];
    streams.push({ offset, stride });
    offset = (offset + n * stride + 15) & ~15;
  }
  const channel = idx => {
    const c = ch[idx];
    if (!c || !c.dimension) return null;
    const dim = c.dimension & 15, [size, get] = formatOf(c.format, major), st = streams[c.stream];
    const out = new Float32Array(n * dim);
    for (let v = 0; v < n; v++) {
      const o = st.offset + c.offset + v * st.stride;
      for (let k = 0; k < dim; k++) out[v * dim + k] = get(dv, o + k * size);
    }
    return { data: out, dim };
  };
  const [POS, NRM, UV0] = major >= 2018 ? [0, 1, 4] : [0, 1, 3];
  const pos = channel(POS), nrm = channel(NRM), uv = channel(UV0);
  const ib = m.m_IndexBuffer, wide = m.m_IndexFormat === 1;
  const idv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength), tris = [];
  for (const sm of m.m_SubMeshes) {
    if (sm.topology !== 0) continue;                // triangles only
    const first = sm.firstByte / (wide ? 4 : 2);
    for (let i = first; i < first + sm.indexCount; i++) tris.push(wide ? idv.getUint32(i * 4, true) : idv.getUint16(i * 2, true));
  }
  return { n, pos, nrm, uv, tris };
}

/* ---------- textures ---------- */
function rgb565(c) { return [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0]; }
function decodeDXT(src, w, h, dxt5) {
  const out = new Uint8Array(w * h * 4), bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), step = dxt5 ? 16 : 8;
  const pal = new Uint8Array(16), alpha = new Uint8Array(8);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let o = (by * bw + bx) * step;
    let abits = 0n;
    if (dxt5) {
      const a0 = src[o], a1 = src[o + 1];
      alpha[0] = a0; alpha[1] = a1;
      for (let i = 2; i < 8; i++) alpha[i] = a0 > a1 ? ((8 - i) * a0 + (i - 1) * a1) / 7 : i < 6 ? ((6 - i) * a0 + (i - 1) * a1) / 5 : i === 6 ? 0 : 255;
      for (let i = 7; i >= 2; i--) abits = (abits << 8n) | BigInt(src[o + i]);
      o += 8;
    }
    const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8);
    const p0 = rgb565(c0), p1 = rgb565(c1);
    pal.set([...p0, 255, ...p1, 255]);
    if (c0 > c1 || dxt5) {
      for (let k = 0; k < 3; k++) { pal[8 + k] = (2 * p0[k] + p1[k]) / 3; pal[12 + k] = (p0[k] + 2 * p1[k]) / 3; }
      pal[11] = pal[15] = 255;
    } else {
      for (let k = 0; k < 3; k++) { pal[8 + k] = (p0[k] + p1[k]) / 2; pal[12 + k] = 0; }
      pal[11] = 255; pal[15] = 0;
    }
    const bits = src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24);
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px, y = by * 4 + py;
      if (x >= w || y >= h) continue;
      const i = py * 4 + px, c = (bits >>> (2 * i)) & 3, d = (y * w + x) * 4;
      out[d] = pal[c * 4]; out[d + 1] = pal[c * 4 + 1]; out[d + 2] = pal[c * 4 + 2];
      out[d + 3] = dxt5 ? alpha[Number((abits >> BigInt(3 * i)) & 7n)] : pal[c * 4 + 3];
    }
  }
  return out;
}
// mip 0 of a Texture2D as RGBA rows bottom-up, or null for formats we don't decode
function decodeTexture(bundle, t) {
  const w = t.m_Width, h = t.m_Height, fmt = t.m_TextureFormat;
  const data = resource(bundle, t.m_StreamData) || t["image data"];
  if (!data || !data.length) return null;
  let rgba;
  if (fmt === 10 || fmt === 12) rgba = decodeDXT(data, w, h, fmt === 12);
  else if (fmt === 3 || fmt === 4 || fmt === 5) {          // RGB24, RGBA32, ARGB32
    const bpp = fmt === 3 ? 3 : 4; rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const s = i * bpp, d = i * 4;
      if (fmt === 5) { rgba[d] = data[s + 1]; rgba[d + 1] = data[s + 2]; rgba[d + 2] = data[s + 3]; rgba[d + 3] = data[s]; }
      else { rgba[d] = data[s]; rgba[d + 1] = data[s + 1]; rgba[d + 2] = data[s + 2]; rgba[d + 3] = bpp === 4 ? data[s + 3] : 255; }
    }
  } else return null;
  // cheap content key so bundles sharing one texture upload it once
  let hsh = 2166136261 ^ data.length;
  for (let i = 0; i < data.length; i += 61) hsh = Math.imul(hsh ^ data[i], 16777619);
  return { key: `${w}x${h}:${fmt}:${(hsh >>> 0).toString(16)}`, width: w, height: h, rgba, alpha: fmt !== 10 && fmt !== 3 };
}

/* ---------- transforms (row-major 4x4) ---------- */
function trs(p, q, s) {
  const { x, y, z, w } = q;
  const R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
             [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
             [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  const S = [s.x, s.y, s.z];
  return [[R[0][0] * S[0], R[0][1] * S[1], R[0][2] * S[2], p.x],
          [R[1][0] * S[0], R[1][1] * S[1], R[1][2] * S[2], p.y],
          [R[2][0] * S[0], R[2][1] * S[1], R[2][2] * S[2], p.z], [0, 0, 0, 1]];
}
const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const mul = (A, B) => A.map(row => [0, 1, 2, 3].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j] + row[3] * B[3][j]));
function inv3(M) {
  const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

/**
 * Every visible mesh of a bundle, in the prefab root's space:
 * [{ pos, nrm, uv (Float32Array), idx (Uint32Array), tex: {key, width, height, rgba, alpha} | null }]
 */
export function readBundle(buf) {
  const bundle = readContainer(buf);
  const major = parseInt(bundle.engine, 10) || 2019;
  const parts = [], texCache = new Map();
  for (const [name, u8] of Object.entries(bundle.files)) {
    if (name.endsWith(".resS") || name.endsWith(".resource")) continue;
    let sf;
    try { sf = readSerialized(u8); } catch (e) { continue; }
    const get = pptr => pptr && sf.byPath.get(String(pptr.m_PathID));
    const read = o => readObject(sf, o);
    const objs = sf.objects, of = id => objs.filter(o => o.type.classID === id);
    const transforms = new Map(), trOfGo = new Map();
    for (const o of of(4)) { const t = read(o); transforms.set(o.pathID, t); trOfGo.set(String(t.m_GameObject.m_PathID), o.pathID); }
    // TTS puts the prefab root where the object is, keeping the root's own rotation and
    // scale (models exported Z-up or in centimetres rely on them); its position is replaced
    const world = id => {
      const t = transforms.get(id);
      if (!t) return I4;
      if (!BigInt(t.m_Father.m_PathID)) return trs({ x: 0, y: 0, z: 0 }, t.m_LocalRotation, t.m_LocalScale);
      return mul(world(String(t.m_Father.m_PathID)), trs(t.m_LocalPosition, t.m_LocalRotation, t.m_LocalScale));
    };
    // MeshRenderer (its mesh is on the MeshFilter) and SkinnedMeshRenderer (its own mesh,
    // drawn in its bind pose: no bones, which is the sculpt as modelled)
    for (const o of [...of(23), ...of(137)]) {
      const rd = read(o), goID = String(rd.m_GameObject.m_PathID), goObj = sf.byPath.get(goID);
      if (!goObj) continue;
      let meshObj = o.type.classID === 137 ? get(rd.m_Mesh) : null;
      if (o.type.classID === 23) {
        const go = read(goObj);
        for (const c of go.m_Component || []) {
          const co = get(c.component || c.second);
          if (co && co.type.classID === 33) { meshObj = get(read(co).m_Mesh); break; }
        }
      }
      if (!meshObj) continue;
      const mesh = decodeMesh(bundle, major, read(meshObj));
      const M = world(trOfGo.get(goID));
      const P = new Float32Array(mesh.n * 3), N = new Float32Array(mesh.n * 3), U = new Float32Array(mesh.n * 2);
      const Ninv = inv3(M), pd = mesh.pos.dim;
      for (let v = 0; v < mesh.n; v++) {
        const x = mesh.pos.data[v * pd], y = mesh.pos.data[v * pd + 1], z = mesh.pos.data[v * pd + 2];
        for (let k = 0; k < 3; k++) P[v * 3 + k] = M[k][0] * x + M[k][1] * y + M[k][2] * z + M[k][3];
        if (mesh.uv) { U[v * 2] = mesh.uv.data[v * mesh.uv.dim]; U[v * 2 + 1] = mesh.uv.data[v * mesh.uv.dim + 1]; }
      }
      const idx = new Uint32Array(mesh.tris.length);
      for (let t = 0; t < idx.length; t += 3) { idx[t] = mesh.tris[t + 2]; idx[t + 1] = mesh.tris[t + 1]; idx[t + 2] = mesh.tris[t]; }
      if (mesh.nrm) {
        const nd = mesh.nrm.dim;
        for (let v = 0; v < mesh.n; v++) {           // row vector times inverse: inverse-transpose
          const a = mesh.nrm.data[v * nd], b = mesh.nrm.data[v * nd + 1], c = mesh.nrm.data[v * nd + 2];
          let nx = a * Ninv[0][0] + b * Ninv[1][0] + c * Ninv[2][0];
          let ny = a * Ninv[0][1] + b * Ninv[1][1] + c * Ninv[2][1];
          let nz = a * Ninv[0][2] + b * Ninv[1][2] + c * Ninv[2][2];
          const l = Math.hypot(nx, ny, nz) || 1e-12;
          N[v * 3] = nx / l; N[v * 3 + 1] = ny / l; N[v * 3 + 2] = nz / l;
        }
      } else faceNormals(P, idx, N);
      let tex = null;
      const matObj = get((rd.m_Materials || [])[0]);
      if (matObj) {
        const env = (read(matObj).m_SavedProperties || {}).m_TexEnvs || [];
        const main = env.find(e => (e.first && (e.first.name || e.first)) === "_MainTex");
        const texObj = main && get(main.second.m_Texture);
        if (texObj) {
          if (!texCache.has(texObj.pathID)) texCache.set(texObj.pathID, decodeTexture(bundle, read(texObj)));
          tex = texCache.get(texObj.pathID);
        }
      }
      parts.push({ pos: P, nrm: N, uv: U, idx, tex });
    }
  }
  return parts;
}
function faceNormals(P, idx, N) {
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1e-12; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
}
