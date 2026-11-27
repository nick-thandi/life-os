// Life OS · activity
// Lets a signed-in family member see what the brain did, undo it, or approve a suggestion.
// Identity: the browser sends its Google access token (from the app's own sign-in). We verify
// it with Google, check the email is a connected account, and only then read or act.
//
//   GET  /activity                -> { me, autonomy, actions: [...] }
//   POST /activity {undo: id}     -> reverses one action
//   POST /activity {approve: id}  -> carries out a suggested calendar event
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://nick-thandi.github.io", "http://localhost:8765"];

function cors(req: Request) {
  const o = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

async function whoIs(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token));
  if (!r.ok) return null;
  const j = await r.json();
  if (j.aud !== Deno.env.get("GOOGLE_CLIENT_ID")) return null; // token must be for this app
  return String(j.email || "").toLowerCase() || null;
}

async function googleToken(sb: any, accountId: string) {
  const { data: refresh } = await sb.rpc("get_google_token", { p_account_id: accountId });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Google token: " + (j.error || res.status));
  return j.access_token as string;
}

async function gapi(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${(j as any).error?.message || ""}`);
  return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  const email = await whoIs(req);
  if (!email) return json(req, { error: "not signed in" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // A person sees their own account's activity and the family account's.
  const { data: visible } = await sb.from("accounts").select("id,email,label").or(`email.eq.${email},label.eq.family`);
  if (!visible?.length || !visible.find((a: any) => a.email === email || a.label === "family")) return json(req, { error: "not a Life OS account" }, 403);
  const ids = visible.map((a: any) => a.id);
  const labels: Record<string, string> = Object.fromEntries(visible.map((a: any) => [a.id, a.label]));

  if (req.method === "GET") {
    const { data: actions } = await sb.from("actions").select("id,account_id,kind,summary,details,undo,created_at,undone_at").in("account_id", ids).order("created_at", { ascending: false }).limit(100);
    const { data: s } = await sb.from("settings").select("key,value").in("key", ["autonomy", "brain_enabled"]);
    const settings = Object.fromEntries((s || []).map((r: any) => [r.key, r.value]));
    return json(req, {
      me: email,
      autonomy: settings.autonomy,
      brain_enabled: settings.brain_enabled,
      actions: (actions || []).map((a: any) => ({ ...a, account: labels[a.account_id], can_undo: !!a.undo && !a.undone_at, can_approve: a.kind === "suggested" && !a.undone_at && !!a.details?.body })),
    });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const id = body.undo || body.approve;
    const { data: a } = await sb.from("actions").select("*").eq("id", id).in("account_id", ids).single();
    if (!a) return json(req, { error: "not found" }, 404);
    if (a.undone_at) return json(req, { error: "already done" }, 409);
    const token = await googleToken(sb, a.account_id);

    if (body.undo && a.undo) {
      const u = a.undo;
      if (u.kind === "task_restore") {
        await gapi(token, u.url, { method: "PATCH", body: JSON.stringify({ title: u.title, notes: u.notes }) });
      } else if (u.kind === "event_remove_and_task_reopen") {
        await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(u.calendar_id)}/events/${u.event_id}`, { method: "DELETE" });
        await gapi(token, u.task_url, { method: "PATCH", body: JSON.stringify({ status: "needsAction", notes: u.task_notes }) });
      } else if (u.kind === "task_complete") {
        await gapi(token, u.url, { method: "PATCH", body: JSON.stringify({ status: "completed", notes: "Undone in Life OS (ticket withdrawn)" }) });
      } else if (u.kind === "event_remove") {
        await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(u.calendar_id)}/events/${u.event_id}`, { method: "DELETE" });
      } else {
        return json(req, { error: "nothing to undo" }, 400);
      }
      await sb.from("actions").update({ undone_at: new Date().toISOString() }).eq("id", a.id);
      await sb.from("actions").insert({ account_id: a.account_id, capture_id: a.capture_id, kind: "undone", summary: `Undone by ${email}: ${a.summary}`, details: { of: a.id } });
      return json(req, { ok: true });
    }

    if (body.approve && a.kind === "suggested" && a.details?.body) {
      const d = a.details;
      const { data: fam } = await sb.from("settings").select("value").eq("key", "family_calendar").single();
      const calId = d.event?.calendar === "family" ? (fam?.value || "oceansfamily2018@gmail.com") : "primary";
      const ev = await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, { method: "POST", body: JSON.stringify(d.body) });
      const { data: cap } = a.capture_id ? await sb.from("captures").select("payload").eq("id", a.capture_id).single() : { data: null };
      let taskUrl = "", taskNotes = "";
      if (cap?.payload?.listId && cap?.payload?.id) {
        taskUrl = `https://tasks.googleapis.com/tasks/v1/lists/${cap.payload.listId}/tasks/${cap.payload.id}`;
        taskNotes = cap.payload.notes || "";
        await gapi(token, taskUrl, { method: "PATCH", body: JSON.stringify({ status: "completed", notes: `→ calendar ${String(d.event?.start || "").slice(0, 16)} (Life OS, approved)\n${taskNotes}`.trim() }) });
      }
      await sb.from("actions").update({ undone_at: new Date().toISOString() }).eq("id", a.id); // suggestion consumed
      await sb.from("actions").insert({
        account_id: a.account_id, capture_id: a.capture_id, kind: "event_created",
        summary: `Approved by ${email}: ${d.body.summary} at ${d.event?.start}`,
        details: { ...d, event_id: ev.id, calendar_id: calId },
        undo: { kind: "event_remove_and_task_reopen", calendar_id: calId, event_id: ev.id, task_url: taskUrl, task_notes: taskNotes },
      });
      return json(req, { ok: true });
    }
    return json(req, { error: "bad request" }, 400);
  }
  return json(req, { error: "method" }, 405);
});
