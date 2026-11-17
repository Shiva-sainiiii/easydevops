# v2.4 — SEO (apply AFTER v2.3)

## Naya
- 7 public content pages (server-rendered, crawlable): /features, /how-it-works, /commands, /faq (18 Q&A + FAQPage schema),
  /guides/deploy-to-vercel-without-cli (Article schema), /about, /privacy
- lib/seo.ts, lib/seo-content.ts — saara content data ek jagah (pages, FAQ, nav)
- components/seo/{SeoShell,ContentPage,JsonLd}.tsx
- public/og-image.png (1200x630), public/llms.txt
- tests/seo.test.ts (title/description length, sitemap = pages, route files, internal links, FAQ, har command example parse hota hai)

## Badla
- app/layout.tsx: metadataBase, title template, 155-char description, sahi OG/Twitter (domain + image), summary_large_image,
  googleBot directives, maximumScale hata (zoom allowed), global canonical hata
- app/page.tsx: canonical + JSON-LD (WebSite, SoftwareApplication, Person)
- components/app-markup.ts: login gate + sidebar footer me Features/FAQ/Privacy links (v2.3 ka Usage Dashboard markup bhi isi file me hai)
- app/globals.css: .seo-* styles (v2.3 ke usage CSS bhi isi file me)
- public/sitemap.xml (8 URLs + lastmod), public/robots.txt

## Verify karne wali baatein
- Home schema me price "0" (free) maana hai.
- /privacy me jo likha hai wo code se match karta hai; legal review nahi hai.
- Deploy ke baad Search Console me sitemap submit + request indexing.
