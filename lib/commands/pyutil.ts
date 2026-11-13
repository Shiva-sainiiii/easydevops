/**
 * Python-jaise chhote helpers (dict["k"] KeyError, dict.get(k, d), truthiness).
 * executor / code_generate / bulk_actions / env_transfer sab yahin se lete hain,
 * taaki executor ka `catch (KeyErr)` har jagah ke KeyError ko pakad sake.
 */

export class KeyErr extends Error {
  constructor(key: string) {
    super(`'${key}'`); // str(KeyError('repo')) == "'repo'"
    this.name = "KeyErr";
  }
}

/** params["key"] */
export function req(params: Record<string, any>, key: string): any {
  if (!Object.prototype.hasOwnProperty.call(params, key)) throw new KeyErr(key);
  return params[key];
}

/** obj["key"] on API data (Python-jaise errors) */
export function K(o: any, key: string): any {
  if (Array.isArray(o)) throw new Error("list indices must be integers or slices, not str");
  if (o === null || o === undefined) throw new Error("'NoneType' object is not subscriptable");
  if (typeof o !== "object" || !(key in o)) throw new KeyErr(key);
  return o[key];
}

/** obj.get(key, default) */
export function gd(o: any, key: string, def: any = null): any {
  return o !== null && o !== undefined && typeof o === "object" && key in o ? o[key] : def;
}

export const pyOr = (v: any, d: any) => (v ? v : d);

/** Python truthiness (empty list / dict bhi False). */
export function pyTruthy(v: any): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}
