/**
 * Route handlers ke shared helpers (Flask request.args / request.form / Response jaise).
 */
import type { UserRow } from "@/lib/db";
import { decryptToken } from "@/lib/db";

/** request.args.get(name) or "" , strip */
export function qs(req: Request, name: string): string {
  return (new URL(req.url).searchParams.get(name) || "").trim();
}

/** User ka decrypt kiya hua GitHub token (null ho sakta hai). */
export function ghTokenOf(user: UserRow): string {
  return decryptToken(user.github_token_encrypted) as string;
}

/** (v or "").strip() */
export function sstr(v: any): string {
  return v ? String(v).trim() : "";
}

/** request.form — multipart na ho to khaali FormData. */
export async function readForm(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

export function formStr(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

/** request.files.get(name) — File ya null. */
export function formFile(form: FormData, name: string): File | null {
  const v = form.get(name);
  return v && typeof v !== "string" ? (v as File) : null;
}

/** HTTP header values latin-1 hi ho sakti hain (em-dash jaise chars fetch/Response me crash karte). */
export function headerSafe(v: string): string {
  return v.replace(/—/g, "-").replace(/[^\x00-\xff]/g, "?");
}

/** Python mimetypes.guess_type ka chhota table (baaki -> application/octet-stream). */
const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  json: "application/json", txt: "text/plain", md: "text/markdown", csv: "text/csv", xml: "text/xml",
  py: "text/x-python", c: "text/plain", h: "text/plain", sh: "application/x-sh",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  ico: "image/vnd.microsoft.icon", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  mp3: "audio/mpeg", wav: "audio/x-wav", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  wasm: "application/wasm",
};

export function guessMime(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i <= 0) return "application/octet-stream";
  return MIME[filename.slice(i + 1).toLowerCase()] ?? "application/octet-stream";
}

/** Attachment-style binary/text Response (Content-Disposition + Content-Length). */
export function attachment(body: Buffer | string, filename: string, contentType: string, extra: Record<string, string> = {}) {
  const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="${headerSafe(filename)}"`,
      "Content-Type": contentType,
      "Content-Length": String(buf.length),
      ...extra,
    },
  });
}
