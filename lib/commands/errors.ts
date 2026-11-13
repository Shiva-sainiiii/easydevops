/** Python RuntimeError ka jodi — chat route ise alag pakadta hai ("❌ AI Error: ..."). */
export class AIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIError";
  }
}
