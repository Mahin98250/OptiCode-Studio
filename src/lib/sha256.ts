const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}
function ch(x: number, y: number, z: number) {
  return (x & y) ^ (~x & z);
}
function maj(x: number, y: number, z: number) {
  return (x & y) ^ (x & z) ^ (y & z);
}
function sigma0(x: number) {
  return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
}
function sigma1(x: number) {
  return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
}
function gamma0(x: number) {
  return rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
}
function gamma1(x: number) {
  return rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);
}

export class StreamingSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;
  private finalized = false;

  update(data: Uint8Array) {
    if (this.finalized) throw new Error('SHA-256 hash is already finalized.');
    this.bytesHashed += data.byteLength;

    let offset = 0;
    if (this.bufferLength > 0) {
      const take = Math.min(64 - this.bufferLength, data.byteLength);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset = take;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= data.byteLength) {
      this.compress(data.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < data.byteLength) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLength = data.byteLength - offset;
    }

    return this;
  }

  private compress(chunk: Uint8Array) {
    const w = this.schedule;
    for (let i = 0; i < 16; i += 1) {
      const p = i * 4;
      w[i] = (
        (chunk[p] << 24) |
        (chunk[p + 1] << 16) |
        (chunk[p + 2] << 8) |
        chunk[p + 3]
      ) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      w[i] = (
        gamma1(w[i - 2]) +
        w[i - 7] +
        gamma0(w[i - 15]) +
        w[i - 16]
      ) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + sigma1(e) + ch(e, f, g) + K[i] + w[i]) >>> 0;
      const t2 = (sigma0(a) + maj(a, b, c)) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digest() {
    if (this.finalized) throw new Error('SHA-256 hash is already finalized.');
    this.finalized = true;

    const paddedLength = this.bufferLength < 56 ? 64 : 128;
    const finalBlock = new Uint8Array(paddedLength);
    finalBlock.set(this.buffer.subarray(0, this.bufferLength));
    finalBlock[this.bufferLength] = 0x80;

    const high = Math.floor(this.bytesHashed / 0x20000000);
    const low = (this.bytesHashed * 8) >>> 0;
    finalBlock[paddedLength - 8] = (high >>> 24) & 0xff;
    finalBlock[paddedLength - 7] = (high >>> 16) & 0xff;
    finalBlock[paddedLength - 6] = (high >>> 8) & 0xff;
    finalBlock[paddedLength - 5] = high & 0xff;
    finalBlock[paddedLength - 4] = (low >>> 24) & 0xff;
    finalBlock[paddedLength - 3] = (low >>> 16) & 0xff;
    finalBlock[paddedLength - 2] = (low >>> 8) & 0xff;
    finalBlock[paddedLength - 1] = low & 0xff;

    for (let offset = 0; offset < paddedLength; offset += 64) {
      this.compress(finalBlock.subarray(offset, offset + 64));
    }

    const output = new Uint8Array(32);
    for (let i = 0; i < this.state.length; i += 1) {
      const value = this.state[i];
      output[i * 4] = (value >>> 24) & 0xff;
      output[i * 4 + 1] = (value >>> 16) & 0xff;
      output[i * 4 + 2] = (value >>> 8) & 0xff;
      output[i * 4 + 3] = value & 0xff;
    }
    return output;
  }
}

export async function sha256Blob(blob: Blob) {
  const reader = blob.stream().getReader();
  const hash = new StreamingSha256();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest();
}
