/**
 * cf-oauth-mcp-proxy
 * Cloudflare Worker — OAuth 2.1 + DCR + PKCE edge proxy for any MCP server.
 *
 * Implements the full OAuth 2.1 authorization server spec so clients like
 * claude.ai can connect via standard OAuth flow. A PIN gates the consent page.
 * Access tokens are stored in KV. The upstream PAT/token is a secret binding —
 * never appears in source code.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  — RFC 8414 discovery
 *   POST /register                                — RFC 7591 DCR
 *   GET  /authorize                               — consent page (PIN-gated)
 *   POST /authorize                               — PIN submit → auth code
 *   POST /token                                   — auth code → access token
 *   POST /revoke                                  — token revocation
 *   *    /mcp (any path/method)                   — authenticated MCP proxy
 *
 * Bindings (set in wrangler.toml or Cloudflare dashboard):
 *   OAUTH_KV   — KV namespace for token storage
 *   UPSTREAM_TOKEN — secret: PAT or token for the upstream MCP server
 *   AUTH_PIN       — secret: PIN to gate the consent page
 *
 * Env vars (set in wrangler.toml):
 *   BASE_URL      — public URL of this Worker  e.g. https://mcp-proxy.example.com
 *   UPSTREAM_MCP  — upstream MCP endpoint      e.g. https://api.githubcopilot.com/mcp
 */

const CODE_TTL  = 300;      // auth code TTL: 5 minutes
const TOKEN_TTL = 2592000;  // access token TTL: 30 days

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const BASE_URL     = env.BASE_URL     || "https://mcp-proxy.example.com";
    const UPSTREAM_MCP = env.UPSTREAM_MCP || "https://api.githubcopilot.com/mcp";

    if (method === "OPTIONS")
      return cors();
    if (path === "/.well-known/oauth-authorization-server" && method === "GET")
      return discovery(BASE_URL);
    if (path === "/register" && method === "POST")
      return register(request, env);
    if (path === "/authorize" && method === "GET")
      return authorizeGet(url, BASE_URL);
    if (path === "/authorize" && method === "POST")
      return authorizePost(request, env);
    if (path === "/token" && method === "POST")
      return tokenEndpoint(request, env);
    if (path === "/revoke" && method === "POST")
      return revoke(request, env);

    // All other paths → MCP proxy (requires valid Bearer token)
    return mcpProxy(request, env, BASE_URL, UPSTREAM_MCP);
  }
};

// ── OAuth Discovery (RFC 8414) ────────────────────────────────────────────────
function discovery(base) {
  return json({
    issuer:                                base,
    authorization_endpoint:               `${base}/authorize`,
    token_endpoint:                        `${base}/token`,
    registration_endpoint:                 `${base}/register`,
    revocation_endpoint:                   `${base}/revoke`,
    response_types_supported:             ["code"],
    grant_types_supported:                ["authorization_code"],
    code_challenge_methods_supported:     ["S256"],
    token_endpoint_auth_methods_supported:["none"],
  });
}

// ── Dynamic Client Registration (RFC 7591) ────────────────────────────────────
async function register(request, env) {
  const body     = await request.json().catch(() => ({}));
  const clientId = crypto.randomUUID();
  const client   = {
    client_id:                    clientId,
    client_name:                  body.client_name || "Unknown",
    redirect_uris:                body.redirect_uris || [],
    grant_types:                  ["authorization_code"],
    response_types:               ["code"],
    token_endpoint_auth_method:   "none",
    created_at:                   Date.now(),
  };
  await env.OAUTH_KV.put(
    `client:${clientId}`,
    JSON.stringify(client),
    { expirationTtl: 86400 * 365 }
  );
  return json(client, 201);
}

// ── Authorize GET — PIN consent page ──────────────────────────────────────────
function authorizeGet(url, base) {
  const p = url.searchParams;
  const H = s => String(s)
    .replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MCP Proxy — Authorize</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#070f08;font-family:Inter,system-ui,sans-serif;color:rgba(255,255,255,.9)}
    .card{background:#0d1a0e;border:1px solid rgba(200,168,75,.25);
          border-radius:12px;padding:40px;width:360px;text-align:center}
    .icon{font-size:36px;margin-bottom:16px}
    h1{font-size:20px;font-weight:600;margin-bottom:8px;color:#c8a84b}
    p{font-size:13px;color:rgba(255,255,255,.5);margin-bottom:24px;line-height:1.6}
    input[type=password]{width:100%;padding:12px;background:#122014;
      border:1px solid rgba(200,168,75,.2);border-radius:8px;
      color:rgba(255,255,255,.9);font-size:18px;letter-spacing:6px;
      text-align:center;margin-bottom:14px;outline:none}
    input[type=password]:focus{border-color:rgba(200,168,75,.6)}
    button{width:100%;padding:12px;background:#c8a84b;color:#070f08;
           border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
    button:hover{background:#e4c97a}
    .note{font-size:11px;color:rgba(255,255,255,.25);margin-top:18px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚡</div>
    <h1>MCP Gateway</h1>
    <p>An OAuth client is requesting MCP proxy access. Enter your PIN to authorize.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id"             value="${H(p.get("client_id")||"")}">
      <input type="hidden" name="redirect_uri"          value="${H(p.get("redirect_uri")||"")}">
      <input type="hidden" name="state"                 value="${H(p.get("state")||"")}">
      <input type="hidden" name="code_challenge"        value="${H(p.get("code_challenge")||"")}">
      <input type="hidden" name="code_challenge_method" value="${H(p.get("code_challenge_method")||"S256")}">
      <input type="password" name="pin" placeholder="••••••••" autofocus autocomplete="off">
      <button type="submit">Authorize Access</button>
    </form>
    <div class="note">${H(base)}</div>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ── Authorize POST — verify PIN, issue auth code ───────────────────────────────
async function authorizePost(request, env) {
  const body = await request.formData();
  const pin  = body.get("pin") || "";

  if (pin !== env.AUTH_PIN) {
    return new Response("Invalid PIN — go back and try again.", {
      status: 401, headers: { "Content-Type": "text/plain" }
    });
  }

  const code = crypto.randomUUID();
  await env.OAUTH_KV.put(`code:${code}`, JSON.stringify({
    client_id:            body.get("client_id")             || "",
    redirect_uri:         body.get("redirect_uri")          || "",
    code_challenge:       body.get("code_challenge")        || "",
    code_challenge_method:body.get("code_challenge_method") || "S256",
  }), { expirationTtl: CODE_TTL });

  const redirect = new URL(body.get("redirect_uri") || "");
  redirect.searchParams.set("code", code);
  const state = body.get("state");
  if (state) redirect.searchParams.set("state", state);

  return Response.redirect(redirect.toString(), 302);
}

// ── Token endpoint ─────────────────────────────────────────────────────────────
async function tokenEndpoint(request, env) {
  // Accept both application/x-www-form-urlencoded and application/json
  const ct = request.headers.get("content-type") || "";
  let get;
  if (ct.includes("application/json")) {
    const j = await request.json().catch(() => ({}));
    get = k => j[k] || "";
  } else {
    const params = new URLSearchParams(await request.text());
    get = k => params.get(k) || "";
  }

  if (get("grant_type") !== "authorization_code")
    return jsonErr("unsupported_grant_type", 400);

  const stored = await env.OAUTH_KV.get(`code:${get("code")}`, "json");
  if (!stored) return jsonErr("invalid_grant", 400);

  // Verify PKCE (S256)
  if (stored.code_challenge) {
    const verifier = get("code_verifier");
    if (!verifier) return jsonErr("invalid_grant", 400);
    const digest   = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    if (expected !== stored.code_challenge)
      return jsonErr("invalid_grant", 400);
  }

  await env.OAUTH_KV.delete(`code:${get("code")}`);

  const accessToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  await env.OAUTH_KV.put(`token:${accessToken}`, JSON.stringify({
    client_id:  stored.client_id,
    created_at: Date.now(),
  }), { expirationTtl: TOKEN_TTL });

  return json({
    access_token: accessToken,
    token_type:   "Bearer",
    expires_in:   TOKEN_TTL,
  });
}

// ── Token revocation ───────────────────────────────────────────────────────────
async function revoke(request, env) {
  const params = new URLSearchParams(await request.text());
  await env.OAUTH_KV.delete(`token:${params.get("token") || ""}`);
  return new Response(null, { status: 200 });
}

// ── MCP Proxy ──────────────────────────────────────────────────────────────────
async function mcpProxy(request, env, base, upstream) {
  // Require valid Bearer token
  const auth = request.headers.get("Authorization") || "";
  const tok  = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tok) return unauth(base);

  const stored = await env.OAUTH_KV.get(`token:${tok}`);
  if (!stored) return unauth(base);

  // Forward to upstream MCP with the secret PAT/token
  const url     = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${env.UPSTREAM_TOKEN}`);
  headers.set("Host", new URL(upstream).host);
  ["cf-connecting-ip","cf-ipcountry","cf-ray","cf-visitor"]
    .forEach(h => headers.delete(h));

  const resp = await fetch(upstream + (url.search || ""), {
    method:  request.method,
    headers,
    body: !["GET","HEAD"].includes(request.method) ? request.body : undefined,
  });

  return new Response(resp.body, {
    status:     resp.status,
    statusText: resp.statusText,
    headers:    resp.headers,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function jsonErr(e, s) { return json({ error: e }, s); }
function unauth(base) {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer realm="${base}"` },
  });
}
function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
