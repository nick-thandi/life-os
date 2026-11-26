// Life OS · brain
// Runs every few minutes. For each connected account: reads new Google Tasks (captures),
// asks Claude what each one means, and files it as a ticket with markers or as a calendar
// event. Every change is logged in public.actions with enough to undo it. Nothing is deleted.
//
// Autonomy (settings.autonomy):
//   "suggest"          log what it would do, change nothing
//   "suggest_then_act" file tickets (markers) itself; only suggest calendar events
//   "full"             tickets and calendar events
//
// Secrets: ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

type Account = { id: string; email: string; label: string; last_sync_at: string | null };
type Capture = { id: string; account_id: string; source: string; external_id: string; text: string; payload: any };
type Decision = {
  capture_id: string;
  action: "ticket" | "event" | "skip" | "ask";
  title?: string;
  priority?: "urgent" | "high" | "medium" | "low" | "";
  tag?: "home" | "money" | "health" | "family" | "career" | "growth" | "fun" | "";
  minutes?: number;
  big?: boolean;
  blocked?: string;
  event?: { start: string; end: string; all_day: boolean; calendar: "family" | "own"; person?: string };
  reason?: string;
};

const PRIORITIES = ["urgent", "high", "medium", "low"];
const TAGS = ["home", "money", "health", "family", "career", "growth", "fun"];
const LIST_NAMES = ["tickets", "ticket", "mytasks", "intray", "inbox", "entry"];
const norm = (t: string) => String(t || "").toLowerCase().replace(/[^a-z]/g, "").replace(/list$/, "").replace(/(?<!mytask)s$/, "");

function markers(d: Decision) {
  const m: string[] = [];
  if (d.priority) m.push("!" + d.priority);
  if (d.tag) m.push("#" + d.tag);
  if (d.minutes) m.push("~" + (d.minutes % 60 === 0 ? d.minutes / 60 + "h" : d.minutes + "m"));
  if (d.big) m.push("big");
  if (d.blocked) m.push("blocked: " + d.blocked);
  return m.join(" ");
}
const hasMarkers = (notes: string) => /(^|\s)(!(urgent|high|medium|low)|#[a-z]+|~\d|big|blocked:)/i.test(notes || "");

// ---------- Google ----------
async function accessToken(sb: SupabaseClient, account: Account): Promise<string> {
  const { data: refresh, error } = await sb.rpc("get_google_token", { p_account_id: account.id });
  if (error || !refresh) throw new Error(`no token for ${account.email}`);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`token refresh failed for ${account.email}: ${j.error || res.status}`);
  return j.access_token;
}

async function gapi(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url.split("?")[0]} -> ${res.status} ${(j as any).error?.message || ""}`);
  return j;
}

async function taskLists(token: string) {
  const j = await gapi(token, "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100");
  const items = (j.items || []) as { id: string; title: string }[];
  const ordered: { id: string; title: string }[] = [];
  for (const n of LIST_NAMES) for (const l of items) if (norm(l.title) === n && !ordered.find((x) => x.id === l.id)) ordered.push(l);
  return ordered;
}

async function openTasks(token: string, listId: string) {
  const j = await gapi(token, `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks?showCompleted=false&showHidden=false&maxResults=100`);
  return (j.items || []) as any[];
}

async function calendarContext(token: string, calendarId: string, days = 7) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  const p = new URLSearchParams({ timeMin: now.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "60" });
  const j = await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${p}`);
  return ((j.items || []) as any[]).map((e) => `${e.start?.dateTime || e.start?.date} → ${e.end?.dateTime || e.end?.date}: ${e.summary || ""}`);
}

// ---------- Claude ----------
async function decide(captures: Capture[], ctx: { now: string; tz: string; calendar: string[]; account: Account }, model: string) {
  const system = `You are the brain of Life OS, a family operating system built on Getting Things Done. You receive raw captures (things a family member typed or said, e.g. "remind me to book the dentist", "Kini karate moved to 5pm Thursday") and decide what each one is.

Family: Dad (Nick, the main user), Mum (Sam), Kini (daughter, 7, school), Pooks (child, 3, nursery). Home is Leicester, UK. Time zone ${ctx.tz}. Now: ${ctx.now}. This account is "${ctx.account.label}" (${ctx.account.email}).

Rules:
- A capture with a clear day and time (or "all day" date) is an EVENT. Otherwise it is a TICKET.
- Tickets get: a clean title (imperative, sentence case, no trailing words like "urgent"), a priority (urgent/high/medium/low) only when the text says or strongly implies one, otherwise "", a tag from: home money health family career growth fun (choose the best fit; "" if none), minutes estimate when stated or obvious (round), big=true if over 2 hours, blocked reason when stated.
- Events: ISO 8601 with offset for the UK; default length 60 min; all_day when no time. calendar "family" for anything involving the children, both parents, or the household; "own" for the account holder's personal items. Title starts with the person's name and a colon when it is about one person ("Kini: dentist").
- "skip" for empty, test, or duplicate captures ("test one", "socks" alone is still a ticket: "Buy socks").
- "ask" when you truly cannot tell (e.g. a date with no year that is ambiguous). Give a one-line reason.
- Never invent facts. Never schedule anything on a work calendar; there is none here.
Respond with JSON only: {"decisions":[{capture_id, action, title, priority, tag, minutes, big, blocked, event:{start,end,all_day,calendar,person}, reason}]}. Include every capture_id exactly once.`;

  const user = `Calendar for the next 7 days (${ctx.account.label}):\n${ctx.calendar.slice(0, 60).join("\n") || "(none)"}\n\nCaptures:\n${captures.map((c) => `- capture_id ${c.id} [${c.source}]: ${JSON.stringify(c.text)}${c.payload?.due ? ` (due ${c.payload.due})` : ""}${c.payload?.notes ? ` notes: ${JSON.stringify(c.payload.notes)}` : ""}`).join("\n")}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Claude: ${j.error?.message || res.status}`);
  const text = (j.content || []).map((c: any) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = m ? JSON.parse(m[0]) : { decisions: [] };
  return { decisions: (parsed.decisions || []) as Decision[], usage: j.usage || {} };
}

// ---------- Apply ----------
async function applyDecision(sb: SupabaseClient, token: string, account: Account, cap: Capture, d: Decision, autonomy: string, familyCalendar: string) {
  const log = async (kind: string, summary: string, details: any, undo: any = null) => {
    await sb.from("actions").insert({ account_id: account.id, capture_id: cap.id, kind, summary, details, undo });
  };
  const task = cap.payload || {};
  const taskUrl = `https://tasks.googleapis.com/tasks/v1/lists/${task.listId}/tasks/${task.id}`;

  if (d.action === "skip") { await log("noted", `Skipped: ${cap.text}`, { reason: d.reason }); return; }
  if (d.action === "ask") { await log("flagged", `Needs you: ${cap.text}`, { reason: d.reason }); return; }

  if (d.action === "ticket") {
    const title = d.title || cap.text;
    const notes = [markers(d), task.notes].filter(Boolean).join("\n").trim();
    if (autonomy === "suggest") { await log("suggested", `Would file ticket: ${title} (${markers(d) || "no markers"})`, d); return; }
    await gapi(token, taskUrl, { method: "PATCH", body: JSON.stringify({ title, notes }) });
    await log("ticket_filed", `Filed: ${title} ${markers(d) ? "(" + markers(d) + ")" : ""}`.trim(), d, { kind: "task_restore", url: taskUrl, title: task.title, notes: task.notes || "" });
    return;
  }

  if (d.action === "event" && d.event) {
    const calId = d.event.calendar === "family" ? familyCalendar : "primary";
    const body: any = {
      summary: d.title || cap.text,
      description: `Created by Life OS from: "${cap.text}"`,
      start: d.event.all_day ? { date: d.event.start.slice(0, 10) } : { dateTime: d.event.start },
      end: d.event.all_day ? { date: d.event.end.slice(0, 10) } : { dateTime: d.event.end },
    };
    if (autonomy !== "full") { await log("suggested", `Would add to ${d.event.calendar} calendar: ${body.summary} at ${d.event.start}`, { ...d, body }); return; }
    const ev = await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, { method: "POST", body: JSON.stringify(body) });
    // The capture becomes a calendar item: complete the task (not delete) and point to the event.
    await gapi(token, taskUrl, { method: "PATCH", body: JSON.stringify({ status: "completed", notes: `→ calendar ${d.event.start.slice(0, 16)} (Life OS)\n${task.notes || ""}`.trim() }) });
    await log("event_created", `Added to ${d.event.calendar} calendar: ${body.summary} at ${d.event.start}`, { ...d, event_id: ev.id, calendar_id: calId },
      { kind: "event_remove_and_task_reopen", calendar_id: calId, event_id: ev.id, task_url: taskUrl, task_notes: task.notes || "" });
  }
}

// ---------- Run ----------
Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: settingsRows } = await sb.from("settings").select("key,value");
  const settings: Record<string, any> = {};
  for (const r of settingsRows || []) settings[r.key] = r.value;
  if (!settings.brain_enabled) return Response.json({ ok: true, skipped: "brain_enabled is false" });

  // Don't run twice within 2 minutes.
  const { data: last } = await sb.from("runs").select("started_at").order("started_at", { ascending: false }).limit(1);
  if (last?.[0] && Date.now() - new Date(last[0].started_at).getTime() < 120000) return Response.json({ ok: true, skipped: "ran recently" });

  const { data: run } = await sb.from("runs").insert({}).select().single();
  const stats = { captures_seen: 0, actions_taken: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 };
  const autonomy = settings.autonomy || "suggest_then_act";
  const familyCalendar = settings.family_calendar || "oceansfamily2018@gmail.com";
  const model = settings.model || "claude-haiku-5-5";
  const tz = settings.time_zone || "Europe/London";
  const errors: string[] = [];

  try {
    const { data: accounts } = await sb.from("accounts").select("id,email,label,last_sync_at").eq("active", true);
    for (const account of (accounts || []) as Account[]) {
      try {
        const token = await accessToken(sb, account);
        // 1. Capture: open tasks without markers that we have not seen.
        const lists = await taskLists(token);
        const fresh: Capture[] = [];
        for (const l of lists) {
          for (const t of await openTasks(token, l.id)) {
            if (!t.title?.trim() || hasMarkers(t.notes)) continue;
            const { data: ins } = await sb.from("captures").upsert(
              { account_id: account.id, source: "tasks", external_id: t.id, text: t.title.trim(), payload: { ...t, listId: l.id, listTitle: l.title } },
              { onConflict: "account_id,source,external_id", ignoreDuplicates: true },
            ).select();
            if (ins?.[0]) fresh.push(ins[0] as Capture);
          }
        }
        // Also anything captured earlier but not yet processed (e.g. the model was down).
        const { data: pending } = await sb.from("captures").select("*").eq("account_id", account.id).is("processed_at", null).limit(25);
        const batch = (pending || []) as Capture[];
        stats.captures_seen += batch.length;
        if (!batch.length) { await sb.from("accounts").update({ last_sync_at: new Date().toISOString() }).eq("id", account.id); continue; }

        // 2. Decide.
        const calendar = await calendarContext(token, account.label === "family" ? familyCalendar : "primary").catch(() => []);
        const now = new Date().toLocaleString("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
        const { decisions, usage } = await decide(batch, { now, tz, calendar, account }, model);
        stats.model_calls++; stats.input_tokens += usage.input_tokens || 0; stats.output_tokens += usage.output_tokens || 0;

        // 3. Apply.
        for (const cap of batch) {
          const d = decisions.find((x) => x.capture_id === cap.id) || { capture_id: cap.id, action: "ask", reason: "no decision returned" } as Decision;
          try {
            await applyDecision(sb, token, account, cap, d, autonomy, familyCalendar);
            stats.actions_taken++;
            await sb.from("captures").update({ processed_at: new Date().toISOString(), outcome: d }).eq("id", cap.id);
          } catch (e) {
            errors.push(`${account.email}/${cap.id}: ${(e as Error).message}`);
          }
        }
        await sb.from("accounts").update({ last_sync_at: new Date().toISOString() }).eq("id", account.id);
      } catch (e) {
        errors.push(`${account.email}: ${(e as Error).message}`);
      }
    }
  } finally {
    await sb.from("runs").update({ finished_at: new Date().toISOString(), ...stats, error: errors.length ? errors.join(" | ") : null }).eq("id", run!.id);
  }
  return Response.json({ ok: true, ...stats, errors });
});
