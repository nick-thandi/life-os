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
  const LIST_TITLE = "In-tray";
  const BASE = "https://tasks.googleapis.com/tasks/v1";
  const PRIORITIES = ["urgent", "high", "medium", "low"];
  const TAGS = ["home", "money", "health", "family", "career", "growth", "fun"];
  let listId = null;

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
    if (res.status === 401 || res.status === 403) {
      window.LifeOSData.dropToken();
      throw new Error("not signed in");
    }
    if (!res.ok) throw new Error("Tasks request failed (" + res.status + ")");
    return res.status === 204 ? null : res.json();
  }

  async function ensureList() {
    if (listId) return listId;
    const lists = await api("/users/@me/lists?maxResults=100");
    const found = (lists.items || []).find((l) => l.title.toLowerCase() === LIST_TITLE.toLowerCase());
    if (found) return (listId = found.id);
    const created = await api("/users/@me/lists", { method: "POST", body: { title: LIST_TITLE } });
    return (listId = created.id);
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

  function toTicket(task) {
    const p = parse((task.notes || "") + " " + (task.title || ""));
    // Title is the task's own title; notes carry the markers.
    const fromNotes = parse(task.notes || "");
    return {
      id: task.id,
      title: task.title || "(no title)",
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
    const id = await ensureList();
    const res = await api("/lists/" + id + "/tasks?showCompleted=false&showHidden=false&maxResults=100");
    return (res.items || [])
      .filter((t) => t.title && t.title.trim())
      .map(toTicket)
      .sort((a, b) => rank(a) - rank(b) || (b.updated || 0) - (a.updated || 0));
  }

  async function add(text) {
    const p = parse(text);
    if (!p.title) throw new Error("Nothing to add");
    const id = await ensureList();
    const task = await api("/lists/" + id + "/tasks", { method: "POST", body: { title: p.title, notes: markers(p) } });
    return toTicket(task);
  }

  async function complete(taskId) {
    const id = await ensureList();
    await api("/lists/" + id + "/tasks/" + taskId, { method: "PATCH", body: { status: "completed" } });
  }

  window.LifeOSTasks = { list, add, complete, parse, PRIORITIES, TAGS };
})();
