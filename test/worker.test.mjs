import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import worker from "../src/worker.mjs";

const fixtures = readdirSync("test/fixtures").map((name) => [name, JSON.parse(readFileSync(`test/fixtures/${name}`))]);
const run = fixtures.find(([name]) => name === "run-2.json")[1];

// Calls the handler like the runtime does; returns the response and what PostHog received.
async function post(body, { limited = false, headers = {}, path = "/v1/run", method = "POST" } = {}) {
  const sent = [];
  const pending = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response("{}"));
  try {
    const request = new Request(`https://telemetry.bddkit.dev${path}`, {
      method,
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      headers: { "CF-IPCountry": "LV", "CF-Connecting-IP": "203.0.113.9", ...headers },
    });
    const env = { POSTHOG_TOKEN: "phc_secret", LIMITER: { limit: async () => ({ success: !limited }) } };
    const response = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return { response, sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("every payload the binary really writes passes unchanged", async () => {
  for (const [name, payload] of fixtures) {
    const { response, sent } = await post(payload);
    assert.equal(response.status, 204, name);
    const { country, $process_person_profile, $geoip_disable, ...properties } = sent[0].body.properties;
    assert.deepEqual(properties, payload, name);
  }
});

test("an unknown key reaches PostHog without it, at any depth", async () => {
  const { response, sent } = await post({
    ...run,
    extra: 1,
    features: { ...run.features, secret: "x" },
    usage: { api: { steps: 1, ms: 2, note: "x" } },
  });
  assert.equal(response.status, 204);
  const properties = sent[0].body.properties;
  assert.equal(properties.extra, undefined);
  assert.equal(properties.features.secret, undefined);
  assert.deepEqual(properties.usage, { api: { steps: 1, ms: 2 } });
});

test("a body over 8 KiB is rejected, the boundary is exact", async () => {
  const pad = (size) => JSON.stringify({ ...run, extra: "" }).length < size
    ? JSON.stringify({ ...run, extra: "x".repeat(size - JSON.stringify({ ...run, extra: "" }).length) })
    : null;
  const small = pad(8191), big = pad(8192);
  assert.equal(new TextEncoder().encode(small).length, 8191);
  assert.equal((await post(small)).response.status, 204);
  const rejected = await post(big);
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.sent.length, 0);
});

test("an unknown schema version, or one that is not a number, is rejected", async () => {
  for (const schema of [3, 0, "1", null, "constructor"]) {
    const { response, sent } = await post({ ...run, schema });
    assert.equal(response.status, 400, String(schema));
    assert.equal(sent.length, 0);
  }
});

test("failures belong to schema 2: a schema 1 body loses them, a wrong type is rejected", async () => {
  const v3 = fixtures.find(([name]) => name === "run-3.json")[1];
  assert.equal((await post({ ...v3, schema: 1 })).sent[0].body.properties.failures, undefined);
  assert.equal((await post({ ...v3, failures: { ...v3.failures, input: "1" } })).response.status, 400);
});

test("malformed bodies, wrong types and unknown enum values are rejected", async () => {
  const bad = ["not json", "[]", "null", JSON.stringify({ ...run, command: "rm" }), JSON.stringify({ ...run, files: "3" }),
    JSON.stringify({ ...run, resources: { ...run.resources, plugins: { "a b": 1 } } }), JSON.stringify({ schema: 1 })];
  for (const body of bad) assert.equal((await post(body)).response.status, 400, body);
});

test("PostHog gets a fresh id, no profile, the country, the token and no client address", async () => {
  const injected = { ...run, $ip: "1.2.3.4", $set: { a: 1 }, distinct_id: "mine", $geoip_disable: false };
  const first = await post(injected, { headers: { "x-forwarded-for": "1.2.3.4" } });
  const second = await post(run);
  const event = first.sent[0];
  assert.equal(event.url, "https://eu.i.posthog.com/i/v0/e/");
  assert.equal(event.body.api_key, "phc_secret");
  assert.equal(event.body.event, "bddkit run");
  assert.notEqual(event.body.distinct_id, "mine");
  assert.notEqual(event.body.distinct_id, second.sent[0].body.distinct_id);
  const p = event.body.properties;
  assert.equal(p.country, "LV");
  assert.equal(p.$process_person_profile, false);
  assert.equal(p.$geoip_disable, true);
  assert.equal(p.$ip, undefined);
  assert.equal(p.$set, undefined);
  assert.ok(!JSON.stringify(event.body).includes("203.0.113.9") && !JSON.stringify(event.body).includes("1.2.3.4"));
});

test("over the rate limit it still answers 204 and forwards nothing", async () => {
  const { response, sent } = await post(run, { limited: true });
  assert.equal(response.status, 204);
  assert.equal(sent.length, 0);
});

test("only POST /v1/run exists", async () => {
  assert.equal((await post(run, { path: "/" })).response.status, 404);
  assert.equal((await post(run, { method: "GET" })).response.status, 405);
});

test("a failing PostHog does not change the answer", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("down"); };
  try {
    const pending = [];
    const response = await worker.fetch(
      new Request("https://t/v1/run", { method: "POST", body: JSON.stringify(run) }),
      { LIMITER: { limit: async () => ({ success: true }) } },
      { waitUntil: (p) => pending.push(p) },
    );
    await Promise.all(pending);
    assert.equal(response.status, 204);
  } finally {
    globalThis.fetch = realFetch;
  }
});
