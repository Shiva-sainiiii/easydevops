/**
 * itsdangerous.URLSafeTimedSerializer ka Node port (itsdangerous 2.x format).
 *
 * Format: <base64url(json)>.<base64url(timestamp)>.<base64url(hmac-sha1)>
 * Key derivation: "django-concat" -> sha1(salt + "signer" + secret)
 *
 * Isse purane Flask se bane `agent_session` cookies naye code mein bhi valid
 * rahenge (users ko dobara login nahi karna padega), aur ulta bhi.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";

export class BadSignature extends Error {
  constructor(message = "Bad signature") {
    super(message);
    this.name = "BadSignature";
  }
}
export class SignatureExpired extends BadSignature {
  constructor(message = "Signature expired") {
    super(message);
    this.name = "SignatureExpired";
  }
}

const SEP = ".";

function intToBytes(n: number): Buffer {
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n % 256);
    n = Math.floor(n / 256);
  }
  return Buffer.from(out);
}

function bytesToInt(b: Buffer): number {
  let n = 0;
  for (const byte of b) n = n * 256 + byte;
  return n;
}

// Python json.dumps(ensure_ascii=True, separators=(",", ":")) jaisa output
function compactJson(obj: unknown): Buffer {
  const s = JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
  return Buffer.from(s, "ascii");
}

export class URLSafeTimedSerializer {
  private readonly key: Buffer;

  constructor(secretKey: string, salt: string) {
    this.key = crypto
      .createHash("sha1")
      .update(Buffer.concat([Buffer.from(salt), Buffer.from("signer"), Buffer.from(secretKey)]))
      .digest();
  }

  private signature(value: Buffer): string {
    return crypto.createHmac("sha1", this.key).update(value).digest().toString("base64url");
  }

  dumps(obj: unknown): string {
    let json = compactJson(obj);
    let compressedFlag = false;
    const compressed = zlib.deflateSync(json);
    if (compressed.length < json.length - 1) {
      json = compressed;
      compressedFlag = true;
    }
    let payload = json.toString("base64url");
    if (compressedFlag) payload = "." + payload;

    const ts = intToBytes(Math.floor(Date.now() / 1000)).toString("base64url");
    const signedValue = `${payload}${SEP}${ts}`;
    return `${signedValue}${SEP}${this.signature(Buffer.from(signedValue))}`;
  }

  loads(token: string, maxAge?: number): any {
    if (!token || !token.includes(SEP)) throw new BadSignature(`No "${SEP}" found in value`);

    const lastSep = token.lastIndexOf(SEP);
    const signedValue = token.slice(0, lastSep);
    const sig = token.slice(lastSep + 1);

    const expected = Buffer.from(this.signature(Buffer.from(signedValue)));
    const got = Buffer.from(sig);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      throw new BadSignature("Signature does not match");
    }

    if (!signedValue.includes(SEP)) throw new BadSignature("timestamp missing");
    const tsSep = signedValue.lastIndexOf(SEP);
    let payload = signedValue.slice(0, tsSep);
    const tsStr = signedValue.slice(tsSep + 1);

    const tsInt = bytesToInt(Buffer.from(tsStr, "base64url"));
    if (maxAge !== undefined) {
      const age = Math.floor(Date.now() / 1000) - tsInt;
      if (age > maxAge) throw new SignatureExpired(`Signature age ${age} > ${maxAge} seconds`);
      if (age < 0) throw new SignatureExpired(`Signature age ${age} < 0 seconds`);
    }

    let decompress = false;
    if (payload.startsWith(".")) {
      payload = payload.slice(1);
      decompress = true;
    }
    try {
      let raw = Buffer.from(payload, "base64url");
      if (decompress) raw = zlib.inflateSync(raw);
      return JSON.parse(raw.toString("utf-8"));
    } catch {
      throw new BadSignature("Could not decode the payload");
    }
  }
}
