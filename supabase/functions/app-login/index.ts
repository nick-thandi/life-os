// Life OS · app-login
// Redirect-style sign-in for the app (works inside installed apps and on TVs; no pop-ups).
//
//   GET  /app-login?return=<app page url>   -> Google sign-in (code flow) -> back to the app with #lifeos_session=...
//   GET  /app-login/callback                -> (Google returns here) creates a device session
//   POST /app-login/token                   -> Bearer <session> : { access_token, expires_in, email, label }
//   POST /app-login/logout                  -> Bearer <session> : revokes it
//
// The Google access token handed to the browser is down-scoped to calendar read + tasks + email,
// even though the stored permission also covers mail (used only by the brain, server-side).
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CONNECT_ALLOWLIST, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_RETURN_PREFIXES = ["https://nick-thandi.github.io/life-os/", "http://localhost:8765/"];
const ALLOWED_ORIGINS = ["https://nick-thandi.github.io", "http://localhost:8765"];
const LOGIN_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/tasks", "https://www.googleapis.com/auth/gmail.readonly"].join(" ");
const APP_TOKEN_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/tasks", "https://www.googleapis.com/auth/userinfo.email"].join(" ");

function cors(req: Request) {
  const o = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
const html = (body: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Life OS</title><body style="font:16px/1.5 system-ui;max-width:32em;margin:3em auto;padding:0 1em;color:#17213A">${body}</body>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return Array.from(a).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function okReturn(u: string) {
  return ALLOWED_RETURN_PREFIXES.some((p) => u.startsWith(p));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  const url = new URL(req.url);
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
  const publicBase = (Deno.env.get("PUBLIC_FUNCTIONS_URL") || `${Deno.env.get("SUPABASE_URL")}/functions/v1`).replace(/\/$/, "");
  const redirectUri = `${publicBase}/app-login/callback`;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- session-authenticated endpoints ----
  if (req.method === "POST" && (url.pathname.endsWith("/token") || url.pathname.endsWith("/logout"))) {
    const sess = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!sess) return json(req, { error: "no session" }, 401);
    const hash = await sha256(sess);
    const { data: s } = await sb.from("sessions").select("id,account_id,expires_at,revoked_at").eq("token_hash", hash).single();
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) return json(req, { error: "session expired" }, 401);
    if (url.pathname.endsWith("/logout")) { await sb.from("sessions").update({ revoked_at: new Date().toISOString() }).eq("id", s.id); return json(req, { ok: true }); }
    const { data: acc } = await sb.from("accounts").select("id,email,label,active").eq("id", s.account_id).single();
    if (!acc || !acc.active) return json(req, { error: "account inactive" }, 403);
    const { data: refresh } = await sb.rpc("get_google_token", { p_account_id: acc.id });
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token", scope: APP_TOKEN_SCOPES }),
    });
    const tj = await tr.json();
    if (!tr.ok) return json(req, { error: "google: " + (tj.error || tr.status) }, 502);
    await sb.from("sessions").update({ last_used_at: new Date().toISOString(), expires_at: new Date(Date.now() + 180 * 86400000).toISOString() }).eq("id", s.id);
    return json(req, { access_token: tj.access_token, expires_in: tj.expires_in, email: acc.email, label: acc.label });
  }

  // ---- Google returns here ----
  if (url.pathname.endsWith("/callback")) {
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    let state: any = {};
    try { state = JSON.parse(atob(url.searchParams.get("state") || "")); } catch (_) { /* ignore */ }
    const back = okReturn(state.r || "") ? state.r : ALLOWED_RETURN_PREFIXES[0];
    if (err || !code) return Response.redirect(back + "#lifeos_error=" + encodeURIComponent(err || "no code"), 302);
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const tok = await tr.json();
    if (!tr.ok) return Response.redirect(back + "#lifeos_error=" + encodeURIComponent(tok.error || "token"), 302);
    const who = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
    const email = String(who.email || "").toLowerCase();
    const allow = (Deno.env.get("CONNECT_ALLOWLIST") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    if (!email || (allow.length && !allow.includes(email))) return html(`<h1>Not a Life OS account</h1><p>${email || "This account"} is not on the family list.</p>`, 403);
    let { data: acc } = await sb.from("accounts").select("id,email,label").eq("email", email).single();
    if (tok.refresh_token) {
      // First sign-in for this account (or re-consent): store the standing permission so the brain can act too.
      await sb.rpc("store_google_token", { p_email: email, p_label: acc?.label || state.l || "member", p_token: tok.refresh_token, p_scopes: tok.scope || LOGIN_SCOPES });
      acc = (await sb.from("accounts").select("id,email,label").eq("email", email).single()).data;
    }
    if (!acc) return html(`<h1>Almost</h1><p>Google did not give Life OS a standing permission for ${email}. Open the connect link once, then sign in again.</p>`, 400);
    const token = randomToken();
    await sb.from("sessions").insert({ account_id: acc.id, token_hash: await sha256(token), device: (req.headers.get("User-Agent") || "").slice(0, 200) });
    return Response.redirect(back + "#lifeos_session=" + token, 302);
  }

  // ---- start ----
  const ret = url.searchParams.get("return") || ALLOWED_RETURN_PREFIXES[0];
  if (!okReturn(ret)) return html("<h1>Bad return address</h1>", 400);
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: LOGIN_SCOPES,
    access_type: "offline", include_granted_scopes: "true", prompt: "select_account",
    state: btoa(JSON.stringify({ r: ret, l: url.searchParams.get("label") || "" })),
  }).toString();
  return Response.redirect(auth.toString(), 302);
});
