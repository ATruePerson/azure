import { expect, test } from "bun:test";
import { assertPublicURL, fetchWebPage, runSearch } from "../src/search.ts";

test("search keeps requested source order and returns partial failures", async () => {
  const fakeFetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("hn.algolia")) return new Response(JSON.stringify({ hits: [{ title: "Hello", url: "https://example.test" }] }), { headers: { "content-type": "application/json" } });
    return new Response("blocked", { status: 429 });
  };
  const result = await runSearch("hello", 2, ["hackernews", "github"], { fetch: fakeFetch });
  expect(result.sources).toEqual(["hackernews", "github"]);
  expect(result.results.hackernews.items?.[0].title).toBe("Hello");
  expect(result.results.github.error).toMatch(/HTTP 429/);
});

test("blocks private web fetch destinations before DNS or HTTP", async () => {
  await expect(assertPublicURL("http://127.0.0.1/admin")).rejects.toThrow(/private|local/);
  await expect(assertPublicURL("http://[::ffff:127.0.0.1]/admin")).rejects.toThrow(/private|local/);
  await expect(assertPublicURL("http://[::]/admin")).rejects.toThrow(/private|local/);
  await expect(assertPublicURL("file:///tmp/secret")).rejects.toThrow(/public HTTP/);
});

test("web fetch stops before buffering oversized responses", async () => {
  const fakeFetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(100))); controller.close(); } }), { headers: { "content-type": "text/plain" } });
  await expect(fetchWebPage("https://example.com", { maxChars: 10, fetch: fakeFetch, lookup: async () => [{ address: "93.184.216.34" }] })).rejects.toThrow(/size limit/);
});
