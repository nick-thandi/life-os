// Life OS · seed-routine (one-off admin)
// Creates recurring "Routine:" events on a connected account's own calendar using the
// permission already stored in Vault. POST { email, events: [{ summary, start, end, byday, description? }] }
// start/end are local times "HH:MM" on the given first date; byday like "MO,WE,FR".
// Protected: requires the project's service role key as Bearer (only callable from inside the project).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const body = await req.json();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // One-time nonce set in settings by the operator; consumed on use.
  const { data: n } = await sb.from("settings").select("value").eq("key", "seed_nonce").single();
  if (!n || !body.nonce || n.value !== body.nonce) return new Response("forbidden", { status: 403 });
  await sb.from("settings").delete().eq("key", "seed_nonce");
  const { data: acc } = await sb.from("accounts").select("id,email").eq("email", String(body.email).toLowerCase()).single();
  if (!acc) return Response.json({ error: "no such account" }, { status: 404 });
  const { data: refresh } = await sb.rpc("get_google_token", { p_account_id: acc.id });
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const tok = (await tr.json()).access_token;
  const results: any[] = [];
  for (const e of body.events) {
    const ev = {
      summary: e.summary,
      description: e.description || "Life OS routine",
      start: { dateTime: `${e.date}T${e.start}:00`, timeZone: "Europe/London" },
      end: { dateTime: `${e.date}T${e.end}:00`, timeZone: "Europe/London" },
      recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${e.byday}`],
      transparency: "transparent",
      reminders: { useDefault: false },
      extendedProperties: { private: { lifeos: "routine" } },
    };
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(ev),
    });
    const j = await r.json();
    results.push({ summary: e.summary, ok: r.ok, id: j.id, error: j.error?.message });
  }
  await sb.from("actions").insert({ account_id: acc.id, kind: "noted", summary: `Routine seeded: ${results.filter((r) => r.ok).length} recurring events on ${acc.email}`, details: results });
  return Response.json({ results });
});
