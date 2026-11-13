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

  if (!FLASK_SECRET_KEY) {
    throw new Error("FLASK_SECRET_KEY env var missing — required to sign session cookies.");
  }
  if (!FERNET_KEY) {
    throw new Error("FERNET_KEY env var missing — required to encrypt stored tokens.");
  }
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    throw new Error(
      "GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing — register a GitHub OAuth App and set these."
    );
  }
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL env var missing — set this to your Neon Postgres connection string.");
  }
  if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON env var missing — paste the full contents of your Firebase service-account JSON key."
    );
  }

  cached = {
    FLASK_SECRET_KEY,
    FERNET_KEY,
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    OPENROUTER_KEY,
    APP_BASE_URL,
    DATABASE_URL,
    FIREBASE_SERVICE_ACCOUNT_JSON,
    IS_PROD: process.env.FLASK_ENV !== "development",
  };
  return cached;
}

export const config: Config = {
  get FLASK_SECRET_KEY() { return load().FLASK_SECRET_KEY; },
  get FERNET_KEY() { return load().FERNET_KEY; },
  get GITHUB_CLIENT_ID() { return load().GITHUB_CLIENT_ID; },
  get GITHUB_CLIENT_SECRET() { return load().GITHUB_CLIENT_SECRET; },
  get OPENROUTER_KEY() { return load().OPENROUTER_KEY; },
  get APP_BASE_URL() { return load().APP_BASE_URL; },
  get DATABASE_URL() { return load().DATABASE_URL; },
  get FIREBASE_SERVICE_ACCOUNT_JSON() { return load().FIREBASE_SERVICE_ACCOUNT_JSON; },
  get IS_PROD() { return load().IS_PROD; },
};
