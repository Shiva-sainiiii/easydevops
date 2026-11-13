/**
 * Python `requests` jaisa chhota shim.
 *
 * Purane Flask code mein har jagah `r.status_code`, `r.json()`, `r.text`,
 * `r.content`, `r.headers.get(...)` use hota tha. Port ko line-by-line
 * rakhne ke liye yahan wahi shape di gayi hai, taaki commands/routes ka
 * logic bina badle move ho sake.
 *
 * Timeout semantics: requests ki tarah timeout sirf "response shuru hone
 * tak" lagta hai (headers aane tak). Body download pe total timeout nahi
 * lagta, taaki bade zip/file downloads beech mein na kat jaayein.
 */

export class RequestException extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class Timeout extends RequestException {}
export class ConnectionError extends RequestException {}

export class PyHeaders {
  constructor(private readonly h: Headers) {}
  get(name: string, def: string | null = null): string | null {
    const v = this.h.get(name);
    return v === null ? def : v;
  }
  has(name: string): boolean {
    return this.h.has(name);
  }
}

export class PyResponse {
  readonly status_code: number;
  readonly headers: PyHeaders;
  readonly content: Buffer;
  readonly url: string;

  constructor(status: number, headers: Headers, content: Buffer, url: string) {
    this.status_code = status;
    this.headers = new PyHeaders(headers);
    this.content = content;
    this.url = url;
  }

  get text(): string {
    return this.content.toString("utf-8");
  }

  get ok(): boolean {
    return this.status_code < 400;
  }

  // Sync, requests ki tarah. Invalid JSON pe throw karta hai.
  json(): any {
    return JSON.parse(this.text);
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  json?: unknown;
  data?: Record<string, string | number | boolean> | string | Buffer;
  params?: Record<string, string | number | boolean | null | undefined>;
  /** seconds, requests ki tarah */
  timeout?: number;
  allowRedirects?: boolean;
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  const n = name.toLowerCase();
  return Object.keys(h).some((k) => k.toLowerCase() === n);
}

export async function request(
  method: string,
  url: string,
  opts: RequestOptions = {}
): Promise<PyResponse> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };

  if (opts.params) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== null && v !== undefined) u.searchParams.append(k, String(v));
    }
    url = u.toString();
  }

  const m = method.toUpperCase();
  let body: string | Buffer | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
  } else if (opts.data !== undefined) {
    if (typeof opts.data === "string" || Buffer.isBuffer(opts.data)) {
      body = opts.data;
    } else {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.data)) sp.append(k, String(v));
      body = sp.toString();
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }
  }
  if (m === "GET" || m === "HEAD") body = undefined;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeout && opts.timeout > 0) {
    timer = setTimeout(() => controller.abort(), opts.timeout * 1000);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: m,
      headers,
      body: body as any,
      redirect: opts.allowRedirects === false ? "manual" : "follow",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new Timeout(`Request to ${url} timed out after ${opts.timeout}s`);
    }
    throw new ConnectionError(err?.message || String(err));
  }
  if (timer) clearTimeout(timer);

  const buf = Buffer.from(await res.arrayBuffer());
  return new PyResponse(res.status, res.headers, buf, res.url);
}

export const get = (url: string, opts?: RequestOptions) => request("GET", url, opts);
export const post = (url: string, opts?: RequestOptions) => request("POST", url, opts);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
