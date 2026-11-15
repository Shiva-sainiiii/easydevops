"use client";

import Script from "next/script";

/**
 * Purana script.js (classic script, global functions) markup render hone ke BAAD load karta hai.
 * Original page me ye <body> ke end pe tha aur DOMContentLoaded handlers parse ke baad chalte the;
 * yahan script late load hota hai, isliye onLoad me DOMContentLoaded khud dispatch karte hain.
 */
export default function ScriptLoader() {
  return (
    <Script
      src="/script.js"
      strategy="afterInteractive"
      onLoad={() => {
        const w = window as any;
        if (w.__easydevopsBooted) return;
        w.__easydevopsBooted = true;
        document.dispatchEvent(new Event("DOMContentLoaded"));
      }}
    />
  );
}
