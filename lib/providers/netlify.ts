/** Netlify API wrapper + site lookup helper. */
import { request, type PyResponse, type RequestOptions } from "@/lib/http";

export function nlApi(
  method: string,
  endpoint: string,
  nlToken: string,
  opts: RequestOptions = {}
): Promise<PyResponse> {
  const url = `https://api.netlify.com/api/v1${endpoint}`;
  const headers = {
    Authorization: `Bearer ${nlToken}`,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  return request(method, url, { ...opts, headers, timeout: 20 });
}

const NL_LINK_NEXT_RE = /<([^>]+)>;\s*rel="next"/;

/**
 * Saari sites laata hai (page/per_page + Link-header pagination, GitHub jaisa).
 * max_total tak cap. Returns [sites, r].
 */
export async function nlListAllSites(
  nlToken: string,
  perPage = 100,
  maxTotal = 300
): Promise<[any[], PyResponse | null]> {
  let endpoint: string | null = `/sites?per_page=${perPage}`;
  const allSites: any[] = [];
  let r: PyResponse | null = null;
  while (endpoint) {
    r = await nlApi("GET", endpoint, nlToken);
    if (r.status_code !== 200) break;
    const page = r.json();
    allSites.push(...page);
    if (allSites.length >= maxTotal || page.length < perPage) break;
    const linkHeader = r.headers.get("Link", "") ?? "";
    const match = NL_LINK_NEXT_RE.exec(linkHeader);
    if (!match) break;
    const nextUrl = match[1];
    const marker = "api.netlify.com/api/v1";
    const idx = nextUrl.indexOf(marker);
    endpoint = idx === -1 ? nextUrl : nextUrl.slice(idx + marker.length);
  }
  return [allSites.slice(0, maxTotal), r];
}

/** Site name/ID se full site object laata hai, ya null. */
export async function netlifyFindSite(siteName: string, nlToken: string): Promise<any | null> {
  const r = await nlApi("GET", `/sites/${siteName}`, nlToken);
  if (r.status_code === 200) return r.json();
  return null;
}
