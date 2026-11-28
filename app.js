// Today screen. Renders the same data as a phone/laptop page or a TV page.
(function () {
  const cfg = window.LIFE_OS_CONFIG;
  const data = window.LifeOSData;
  const tv = document.body.classList.contains("tv");

  const el = (id) => document.getElementById(id);
  const $ = {
    date: el("date"),
    clock: el("clock"),
    status: el("status"),
    gate: el("gate"),
    gateMsg: el("gate-message"),
    signin: el("signin"),
    signout: el("signout"),
    board: el("board"),
    now: el("now-banner"),
    dayStrip: el("day-strip"),
  };

  let viewDate = startOfDay(new Date());
  let events = [];      // family calendar
  let ownEvents = [];   // signed-in person's own calendar
  let view = "family"; // single view: every person is a card; tap your own for your day
  let refreshTimer = null;

  // ---------- helpers ----------
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function fmtTime(d) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: cfg.timeZone });
  }
  // "10:00–11:00"; a very short block (under 20 min) shows its start only.
  function fmtSpan(e) {
    if (e.allDay) return "All day";
    const mins = (e.end - e.start) / 60000;
    if (mins < 20) return fmtTime(e.start);
    return fmtTime(e.start) + "–" + fmtTime(e.end);
  }
  function fmtDate(d) {
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: cfg.timeZone });
  }
  function fmtShort(d) {
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: cfg.timeZone });
  }
  function titleLower(e) {
    return e.title.trim().toLowerCase();
  }
  function personId(name) {
    const n = name.trim().toLowerCase();
    for (const p of cfg.people) if (p.prefixes.includes(n)) return p.id;
    return null;
  }
  // Splits "Mum and Dad: date night (bring coats)" into who, what and a detail.
  function parse(e) {
    if (e._p) return e._p;
    let t = e.title.trim(), ids = [], routine = false;
    const m = t.match(/^([^:]{1,24}):\s*(.+)$/);
    if (m) {
      const head = m[1].trim();
      if (cfg.routinePrefixes.includes(head.toLowerCase())) { routine = true; t = m[2]; }
      else {
        const parts = head.split(/\s*(?:,|&|\+|\band\b)\s*/i).map(personId);
        if (parts.length && parts.every(Boolean)) { ids = parts; t = m[2]; }
        else if (head.toLowerCase() === "family") { t = m[2]; }
      }
    } else if (cfg.routinePrefixes.some((r) => t.toLowerCase().startsWith(r))) routine = true;
    // Others named in the text: "with Dad", "+ Pooks".
    for (const p of cfg.people) {
      if (ids.includes(p.id)) continue;
      if (ids.length && p.prefixes.some((pre) => new RegExp("(with|\\+|and|&)\\s+" + pre + "(\\b|'s)", "i").test(t))) ids.push(p.id);
    }
    if (!ids.length) {
      const g = Object.keys(cfg.groups || {}).find((k) => new RegExp("^" + k + "\\b", "i").test(t));
      if (g) ids = cfg.groups[g].slice();
      else if (e.owner) ids = [e.owner];
    }
    let detail = "";
    const d = t.match(/^(.*?)\s*\((.+)\)\s*$/);
    if (d && d[1]) { t = d[1]; detail = d[2]; }
    t = t.charAt(0).toUpperCase() + t.slice(1);
    detail = detail.charAt(0).toUpperCase() + detail.slice(1);
    return (e._p = { ids: ids.length ? ids : ["family"], what: t, detail, routine });
  }
  const peopleFor = (e) => parse(e).ids;
  const isRoutine = (e) => parse(e).routine;
  const nameOf = (id) => (cfg.people.find((p) => p.id === id) || { name: "Family" }).name;
  const avatarOf = (id) => (cfg.people.find((p) => p.id === id) || { avatar: cfg.familyAvatar || "" }).avatar || "";
  function avatars(ids) {
    // An event for the whole family shows everyone's face.
    if (ids.length === 1 && ids[0] === "family") { ids = cfg.people.map((p) => p.id); if (!ids.length) ids = ["family"]; }
    return '<span class="who' + (ids.length > 2 ? " many" : "") + '" aria-label="' + esc(ids.length === cfg.people.length && ids.length > 2 ? "Everyone" : ids.map(nameOf).join(" and ")) + '">' + ids.map((id) => '<span class="av av-' + id + '" title="' + esc(nameOf(id)) + '">' + avatarOf(id) + "</span>").join("") + "</span>";
  }
  // One row, used by every card: time, title, optional supporting line, and who is involved.
  function row(e, now, forId) {
    const p = parse(e), st = state(e, now);
    const sup = [p.detail, e.location].filter(Boolean).join(" · ");
    const showWho = forId === "all" ? true : p.ids.length > 1 || p.ids[0] === "family";
    const li = document.createElement("li");
    li.className = "ev " + st;
    li.innerHTML = '<span class="time">' + fmtSpan(e) + "</span>" +
      '<span class="what"><span class="title">' + esc(p.what) + (st === "now" ? ' <span class="badge">Now</span>' : "") + "</span>" +
      (sup ? '<span class="sup">' + esc(sup) + "</span>" : "") + "</span>" +
      (showWho ? avatars(p.ids) : "");
    return li;
  }
  function state(e, now) {
    if (e.allDay) return "allday";
    if (e.end <= now) return "done";
    // Something that runs for half a day or more (an overnight stay) is background, not "now".
    if (e.start <= now) return e.end - e.start >= 12 * 3600000 ? "ongoing" : "now";
    return "later";
  }

  // ---------- rendering ----------
  const sortEv = (a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1);
  const meId = () => personId(data.label() || "");
  const expanded = new Set();
  const wide = () => tv || window.matchMedia("(min-width: 768px)").matches;

  // Day notes: calendar entries titled "Helper: ..." or "Menu: ..." are shown as a strip above the cards, not as events.
  const NOTES = [["helper", /^(today'?s\s+)?helper\s*:\s*/i, "Today's helper", "🤝"], ["menu", /^(on\s+the\s+)?(menu|dinner\s+menu)\s*:\s*/i, "On the menu", "🍲"]];
  const noteKind = (e) => NOTES.find((n) => n[1].test(e.title.trim()));
  function everything() { return events.concat(ownEvents).filter((e) => !noteKind(e)).sort(sortEv); }
  function dayNotes() {
    const out = [];
    for (const n of NOTES) {
      const vals = events.concat(ownEvents).filter((e) => noteKind(e) === n).map((e) => e.title.trim().replace(n[1], "").trim()).filter(Boolean);
      // No calendar entry for the day: fall back to the weekly lists in config.js (0 = Sunday).
      const fallback = ((n[0] === "menu" ? cfg.menu : cfg.helpers) || {})[viewDate.getDay()];
      if (vals.length) out.push({ label: n[2], icon: n[3], value: [...new Set(vals)].join(", ") });
      else if (fallback) out.push({ label: n[2], icon: n[3], value: fallback });
    }
    if (!out.length) return null;
    const el = document.createElement("div");
    el.className = "info-strip" + (out.length === 1 ? " one" : "");
    el.innerHTML = out.map((o) => '<div class="tile"><span class="icon" aria-hidden="true">' + o.icon + '</span><span class="txt"><span class="label">' + esc(o.label) + '</span><span class="value">' + esc(o.value.charAt(0).toUpperCase() + o.value.slice(1)) + "</span></span></div>").join("");
    return el;
  }
  function mineOnly() { const me = meId(); return everything().filter((e) => { const ids = peopleFor(e); return ids.includes(me) || ids[0] === "family"; }); }
  function summary(list, now) {
    const cur = list.find((e) => state(e, now) === "now");
    if (cur) return "Now: " + parse(cur).what;
    const next = list.filter((e) => !e.allDay && e.start > now)[0];
    if (next) return "Next " + fmtTime(next.start) + ": " + parse(next).what;
    return list.length ? "All done for today" : "Nothing planned";
  }

  function render() {
    const now = new Date();
    $.date.textContent = fmtDate(viewDate);
    $.clock.textContent = fmtTime(now);
    renderDayStrip();
    renderNowBanner(now);
    renderViewSwitch();
    $.board.innerHTML = "";
    $.board.className = "board view-" + view;
    const notes = dayNotes();
    if (notes) $.board.appendChild(notes);

    if (view === "me") {
      const me = meId(), list = mineOnly();
      $.board.appendChild(card({ id: me, name: nameOf(me) + "'s day" }, list, now, true));
      return;
    }
    const groups = { family: [] };
    cfg.people.forEach((p) => (groups[p.id] = []));
    everything().forEach((e) => peopleFor(e).forEach((id) => groups[id].push(e)));
    const me = meId();
    const cards = [{ id: "family", name: "Everyone" }].concat(cfg.people).sort((a, b) => (b.id === me) - (a.id === me));
    if (me && !render.opened) { expanded.add(me); render.opened = true; }
    for (const c of cards) { if (c.id === "family" && !groups.family.length) continue; $.board.appendChild(card(c, groups[c.id], now, wide() || expanded.has(c.id))); }
  }

  function card(c, list, now, open) {
    const el = document.createElement("section");
    el.className = "card person-" + c.id + (open ? " open" : "");
    const left = list.filter((e) => state(e, now) !== "done").length;
    const head = document.createElement(wide() || view === "me" ? "div" : "button");
    head.className = "card-head";
    if (head.tagName === "BUTTON") { head.setAttribute("aria-expanded", String(open)); head.onclick = () => { expanded.has(c.id) ? expanded.delete(c.id) : expanded.add(c.id); render(); }; }
    head.innerHTML = '<span class="av av-lg av-' + c.id + '">' + avatarOf(c.id) + "</span>" +
      '<span class="head-text"><span class="name">' + esc(c.name) + '</span><span class="summary">' + esc(summary(list, now)) + "</span></span>" +
      '<span class="count">' + (list.length ? (left ? left + " to go" : "Done") : "") + "</span>" +
      (head.tagName === "BUTTON" ? '<span class="chev" aria-hidden="true"></span>' : "");
    el.appendChild(head);
    if (open) {
      const ul = document.createElement("ul");
      if (!list.length) ul.innerHTML = '<li class="empty">Nothing planned</li>';
      for (const e of list) ul.appendChild(row(e, now, view === "me" ? c.id : c.id));
      el.appendChild(ul);
    }
    return el;
  }

  function renderViewSwitch() {
    const el = document.getElementById("view-switch");
    if (!el || tv) return;
    el.hidden = true;
    el.querySelectorAll("button").forEach((b) => { b.className = b.dataset.view === view ? "active" : ""; b.setAttribute("aria-pressed", String(b.dataset.view === view)); });
  }

  function renderNowBanner(now) {
    if (!sameDay(viewDate, now)) {
      $.now.hidden = true;
      return;
    }
    const pool = view === "me" ? mineOnly() : everything();
    const timed = pool.filter((e) => !e.allDay && !isRoutine(e));
    const current = timed.filter((e) => e.start <= now && e.end > now && e.end - e.start < 12 * 3600000);
    const next = timed.filter((e) => e.start > now).sort((a, b) => a.start - b.start)[0];
    let html = "";
    if (current.length) {
      html += '<div class="now"><span class="label">Now</span>' + current.map((e) => esc(e.title) + ' <span class="when">until ' + fmtTime(e.end) + "</span>").join(" · ") + "</div>";
    }
    if (next) {
      const mins = Math.round((next.start - now) / 60000);
      const when = mins < 60 ? "in " + mins + " min" : "at " + fmtTime(next.start);
      html += '<div class="next"><span class="label">Next</span>' + esc(next.title) + " <span class='when'>" + when + "</span></div>";
    }
    $.now.innerHTML = html;
    $.now.hidden = !html;
  }

  function renderDayStrip() {
    if (!$.dayStrip) return;
    const today = startOfDay(new Date());
    $.dayStrip.innerHTML = "";
    for (let i = -1; i <= 5; i++) {
      const d = new Date(today.getTime() + i * 86400000);
      const b = document.createElement("button");
      b.textContent = i === 0 ? "Today" : fmtShort(d);
      b.className = sameDay(d, viewDate) ? "active" : "";
      b.onclick = () => {
        viewDate = d;
        load();
      };
      $.dayStrip.appendChild(b);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- loading ----------
  async function load() {
    try {
      $.status.textContent = "Updating…";
      const [fam, own] = await Promise.all([data.eventsForDay(viewDate), data.peopleEventsForDay(viewDate)]);
      events = fam; ownEvents = own;
      events.sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
      $.status.textContent = data.mode() === "demo" ? "Demo data" : "Updated " + fmtTime(new Date());
      showGate(false);
      render();
    } catch (err) {
      if (String(err.message).includes("not signed in")) {
        showGate(true, "Sign in with Google (your own account on your phone, the family account on the TV) to see today.");
      } else {
        $.status.textContent = "Could not update: " + err.message;
      }
    }
  }

  function showGate(on, msg) {
    $.gate.hidden = !on;
    $.board.hidden = on;
    $.now.hidden = on || $.now.hidden;
    if (msg) $.gateMsg.textContent = msg;
    $.signout.hidden = data.mode() === "demo" || on;
  }

  async function start() {
    const sw = document.getElementById("view-switch");
    if (sw) sw.querySelectorAll("button").forEach((b) => (b.onclick = () => { view = b.dataset.view; try { localStorage.setItem("lifeos.view", view); } catch (e) {} render(); }));
    $.signin.onclick = async () => {
      try {
        await data.signIn();
        await load();
      } catch (e) {
        $.gateMsg.textContent = "Sign-in did not complete: " + e.message;
      }
    };
    $.signout.onclick = () => {
      data.signOut();
      showGate(true, "Signed out.");
    };

    if (window.__lifeosSignInError) showGate(true, "Sign-in did not complete: " + window.__lifeosSignInError);
    if (data.mode() === "google") {
      const ok = await data.signInSilently();
      if (!ok) {
        showGate(true, "Sign in with Google (your own account on your phone, the family account on the TV) to see today.");
      }
    }
    await load();

    setInterval(() => {
      $.clock.textContent = fmtTime(new Date());
      render();
    }, 30000);
    refreshTimer = setInterval(async () => {
      if (data.mode() === "google" && !data.isSignedIn()) await data.signInSilently();
      load();
    }, cfg.refreshMinutes * 60000);

    // Midnight rollover for screens that stay on.
    setInterval(() => {
      const today = startOfDay(new Date());
      if (!sameDay(today, viewDate) && viewDate < today && !document.body.dataset.pinned) {
        viewDate = today;
        load();
      }
    }, 60000);
  }

  function waitForGoogle() {
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (window.google && google.accounts && google.accounts.oauth2) {
          clearInterval(t);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(t); resolve(); }, 8000);
    });
  }

  start();
})();
