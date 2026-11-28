// Life OS · microsoft-connect
// One-time sign-in for a legacy Outlook mailbox so the brain can sweep it (read-only).
//   GET /microsoft-connect            -> Microsoft sign-in (personal accounts only)
//   GET /microsoft-connect/callback   -> stores the standing permission in the vault, then lands on the app
// Only mailboxes named in settings.outlook_owners may connect; if that setting is missing or empty, nobody can.
// Permissions asked for: Mail.Read (read only), User.Read (who signed in), offline_access (stay connected).
// Secrets: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SCOPES = "offline_access User.Read Mail.Read";
const MS_DOMAINS = ["hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "live.co.uk", "msn.com"];
const APP = "https://nick-thandi.github.io/life-os/connected.html";
const land = (q: Record<string, string>) => Response.redirect(APP + "#" + new URLSearchParams(q).toString(), 302);

async function sign(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
  if (!clientId || !clientSecret) return land({ error: "Microsoft keys are not set in Supabase yet" });
  const redirectUri = `${Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")}/functions/v1/microsoft-connect/callback`;

  if (!url.pathname.endsWith("/callback")) {
    // State = timestamp + signature, so only a sign-in started here within 15 minutes is accepted back.
    const ts = String(Date.now());
    const auth = new URL("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
    auth.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: SCOPES, prompt: "select_account", state: `${ts}.${await sign(clientSecret, ts)}` }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (err || !code) return land({ error: url.searchParams.get("error_description")?.slice(0, 200) || err || "no code" });
  const [ts, sig] = (url.searchParams.get("state") || "").split(".");
  if (!ts || !sig || sig !== await sign(clientSecret, ts) || Date.now() - Number(ts) > 15 * 60000) return land({ error: "That sign-in link expired. Open the connect link again." });

  const tr = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code", scope: SCOPES }),
  });
  const tok = await tr.json();
  if (!tr.ok || !tok.refresh_token) return land({ error: "Microsoft: " + String(tok.error_description || tok.error || tr.status).slice(0, 200) });
  const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  const email = String(me.mail || me.userPrincipalName || "").toLowerCase();
  const [local, domain] = email.split("@");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: s } = await sb.from("settings").select("value").eq("key", "outlook_owners").single();
  const owners: Record<string, string> = (s?.value && typeof s.value === "object") ? s.value : {};
  const ownerEmail = MS_DOMAINS.includes(domain || "") ? (owners[email] || owners[local]) : owners[email];
  if (!ownerEmail) return land({ error: `${email || "That account"} is not on the Life OS list` });
  const { data: owner } = await sb.from("accounts").select("id,email").eq("email", String(ownerEmail).toLowerCase()).single();
  if (!owner) return land({ error: "The owner's Google account is not connected yet" });

  const { data: id, error } = await sb.rpc("store_ms_token", { p_email: email, p_owner_account_id: owner.id, p_token: tok.refresh_token });
  if (error) return land({ error: "Could not store the permission" });
  // The first mailbox was already swept daily by a Claude task: carry on from where that stopped, not 7 days back.
  if (local === "athandi1") {
    const { data: hw } = await sb.from("settings").select("value").eq("key", "outlook_last_sweep_at").single();
    if (hw?.value) await sb.from("ms_accounts").update({ last_sweep_at: hw.value }).eq("id", id).is("last_sweep_at", null);
  }
  return land({ outlook: email, owner: owner.email });
});
