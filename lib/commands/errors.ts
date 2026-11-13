/** Python RuntimeError ka jodi — chat route ise alag pakadta hai ("❌ AI Error: ..."). */
export class AIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIError";
  }
}

/** User ne abhi tak koi AI key / model set nahi kiya — chat route ise "ai_setup_required" bana deta hai. */
export class NoAIKeyError extends AIError {
  constructor(message = "🤖 AI use karne ke liye pehle AI Gateway me apni API key daalo (Google AI Studio ya OpenRouter) aur model chuno.") {
    super(message);
    this.name = "NoAIKeyError";
  }
}
