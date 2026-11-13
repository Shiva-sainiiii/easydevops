/**
 * Fernet (cryptography.fernet.Fernet) ka Node port, bina kisi extra package ke.
 *
 * Python wale format ke saath bit-for-bit compatible hai, isliye Neon mein
 * pehle se encrypted tokens naye code se bhi decrypt honge.
 *
 * Token layout: 0x80 | timestamp(8, BE) | IV(16) | AES-128-CBC(PKCS7) | HMAC-SHA256(32)
 * Key: urlsafe-base64 of 32 bytes -> pehle 16 bytes signing, baaki 16 encryption.
 */
import crypto from "node:crypto";

export class InvalidToken extends Error {
  constructor(message = "Invalid token") {
    super(message);
    this.name = "InvalidToken";
  }
}

export class Fernet {
  private readonly signingKey: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(key: string | Buffer) {
    const keyStr = Buffer.isBuffer(key) ? key.toString("ascii") : key;
    const raw = Buffer.from(keyStr, "base64url");
    if (raw.length !== 32) {
      throw new Error("Fernet key must be 32 url-safe base64-encoded bytes.");
    }
    this.signingKey = raw.subarray(0, 16);
    this.encryptionKey = raw.subarray(16, 32);
  }

  encrypt(data: Buffer): Buffer {
    const iv = crypto.randomBytes(16);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));

    const cipher = crypto.createCipheriv("aes-128-cbc", this.encryptionKey, iv);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);

    const basic = Buffer.concat([Buffer.from([0x80]), ts, iv, ct]);
    const hmac = crypto.createHmac("sha256", this.signingKey).update(basic).digest();
    const token = Buffer.concat([basic, hmac]);
    // Python urlsafe_b64encode padding ("=") ke saath deta hai
    return Buffer.from(toPaddedBase64Url(token), "ascii");
  }

  decrypt(token: Buffer | string): Buffer {
    const tokenStr = Buffer.isBuffer(token) ? token.toString("ascii") : token;
    let data: Buffer;
    try {
      data = Buffer.from(tokenStr, "base64url");
    } catch {
      throw new InvalidToken();
    }
    // version(1) + ts(8) + iv(16) + min 1 block(16) + hmac(32)
    if (data.length < 1 + 8 + 16 + 16 + 32 || data[0] !== 0x80) throw new InvalidToken();

    const basic = data.subarray(0, data.length - 32);
    const sig = data.subarray(data.length - 32);
    const expected = crypto.createHmac("sha256", this.signingKey).update(basic).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
      throw new InvalidToken();
    }

    const iv = basic.subarray(9, 25);
    const ct = basic.subarray(25);
    try {
      const decipher = crypto.createDecipheriv("aes-128-cbc", this.encryptionKey, iv);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new InvalidToken();
    }
  }
}

function toPaddedBase64Url(buf: Buffer): string {
  let s = buf.toString("base64url");
  while (s.length % 4 !== 0) s += "=";
  return s;
}
