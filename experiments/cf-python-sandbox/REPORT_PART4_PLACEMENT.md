# Part 4 — Log/placement investigation + why the numbers are fuzzy

You were right: the cold-start figures are **not** a clean "container cold start." I queried your account directly (containers API, `wrangler containers info`, live `wrangler tail` logs, and an in-container trace probe). Findings:

## 1. Container placement is capacity-driven to hubs — NOT near the request
Across 8 cold starts, the **Worker always ran at ORD** (Chicago — nearest colo to this test origin, GCP Iowa) but the **container landed at a rotating set of eastern-US hubs**, never co-located:

| cold # | worker colo | container colo | worker_wait |
|---|---|---|---|
| 1 | ORD | **MIA** (Miami) | 2271 ms |
| 2 | ORD | **ATL** (Atlanta) | 2373 ms |
| 3 | ORD | **IAD** (Ashburn) | 2956 ms |
| 4 | ORD | IAD | 2595 ms |
| 5 | ORD | ATL | 2246 ms |
| 6 | ORD | MIA | 2370 ms |
| 7 | ORD | IAD | 2543 ms |
| 8 | ORD | IAD | 2992 ms |

Cloudflare's docs say this outright: placement is "optimized for … startup speed, so a Container may start in a different location than its Durable Object … some container instances may be started in locations that are farther away from the end-user." At your (low) traffic, container capacity is concentrated at a few US hubs, so **every request pays a cross-region Worker→container hop**, and **which hub varies call-to-call** — that's why your numbers swing 2–4 s.

## 2. What the observed ~3 s actually decomposes into
`observed = client→worker + worker→container(far hub) + Firecracker VM boot + Python import + exec`
- **Network-free intrinsic cold** (Firecracker boot + eager numpy/matplotlib import): **~2 s** — measured via the container's self-reported age, independent of placement. *This alone exceeds your 2 s target.*
- **Worker→container network**: tens of ms within the US here; **100–300 ms for users far from CF's container hubs**.
- **Snippet exec** (pandas import + plot): ~0.4–0.6 s.
- **VM provisioning variance**: the swing between 2.2 s and 3.0 s above is mostly scheduling/boot at the chosen hub.

`runtime: "firecracker"` confirmed — these are Firecracker microVMs, which is why boot is ~1 s even before Python.

## 3. Billing / logs sanity checks
- **Not billing you:** the app's instance health is `active: 0` (scaled to zero). The "5 healthy" are idle slots, not running compute. (Still: `wrangler delete` when done.)
- **Logs confirm cold boots:** `wrangler tail` captured `onStart` → `"COLD: container booted"` on each fresh instance, with DO/container fetch wall times of 2.7–2.9 s. Worker `cf` telemetry shows request origin (GCP Iowa) → colo ORD, `clientTcpRtt ≈ 12 ms`.

## 4. My thoughts — is this measurable / will it work for real users?
- **You genuinely cannot predict per-user cold start on CF Containers**, because placement is capacity-driven and geographic, not user-proximate, and varies per request. Your test (and mine) is "US client → US hub"; a **Tokyo or Frankfurt user gets a nearby Worker but a US (or distant) container**, adding 150–300 ms to *every* request (cold *and* warm) on top of the ~2 s intrinsic boot.
- **<2 s cold is structurally impossible here**: the network-free floor (Firecracker + numpy/matplotlib import) is already ~2 s. No image optimization removes Cloudflare's VM boot or the placement hop.
- **Warm reuse (~0.4 s + hub hop)** is the only fast path, and it still carries the cross-region hop for distant users.
- **Verdict for avlo:** CF Containers fits only if you can (a) frame the first run as a one-time "warming up…" (~3 s, occasionally more), and (b) accept geographically-variable latency you don't control. If avlo needs snappy, predictable code execution worldwide, this is the wrong primitive.
- **What would actually get <2 s:** a platform that restores a **process snapshot with numpy/matplotlib already imported** (Firecracker snapshotting / Lambda SnapStart / CRaC-style) — skips both the import (~1 s) and most of the boot — **and** lets you pin regions. Modal and Fly Machines are the realistic candidates. Happy to benchmark one head-to-head with the same snippet so you have an apples-to-apples cold-start + cost comparison.

## How to reproduce the placement probe yourself
```
curl -s -X POST https://avlo-pyexec-raw.issakakar001.workers.dev/run \
  -H 'content-type: application/json' \
  -d '{"fresh":true,"code":"import urllib.request as u;print(u.urlopen(\"https://www.cloudflare.com/cdn-cgi/trace\").read().decode())"}'
```
The `colo=` line in the output is where Cloudflare placed *that* container.
