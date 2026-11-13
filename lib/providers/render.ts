/** Render API wrapper. */
import { request, type PyResponse, type RequestOptions } from "@/lib/http";

export function rdApi(
  method: string,
  endpoint: string,
  rdToken: string,
  opts: RequestOptions = {}
): Promise<PyResponse> {
  const url = `https://api.render.com/v1${endpoint}`;
  const headers = {
    Authorization: `Bearer ${rdToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  return request(method, url, { ...opts, headers, timeout: 20 });
}

/**
 * Saari services laata hai, Render ke cursor pagination se: list ka har item
 * `{"cursor": ..., "service": {...}}` hota hai aur *last* item ka cursor agle
 * page ke liye `?cursor=` mein jaata hai. max_total tak cap.
 *
 * Returns [items, r] — items original `{cursor, service}` wrapper shape mein.
 */
export async function rdListAllServices(
  rdToken: string,
  limit = 100,
  maxTotal = 300
): Promise<[any[], PyResponse | null]> {
  let endpoint: string | null = `/services?limit=${limit}`;
  const allItems: any[] = [];
  let r: PyResponse | null = null;
  while (endpoint) {
    r = await rdApi("GET", endpoint, rdToken);
    if (r.status_code !== 200) break;
    const page = r.json();
    allItems.push(...page);
    if (allItems.length >= maxTotal || page.length < limit) break;
    const lastCursor = page[page.length - 1].cursor;
    if (!lastCursor) break;
    endpoint = `/services?limit=${limit}&cursor=${lastCursor}`;
  }
  return [allItems.slice(0, maxTotal), r];
}
