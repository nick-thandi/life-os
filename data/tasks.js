// In-tray data layer, backed by a Google Tasks list on the family account.
// Uses the same sign-in as the calendar (LifeOSData). Nothing here is shown
// on screen; see intray.js for the UI.
//
// Public API:
//   LifeOSTasks.list()                 -> Promise<Ticket[]>   (open tickets, sorted)
//   LifeOSTasks.add(text)              -> Promise<Ticket>     (text may contain markers)
//   LifeOSTasks.complete(id)           -> Promise<void>
//   LifeOSTasks.parse(text)            -> { title, priority, tag, minutes, big, blocked }
//
// Markers, anywhere in the text or notes, spoken or typed:
//   priority: "urgent" | "high" | "medium" | "low"   (also "!urgent")
//   tag:      home, money, health, family, career, growth, fun   (also "#home")
//   time:     "30 min", "2 hours", "~45m", "1h30"
//   big:      the word "big"
//   blocked:  "blocked: <reason>" or "blocked by <reason>"

(function () {
  const cfg = window.LIFE_OS_CONFIG;
  const LIST_NAMES = (cfg.taskListNames && cfg.taskListNames.length ? cfg.taskListNames : ["In-tray"]).map((n) => n.toLowerCase());
  const BASE = "https://tasks.googleapis.com/tasks/v1";
  const PRIORITIES = ["urgent", "high", "medium", "low"];
  const TAGS = ["home", "money", "health", "family", "career", "growth", "fun"];
  let listIds = null; // all matching lists, preferred first

  function token() {
    const t = window.LifeOSData && window.LifeOSData.accessToken && window.LifeOSData.accessToken();
    if (!t) throw new Error("not signed in");
    return t;
  }

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: Object.assign({ Authorization: "Bearer " + token() }, opts.body ? { "Content-Type": "application/json" } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      window.LifeOSData.dropToken();
      if (!opts._retried && await window.LifeOSData.signInSilently()) return api(path, Object.assign({}, opts, { _retried: true }));
      throw new Error("not signed in");
    }
    if (!res.ok) {
      let reason = "";
      try { const j = await res.json(); reason = (j.error && j.error.message) || ""; } catch (e) { /* no body */ }
      if (res.status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(reason)) {
        throw new Error("Google Tasks API is not enabled in the Life OS Google Cloud project. Enable it under APIs & Services, then reload.");
      }
      if (res.status === 403 && /insufficient/i.test(reason)) {
        window.LifeOSData.dropToken();
        throw new Error("not signed in");
      }
      throw new Error("Google Tasks said: " + (reason || res.status));
    }
    return res.status === 204 ? null : res.json();
  }

  async function ensureLists() {
    if (listIds) return listIds;
    const lists = await api("/users/@me/lists?maxResults=100");
    const items = lists.items || [];
    const found = [];
    const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z]/g, "").replace(/list$/, "").replace(/(?<!mytask)s$/, "");
    for (const name of LIST_NAMES) {
      const n = norm(name);
      for (const l of items) if (norm(l.title) === n && !found.includes(l.id)) found.push(l.id);
    }
    // The first configured name is the home list: create it if missing so new tickets never land in My Tasks.
    const homeName = cfg.taskListNames ? cfg.taskListNames[0] : "Tickets";
    const hasHome = items.some((l) => norm(l.title) === norm(homeName));
    if (!hasHome) {
      const created = await api("/users/@me/lists", { method: "POST", body: { title: homeName } });
      found.unshift(created.id);
    }
    return (listIds = found);
  }

  // ---- parsing ----
  function parse(text) {
    let t = " " + String(text || "").trim() + " ";
    const out = { title: "", priority: "", tag: "", minutes: 0, big: false, blocked: "" };

    const b = t.match(/\bblocked(?:\s*:|\s+by|\s+on)\s+([^.;\n]+)/i);
    if (b) { out.blocked = b[1].trim(); t = t.replace(b[0], " "); }

    for (const p of PRIORITIES) {
      const re = new RegExp("(?:^|\\s)!?" + p + "(?:\\s+priority)?(?=\\s|$)", "i");
      if (re.test(t)) { out.priority = p; t = t.replace(re, " "); break; }
    }
    for (const g of TAGS) {
      const re = new RegExp("(?:^|\\s)#?" + g + "(?=\\s|$)", "i");
      if (re.test(t)) { out.tag = g; t = t.replace(re, " "); break; }
    }
    const time = t.match(/(?:^|\s)~?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?:\s*(\d+)\s*(?:m|min|mins|minutes)?)?(?=\s|$)/i);
    if (time) {
      const n = parseFloat(time[1]);
      const unit = time[2].toLowerCase();
      out.minutes = unit.startsWith("h") ? Math.round(n * 60) + (time[3] ? parseInt(time[3], 10) : 0) : Math.round(n);
      t = t.replace(time[0], " ");
    }
    if (/(?:^|\s)big(?=\s|$)/i.test(t)) { out.big = true; t = t.replace(/(?:^|\s)big(?=\s|$)/i, " "); }

    out.title = t.replace(/\s+/g, " ").trim().replace(/^[,.;:\-]+|[,.;:\-]+$/g, "").trim();
    if (out.title) out.title = out.title[0].toUpperCase() + out.title.slice(1);
    if (out.minutes > 120) out.big = true;
    return out;
  }

  function markers(p) {
    const m = [];
    if (p.priority) m.push("!" + p.priority);
    if (p.tag) m.push("#" + p.tag);
    if (p.minutes) m.push("~" + (p.minutes % 60 === 0 ? p.minutes / 60 + "h" : p.minutes + "m"));
    if (p.big) m.push("big");
    if (p.blocked) m.push("blocked: " + p.blocked);
    return m.join(" ");
  }

  function toTicket(task, listId) {
    const p = parse((task.notes || "") + " " + (task.title || ""));
    // Title is the task's own title; notes carry the markers.
    const fromNotes = parse(task.notes || "");
    return {
      id: task.id,
      listId: listId,
      title: task.title || "(no title)",
      notes: task.notes || "",
      priority: fromNotes.priority || p.priority,
      tag: fromNotes.tag || p.tag,
      minutes: fromNotes.minutes || p.minutes,
      big: fromNotes.big || p.big,
      blocked: fromNotes.blocked || p.blocked,
      due: task.due ? new Date(task.due) : null,
      updated: task.updated ? new Date(task.updated) : null,
    };
  }

  function rank(t) {
    const i = PRIORITIES.indexOf(t.priority);
    return i === -1 ? 9 : i;
  }

  async function list() {
    const ids = await ensureLists();
    const all = [];
    for (const id of ids) {
      const res = await api("/lists/" + id + "/tasks?showCompleted=false&showHidden=false&maxResults=100");
      for (const t of res.items || []) if (t.title && t.title.trim()) all.push(toTicket(t, id));
    }
    return all.sort((a, b) => rank(a) - rank(b) || (b.updated || 0) - (a.updated || 0));
  }

  async function add(text) {
    const p = parse(text);
    if (!p.title) throw new Error("Nothing to add");
    const ids = await ensureLists();
    const task = await api("/lists/" + ids[0] + "/tasks", { method: "POST", body: { title: p.title, notes: markers(p) } });
    return toTicket(task, ids[0]);
  }

  async function complete(taskId, listId) {
    const ids = await ensureLists();
    await api("/lists/" + (listId || ids[0]) + "/tasks/" + taskId, { method: "PATCH", body: { status: "completed" } });
  }

  window.LifeOSTasks = { list, add, complete, parse, PRIORITIES, TAGS };
})();
