// Life OS · outlook-file
// Files tickets from the daily Outlook sweep. The sweep itself is a scheduled Claude task that reads the
// Outlook inbox through Nick's Microsoft connector (sender, subject, date only) and decides ticket / ignore.
// This function is the only write path: it dedupes against outlook_seen, adds tickets to the target account's
// Google Tasks "Tickets" list, logs each one in actions (with undo), and only then marks the email as seen.
// POST { nonce, swept_until, items: [{ id, received, decision, title, priority, tag, minutes, from, subject, link, known }] }
// known === false marks a sender the sweep did not recognise: the ticket title gets a warning sign and a caution line.
// The nonce is a one-time value placed in settings.admin_nonce from inside the database and consumed on use.
// Nothing is ever sent, moved, labelled or deleted in Outlook.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const norm = (t: string) => String(t || "").toLowerCase().replace(/[^a-z]/g, "").replace(/list$/, "").replace(/s$/, "");
const PRIORITIES = ["urgent", "high", "medium", "low"];
const TAGS = ["home", "money", "health", "family", "career", "growth", "fun"];
const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

Deno.serve(async (req) => {
  let body: any;
  try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: n } = await sb.from("settings").select("value").eq("key", "admin_nonce").single();
  if (!n || !body.nonce || n.value !== body.nonce) return new Response("forbidden", { status: 403 });
  await sb.from("settings").delete().eq("key", "admin_nonce");

  const { data: target } = await sb.from("settings").select("value").eq("key", "outlook_target_email").single();
  const email = String(target?.value || "").toLowerCase();
  const { data: acc } = await sb.from("accounts").select("id,email").eq("email", email).single();
  if (!acc) return Response.json({ error: "no target account" }, { status: 404 });

  const items: any[] = (Array.isArray(body.items) ? body.items : []).filter((i) => i && typeof i.id === "string" && i.id.length > 0 && i.id.length < 600 && (i.decision === "ticket" || i.decision === "ignore")).slice(0, 200);
  const ids = items.map((i) => i.id);
  const seen = new Set<string>();
  for (let k = 0; k < ids.length; k += 50) {
    const { data } = await sb.from("outlook_seen").select("message_id").in("message_id", ids.slice(k, k + 50));
    (data || []).forEach((r: any) => seen.add(r.message_id));
  }
  const fresh = items.filter((i) => !seen.has(i.id));
  const tickets = fresh.filter((i) => i.decision === "ticket");
  const ignores = fresh.filter((i) => i.decision === "ignore");
  const received = (i: any) => { const d = new Date(i.received); return isNaN(d.getTime()) ? null : d.toISOString(); };

  let filed = 0; const failed: string[] = [];
  if (tickets.length) {
    const { data: refresh } = await sb.rpc("get_google_token", { p_account_id: acc.id });
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    const tok = (await tr.json()).access_token;
    if (!tok) return Response.json({ error: "could not get a Google token" }, { status: 502 });
    const h = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
    const lists = await (await fetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100", { headers: h })).json();
    let list = (lists.items || []).find((l: any) => norm(l.title) === "ticket");
    if (!list) list = await (await fetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", { method: "POST", headers: h, body: JSON.stringify({ title: "Tickets" }) })).json();
    for (const t of tickets) {
      const unknown = t.known === false;
      const title = (unknown ? "⚠️ " : "") + clean(t.title || t.subject || "Outlook email needs action", 200);
      const mk = [PRIORITIES.includes(t.priority) ? `!${t.priority}` : "!medium", TAGS.includes(t.tag) ? `#${t.tag}` : "", Number(t.minutes) > 0 ? `~${Math.round(Number(t.minutes))}m` : ""].filter(Boolean).join(" ");
      const link = /^https:\/\/outlook\.live\.com\//.test(String(t.link || "")) ? String(t.link) : "";
      const notes = [mk, unknown ? "⚠️ Sender not recognised. Check it is real before acting, and never pay from a link in the email." : "", `From Outlook: ${clean(t.from, 120)}`, clean(t.subject, 200), link].filter(Boolean).join("\n");
      const r = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks`, { method: "POST", headers: h, body: JSON.stringify({ title, notes }) });
      const j = await r.json();
      if (!r.ok) { failed.push(t.id); continue; }
      await sb.from("actions").insert({ account_id: acc.id, kind: "ticket_filed", summary: `Filed from Outlook: ${title} (${mk})`, details: { source: "outlook", known: !unknown, from: clean(t.from, 120), subject: clean(t.subject, 200), notes }, undo: { kind: "task_complete", url: `https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks/${j.id}` } });
      await sb.from("outlook_seen").upsert({ message_id: t.id, decision: "ticket", received_at: received(t) });
      filed++;
    }
  }
  for (let k = 0; k < ignores.length; k += 50) {
    await sb.from("outlook_seen").upsert(ignores.slice(k, k + 50).map((i) => ({ message_id: i.id, decision: "ignore", received_at: received(i) })));
  }
  // Only move the high-water mark when every ticket landed, so a failure is retried on the next run.
  const until = new Date(body.swept_until);
  if (!failed.length && !isNaN(until.getTime()) && until.getTime() <= Date.now() + 60000) {
    await sb.from("settings").upsert({ key: "outlook_last_sweep_at", value: until.toISOString() });
  }
  return Response.json({ received: items.length, already_seen: items.length - fresh.length, filed, ignored: ignores.length, failed: failed.length });
});
