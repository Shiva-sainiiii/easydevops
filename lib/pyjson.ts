/**
 * Python-compatible helpers (sirf wahan use hote hain jahan exact string
 * output matter karta hai, jaise confirmation token ka JSON).
 *
 * pyJsonDumps  == json.dumps(obj, sort_keys=True)   (separators ", " / ": ", ensure_ascii=True)
 * pyStr        == f"{x}" ke liye (None -> "None", True -> "True")
 * pyRepr       == repr(x) (dict/list/str/None/bool)
 */
function escapeStr(s: string): string {
  return JSON.stringify(s).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

export function pyJsonDumps(value: any, sortKeys = true): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return escapeStr(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => pyJsonDumps(v, sortKeys)).join(", ") + "]";
  }
  if (typeof value === "object") {
    let keys = Object.keys(value);
    if (sortKeys) keys = keys.sort();
    return "{" + keys.map((k) => `${escapeStr(k)}: ${pyJsonDumps(value[k], sortKeys)}`).join(", ") + "}";
  }
  return "null";
}

export function pyStr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

export function pyRepr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    return q + v.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n") + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  }
  return String(v);
}
