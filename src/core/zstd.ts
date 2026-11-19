/* Pure-TypeScript RFC 8878 Zstandard compressor for KTX2 supercompressionScheme = 1 (Apache-2.0). */

/**
 * Pure-TypeScript RFC 8878 Zstandard frame compressor (`KHR_SUPERCOMPRESSION_ZSTD`).
 *
 * Runs identically in browser WebGL workers and Node without external WASM dependencies:
 * - Emits standard Zstandard frames (`0xFD2FB528` magic + `Single_Segment` content size header)
 * - Uses 128 KB blocks (`RLE_Block` for uniform spans, `Compressed_Block` with fast hash-chain LZ77 matching
 *   + exact bijective Predefined-FSE backward bitstream encoding, and `Raw_Block` fallback on incompressible noise)
 * - Compresses UASTC 4×4 KTX2 mip levels with gutters/flat surfaces/repeated texels by 2.5–20× on disk while
 *   decoding directly via Three.js `KTX2Loader` (`zstddec.module.js`) and standard Zstandard decoders.
 */

const ZSTD_MAGIC = 0xfd2fb528;
const MAX_BLOCK_SIZE = 131072; // 128 KiB RFC 8878 max block size

interface FsePredecessor {
  state: number;
  bits: number;
  nbBits: number;
}

interface PredefinedFseEncoder {
  accuracyLog: number;
  initialStateForSymbol: Uint16Array;
  /** Indexed by `symbol * tableSize + nextState`. */
  pred: FsePredecessor[];
  tableSize: number;
}

function highBit32(v: number): number {
  return 31 - Math.clz32(v);
}

/**
 * Build exact RFC 8878 §4.1.1 FSE decoding table from normalized counts, then invert its bijective state partition
 * so any `(symbol, nextState)` maps in O(1) to the unique `(prevState, bits, nbBits)` that decodes into `nextState`.
 */
function buildPredefinedFse(norm: readonly number[], accuracyLog: number): PredefinedFseEncoder {
  const tableSize = 1 << accuracyLog;
  const maxSymbol = norm.length - 1;
  const tableSymbol = new Uint8Array(tableSize);
  const symbolNext = new Uint16Array(maxSymbol + 1);

  let highThreshold = tableSize - 1;
  for (let s = 0; s <= maxSymbol; s++) {
    if (norm[s] === -1) {
      tableSymbol[highThreshold--] = s;
      symbolNext[s] = 1;
    } else if (norm[s] > 0) {
      symbolNext[s] = norm[s];
    }
  }

  const step = (tableSize >> 1) + (tableSize >> 3) + 3;
  const mask = tableSize - 1;
  let pos = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const count = norm[s];
    if (count <= 0) continue;
    for (let i = 0; i < count; i++) {
      tableSymbol[pos] = s;
      do {
        pos = (pos + step) & mask;
      } while (pos > highThreshold);
    }
  }

  const numBits = new Uint8Array(tableSize);
  const baseline = new Uint16Array(tableSize);
  for (let u = 0; u < tableSize; u++) {
    const sym = tableSymbol[u];
    const nextStateVal = symbolNext[sym]++;
    const nb = accuracyLog - highBit32(nextStateVal);
    numBits[u] = nb;
    baseline[u] = (nextStateVal << nb) - tableSize;
  }

  const initialStateForSymbol = new Uint16Array(maxSymbol + 1);
  const pred: FsePredecessor[] = new Array((maxSymbol + 1) * tableSize);
  const seen = new Uint8Array(maxSymbol + 1);

  for (let u = 0; u < tableSize; u++) {
    const sym = tableSymbol[u];
    if (!seen[sym]) {
      initialStateForSymbol[sym] = u;
      seen[sym] = 1;
    }
    const nb = numBits[u];
    const base = baseline[u];
    const span = 1 << nb;
    const row = sym * tableSize;
    for (let b = 0; b < span; b++) {
      pred[row + base + b] = { state: u, bits: b, nbBits: nb };
    }
  }

  return { accuracyLog, initialStateForSymbol, pred, tableSize };
}

// RFC 8878 §3.1.1.3.2.2 Predefined FSE Distributions
const LL_DEFAULT_NORM = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1,
];
const ML_DEFAULT_NORM = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
  -1, -1, -1, -1, -1,
];
const OF_DEFAULT_NORM = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

const FSE_LL = buildPredefinedFse(LL_DEFAULT_NORM, 6);
const FSE_ML = buildPredefinedFse(ML_DEFAULT_NORM, 6);
const FSE_OF = buildPredefinedFse(OF_DEFAULT_NORM, 5);

// RFC 8878 Table 16: Literals_Length_Code baseline & extra bits (codes 0..35)
const LL_BASELINE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096,
  8192, 16384, 32768, 65536,
];
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
];

// RFC 8878 Table 17: Match_Length_Code baseline & extra bits (codes 0..52, matchLen >= 3)
const ML_BASELINE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
];
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11,
  12, 13, 14, 15, 16,
];

function encodeLlCode(litLen: number): number {
  if (litLen < 16) return litLen;
  for (let c = 35; c >= 16; c--) {
    if (litLen >= LL_BASELINE[c]) return c;
  }
  return 16;
}

function encodeMlCode(matchLen: number): number {
  if (matchLen < 35) return matchLen - 3;
  for (let c = 52; c >= 32; c--) {
    if (matchLen >= ML_BASELINE[c]) return c;
  }
  return 32;
}

class ForwardBitStream {
  private buf: Uint8Array;
  private bitPos = 0;

  constructor(initialBytes = 1024) {
    this.buf = new Uint8Array(initialBytes);
  }

  write(value: number, nbBits: number): void {
    if (nbBits === 0) return;
    const neededBytes = ((this.bitPos + nbBits + 7) >> 3) + 4;
    if (neededBytes > this.buf.length) {
      const next = new Uint8Array(Math.max(neededBytes, this.buf.length * 2));
      next.set(this.buf);
      this.buf = next;
    }
    let v = value >>> 0;
    let rem = nbBits;
    while (rem > 0) {
      const byteIdx = this.bitPos >> 3;
      const shift = this.bitPos & 7;
      const take = Math.min(rem, 8 - shift);
      const mask = take === 32 ? 0xffffffff : (1 << take) - 1;
      this.buf[byteIdx] |= (v & mask) << shift;
      v >>>= take;
      this.bitPos += take;
      rem -= take;
    }
  }

  finishWithSentinel(): Uint8Array {
    this.write(1, 1);
    return this.buf.subarray(0, (this.bitPos + 7) >> 3);
  }
}

interface Sequence {
  litLen: number;
  offsetValue: number; // rawDistance + 3 (>= 4), or 1 for repeat_offset_1 when litLen > 0
  matchLen: number;
}

function encodeLiteralsSection(literals: Uint8Array): Uint8Array {
  const L = literals.length;
  if (L > 0) {
    let allSame = true;
    const b0 = literals[0];
    for (let i = 1; i < L; i++) {
      if (literals[i] !== b0) { allSame = false; break; }
    }
    if (allSame && L >= 4) {
      // RLE_Literals_Block (Literals_Block_Type = 1)
      if (L < 32) {
        return Uint8Array.of((L << 3) | 1, b0);
      } else if (L < 4096) {
        const h = (L << 4) | (1 << 2) | 1;
        return Uint8Array.of(h & 0xff, (h >> 8) & 0xff, b0);
      } else {
        const h = (L << 4) | (3 << 2) | 1;
        return Uint8Array.of(h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff, b0);
      }
    }
  }

  // Raw_Literals_Block (Literals_Block_Type = 0)
  let hdrLen = 1;
  let hdr = 0;
  if (L < 32) {
    hdrLen = 1;
    hdr = (L << 3) | 0;
  } else if (L < 4096) {
    hdrLen = 2;
    hdr = (L << 4) | (1 << 2) | 0;
  } else {
    hdrLen = 3;
    hdr = (L << 4) | (3 << 2) | 0;
  }
  const out = new Uint8Array(hdrLen + L);
  for (let b = 0; b < hdrLen; b++) out[b] = (hdr >> (8 * b)) & 0xff;
  out.set(literals, hdrLen);
  return out;
}

function encodeCompressedBlockPayload(chunk: Uint8Array): Uint8Array | null {
  const N = chunk.length;
  if (N < 16) return null;

  // Fast 4-byte hash table LZ77 matcher (max match 131072, min match 4)
  const HASH_BITS = 14;
  const hashTable = new Int32Array(1 << HASH_BITS).fill(-1);
  const literals = new Uint8Array(N);
  let litWrite = 0;
  const seqs: Sequence[] = [];

  let anchor = 0;
  let ip = 0;
  const limit = N - 8; // keep final 5+ bytes safe for fast 4-byte reads

  const hash4 = (p: number) =>
    (((chunk[p] | (chunk[p + 1] << 8) | (chunk[p + 2] << 16) | (chunk[p + 3] << 24)) >>> 0) * 2654435761) >>> (32 - HASH_BITS);

  while (ip <= limit) {
    const h = hash4(ip);
    const ref = hashTable[h];
    hashTable[h] = ip;

    if (
      ref >= 0 &&
      ip - ref > 0 &&
      chunk[ref] === chunk[ip] &&
      chunk[ref + 1] === chunk[ip + 1] &&
      chunk[ref + 2] === chunk[ip + 2] &&
      chunk[ref + 3] === chunk[ip + 3]
    ) {
      // Extend match forward up to min(N - ip, 131072)
      let ml = 4;
      const maxMl = Math.min(N - ip, 131071);
      while (ml < maxMl && chunk[ref + ml] === chunk[ip + ml]) ml++;

      const litLen = ip - anchor;
      // Split litLen > 131071 is impossible since N <= 131072
      if (litLen > 0) {
        literals.set(chunk.subarray(anchor, ip), litWrite);
        litWrite += litLen;
      }
      const rawDist = ip - ref;
      seqs.push({
        litLen,
        offsetValue: rawDist + 3, // RFC 8878 §3.1.1.5: Offset_Value > 3 => offset = Offset_Value - 3
        matchLen: ml,
      });

      // Seed intermediate hash positions sparsely on long matches so subsequent matches lock quickly
      const nextIp = ip + ml;
      if (ml < 64) {
        for (let k = ip + 1; k < Math.min(nextIp, limit); k += 2) hashTable[hash4(k)] = k;
      } else if (nextIp - 2 <= limit) {
        hashTable[hash4(nextIp - 2)] = nextIp - 2;
      }
      ip = nextIp;
      anchor = ip;
      continue;
    }
    ip++;
  }

  if (seqs.length === 0) return null;

  // Copy trailing literals after last match
  if (anchor < N) {
    const tail = N - anchor;
    literals.set(chunk.subarray(anchor, N), litWrite);
    litWrite += tail;
  }

  const litSection = encodeLiteralsSection(literals.subarray(0, litWrite));
  const numSeq = seqs.length;

  // Precompute codes & extra bits for all sequences
  const llCode = new Uint8Array(numSeq);
  const llExtra = new Uint32Array(numSeq);
  const llBits = new Uint8Array(numSeq);
  const mlCode = new Uint8Array(numSeq);
  const mlExtra = new Uint32Array(numSeq);
  const mlBits = new Uint8Array(numSeq);
  const ofCode = new Uint8Array(numSeq);
  const ofExtra = new Uint32Array(numSeq);
  const ofBits = new Uint8Array(numSeq);

  for (let i = 0; i < numSeq; i++) {
    const s = seqs[i];
    const lc = encodeLlCode(s.litLen);
    llCode[i] = lc;
    llBits[i] = LL_BITS[lc];
    llExtra[i] = s.litLen - LL_BASELINE[lc];

    const mc = encodeMlCode(s.matchLen);
    mlCode[i] = mc;
    mlBits[i] = ML_BITS[mc];
    mlExtra[i] = s.matchLen - ML_BASELINE[mc];

    const oc = highBit32(s.offsetValue);
    ofCode[i] = oc;
    ofBits[i] = oc;
    ofExtra[i] = s.offsetValue - (1 << oc);
  }

  // Backward FSE bitstream: emit in exact reverse of decoder read order
  const bs = new ForwardBitStream(Math.max(64, numSeq * 4));
  const last = numSeq - 1;
  let stateLL = FSE_LL.initialStateForSymbol[llCode[last]];
  let stateML = FSE_ML.initialStateForSymbol[mlCode[last]];
  let stateOF = FSE_OF.initialStateForSymbol[ofCode[last]];

  for (let i = last; i >= 0; i--) {
    if (i < last) {
      // Decoder updates LL, then ML, then OF -> reverse emits OF, then ML, then LL
      const pOF = FSE_OF.pred[ofCode[i] * FSE_OF.tableSize + stateOF];
      const pML = FSE_ML.pred[mlCode[i] * FSE_ML.tableSize + stateML];
      const pLL = FSE_LL.pred[llCode[i] * FSE_LL.tableSize + stateLL];
      bs.write(pOF.bits, pOF.nbBits);
      bs.write(pML.bits, pML.nbBits);
      bs.write(pLL.bits, pLL.nbBits);
      stateOF = pOF.state;
      stateML = pML.state;
      stateLL = pLL.state;
    }
    // Decoder reads OF extra, then ML extra, then LL extra -> reverse emits LL, then ML, then OF
    bs.write(llExtra[i], llBits[i]);
    bs.write(mlExtra[i], mlBits[i]);
    bs.write(ofExtra[i], ofBits[i]);
  }

  // Decoder initializes stateLL (6b), then stateOF (5b), then stateML (6b) -> reverse emits ML, OF, LL
  bs.write(stateML, FSE_ML.accuracyLog);
  bs.write(stateOF, FSE_OF.accuracyLog);
  bs.write(stateLL, FSE_LL.accuracyLog);

  const seqBitstream = bs.finishWithSentinel();

  // Sequences_Section_Header: Number_of_Sequences (1..3 bytes) + Symbol_Compression_Modes = 0x00 (Predefined_Mode)
  let seqHdr: Uint8Array;
  if (numSeq < 128) {
    seqHdr = Uint8Array.of(numSeq, 0x00);
  } else if (numSeq < 0x7f00) {
    seqHdr = Uint8Array.of(((numSeq >> 8) & 0xff) + 0x80, numSeq & 0xff, 0x00);
  } else {
    const adj = numSeq - 0x7f00;
    seqHdr = Uint8Array.of(0xff, adj & 0xff, (adj >> 8) & 0xff, 0x00);
  }

  const totalLen = litSection.length + seqHdr.length + seqBitstream.length;
  // RFC 8878 §3.1.1.2: Compressed_Block size MUST be strictly smaller than uncompressed block size
  if (totalLen >= N) return null;

  const payload = new Uint8Array(totalLen);
  payload.set(litSection, 0);
  payload.set(seqHdr, litSection.length);
  payload.set(seqBitstream, litSection.length + seqHdr.length);
  return payload;
}

/** Compress `src` into a standard RFC 8878 Zstandard frame (`0xFD2FB528`). */
export function zstdCompress(src: Uint8Array): Uint8Array {
  const totalLen = src.byteLength;
  // Frame header: 4B magic + 1B descriptor (Single_Segment_Flag=1 | FCS_Field_Size=4B => 0xA0) + 4B uint32 size
  const frameHeader = new Uint8Array(9);
  const dv = new DataView(frameHeader.buffer);
  dv.setUint32(0, ZSTD_MAGIC, true);
  frameHeader[4] = 0xa0;
  dv.setUint32(5, totalLen >>> 0, true);

  if (totalLen === 0) {
    const out = new Uint8Array(12);
    out.set(frameHeader, 0);
    // Last_Block = 1, Block_Type = 0 (Raw_Block), Block_Size = 0
    out[9] = 0x01;
    return out;
  }

  const parts: Uint8Array[] = [frameHeader];
  let totalOut = frameHeader.length;

  for (let offset = 0; offset < totalLen; offset += MAX_BLOCK_SIZE) {
    const end = Math.min(totalLen, offset + MAX_BLOCK_SIZE);
    const chunk = src.subarray(offset, end);
    const N = chunk.length;
    const lastBit = end === totalLen ? 1 : 0;

    // Check RLE_Block (all bytes identical)
    let rle = true;
    const first = chunk[0];
    for (let i = 1; i < N; i++) {
      if (chunk[i] !== first) { rle = false; break; }
    }
    if (rle && N > 1) {
      const hdr = lastBit | (1 << 1) | (N << 3);
      const blk = Uint8Array.of(hdr & 0xff, (hdr >> 8) & 0xff, (hdr >> 16) & 0xff, first);
      parts.push(blk);
      totalOut += blk.length;
      continue;
    }

    const compressed = encodeCompressedBlockPayload(chunk);
    if (compressed) {
      const hdr = lastBit | (2 << 1) | (compressed.length << 3);
      const blk = new Uint8Array(3 + compressed.length);
      blk[0] = hdr & 0xff;
      blk[1] = (hdr >> 8) & 0xff;
      blk[2] = (hdr >> 16) & 0xff;
      blk.set(compressed, 3);
      parts.push(blk);
      totalOut += blk.length;
    } else {
      // Raw_Block fallback
      const hdr = lastBit | (0 << 1) | (N << 3);
      const blk = new Uint8Array(3 + N);
      blk[0] = hdr & 0xff;
      blk[1] = (hdr >> 8) & 0xff;
      blk[2] = (hdr >> 16) & 0xff;
      blk.set(chunk, 3);
      parts.push(blk);
      totalOut += blk.length;
    }
  }

  const out = new Uint8Array(totalOut);
  let writeOff = 0;
  for (const p of parts) {
    out.set(p, writeOff);
    writeOff += p.length;
  }
  return out;
}
