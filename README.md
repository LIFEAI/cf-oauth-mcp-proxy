# cf-oauth-mcp-proxy

> **Cloudflare Worker** — OAuth 2.1 + DCR + PKCE edge proxy for any PAT-authenticated MCP server.

Connects OAuth-capable MCP clients (like **claude.ai**) to MCP servers that only support PAT/token auth (like the official GitHub MCP server). The upstream token lives as a Cloudflare Worker secret — never in source code, never in your conversation transcript.

---

## The Problem

**claude.ai** speaks OAuth 2.1. **GitHub's MCP server** speaks PAT. There is no bridge.

The official `api.githubcopilot.com/mcp` endpoint requires a registered GitHub OAuth App per host application — something only GitHub controls for their own integrations. Third-party clients including claude.ai are not registered.

## The Solution

A single Cloudflare Worker that:

1. **Speaks OAuth 2.1** to claude.ai (DCR, PKCE, auth codes, access tokens)
2. **Speaks PAT** to the upstream MCP server
3. **Stores nothing sensitive in code** — all secrets are CF Worker bindings
4. **Gates authorization behind a PIN** — only you can approve connections
5. **Runs at the edge** — zero infrastructure, zero maintenance, ~$0 cost

```
claude.ai  →  OAuth 2.1  →  [this Worker]  →  PAT  →  api.githubcopilot.com/mcp
                              (CF edge)
```

---

## OAuth Flow

```
1. claude.ai  →  GET /.well-known/oauth-authorization-server  →  Worker returns metadata
2. claude.ai  →  POST /register                               →  Worker issues client_id (DCR)
3. claude.ai  →  GET /authorize?code_challenge=...            →  Worker serves PIN consent page
4. You        →  Enter PIN in browser                         →  Worker issues auth code
5. claude.ai  →  POST /token  {code, code_verifier}           →  Worker issues access token (PKCE verified)
6. claude.ai  →  POST /mcp    Authorization: Bearer <token>   →  Worker validates token, injects PAT, proxies to GitHub
```

---

## Prerequisites

- [Cloudflare account](https://cloudflare.com) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- GitHub Personal Access Token with `repo` scope
- A domain on Cloudflare DNS (or use the free `*.workers.dev` subdomain)

---

## Setup

### 1. Clone

```bash
git clone https://github.com/LIFEAI/cf-oauth-mcp-proxy.git
cd cf-oauth-mcp-proxy
```

### 2. Create KV namespace

```bash
wrangler kv namespace create github-mcp-oauth
# Copy the id from the output
```

### 3. Configure `wrangler.toml`

```toml
[vars]
BASE_URL     = "https://mcp-proxy.yourdomain.com"   # your Worker's public URL
UPSTREAM_MCP = "https://api.githubcopilot.com/mcp"  # or any other MCP endpoint

[[kv_namespaces]]
binding = "OAUTH_KV"
id      = "PASTE_KV_ID_HERE"
```

### 4. Set secrets

```bash
wrangler secret put UPSTREAM_TOKEN   # your GitHub PAT (ghp_...)
wrangler secret put AUTH_PIN         # a PIN you'll type in the browser to authorize
```

> **AUTH_PIN** — choose something you can type in a browser. Alphanumeric, 6–12 chars.
> Store it somewhere safe (password manager). Anyone with this PIN can authorize a client.

### 5. Deploy

```bash
wrangler deploy
```

### 6. Add DNS route (optional — skip for `*.workers.dev`)

In Cloudflare dashboard:
- DNS → add `A` record: `mcp-proxy` → `192.0.2.1` (proxied ✅)
- Workers → Routes → add `mcp-proxy.yourdomain.com/*` → `cf-oauth-mcp-proxy`

Or via CLI:
```bash
wrangler deploy --routes "mcp-proxy.yourdomain.com/*"
```

### 7. Connect in claude.ai

1. Settings → Connectors → Add custom connector
2. URL: `https://mcp-proxy.yourdomain.com/mcp`
3. Click **Connect** — your browser opens the consent page
4. Enter your **AUTH_PIN**
5. Click **Authorize Access** — redirected back to claude.ai ✅

---

## Configuration Reference

### `wrangler.toml` vars

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | ✅ | Public URL of this Worker (used in OAuth metadata) |
| `UPSTREAM_MCP` | ✅ | URL of the upstream MCP server to proxy to |

### Secrets (`wrangler secret put`)

| Secret | Required | Description |
|---|---|---|
| `UPSTREAM_TOKEN` | ✅ | PAT or Bearer token for the upstream MCP server |
| `AUTH_PIN` | ✅ | PIN to gate the consent page |

### KV binding

| Binding | Purpose |
|---|---|
| `OAUTH_KV` | Stores registered clients, auth codes (5min TTL), access tokens (30 day TTL) |

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 discovery |
| `POST` | `/register` | RFC 7591 Dynamic Client Registration |
| `GET` | `/authorize` | PIN consent page |
| `POST` | `/authorize` | PIN submit → auth code |
| `POST` | `/token` | Auth code → access token (PKCE verified) |
| `POST` | `/revoke` | Token revocation |
| `*` | `/mcp` (any path) | Authenticated MCP proxy |

---

## Security Model

| Layer | Mechanism |
|---|---|
| Upstream token | CF Worker secret binding — encrypted at rest, never in code |
| Client authorization | PIN-gated consent page — only PIN holder can authorize |
| Token transport | PKCE (S256) — auth code interception is useless without code_verifier |
| Token storage | KV — 30-day TTL, revocable |
| Proxy URL | Unauthenticated GET returns 401 — requires valid Bearer token |

**What this does NOT protect against:** someone who knows your Worker URL AND has a valid access token. To add IP allowlisting (Anthropic's IP ranges only), see [Cloudflare Firewall Rules](https://developers.cloudflare.com/firewall/).

---

## Adapting for Other MCP Servers

Change `UPSTREAM_MCP` in `wrangler.toml` to point at any MCP server that accepts a Bearer token. The Worker is fully generic — nothing GitHub-specific except the default value.

Examples:
```toml
# Linear
UPSTREAM_MCP = "https://mcp.linear.app/sse"

# Any self-hosted MCP
UPSTREAM_MCP = "https://my-mcp.internal.company.com/mcp"
```

---

## Deploying via Coolify (LIFEAI pattern)

If you prefer container deployment over Wrangler:

1. Build the Worker as a Docker container using [`supergateway`](https://github.com/supermachine-ai/supergateway)
2. Deploy to Coolify Infrastructure project
3. Set env vars in Coolify → not recommended — **use Wrangler + CF Workers for this pattern**

The whole point is zero infrastructure. Stay on CF Workers.

---

## License

MIT — use freely, adapt for any MCP server.

---

*Built by [LIFEAI / Regen Dev Corp](https://regendevcorp.com) — Life before Profits.*
