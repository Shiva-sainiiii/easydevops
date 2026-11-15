/**
 * App-level configuration: env vars aur constants.
 *
 * Ye wahi env vars hain jo Flask version mein the (naam same rakhe gaye hain,
 * isliye Vercel pe kuch badalna nahi padega):
 * FLASK_SECRET_KEY, FERNET_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
 * OPENROUTER_KEY, APP_BASE_URL, DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_JSON.
 *
 * Flask mein validation import-time pe hoti thi. Next.js build ke waqt env
 * available na ho to build toot jaata, isliye yahan pehli baar access hone
 * pe validate hota hai (error messages wahi hain).
 */

export const OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

interface Config {
  FLASK_SECRET_KEY: string;
  FERNET_KEY: string;
  FERNET_KEYS_OLD: string[];
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OPENROUTER_KEY: string | undefined;
  APP_BASE_URL: string;
  DATABASE_URL: string;
  FIREBASE_SERVICE_ACCOUNT_JSON: string;
  IS_PROD: boolean;
}

let cached: Config | undefined;

function load(): Config {
  if (cached) return cached;

  const FLASK_SECRET_KEY = process.env.FLASK_SECRET_KEY;
  const FERNET_KEY = process.env.FERNET_KEY;
  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
  const OPENROUTER_KEY = process.env.OPENROUTER_KEY || undefined;
  const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";
  const DATABASE_URL = process.env.DATABASE_URL;
  const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  // Saari problems ek saath batao (pehle ek-ek karke error aata tha)
  const problems: string[] = [];
  if (!FLASK_SECRET_KEY) {
    problems.push("FLASK_SECRET_KEY env var missing — required to sign session cookies.");
  } else if (FLASK_SECRET_KEY.length < 32) {
    console.warn("[config] FLASK_SECRET_KEY chhota hai (<32 chars). `python -c \"import secrets;print(secrets.token_urlsafe(48))\"` se naya banao.");
  }
  if (!FERNET_KEY) {
    problems.push("FERNET_KEY env var missing — required to encrypt stored tokens.");
  } else if (Buffer.from(FERNET_KEY, "base64url").length !== 32) {
    problems.push("FERNET_KEY galat format — 32 bytes ka url-safe base64 key chahiye (Fernet.generate_key()).");
  }
  const FERNET_KEYS_OLD = (process.env.FERNET_KEYS_OLD || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of FERNET_KEYS_OLD) {
    if (Buffer.from(k, "base64url").length !== 32) {
      problems.push("FERNET_KEYS_OLD me ek key galat format ki hai (har key 32 bytes url-safe base64).");
      break;
    }
  }
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    problems.push("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing — register a GitHub OAuth App and set these.");
  }
  if (!DATABASE_URL) {
    problems.push("DATABASE_URL env var missing — set this to your Neon Postgres connection string.");
  } else if (!/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
    problems.push("DATABASE_URL postgres:// ya postgresql:// se shuru hona chahiye.");
  }
  if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
    problems.push("FIREBASE_SERVICE_ACCOUNT_JSON env var missing — paste the full contents of your Firebase service-account JSON key.");
  }
  try {
    new URL(APP_BASE_URL);
  } catch {
    problems.push("APP_BASE_URL valid URL nahi hai (jaise https://your-app.vercel.app).");
  }
  if (problems.length) {
    throw new Error("Config problems:\n- " + problems.join("\n- "));
  }
  if (process.env.FLASK_ENV !== "development" && /localhost|127\.0\.0\.1/.test(APP_BASE_URL)) {
    console.warn("[config] APP_BASE_URL localhost hai par app production mode me chal rahi hai — OAuth redirect toot sakta hai.");
  }

  cached = {
    FLASK_SECRET_KEY: FLASK_SECRET_KEY as string,
    FERNET_KEY: FERNET_KEY as string,
    FERNET_KEYS_OLD,
    GITHUB_CLIENT_ID: GITHUB_CLIENT_ID as string,
    GITHUB_CLIENT_SECRET: GITHUB_CLIENT_SECRET as string,
    OPENROUTER_KEY,
    APP_BASE_URL: APP_BASE_URL.replace(/\/+$/, ""),
    DATABASE_URL: DATABASE_URL as string,
    FIREBASE_SERVICE_ACCOUNT_JSON: FIREBASE_SERVICE_ACCOUNT_JSON as string,
    IS_PROD: process.env.FLASK_ENV !== "development",
  };
  return cached;
}

export const config: Config = {
  get FLASK_SECRET_KEY() { return load().FLASK_SECRET_KEY; },
  get FERNET_KEY() { return load().FERNET_KEY; },
  get FERNET_KEYS_OLD() { return load().FERNET_KEYS_OLD; },
  get GITHUB_CLIENT_ID() { return load().GITHUB_CLIENT_ID; },
  get GITHUB_CLIENT_SECRET() { return load().GITHUB_CLIENT_SECRET; },
  get OPENROUTER_KEY() { return load().OPENROUTER_KEY; },
  get APP_BASE_URL() { return load().APP_BASE_URL; },
  get DATABASE_URL() { return load().DATABASE_URL; },
  get FIREBASE_SERVICE_ACCOUNT_JSON() { return load().FIREBASE_SERVICE_ACCOUNT_JSON; },
  get IS_PROD() { return load().IS_PROD; },
};
