import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { KHR_SUPERCOMPRESSION_ZSTD, read as readKtx2 } from 'three/examples/jsm/libs/ktx-parse.module.js';
import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js';
import { describe, expect, it } from 'vitest';
import { encodeUastcKtx2, rewriteGlbWithKtx2, zstdCompress } from '../src/core/ktx2';

async function loadBasisTranscoder() {
  const jsCode = fs.readFileSync('node_modules/three/examples/jsm/libs/basis/basis_transcoder.js', 'utf8');
  const wasmBinary = fs.readFileSync('node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm');
  const BASIS = vm.runInNewContext(jsCode + '\nBASIS;', { WebAssembly, console, setTimeout, clearTimeout, URL }) as (o: {
    wasmBinary: Buffer;
  }) => Promise<{
    initializeBasis(): void;
    KTX2File: new (data: Uint8Array) => {
      isValid(): boolean;
      isUASTC(): boolean;
      getWidth(): number;
      getHeight(): number;
      getLevels(): number;
      startTranscoding(): boolean;
      transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, fmt: number, flags: number, rowPitch: number, rows: number): number;
      close(): void;
      delete(): void;
    };
  }>;
  const mod = await BASIS({ wasmBinary });
  mod.initializeBasis();
  return mod;
}

describe('Khronos KTX2 UASTC encoder & KHR_texture_basisu GLB export', () => {
  it('encodes RGBA8 images into spec-compliant UASTC KTX2 containers that transcode to BC7, ASTC 4x4, ETC2 and RGBA32 via basis_transcoder.wasm', async () => {
    const mod = await loadBasisTranscoder();
    const W = 64, H = 64;
    const src = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = 4 * (y * W + x);
        if (x < 16 && y < 16) {
          // Solid block region -> exact Mode 8
          src[i] = 142; src[i + 1] = 118; src[i + 2] = 94; src[i + 3] = 255;
        } else {
          // Smooth limestone gradient + mortar modulation -> Mode 5 PCA + LSQ
          const mortar = x % 16 === 0 || y % 8 === 0 ? -24 : 0;
          src[i] = Math.max(0, Math.min(255, Math.round(110 + (x / W) * 90 + mortar)));
          src[i + 1] = Math.max(0, Math.min(255, Math.round(98 + (y / H) * 80 + mortar)));
          src[i + 2] = Math.max(0, Math.min(255, Math.round(84 + ((x + y) / (W + H)) * 70 + mortar)));
          src[i + 3] = 255;
        }
      }
    }

    const ktx2 = encodeUastcKtx2(src, W, H, { srgb: true, mipmaps: true });
    const parsed = readKtx2(ktx2);
    expect(parsed.pixelWidth).toBe(W);
    expect(parsed.pixelHeight).toBe(H);
    expect(parsed.levelCount).toBe(7); // 64 -> 32 -> 16 -> 8 -> 4 -> 2 -> 1
    expect(parsed.supercompressionScheme).toBe(KHR_SUPERCOMPRESSION_ZSTD);
    // Level 0 uncompressed GPU payload is 4x smaller than RGBA8 (4096 vs 16384), and Zstd shrinks disk bytes further!
    expect(parsed.levels[0].uncompressedByteLength).toBe((W * H * 4) / 4);
    expect(parsed.levels[0].levelData.byteLength).toBeLessThan(parsed.levels[0].uncompressedByteLength * 0.65);

    // Verify ZSTDDecoder (used by Three.js KTX2Loader) and Node zlib.zstdDecompressSync both decode byte-for-byte
    const zstd = new ZSTDDecoder();
    await zstd.init();
    const decodedByThree = zstd.decode(parsed.levels[0].levelData, parsed.levels[0].uncompressedByteLength);
    expect(decodedByThree.byteLength).toBe(parsed.levels[0].uncompressedByteLength);
    if (typeof zlib.zstdDecompressSync === 'function') {
      const decodedByNode = new Uint8Array(zlib.zstdDecompressSync(parsed.levels[0].levelData));
      expect(Buffer.compare(Buffer.from(decodedByThree), Buffer.from(decodedByNode))).toBe(0);
    }

    const kf = new mod.KTX2File(ktx2);
    expect(kf.isValid()).toBeTruthy();
    expect(kf.isUASTC()).toBeTruthy();
    expect(kf.getLevels()).toBe(7);
    expect(kf.startTranscoding()).toBeTruthy();

    // Transcode to BC7 (6), ASTC 4x4 (10), ETC2 (3), and RGBA32 (13)
    const bc7 = new Uint8Array((W / 4) * (H / 4) * 16);
    expect(kf.transcodeImage(bc7, 0, 0, 0, 6, 0, -1, -1)).toBe(1);
    const astc = new Uint8Array((W / 4) * (H / 4) * 16);
    expect(kf.transcodeImage(astc, 0, 0, 0, 10, 0, -1, -1)).toBe(1);
    const etc2 = new Uint8Array((W / 4) * (H / 4) * 16);
    expect(kf.transcodeImage(etc2, 0, 0, 0, 3, 0, -1, -1)).toBe(1);

    const rgba = new Uint8Array(W * H * 4);
    expect(kf.transcodeImage(rgba, 0, 0, 0, 13, 0, -1, -1)).toBe(1);
    kf.close();
    kf.delete();

    // Solid region is lossless bit-exact
    expect(Array.from(rgba.slice(0, 4))).toEqual([142, 118, 94, 255]);

    // Overall PSNR > 36 dB across textured blocks
    let mse = 0;
    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++) {
        const d = rgba[4 * p + c] - src[4 * p + c];
        mse += d * d;
      }
    }
    mse /= W * H * 3;
    const psnr = 10 * Math.log10((255 * 255) / mse);
    expect(psnr).toBeGreaterThan(36);
  });

  it('rewrites GLTFExporter binary GLBs into 4-byte-aligned KHR_texture_basisu GLBs', async () => {
    const W = 16, H = 16;
    const pixels = new Uint8Array(W * H * 4).fill(180);
    const dataTex = new THREE.DataTexture(pixels, W, H, THREE.RGBAFormat);
    dataTex.name = 'pk_tex_0';
    dataTex.needsUpdate = true;

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ map: dataTex }),
    );
    // In Node without HTMLCanvasElement.toBlob, build a minimal spec-valid GLB with an image bufferView and verify rewriteGlbWithKtx2
    const dummyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const posBytes = new Float32Array((mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array);
    const binPayload = new Uint8Array(posBytes.byteLength + dummyPng.byteLength);
    binPayload.set(new Uint8Array(posBytes.buffer, posBytes.byteOffset, posBytes.byteLength), 0);
    binPayload.set(dummyPng, posBytes.byteLength);

    const gltfJson = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: binPayload.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength },
        { buffer: 0, byteOffset: posBytes.byteLength, byteLength: dummyPng.byteLength },
      ],
      images: [{ mimeType: 'image/png', bufferView: 1 }],
      textures: [{ name: 'pk_tex_0', source: 0 }],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltfJson));
    const jsonAligned = (jsonBytes.byteLength + 3) & ~3;
    const binAligned = (binPayload.byteLength + 3) & ~3;
    const rawGlb = new ArrayBuffer(12 + 8 + jsonAligned + 8 + binAligned);
    const dv = new DataView(rawGlb);
    const u8 = new Uint8Array(rawGlb);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, rawGlb.byteLength, true);
    dv.setUint32(12, jsonAligned, true);
    dv.setUint32(16, 0x4e4f534a, true);
    u8.set(jsonBytes, 20);
    for (let i = jsonBytes.byteLength; i < jsonAligned; i++) u8[20 + i] = 0x20;
    dv.setUint32(20 + jsonAligned, binAligned, true);
    dv.setUint32(20 + jsonAligned + 4, 0x004e4942, true);
    u8.set(binPayload, 28 + jsonAligned);

    const ktx2Bytes = encodeUastcKtx2(pixels, W, H, { srgb: true, mipmaps: false });
    const rewritten = rewriteGlbWithKtx2(rawGlb, new Map([['pk_tex_0', ktx2Bytes]]));
    expect(rewritten.byteLength % 4).toBe(0);

    const rdv = new DataView(rewritten);
    const rJsonLen = rdv.getUint32(12, true);
    const rJson = JSON.parse(new TextDecoder().decode(new Uint8Array(rewritten, 20, rJsonLen)));
    expect(rJson.extensionsUsed).toContain('KHR_texture_basisu');
    expect(rJson.extensionsRequired).toContain('KHR_texture_basisu');
    expect(rJson.images[0].mimeType).toBe('image/ktx2');
    expect(rJson.textures[0].extensions.KHR_texture_basisu).toEqual({ source: 0 });
    expect(rJson.textures[0].source).toBeUndefined();
  });

  it('compresses multi-block 512x512 guttered UASTC atlases >3x on disk via RFC 8878 Zstandard and handles RLE & incompressible fallback', async () => {
    const zstd = new ZSTDDecoder();
    await zstd.init();

    // 1. Empty & pure RLE spans
    expect(zstd.decode(zstdCompress(new Uint8Array(0)), 0).byteLength).toBe(0);
    const rleSrc = new Uint8Array(200000).fill(0x5a);
    const rleFrame = zstdCompress(rleSrc);
    expect(rleFrame.byteLength).toBeLessThan(32);
    expect(Buffer.compare(Buffer.from(zstd.decode(rleFrame, rleSrc.byteLength)), Buffer.from(rleSrc))).toBe(0);

    // 2. High-entropy incompressible pseudo-random bytes -> falls back cleanly to Raw_Block
    const rnd = new Uint8Array(16384);
    let state = 0x12345678;
    for (let i = 0; i < rnd.length; i++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      rnd[i] = state & 0xff;
    }
    const rndFrame = zstdCompress(rnd);
    expect(Buffer.compare(Buffer.from(zstd.decode(rndFrame, rnd.byteLength)), Buffer.from(rnd))).toBe(0);

    // 3. Realistic 512x512 atlas (~35% UV gutters + brick/stone islands) -> 262,144B UASTC across 3 Zstd blocks
    const S = 512;
    const atlas = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = 4 * (y * S + x);
        const inGutter = (x % 128 < 22) || (y % 128 < 22);
        if (inGutter) {
          atlas.set([128, 128, 128, 255], i);
        } else {
          const mortar = (y % 16 === 0) || ((x + ((y >> 4) % 2) * 16) % 32 === 0);
          const v = mortar ? 96 : 154 + ((x * 5 + y * 3) & 7);
          atlas.set([v, v - 10, v - 18, 255], i);
        }
      }
    }
    const rawKtx2 = encodeUastcKtx2(atlas, S, S, { srgb: true, mipmaps: true, supercompress: false });
    const zstdKtx2 = encodeUastcKtx2(atlas, S, S, { srgb: true, mipmaps: true, supercompress: true });
    expect(zstdKtx2.byteLength).toBeLessThan(rawKtx2.byteLength / 3);

    const mod = await loadBasisTranscoder();
    const kf = new mod.KTX2File(zstdKtx2);
    expect(kf.isValid()).toBeTruthy();
    expect(kf.startTranscoding()).toBeTruthy();
    const bc7 = new Uint8Array((S / 4) * (S / 4) * 16);
    expect(kf.transcodeImage(bc7, 0, 0, 0, 6, 0, -1, -1)).toBe(1);
    kf.close();
    kf.delete();
  });
});
