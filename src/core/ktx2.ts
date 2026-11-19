/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import {
  createDefaultContainer,
  KHR_DF_MODEL_UASTC,
  KHR_DF_PRIMARIES_BT709,
  KHR_DF_PRIMARIES_UNSPECIFIED,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  write,
} from 'three/examples/jsm/libs/ktx-parse.module.js';

/**
 * Pure-TypeScript Khronos KTX 2.0 UASTC 4×4 block encoder & glTF 2.0 `KHR_texture_basisu` container rewriter.
 *
 * Encodes RGBA8 images at 8 bits/pixel (16 bytes per 4×4 block — 4× smaller GPU VRAM than RGBA8) using:
 * - UASTC Mode 8 (5-bit prefix `0b10111`, exact 32-bit RGBA8 solid-color blocks)
 * - UASTC Mode 5 (4-bit prefix `0b1011`, full 24-bit RGB888 endpoints + 16 × 3-bit ASTC/BC7 interpolation weights
 *   fitted via power-iteration PCA + closed-form linear least-squares endpoint refinement)
 *
 * Verified against Three.js's Khronos/Binomial `basis_transcoder.wasm` across BC7, ASTC 4×4, ETC2 and RGBA32 targets.
 */

const WEIGHTS_3BIT = [0, 9, 18, 27, 37, 46, 55, 64]; // exact ASTC/BC7 3-bit weight ramp in 0..64
const KHR_DF_CHANNEL_UASTC_RGB = 0;
const KHR_DF_CHANNEL_UASTC_RGBA = 3;

export interface UastcEncodeOptions {
  /** True for base-color/albedo maps (`KHR_DF_TRANSFER_SRGB`); false for linear Normal/ORM/AO maps. */
  srgb?: boolean;
  /** Generate a box-filtered mipmap pyramid down to 1×1 (default false). */
  mipmaps?: boolean;
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgbByte(l: number): number {
  const c = Math.max(0, Math.min(1, l));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

export function downsampleMip2x(
  src: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  srgb: boolean,
): { data: Uint8Array; width: number; height: number } {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const dst = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.min(h - 1, y * 2);
    const sy1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.min(w - 1, x * 2);
      const sx1 = Math.min(w - 1, x * 2 + 1);
      const indices = [
        4 * (sy0 * w + sx0),
        4 * (sy0 * w + sx1),
        4 * (sy1 * w + sx0),
        4 * (sy1 * w + sx1),
      ];
      const outIdx = 4 * (y * nw + x);
      if (srgb) {
        let lr = 0, lg = 0, lb = 0, la = 0;
        for (const k of indices) {
          lr += srgbToLinear(src[k]);
          lg += srgbToLinear(src[k + 1]);
          lb += srgbToLinear(src[k + 2]);
          la += src[k + 3];
        }
        dst[outIdx] = linearToSrgbByte(lr * 0.25);
        dst[outIdx + 1] = linearToSrgbByte(lg * 0.25);
        dst[outIdx + 2] = linearToSrgbByte(lb * 0.25);
        dst[outIdx + 3] = Math.round(la * 0.25);
      } else {
        for (let c = 0; c < 4; c++) {
          dst[outIdx + c] = Math.round((src[indices[0] + c] + src[indices[1] + c] + src[indices[2] + c] + src[indices[3] + c]) * 0.25);
        }
      }
    }
  }
  return { data: dst, width: nw, height: nh };
}

class BitWriter128 {
  private readonly bytes: Uint8Array;
  private readonly base: number;
  private bitPos = 0;

  constructor(out: Uint8Array, byteOffset: number) {
    this.bytes = out;
    this.base = byteOffset;
    out.fill(0, byteOffset, byteOffset + 16);
  }

  write(value: number, bitCount: number) {
    let v = value >>> 0;
    let rem = bitCount;
    while (rem > 0) {
      const byteIdx = this.base + (this.bitPos >> 3);
      const shift = this.bitPos & 7;
      const take = Math.min(rem, 8 - shift);
      const mask = (1 << take) - 1;
      this.bytes[byteIdx] |= (v & mask) << shift;
      v >>>= take;
      this.bitPos += take;
      rem -= take;
    }
  }
}

/** Encode a single 4×4 RGBA8 block (64 bytes) into 16 bytes of Khronos UASTC at `out[byteOffset .. byteOffset + 15]`. */
export function encodeUastcBlock(block: Uint8Array, out: Uint8Array, byteOffset: number): void {
  const r0 = block[0], g0 = block[1], b0 = block[2], a0 = block[3];
  let solid = true;
  for (let i = 4; i < 64; i += 4) {
    if (block[i] !== r0 || block[i + 1] !== g0 || block[i + 2] !== b0 || block[i + 3] !== a0) {
      solid = false;
      break;
    }
  }
  const bw = new BitWriter128(out, byteOffset);
  if (solid) {
    // UASTC Mode 8 (void-extent solid RGBA8): 5-bit mode code 0b10111 (23), followed by R8, G8, B8, A8 at bits 5..36.
    bw.write(0b10111, 5);
    bw.write(r0, 8);
    bw.write(g0, 8);
    bw.write(b0, 8);
    bw.write(a0, 8);
    return;
  }

  // Compute mean & principal color axis across the 16 RGB texels
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 64; i += 4) {
    mr += block[i];
    mg += block[i + 1];
    mb += block[i + 2];
  }
  mr *= 0.0625;
  mg *= 0.0625;
  mb *= 0.0625;

  let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
  for (let i = 0; i < 64; i += 4) {
    const dr = block[i] - mr, dg = block[i + 1] - mg, db = block[i + 2] - mb;
    crr += dr * dr; crg += dr * dg; crb += dr * db;
    cgg += dg * dg; cgb += dg * db; cbb += db * db;
  }

  // 4-step power iteration for dominant eigenvector (seeded along largest-variance channel)
  let ar = crr >= cgg && crr >= cbb ? 1 : 0;
  let ag = ar === 0 && cgg >= cbb ? 1 : 0;
  let ab = ar === 0 && ag === 0 ? 1 : 0;
  for (let it = 0; it < 4; it++) {
    const nr = crr * ar + crg * ag + crb * ab;
    const ng = crg * ar + cgg * ag + cgb * ab;
    const nb = crb * ar + cgb * ag + cbb * ab;
    const len = Math.hypot(nr, ng, nb);
    if (len < 1e-8) break;
    ar = nr / len; ag = ng / len; ab = nb / len;
  }

  let minProj = Infinity, maxProj = -Infinity;
  for (let i = 0; i < 64; i += 4) {
    const p = (block[i] - mr) * ar + (block[i + 1] - mg) * ag + (block[i + 2] - mb) * ab;
    if (p < minProj) minProj = p;
    if (p > maxProj) maxProj = p;
  }

  let e0r = Math.max(0, Math.min(255, Math.round(mr + ar * minProj)));
  let e0g = Math.max(0, Math.min(255, Math.round(mg + ag * minProj)));
  let e0b = Math.max(0, Math.min(255, Math.round(mb + ab * minProj)));
  let e1r = Math.max(0, Math.min(255, Math.round(mr + ar * maxProj)));
  let e1g = Math.max(0, Math.min(255, Math.round(mg + ag * maxProj)));
  let e1b = Math.max(0, Math.min(255, Math.round(mb + ab * maxProj)));

  const weights = new Uint8Array(16);

  const assignWeights = () => {
    const dx = e1r - e0r, dy = e1g - e0g, dz = e1b - e0b;
    const denom = dx * dx + dy * dy + dz * dz;
    if (denom < 1) {
      weights.fill(0);
      return;
    }
    for (let p = 0; p < 16; p++) {
      const i = 4 * p;
      const t64 = ((block[i] - e0r) * dx + (block[i + 1] - e0g) * dy + (block[i + 2] - e0b) * dz) * 64 / denom;
      let bestW = 0, bestDist = Infinity;
      for (let w = 0; w < 8; w++) {
        const d = Math.abs(t64 - WEIGHTS_3BIT[w]);
        if (d < bestDist) { bestDist = d; bestW = w; }
      }
      weights[p] = bestW;
    }
  };

  assignWeights();

  // Closed-form linear least-squares endpoint refinement given quantized 3-bit weights
  let saa = 0, sab = 0, sbb = 0;
  let sar = 0, sbr = 0, sag = 0, sbg = 0, sabCh = 0, sbbCh = 0;
  for (let p = 0; p < 16; p++) {
    const b = WEIGHTS_3BIT[weights[p]] / 64;
    const a = 1 - b;
    saa += a * a; sab += a * b; sbb += b * b;
    const i = 4 * p;
    sar += a * block[i]; sbr += b * block[i];
    sag += a * block[i + 1]; sbg += b * block[i + 1];
    sabCh += a * block[i + 2]; sbbCh += b * block[i + 2];
  }
  const det = saa * sbb - sab * sab;
  if (det > 1e-4) {
    const inv = 1 / det;
    e0r = Math.max(0, Math.min(255, Math.round((sbb * sar - sab * sbr) * inv)));
    e1r = Math.max(0, Math.min(255, Math.round((saa * sbr - sab * sar) * inv)));
    e0g = Math.max(0, Math.min(255, Math.round((sbb * sag - sab * sbg) * inv)));
    e1g = Math.max(0, Math.min(255, Math.round((saa * sbg - sab * sag) * inv)));
    e0b = Math.max(0, Math.min(255, Math.round((sbb * sabCh - sab * sbbCh) * inv)));
    e1b = Math.max(0, Math.min(255, Math.round((saa * sbbCh - sab * sabCh) * inv)));
    assignWeights();
  }

  // Anchor weight w[0] is encoded in 2 bits (MSB implicitly 0 -> 0..3); swap endpoints if w[0] >= 4.
  if (weights[0] >= 4) {
    [e0r, e1r] = [e1r, e0r];
    [e0g, e1g] = [e1g, e0g];
    [e0b, e1b] = [e1b, e0b];
    for (let p = 0; p < 16; p++) weights[p] = 7 - weights[p];
  }

  // UASTC Mode 5: 4-bit mode code 0b1011 (11) + 16 hint bits + R0,R1,G0,G1,B0,B1 + 2-bit w[0] + 15 × 3-bit w[1..15].
  bw.write(0b1011, 4);
  bw.write(0, 16);
  bw.write(e0r, 8); bw.write(e1r, 8);
  bw.write(e0g, 8); bw.write(e1g, 8);
  bw.write(e0b, 8); bw.write(e1b, 8);
  bw.write(weights[0] & 0x3, 2);
  for (let p = 1; p < 16; p++) bw.write(weights[p] & 0x7, 3);
}

export function encodeUastcLevel(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const bx = Math.max(1, Math.ceil(width / 4));
  const by = Math.max(1, Math.ceil(height / 4));
  const out = new Uint8Array(bx * by * 16);
  const block = new Uint8Array(64);

  for (let gy = 0; gy < by; gy++) {
    for (let gx = 0; gx < bx; gx++) {
      for (let py = 0; py < 4; py++) {
        const sy = Math.min(height - 1, gy * 4 + py);
        for (let px = 0; px < 4; px++) {
          const sx = Math.min(width - 1, gx * 4 + px);
          const sOff = 4 * (sy * width + sx);
          const dOff = 4 * (py * 4 + px);
          block[dOff] = rgba[sOff];
          block[dOff + 1] = rgba[sOff + 1];
          block[dOff + 2] = rgba[sOff + 2];
          block[dOff + 3] = rgba[sOff + 3];
        }
      }
      encodeUastcBlock(block, out, (gy * bx + gx) * 16);
    }
  }
  return out;
}

/** Encode an RGBA8 buffer into a Khronos KTX 2.0 UASTC container (`image/ktx2`). */
export function encodeUastcKtx2(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: UastcEncodeOptions = {},
): Uint8Array {
  const srgb = opts.srgb ?? false;
  const mipmaps = opts.mipmaps ?? false;

  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) { hasAlpha = true; break; }
  }

  const levels: { levelData: Uint8Array; uncompressedByteLength: number }[] = [];
  let curData: Uint8ClampedArray | Uint8Array = rgba;
  let cw = width, ch = height;
  while (true) {
    const encoded = encodeUastcLevel(curData, cw, ch);
    levels.push({ levelData: encoded, uncompressedByteLength: encoded.byteLength });
    if (!mipmaps || (cw === 1 && ch === 1)) break;
    const next = downsampleMip2x(curData, cw, ch, srgb);
    curData = next.data;
    cw = next.width;
    ch = next.height;
  }

  const container = createDefaultContainer();
  container.vkFormat = 0; // VK_FORMAT_UNDEFINED for UASTC block-compressed payloads
  container.typeSize = 1;
  container.pixelWidth = width;
  container.pixelHeight = height;
  container.pixelDepth = 0;
  container.layerCount = 0;
  container.faceCount = 1;
  container.levelCount = levels.length;
  container.supercompressionScheme = 0;
  container.levels = levels;
  container.dataFormatDescriptor = [
    {
      vendorId: 0,
      descriptorType: 0,
      versionNumber: 2,
      colorModel: KHR_DF_MODEL_UASTC,
      colorPrimaries: srgb ? KHR_DF_PRIMARIES_BT709 : KHR_DF_PRIMARIES_UNSPECIFIED,
      transferFunction: srgb ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR,
      flags: 0,
      texelBlockDimension: [3, 3, 0, 0],
      bytesPlane: [16, 0, 0, 0, 0, 0, 0, 0],
      samples: [
        {
          bitOffset: 0,
          bitLength: 127,
          channelType: hasAlpha ? KHR_DF_CHANNEL_UASTC_RGBA : KHR_DF_CHANNEL_UASTC_RGB,
          samplePosition: [0, 0, 0, 0],
          sampleLower: 0,
          sampleUpper: 255,
        },
      ],
    },
  ];
  container.keyValue = { KTXwriter: 'Potemkin3D UASTC' };
  return write(container);
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Replace embedded PNG/JPEG texture bufferViews in a binary glTF 2.0 (`ArrayBuffer`) with `image/ktx2` UASTC payloads
 * keyed by `THREE.Texture.name` (`textureByName`), wiring the standard `KHR_texture_basisu` extension.
 */
export function rewriteGlbWithKtx2(glbBuffer: ArrayBuffer, textureByName: Map<string, Uint8Array>): ArrayBuffer {
  if (!textureByName.size) return glbBuffer;
  const view = new DataView(glbBuffer);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error('Invalid glTF 2.0 binary header');
  }
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('Expected JSON chunk first in GLB');
  const jsonBytes = new Uint8Array(glbBuffer, 20, jsonLen);
  const gltf = JSON.parse(new TextDecoder().decode(jsonBytes)) as {
    extensionsUsed?: string[];
    extensionsRequired?: string[];
    images?: { name?: string; mimeType?: string; bufferView?: number }[];
    textures?: { name?: string; source?: number; sampler?: number; extensions?: Record<string, unknown> }[];
    bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }[];
    buffers?: { byteLength: number }[];
  };

  const binChunkStart = 20 + jsonLen;
  if (binChunkStart + 8 > glbBuffer.byteLength || view.getUint32(binChunkStart + 4, true) !== CHUNK_BIN) {
    return glbBuffer;
  }
  const binLen = view.getUint32(binChunkStart, true);
  const oldBin = new Uint8Array(glbBuffer, binChunkStart + 8, binLen);

  const images = gltf.images ?? [];
  const textures = gltf.textures ?? [];
  const bufferViews = gltf.bufferViews ?? [];

  // Map imageIndex -> KTX2 payload via texture.name or image.name
  const imageReplacement = new Map<number, Uint8Array>();
  for (const tex of textures) {
    const srcIdx = tex.source;
    if (typeof srcIdx !== 'number') continue;
    const key = tex.name ?? images[srcIdx]?.name ?? '';
    const ktx2 = textureByName.get(key);
    if (ktx2) imageReplacement.set(srcIdx, ktx2);
  }
  if (!imageReplacement.size) return glbBuffer;

  const replacedBv = new Map<number, Uint8Array>();
  for (const [imgIdx, ktx2] of imageReplacement) {
    const bvIdx = images[imgIdx]?.bufferView;
    if (typeof bvIdx === 'number') {
      replacedBv.set(bvIdx, ktx2);
      images[imgIdx].mimeType = 'image/ktx2';
    }
  }

  for (const tex of textures) {
    if (typeof tex.source === 'number' && imageReplacement.has(tex.source)) {
      tex.extensions = { ...(tex.extensions ?? {}), KHR_texture_basisu: { source: tex.source } };
      delete tex.source;
    }
  }

  const extUsed = new Set(gltf.extensionsUsed ?? []);
  extUsed.add('KHR_texture_basisu');
  gltf.extensionsUsed = [...extUsed];
  const extReq = new Set(gltf.extensionsRequired ?? []);
  extReq.add('KHR_texture_basisu');
  gltf.extensionsRequired = [...extReq];

  // Rebuild BIN buffer with 4-byte aligned bufferViews
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < bufferViews.length; i++) {
    const bv = bufferViews[i];
    const replacement = replacedBv.get(i);
    const data = replacement ?? oldBin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const alignedLen = align4(data.byteLength);
    bv.byteOffset = offset;
    bv.byteLength = data.byteLength;
    chunks.push(data);
    if (alignedLen > data.byteLength) chunks.push(new Uint8Array(alignedLen - data.byteLength));
    offset += alignedLen;
  }
  if (gltf.buffers?.[0]) gltf.buffers[0].byteLength = offset;

  const newJsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const newJsonLen = align4(newJsonRaw.byteLength);
  const totalLen = 12 + 8 + newJsonLen + 8 + offset;
  const outBuf = new ArrayBuffer(totalLen);
  const outU8 = new Uint8Array(outBuf);
  const outView = new DataView(outBuf);

  outView.setUint32(0, GLB_MAGIC, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, totalLen, true);

  outView.setUint32(12, newJsonLen, true);
  outView.setUint32(16, CHUNK_JSON, true);
  outU8.set(newJsonRaw, 20);
  for (let i = newJsonRaw.byteLength; i < newJsonLen; i++) outU8[20 + i] = 0x20; // space pad JSON

  const newBinHeader = 20 + newJsonLen;
  outView.setUint32(newBinHeader, offset, true);
  outView.setUint32(newBinHeader + 4, CHUNK_BIN, true);
  let cursor = newBinHeader + 8;
  for (const ch of chunks) {
    outU8.set(ch, cursor);
    cursor += ch.byteLength;
  }
  return outBuf;
}
