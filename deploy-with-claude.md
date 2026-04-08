# Deploy with Claude + Cloudflare MCP

> Any Claude instance with the **Cloudflare Developer Platform MCP** connected can deploy this Worker from scratch — no local machine, no Wrangler CLI, no terminal required.

This runbook documents every API call needed. Claude executes them directly via the CF MCP and `bash_tool`.

---

## Prerequisites

Connect the following MCP servers to your Claude session:

| MCP | Purpose |
|---|---|
| Cloudflare Developer Platform | Worker deploy, KV namespace create, route management |
| GitHub (optional) | Read `worker.js` directly from this repo |

You also need:
- A Cloudflare account ID
- A CF API token with **all four** of the following permissions:

  | Permission | Scope | Needed for |
  |---|---|---|
  | Workers Scripts | Account | Deploy / update Worker code |
  | Workers KV Storage | Account | Create KV namespace |
  | Workers Routes | Zone (All zones) | Add subdomain route to Worker |
  | DNS | Zone (All zones) | Add A record for subdomain |

  > **Important:** Workers Scripts and Workers KV Storage are **Account-level** permissions.
  > Workers Routes and DNS are **Zone-level** permissions — set them to "All zones" or select your specific zone.
  > Missing any one of these will cause a partial failure mid-deploy.
  >
  > Use the "Edit Cloudflare Workers" template at `dash.cloudflare.com/profile/api-tokens` as a starting point, then add DNS: Edit manually.

- Your upstream MCP server PAT/token (e.g. GitHub PAT with `repo` scope)
- A chosen AUTH_PIN (see [Generating an AUTH_PIN](README.md#generating-an-auth_pin))
- A domain on Cloudflare DNS for the Worker route

---

## Step 1 — Get your Cloudflare Account ID

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import json,sys; [print(a['id'], a['name']) for a in json.load(sys.stdin)['result']]"
```

---

## Step 2 — Create the KV namespace

```bash
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/storage/kv/namespaces" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "github-mcp-oauth"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('KV ID:', d['result']['id'])"
```

Save the KV ID — you need it in Step 3.

---

## Step 3 — Deploy the Worker

Fetch `worker.js` from this repo and deploy it with all three bindings in one API call:

```python
import urllib.request, json, base64

CF_TOKEN     = "your-cf-token"
ACCOUNT_ID   = "your-account-id"
KV_ID        = "kv-namespace-id-from-step-2"
UPSTREAM_PAT = "ghp_your-github-pat"
AUTH_PIN     = "YOUR8PIN"

# Fetch worker.js from GitHub
req = urllib.request.Request(
    "https://api.github.com/repos/LIFEAI/cf-oauth-mcp-proxy/contents/worker.js",
    headers={"Accept": "application/vnd.github.v3.raw"}
)
with urllib.request.urlopen(req) as r:
    worker_code = r.read()

metadata = json.dumps({
    "main_module": "worker.js",
    "bindings": [
        {"type": "kv_namespace",  "name": "OAUTH_KV",        "namespace_id": KV_ID},
        {"type": "secret_text",   "name": "UPSTREAM_TOKEN",  "text": UPSTREAM_PAT},
        {"type": "secret_text",   "name": "AUTH_PIN",        "text": AUTH_PIN},
        {"type": "plain_text",    "name": "BASE_URL",        "text": "https://YOUR_WORKER_DOMAIN"},
        {"type": "plain_text",    "name": "UPSTREAM_MCP",    "text": "https://api.githubcopilot.com/mcp"},
    ]
}).encode()

boundary = b"----MCPProxyBoundary"
body = (
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="metadata"\r\n'
    b"Content-Type: application/json\r\n\r\n" +
    metadata + b"\r\n"
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
    b"Content-Type: application/javascript+module\r\n\r\n" +
    worker_code + b"\r\n"
    b"--" + boundary + b"--\r\n"
)

req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/cf-oauth-mcp-proxy",
    data=body,
    method="PUT",
    headers={
        "Authorization": f"Bearer {CF_TOKEN}",
        "Content-Type": f"multipart/form-data; boundary={boundary.decode()}",
    }
)
with urllib.request.urlopen(req) as r:
    d = json.load(r)
    print("Deployed:", d.get("success"))
    print("Errors:",   d.get("errors", []))
```

---

## Step 4 — Add DNS A record

```bash
CF_TOKEN=your-cf-token
ZONE_ID=your-zone-id   # find at dash.cloudflare.com → your domain → Overview

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":    "A",
    "name":    "YOUR_SUBDOMAIN",
    "content": "192.0.2.1",
    "proxied": true,
    "ttl":     1
  }' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('DNS:', d.get('success'), d.get('result',{}).get('name',''))"
```

> The IP `192.0.2.1` is a placeholder — Cloudflare proxied DNS for Workers doesn't route to the IP, it routes to the Worker via the route in Step 5.

---

## Step 5 — Add Worker route

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pattern":"YOUR_SUBDOMAIN.YOUR_DOMAIN/*","script":"cf-oauth-mcp-proxy"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('Route:', d.get('success'), d.get('result',{}).get('id',''))"
```

---

## Step 6 — Verify

```bash
# OAuth discovery
curl -s "https://YOUR_WORKER_DOMAIN/.well-known/oauth-authorization-server" | python3 -m json.tool

# MCP proxy (expect 401 Unauthorized — correct, no token yet)
curl -s -o /dev/null -w "HTTP %{http_code}" -X POST "https://YOUR_WORKER_DOMAIN/mcp"
```

Both should return valid responses. If `/.well-known/` returns a 522/526, wait 30 seconds for DNS + SSL to propagate.

---

## Step 7 — Connect in claude.ai

1. Settings → Connectors → Add custom connector
2. URL: `https://YOUR_WORKER_DOMAIN/mcp`
3. Click **Connect** → browser opens PIN consent page
4. Enter your **AUTH_PIN** → **Authorize Access** → done ✅

---

## Updating the Worker (redeploy)

Repeat Step 3 with the latest `worker.js` from the repo. Bindings are preserved if you include them in the metadata. Existing KV tokens remain valid — no re-authorization needed.

To rotate the PAT or PIN, repeat Step 3 with the new secret values. KV tokens are unaffected.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `526` on all requests | SSL cert not issued yet | Wait 30–60s, CF Traefik needs time |
| `401` on `/mcp` | No Bearer token | Expected — complete OAuth flow in claude.ai |
| `invalid_grant` on `/token` | Code expired or PKCE mismatch | Re-trigger OAuth flow |
| PIN page returns 401 | Wrong PIN | Check `AUTH_PIN` secret, redeploy if rotated |
| `Authentication error` on deploy | CF token missing permissions | Add `Workers Scripts: Edit` + `Workers KV Storage: Edit` |

---

*Repo: [LIFEAI/cf-oauth-mcp-proxy](https://github.com/LIFEAI/cf-oauth-mcp-proxy)*
