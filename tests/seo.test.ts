import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { FAQ, PAGES, PAGE_ORDER } from "../lib/seo-content";
import { parseIntentEx } from "../lib/commands/intent_parser";
import { SITE_URL } from "../lib/seo";

const root = path.join(__dirname, "..");

test("har page ka title/description SERP limits ke andar", () => {
  for (const k of PAGE_ORDER) {
    const p = PAGES[k];
    assert.ok(p.title.length <= 66, `${k} title ${p.title.length}`);
    assert.ok(p.description.length >= 80 && p.description.length <= 160, `${k} description ${p.description.length}`);
  }
});

test("sitemap.xml me home + saare pages hain (aur koi extra nahi)", () => {
  const xml = fs.readFileSync(path.join(root, "public/sitemap.xml"), "utf-8");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
  const want = [SITE_URL + "/", ...PAGE_ORDER.map((k) => SITE_URL + PAGES[k].path)].sort();
  assert.deepEqual(locs, want);
});

test("har page ka route file maujood hai", () => {
  for (const k of PAGE_ORDER) {
    assert.ok(fs.existsSync(path.join(root, "app", PAGES[k].path, "page.tsx")), k);
  }
});

test("content ke saare internal links valid pages par jaate hain", () => {
  const valid = new Set(["/", ...PAGE_ORDER.map((k) => PAGES[k].path)]);
  const texts: string[] = [];
  for (const k of PAGE_ORDER) {
    const p = PAGES[k];
    texts.push(p.lead);
    for (const s of p.sections) texts.push(...(s.p ?? []), ...(s.ul ?? []), ...(s.ol ?? []));
    for (const f of p.faq ?? []) texts.push(f.a);
    for (const r of p.related) assert.ok(PAGES[r], `related ${r} missing`);
  }
  for (const t of texts) for (const m of t.matchAll(/\]\((\/[^)]*)\)/g)) assert.ok(valid.has(m[1]), `broken link ${m[1]}`);
});

test("FAQ: unique sawaal, khaali jawab nahi", () => {
  assert.ok(FAQ.length >= 15);
  assert.equal(new Set(FAQ.map((f) => f.q)).size, FAQ.length);
  for (const f of FAQ) assert.ok(f.q.endsWith("?") && f.a.length > 60, f.q);
});

test("commands page ke har example ko parser sach me samajhta hai (copy-paste promise)", () => {
  for (const s of PAGES.commands.sections) {
    for (const row of s.table?.rows ?? []) {
      for (const cell of row.slice(1)) {
        if (cell === "—") continue;
        const m = parseIntentEx(cell);
        assert.ok(m, `parse nahi hua: ${cell}`);
        assert.notEqual(m!.cmd, "CODE_GENERATE", `galat command (AI codegen): ${cell}`);
      }
    }
  }
});

test("robots.txt sitemap batata hai aur SEO pages block nahi karta", () => {
  const r = fs.readFileSync(path.join(root, "public/robots.txt"), "utf-8");
  assert.ok(r.includes(`Sitemap: ${SITE_URL}/sitemap.xml`));
  const disallowed = [...r.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
  for (const k of PAGE_ORDER) for (const d of disallowed) assert.ok(!PAGES[k].path.startsWith(d), `${PAGES[k].path} blocked by ${d}`);
});
