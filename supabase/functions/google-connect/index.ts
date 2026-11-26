// Life OS · google-connect
// One-off per account: sends the person to Google for standing (offline) permission,
// receives the code, exchanges it for a refresh token and stores it in Vault.
//
// Routes:
//   GET /google-connect?label=dad           -> redirects to Google
//   GET /google-connect/callback?code=...   -> stores token, shows a plain confirmation
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CONNECT_ALLOWLIST (comma-separated emails),
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by the platform).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
].join(" ");

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Life OS</title><body style="font:16px/1.5 system-ui;max-width:32em;margin:3em auto;padding:0 1em;color:#17213A">${body}</body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const allow = (Deno.env.get("CONNECT_ALLOWLIST") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (!clientId || !clientSecret) return html("<h1>Not configured</h1><p>GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.</p>", 500);

  // Pin to the public project URL: inside the runtime the request may carry an internal hostname.
  const publicBase = (Deno.env.get("PUBLIC_FUNCTIONS_URL") || `${Deno.env.get("SUPABASE_URL")}/functions/v1`).replace(/\/$/, "");
  const redirectUri = `${publicBase}/google-connect/callback`;
  if (url.searchParams.get("debug") === "1") return html(`<p>redirect_uri in use:</p><pre>${redirectUri}</pre>`);

  if (url.pathname.endsWith("/callback")) {
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    const label = url.searchParams.get("state") || "member";
    if (err || !code) return html(`<h1>Not connected</h1><p>Google said: ${err || "no code"}.</p>`, 400);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok || !tok.refresh_token) {
      return html(`<h1>Not connected</h1><p>Google did not return a standing permission (${tok.error || tokenRes.status}). If this account was connected before, remove Life OS at myaccount.google.com/permissions and try again.</p>`, 400);
    }
    const who = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
    const email = String(who.email || "").toLowerCase();
    if (!email || (allow.length && !allow.includes(email))) {
      return html(`<h1>Not connected</h1><p>${email || "This account"} is not on the Life OS list.</p>`, 403);
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await supabase.rpc("store_google_token", { p_email: email, p_label: label, p_token: tok.refresh_token, p_scopes: tok.scope || SCOPES });
    if (error) return html(`<h1>Not connected</h1><p>Could not store the permission: ${error.message}</p>`, 500);
    return html(`<h1>Connected</h1><p><b>${email}</b> is now connected to Life OS as <b>${label}</b>. The brain can read its calendar and tasks and act on them. You can close this page.</p><p style="color:#5A6478">To disconnect later, remove Life OS at myaccount.google.com/permissions.</p>`);
  }

  // Start: send to Google asking for offline access.
  const label = url.searchParams.get("label") || "member";
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: label,
  }).toString();
  return Response.redirect(auth.toString(), 302);
});
