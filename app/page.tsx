import type { Metadata } from "next";

import ScriptLoader from "@/components/ScriptLoader";
import { APP_MARKUP } from "@/components/app-markup";
import JsonLd from "@/components/seo/JsonLd";
import { AUTHOR, OG_IMAGE, SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, abs } from "@/lib/seo";

export const metadata: Metadata = {
  alternates: { canonical: abs("/") },
};

// Home ke structured data: WebSite + SoftwareApplication + creator (FAQPage /faq pe hai, jahan FAQ visible hai)
const HOME_SCHEMA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": abs("/#website"),
      url: abs("/"),
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      inLanguage: "en",
      publisher: { "@id": abs("/#creator") },
    },
    {
      "@type": "SoftwareApplication",
      "@id": abs("/#app"),
      name: SITE_NAME,
      alternateName: SITE_TAGLINE,
      url: abs("/"),
      description: SITE_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web (any modern browser, works on mobile)",
      image: abs(OG_IMAGE.url),
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      featureList: [
        "Create GitHub repositories, files, branches and pull requests from chat",
        "Deploy to Vercel, Netlify and Render",
        "Manage environment variables and rollbacks",
        "Multi-step requests in one message",
        "English and Hinglish commands",
        "Rules-first parser; AI only for complex tasks",
      ],
      author: { "@id": abs("/#creator") },
    },
    { "@type": "Person", "@id": abs("/#creator"), name: AUTHOR.name, url: AUTHOR.url },
  ],
};

// `display: contents` wrapper layout me kuch add nahi karta — #ambient / #app waise hi <body> ke direct children jaise behave karte hain.
export default function Page() {
  return (
    <>
      <JsonLd data={HOME_SCHEMA} />
      <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: APP_MARKUP }} />
      <ScriptLoader />
    </>
  );
}
