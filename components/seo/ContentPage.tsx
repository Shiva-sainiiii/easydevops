import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import JsonLd from "@/components/seo/JsonLd";
import SeoShell from "@/components/seo/SeoShell";
import { AUTHOR, OG_IMAGE, SITE_NAME, abs } from "@/lib/seo";
import { PAGES, type PageDef, type Section } from "@/lib/seo-content";

/** [text](/path) -> link, `code` -> <code>. Baaki plain text (React escape karta hai). */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[3] !== undefined) {
      out.push(<code key={i++}>{m[3]}</code>);
    } else if (m[2].startsWith("/")) {
      out.push(
        <Link key={i++} href={m[2]}>
          {m[1]}
        </Link>
      );
    } else {
      out.push(
        <a key={i++} href={m[2]} rel="noopener">
          {m[1]}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function pageMetadata(page: PageDef): Metadata {
  const url = abs(page.path);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: {
      type: page.kind === "article" ? "article" : "website",
      siteName: SITE_NAME,
      title: page.title,
      description: page.description,
      url,
      images: [OG_IMAGE],
    },
    twitter: { card: "summary_large_image", title: page.title, description: page.description, images: [OG_IMAGE.url] },
  };
}

function SectionView({ s }: { s: Section }) {
  return (
    <section id={s.id}>
      <h2>{s.h2}</h2>
      {s.p?.map((t, i) => (
        <p key={i}>{renderInline(t)}</p>
      ))}
      {s.ul && (
        <ul>
          {s.ul.map((t, i) => (
            <li key={i}>{renderInline(t)}</li>
          ))}
        </ul>
      )}
      {s.ol && (
        <ol>
          {s.ol.map((t, i) => (
            <li key={i}>{renderInline(t)}</li>
          ))}
        </ol>
      )}
      {s.table && (
        <div className="seo-table-wrap">
          <table>
            <thead>
              <tr>
                {s.table.head.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{j > 0 && c !== "—" && c !== "" && s.table!.head.length === 3 ? <code>{c}</code> : c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.code && <pre>{s.code}</pre>}
    </section>
  );
}

export function buildSchema(page: PageDef) {
  const url = abs(page.path);
  const crumbs = [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: abs("/") },
    { "@type": "ListItem", position: 2, name: page.h1, item: url },
  ];
  const graph: Record<string, unknown>[] = [
    { "@type": "BreadcrumbList", itemListElement: crumbs },
  ];
  if (page.faq) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: page.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") },
      })),
    });
  }
  if (page.kind === "article") {
    graph.push({
      "@type": "Article",
      headline: page.h1,
      description: page.description,
      dateModified: page.updated,
      datePublished: page.updated,
      mainEntityOfPage: url,
      image: abs(OG_IMAGE.url),
      author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
      publisher: { "@type": "Organization", name: SITE_NAME, url: abs("/") },
    });
  }
  if (page.kind === "about") {
    graph.push({ "@type": "AboutPage", name: page.h1, url, mainEntity: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url } });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

export default function ContentPage({ page }: { page: PageDef }) {
  return (
    <SeoShell>
      <JsonLd data={buildSchema(page)} />
      <nav aria-label="Breadcrumb" className="seo-crumbs">
        <Link href="/">Easy DevOps</Link> <span aria-hidden="true">/</span> <span>{page.h1}</span>
      </nav>
      <article className="seo-article">
        <h1>{page.h1}</h1>
        <p className="seo-lead">{renderInline(page.lead)}</p>
        {page.sections.map((s) => (
          <SectionView key={s.id} s={s} />
        ))}
        {page.faq && (
          <section>
            {page.faq.map((f, i) => (
              <div key={i} className="seo-faq-item">
                <h3>{f.q}</h3>
                <p>{renderInline(f.a)}</p>
              </div>
            ))}
          </section>
        )}
        <aside className="seo-related" aria-label="Related">
          <h2>Related</h2>
          <ul>
            {page.related.map((k) => {
              const r = PAGES[k];
              return r ? (
                <li key={k}>
                  <Link href={r.path}>{r.h1}</Link>
                </li>
              ) : null;
            })}
          </ul>
        </aside>
        <p className="seo-updated">Last updated: {page.updated}</p>
      </article>
    </SeoShell>
  );
}
