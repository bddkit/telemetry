import schemas from "./schema.json" with { type: "json" };

const MAX_BODY = 8 * 1024;
const ENDPOINT = "https://eu.i.posthog.com/i/v0/e/";
// A name that comes from the binary's own vocabulary or an official plugin.
const NAME = /^[A-Za-z0-9_.+-]{1,64}$/;

class Invalid extends Error {}

// Returns the value cut down to the type, or throws Invalid. Unknown keys of
// an object are dropped; a wrong type, an unknown enum value or a key of a map
// that is not a plain name rejects the whole payload. null passes through:
// the payload has Option fields.
function filter(value, type) {
  if (value === null) return null;
  if (type === "int") return check(Number.isSafeInteger(value), value);
  if (type === "bool") return check(typeof value === "boolean", value);
  if (type === "str") return check(typeof value === "string" && value.length <= 64, value);
  if (type.enum) return check(type.enum.includes(value), value);
  if (type.list) {
    check(Array.isArray(value), value);
    return value.map((item) => filter(item, type.list));
  }
  check(typeof value === "object" && !Array.isArray(value), value);
  if (type.map) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [check(NAME.test(key), key), filter(item, type.map)]),
    );
  }
  const out = {};
  for (const [key, spec] of Object.entries(type.obj)) {
    if (Object.hasOwn(value, key)) out[key] = filter(value[key], spec);
  }
  return out;
}

function check(ok, value) {
  if (!ok) throw new Invalid();
  return value;
}

export function validate(body) {
  check(typeof body === "object" && body !== null && !Array.isArray(body), body);
  const schema = schemas[String(body.schema)];
  check(schema !== undefined && typeof body.schema === "number", body.schema);
  for (const key of schema.required) check(Object.hasOwn(body, key), key);
  return filter(body, { obj: schema.fields });
}

async function forward(env, request, payload) {
  const { success } = await env.LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "" });
  if (!success) return;
  const country = request.headers.get("CF-IPCountry");
  await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.POSTHOG_TOKEN,
      event: `bddkit ${payload.command}`,
      distinct_id: crypto.randomUUID(),
      properties: {
        ...payload,
        country: /^[A-Za-z0-9]{2}$/.test(country ?? "") ? country : null,
        $process_person_profile: false,
        $geoip_disable: true,
      },
    }),
  });
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/v1/run") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (Number(request.headers.get("content-length") ?? 0) >= MAX_BODY) return new Response(null, { status: 400 });
    const raw = await request.arrayBuffer();
    if (raw.byteLength >= MAX_BODY) return new Response(null, { status: 400 });
    let payload;
    try {
      payload = validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
    } catch {
      return new Response(null, { status: 400 });
    }
    // ponytail: a failed forward is dropped, telemetry is best-effort; add a retry or queue if loss matters
    ctx.waitUntil(forward(env, request, payload).catch(() => {}));
    return new Response(null, { status: 204 });
  },
};
