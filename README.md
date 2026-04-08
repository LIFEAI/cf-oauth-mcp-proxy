# cf-oauth-mcp-proxy

[![GitHub Sponsors](https://img.shields.io/github/sponsors/daveladouceur?label=Sponsor%20This%20Work&logo=GitHub&color=c8a84b&style=for-the-badge)](https://github.com/sponsors/daveladouceur)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white&style=flat-square)](https://workers.cloudflare.com)
[![MCP](https://img.shields.io/badge/MCP-OAuth%202.1-blueviolet?style=flat-square)](https://modelcontextprotocol.io)

> **Cloudflare Worker** — OAuth 2.1 + DCR + PKCE edge proxy for any PAT-authenticated MCP server.  
> Connects **claude.ai** (and any OAuth MCP client) to MCP servers that only support PAT/token auth — like the official GitHub MCP server.

---

## 💛 Support This Work

**This tool is free, open source, and took real time to build.**

If it saves you hours of debugging OAuth flows, Dockerfiles, and Cloudflare configs — please consider sponsoring. Every contribution directly funds continued open source tooling for the regenerative AI ecosystem.

### → [github.com/sponsors/daveladouceur](https://github.com/sponsors/daveladouceur)

> *"Life before Profits."*  
> — Dave Ladouceur / [LIFEAI](https://lifeai.dev) / [Regen Dev Corp](https://YOUR_DOMAIN)

---

## The Problem

**claude.ai** speaks OAuth 2.1. **GitHub's MCP server** speaks PAT. There is no official bridge.

`api.githubcopilot.com/mcp` requires a registered GitHub OAuth App per host — something only GitHub controls. Third-party clients including claude.ai are not registered, and the workaround in their own docs is "use Docker locally" — which defeats the purpose of a cloud AI assistant.

## The Solution

A single Cloudflare Worker (~200 lines) that:

1. **Speaks OAuth 2.1** to claude.ai — full DCR, PKCE, auth codes, access tokens
2. **Speaks PAT** to the upstream MCP server
3. **Stores nothing sensitive in code** — all secrets are CF Worker bindings
4. **Gates authorization with a PIN** — only you can approve new connections
5. **Runs at the CF edge** — zero infrastructure, zero maintenance, ~$0/month

```
claude.ai  ──OAuth 2.1──▶  [this Worker]  ──PAT──▶  api.githubcopilot.com/mcp
                            (Cloudflare edge)
```

---

## OAuth Flow

```
1. claude.ai  →  GET /.well-known/oauth-authorization-server  →  discovers OAuth metadata
2. claude.ai  →  POST /register                               →  gets client_id (DCR, RFC 7591)
3. claude.ai  →  GET /authorize?code_challenge=...            →  Worker serves PIN consent page
4. You        →  enter PIN in browser                         →  Worker issues auth code
5. claude.ai  →  POST /token {code, code_verifier}            →  Worker issues access token (PKCE)
6. claude.ai  →  POST /mcp  Authorization: Bearer <token>     →  Worker validates, injects PAT, proxies
```

---

## Prerequisites

- [Cloudflare account](https://cloudflare.com) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- GitHub PAT with `repo` scope (or any upstream Bearer token)
- A domain on Cloudflare DNS — or use the free `*.workers.dev` subdomain

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
# Copy the id from output
```

### 3. Configure `wrangler.toml`

```toml
[vars]
BASE_URL     = "https://YOUR_WORKER_DOMAIN"   # your Worker's public URL
UPSTREAM_MCP = "https://api.githubcopilot.com/mcp"  # target MCP endpoint

[[kv_namespaces]]
binding = "OAUTH_KV"
id      = "PASTE_YOUR_KV_ID_HERE"
```

### 4. Set secrets

```bash
wrangler secret put UPSTREAM_TOKEN   # your GitHub PAT (ghp_...)
wrangler secret put AUTH_PIN         # PIN you'll type in browser to authorize
```

> **AUTH_PIN** — alphanumeric, 6–12 chars, store in your password manager.
> Anyone with this PIN can authorize a new client connection.

### 5. Deploy

```bash
wrangler deploy
```

### 6. (Optional) Add custom domain via Cloudflare DNS

In Cloudflare dashboard: DNS → add proxied `A` record → Workers → Routes → add `YOUR_WORKER_DOMAIN/*` → `cf-oauth-mcp-proxy`

### 7. Connect your clients

> **Important:** Each MCP client (claude.ai, Claude Code, etc.) runs its own independent
> OAuth flow and gets its own KV access token. They never interfere with each other.
> You will enter your PIN once per client. **Connect claude.ai first** — it is the
> fastest sanity check that your Worker, KV, PIN, and redirect are all working correctly.

#### Step 7a — claude.ai (do this first)

1. **Settings → Connectors → Add custom connector**
2. URL: `https://YOUR_WORKER_DOMAIN/mcp`
3. Click **Connect** — browser opens the PIN consent page
4. Enter your **AUTH_PIN** → click **Authorize Access**
5. Redirected back to claude.ai ✅

Verify it works by asking Claude to list your private repos before moving on.

#### Step 7b — Claude Code CLI (after claude.ai is confirmed working)

```bash
# Add the connector (Claude Code handles OAuth automatically)
claude mcp add-json github '{"type":"http","url":"https://YOUR_WORKER_DOMAIN/mcp"}'
```

Restart Claude Code. On first use run `/mcp` — browser opens for PIN auth.
Claude Code stores its own token in your system keychain independently of claude.ai.

```bash
# Verify
claude mcp list
claude mcp get github
```

> **Windows note:** If `add-json` returns `Invalid input`, use:
> `claude mcp add --transport http github https://YOUR_WORKER_DOMAIN/mcp`

#### How tokens work across clients

Each client that completes the OAuth flow gets its own entry in KV:

```
KV store:
  token:<uuid-A>  →  { client_id: "claude-ai-dcr-id",   created_at: ... }   ← claude.ai token
  token:<uuid-B>  →  { client_id: "claude-code-dcr-id", created_at: ... }   ← Claude Code token
```

Both tokens are valid simultaneously. Each expires after 30 days independently.
To revoke a specific client: disconnect it in claude.ai settings or run `claude mcp remove github`.

---

---

## Connecting MCP Clients

### claude.ai (Web)

1. Go to **Settings → Connectors → Add custom connector**
2. Enter your Worker URL:
   ```
   https://YOUR_WORKER_DOMAIN/mcp
   ```
3. Click **Connect** — your browser opens the PIN consent page
4. Enter your **AUTH_PIN** and click **Authorize Access**
5. You are redirected back to claude.ai ✅

To enable per-conversation: click **+** → **Connectors** → toggle on.

To revoke: Settings → Connectors → remove the connector. The access token expires automatically after 30 days.

---

### Windows — One-Click Installer (`install-mcp.cmd`)

Download and run the included installer from `cmd.exe` — no PowerShell, no admin rights required.

**With your Worker URL as argument:**

```cmd
install-mcp.cmd https://YOUR_WORKER_DOMAIN
```

**Or run it and it will prompt you:**

```cmd
install-mcp.cmd
```

The script will:
1. Check `claude` CLI is installed
2. Remove any existing `github` MCP entry
3. Try `claude mcp add-json` (Claude Code 2.1.1+)
4. Fall back to `claude mcp add --transport http` if needed
5. Verify with `claude mcp list`
6. Print next steps including the OAuth PIN URL

After running — restart Claude Code, then run `/mcp` to trigger the browser OAuth flow.

---

### Claude Code CLI (manual)

Claude Code supports OAuth 2.1 natively — it auto-discovers your OAuth endpoints and opens the browser for authorization. No PAT or headers needed in the config.

**Add via JSON (recommended):**

```bash
claude mcp add-json github '{"type":"http","url":"https://YOUR_WORKER_DOMAIN/mcp"}'
```

**Or via legacy transport flag:**

```bash
claude mcp add --transport http github https://YOUR_WORKER_DOMAIN/mcp
```

**Windows (PowerShell):**

```powershell
claude mcp add-json github '{"type":"http","url":"https://YOUR_WORKER_DOMAIN/mcp"}'
```

> **Windows note:** If `claude mcp add-json` returns `Invalid input`, use the legacy `--transport http` form above.

After adding, restart Claude Code. On first use, run `/mcp` — Claude Code opens the browser for PIN authorization and stores the token in your system keychain (Windows Credential Manager / macOS Keychain).

**Verify connection:**

```bash
claude mcp list
claude mcp get github
```

**Scope the config (optional):**

```bash
# Available only in current project (default)
claude mcp add-json github '...' --scope local

# Shared with team via .mcp.json in repo root
claude mcp add-json github '...' --scope project

# Available across all your projects
claude mcp add-json github '...' --scope user
```

**Re-authorize (if token expires or is revoked):**

```bash
claude mcp remove github
claude mcp add-json github '{"type":"http","url":"https://YOUR_WORKER_DOMAIN/mcp"}'
# Then restart Claude Code and run /mcp to re-trigger OAuth flow
```

---

### `.mcp.json` (project-level, checked into git)

Add to your repo root `.mcp.json` to share the connector with your whole team:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://YOUR_WORKER_DOMAIN/mcp"
    }
  }
}
```

Each team member authorizes individually with their own PIN flow — tokens are personal and stored locally.

---

## Configuration Reference

### `wrangler.toml` vars

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | ✅ | Public URL of this Worker (used in OAuth metadata) |
| `UPSTREAM_MCP` | ✅ | URL of the upstream MCP server |

### Secrets

| Secret | Description |
|---|---|
| `UPSTREAM_TOKEN` | PAT or Bearer token for the upstream MCP server |
| `AUTH_PIN` | PIN to gate the consent page |

### KV binding

| Binding | Purpose |
|---|---|
| `OAUTH_KV` | Clients, auth codes (5 min TTL), access tokens (30 day TTL) |

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 discovery |
| `POST` | `/register` | RFC 7591 Dynamic Client Registration |
| `GET` | `/authorize` | PIN consent page |
| `POST` | `/authorize` | PIN submit → issues auth code |
| `POST` | `/token` | Auth code + PKCE verifier → access token |
| `POST` | `/revoke` | Token revocation |
| `*` | `/*` | Authenticated MCP proxy to upstream |

---

## Security Model

| Layer | Mechanism |
|---|---|
| Upstream token | CF Worker secret binding — encrypted at rest, never in source |
| Client authorization | PIN-gated consent page — only PIN holder can authorize |
| Code interception | PKCE S256 — stolen auth codes are useless without `code_verifier` |
| Token storage | KV with 30-day TTL — revocable at any time |
| Unauthenticated requests | 401 with `WWW-Authenticate` header |

**Optional hardening:** Add a [Cloudflare WAF rule](https://developers.cloudflare.com/firewall/) to restrict `/mcp` to [Anthropic's IP ranges](https://docs.anthropic.com/en/api/ip-addresses) only.

---

## Adapting for Other MCP Servers

Change `UPSTREAM_MCP` in `wrangler.toml`. The Worker is fully generic.

```toml
# Any PAT-authenticated MCP server
UPSTREAM_MCP = "https://mcp.linear.app/sse"
UPSTREAM_MCP = "https://my-internal-mcp.company.com/mcp"
```

---

## Why Not Docker / Coolify?

We tried. The official `ghcr.io/github/github-mcp-server` image requires the right CMD args. The npm package is deprecated. Supergateway crashes on reconnect. Cloudflare Worker is 200 lines with zero runtime dependencies, deploys in 3 seconds, and costs nothing.

Stay on CF Workers for this pattern.

---

## 💛 If This Helped You

This pattern emerged from hours of trial and error building the LIFEAI regenerative AI ecosystem. If it saved you time — please sponsor:

### → [github.com/sponsors/daveladouceur](https://github.com/sponsors/daveladouceur)

Even $5/month helps sustain open tooling for the people building at the intersection of AI, regenerative systems, and financial engineering. Thank you.

---

*Built by [Dave Ladouceur](https://github.com/daveladouceur) / [LIFEAI](https://lifeai.dev) / [Regen Dev Corp](https://YOUR_DOMAIN)*  
*Life before Profits.*

---

## License

MIT — use freely, fork liberally, adapt for any MCP server.
