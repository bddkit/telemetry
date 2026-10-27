# bddkit-telemetry

The collector behind `https://telemetry.bddkit.dev`: a Cloudflare Worker that takes the payload `bddkit` sends (`POST /v1/run`), validates it and forwards it to PostHog Cloud EU. Specification: section 8 of bddkit/bddkit#116; the fields per schema version: `docs/telemetry.md` in bddkit.

- `src/schema.json` is the published schema: for each version the fields, their types and enum values. A new schema version is a new top-level entry.
- A body of 8 KiB or more, invalid JSON, an unknown `schema`, a missing common field, a wrong type or an unknown enum value is a 400. Unknown keys are dropped, at any depth.
- Every accepted payload gets a 204 at once; the rate limit (600 a minute per IP) and the forwarding run after it. Over the limit the payload is dropped, still with a 204.
- PostHog gets `bddkit <command>`, a random `distinct_id` per event, `$process_person_profile: false`, `$geoip_disable: true`, the payload's fields and `country` from `CF-IPCountry`. No header of the request is copied, so no client address is sent.
- `test/fixtures/` are payloads written by a real `bddkit` build (`BDDKIT_TELEMETRY_LOG`); a test requires each to pass unchanged, so a field added to bddkit and forgotten in the schema fails here.

## Deploy

1. `wrangler login`
2. `wrangler secret put POSTHOG_TOKEN`
3. `wrangler deploy` (the custom domain and the rate-limit binding are in `wrangler.toml`)
4. In the PostHog EU project: discard client IP data on, the GeoIP transformation off, a billing limit at the free tier.

`npm test` needs only Node 22.
