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
  let view = (!tv && localStorage.getItem("lifeos.view")) || "family"; // "me" | "family"
  const canMe = !tv;
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
  // One row, used by every card: time, title, optional supporting line.
  function row(e, now, forId) {
    const p = parse(e), st = state(e, now);
    const others = p.ids.filter((id) => id !== forId && id !== "family").map(nameOf);
    const sup = [forId === "all" && p.ids[0] !== "family" ? p.ids.map(nameOf).join(" and ") : (others.length ? "With " + others.join(" and ") : ""), p.detail, e.location].filter(Boolean).join(" · ");
    const li = document.createElement("li");
    li.className = "ev " + st;
    li.innerHTML = '<span class="time">' + fmtSpan(e) + "</span>" +
      '<span class="what"><span class="title">' + esc(p.what) + (st === "now" ? ' <span class="badge">Now</span>' : "") + "</span>" +
      (sup ? '<span class="sup">' + esc(sup) + "</span>" : "") + "</span>";
    return li;
  }
  function state(e, now) {
    if (e.allDay) return "allday";
    if (e.end <= now) return "done";
    if (e.start <= now) return "now";
    return "later";
  }

  // ---------- rendering ----------
  function render() {
    const now = new Date();
    $.date.textContent = fmtDate(viewDate) + (sameDay(viewDate, now) ? "" : "");
    $.clock.textContent = fmtTime(now);

    renderDayStrip();
    renderNowBanner(now);
    renderViewSwitch();

    if (view === "me") { renderMe(now); return; }

    const groups = { family: [] };
    cfg.people.forEach((p) => (groups[p.id] = []));
    events.forEach((e) => peopleFor(e).forEach((id) => groups[id].push(e)));

    const cards = [{ id: "family", name: "Family" }].concat(cfg.people);
    $.board.innerHTML = "";
    for (const c of cards) {
      const list = groups[c.id];
      const card = document.createElement("section");
      card.className = "card person-" + c.id;
      const open = list.filter((e) => state(e, now) !== "done").length;
      card.innerHTML =
        '<header><h2>' + esc(c.name) + '</h2><span class="count">' + (list.length ? (open ? open + " to go" : "All done") : "") + "</span></header>";
      const ul = document.createElement("ul");
      if (!list.length) {
        ul.innerHTML = '<li class="empty">' + (c.id === "family" ? "Nothing for everyone today" : "Nothing planned") + "</li>";
      }
      for (const e of list) ul.appendChild(row(e, now, c.id));
      card.appendChild(ul);
      $.board.appendChild(card);
    }
  }

  function renderViewSwitch() {
    const el = document.getElementById("view-switch");
    if (!el || !canMe) return;
    el.hidden = false;
    el.querySelectorAll("button").forEach((b) => { b.className = b.dataset.view === view ? "active" : ""; b.setAttribute("aria-pressed", String(b.dataset.view === view)); });
  }

  // "Me": one chronological day, family calendar plus my own calendar.
  function renderMe(now) {
    const me = personId(data.label() || "") || null;
    const mine = me ? events.filter((e) => { const ids = peopleFor(e); return ids.includes(me) || ids[0] === "family"; }) : events;
    const all = mine.concat(ownEvents).sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
    $.board.innerHTML = "";
    const card = document.createElement("section");
    card.className = "card me";
    const open = all.filter((e) => state(e, now) !== "done").length;
    card.innerHTML = '<header><h2>My day</h2><span class="count">' + (all.length ? (open ? open + " to go" : "All done") : "") + "</span></header>";
    const ul = document.createElement("ul");
    if (!all.length) ul.innerHTML = '<li class="empty">Nothing planned</li>';
    for (const e of all) ul.appendChild(row(e, now, me || "all"));
    card.appendChild(ul);
    $.board.appendChild(card);
  }
  function renderNowBanner(now) {
    if (!sameDay(viewDate, now)) {
      $.now.hidden = true;
      return;
    }
    const pool = view === "me" ? events.concat(ownEvents) : events;
    const timed = pool.filter((e) => !e.allDay && !isRoutine(e));
    const current = timed.filter((e) => e.start <= now && e.end > now);
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
      const [fam, own] = await Promise.all([data.eventsForDay(viewDate), canMe ? data.ownEventsForDay(viewDate) : Promise.resolve([])]);
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
