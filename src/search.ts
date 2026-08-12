import { lookup } from "node:dns/promises";

export type SearchItem = { title: string; url: string; snippet?: string; when?: string; by?: string; engagement?: Record<string, unknown> };
export type SourceResult = { source: string; items?: SearchItem[]; error?: string };
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type LookupLike = (hostname: string, options: { all: true }) => Promise<Array<{ address: string }>>;

const userAgent = "Azure-Search/1.0 (+https://localhost)";
const sourceNames = ["hackernews", "github", "polymarket", "reddit", "web"] as const;
const sourceSet = new Set<string>(sourceNames);

function withTimeout(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  parent?.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

async function getJson<T>(url: string, signal: AbortSignal, fetchFn: FetchLike): Promise<T> {
  const response = await fetchFn(url, { headers: { accept: "application/json", "user-agent": userAgent }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await readTextLimit(response, 2_000_000)) as T;
}

function limitItems(items: SearchItem[], count: number): SearchItem[] { return items.slice(0, count); }

async function searchSource(source: string, query: string, count: number, signal: AbortSignal, fetchFn: FetchLike): Promise<SourceResult> {
  try {
    if (source === "hackernews") {
      const data = await getJson<{ hits: any[] }>(`https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${count * 2}&query=${encodeURIComponent(query)}`, signal, fetchFn);
      return { source, items: limitItems(data.hits.map((hit) => ({ title: hit.title || hit.story_title || "Untitled", url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`, when: hit.created_at, by: hit.author, engagement: { points: hit.points, comments: hit.num_comments } })), count) };
    }
    if (source === "github") {
      const data = await getJson<{ items: any[] }>(`https://api.github.com/search/repositories?sort=stars&order=desc&per_page=${count}&q=${encodeURIComponent(query)}`, signal, fetchFn);
      return { source, items: data.items.map((repo) => ({ title: repo.full_name, url: repo.html_url, snippet: repo.description || undefined, when: repo.updated_at, by: repo.owner?.login, engagement: { stars: repo.stargazers_count, forks: repo.forks_count, issues: repo.open_issues_count } })) };
    }
    if (source === "polymarket") {
      const data = await getJson<any[]>(`https://gamma-api.polymarket.com/events?search=${encodeURIComponent(query)}&limit=${count * 2}&closed=false&order=volume&ascending=false`, signal, fetchFn);
      return { source, items: limitItems(data.map((event) => ({ title: event.title, url: event.slug ? `https://polymarket.com/event/${event.slug}` : "https://polymarket.com", snippet: String(event.description || "").slice(0, 200), when: event.endDate || event.startDate, engagement: { volume: event.volume, liquidity: event.liquidity } })), count) };
    }
    if (source === "reddit") {
      const data = await getJson<any>(`https://www.reddit.com/search.json?sort=top&t=all&limit=${count}&q=${encodeURIComponent(query)}`, signal, fetchFn);
      return { source, items: data.data.children.map((child: any) => { const post = child.data; return { title: post.title, url: `https://www.reddit.com${post.permalink}`, snippet: `r/${post.subreddit} - ${String(post.selftext || "").slice(0, 160)}`, when: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : undefined, by: post.author, engagement: { upvotes: post.ups, comments: post.num_comments, ratio: post.upvote_ratio } }; }) };
    }
    const response = await fetchFn(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { accept: "text/html", "user-agent": userAgent }, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await readTextLimit(response, 2_000_000);
    const items: SearchItem[] = [];
    const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
    for (const match of html.matchAll(pattern)) {
      let url = match[1];
      try { url = new URL(url).searchParams.get("uddg") || url; } catch { /* keep original */ }
      items.push({ title: match[2].replace(/<[^>]+>/g, "").trim(), url });
      if (items.length === count) break;
    }
    return { source, items };
  } catch (error) {
    return { source, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSearch(query: string, count = 6, requested: string[] = [], options: { fetch?: FetchLike; signal?: AbortSignal } = {}): Promise<{ query: string; sources: string[]; results: Record<string, SourceResult> }> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("query is required");
  const limit = Math.max(1, Math.min(10, Math.trunc(count)));
  const wanted = (requested.length ? requested : [...sourceNames]).filter((source, index, all) => sourceSet.has(source) && all.indexOf(source) === index);
  const fetchFn = options.fetch || fetch;
  const values = await Promise.all(wanted.map((source) => searchSource(source, normalizedQuery, limit, withTimeout(options.signal, 15000), fetchFn)));
  return { query: normalizedQuery, sources: wanted, results: Object.fromEntries(values.map((value) => [value.source, value])) };
}

function privateIPv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const value = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
  const inRange = (start: number, end: number) => value >= start && value <= end;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 || inRange(0x64400000, 0x647fffff) || inRange(0xa9fe0000, 0xa9feffff) || inRange(0xc0000000, 0xc00000ff) || inRange(0xc0000200, 0xc00002ff) || inRange(0xc0000263, 0xc0000263) || inRange(0xc0001200, 0xc00012ff) || inRange(0xc6120000, 0xc613ffff) || inRange(0xcb007100, 0xcb0071ff) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

function privateIPv6(host: string): boolean {
  let lower = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower.includes(".")) {
    const split = lower.lastIndexOf(":");
    const v4 = lower.slice(split + 1);
    const octets = v4.split(".").map(Number);
    if (split < 0 || octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    lower = `${lower.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = lower.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const expanded = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : [...left];
  if (expanded.length !== 8 || expanded.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return false;
  const groups = expanded.map((part) => parseInt(part, 16));
  if (groups.slice(0, 5).every((value) => value === 0) && groups[5] === 0xffff) return privateIPv4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  const first = groups[0];
  return groups.every((value) => value === 0) || (groups[7] === 1 && groups.slice(0, 7).every((value) => value === 0)) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || (first === 0x2001 && (groups[1] === 0xdb8 || (groups[1] & 0xfff0) === 0x10));
}

function blockedAddress(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".local") || privateIPv4(normalized) || privateIPv6(normalized);
}

export async function assertPublicURL(target: string, lookupFn: LookupLike = lookup): Promise<URL> {
  let url: URL;
  try { url = new URL(target); } catch { throw new Error("url must be valid HTTP(S)"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("url must be a public HTTP(S) URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (blockedAddress(host)) throw new Error("private or local destinations are blocked");
  const addresses = await lookupFn(host, { all: true });
  if (addresses.some(({ address }) => blockedAddress(address))) throw new Error("private or local destinations are blocked");
  return url;
}

async function readTextLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) throw new Error("response exceeds the size limit");
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

export async function fetchWebPage(target: string, options: { maxChars?: number; fetch?: FetchLike; signal?: AbortSignal; lookup?: LookupLike } = {}): Promise<{ url: string; text: string }> {
  const url = await assertPublicURL(target, options.lookup);
  const response = await (options.fetch || fetch)(url, { headers: { accept: "text/html,text/plain,application/json", "user-agent": userAgent }, signal: withTimeout(options.signal, 20000), redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error("redirects are blocked; fetch the final public URL");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") || "";
  if (!/(text\/|application\/json)/i.test(type)) throw new Error("unsupported content type");
  const maxChars = Math.max(1, Math.min(options.maxChars || 50000, 100000));
  const body = await readTextLimit(response, maxChars * 4 + 4);
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { url: url.toString(), text: text.slice(0, maxChars) };
}
