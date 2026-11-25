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
  let events = [];
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
  function fmtDate(d) {
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: cfg.timeZone });
  }
  function fmtShort(d) {
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: cfg.timeZone });
  }
  function titleLower(e) {
    return e.title.trim().toLowerCase();
  }
  function personFor(e) {
    const t = titleLower(e);
    for (const p of cfg.people) {
      for (const pre of p.prefixes) {
        if (t.startsWith(pre + ":") || t.startsWith(pre + " -") || t.startsWith(pre + " today") || t === pre) return p.id;
      }
    }
    return "family";
  }
  function isRoutine(e) {
    const t = titleLower(e);
    return cfg.routinePrefixes.some((p) => t.startsWith(p));
  }
  function stripPrefix(e) {
    const t = e.title.trim();
    const m = t.match(/^[^:]{1,12}:\s*(.+)$/);
    return m ? m[1] : t;
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

    const groups = { family: [] };
    cfg.people.forEach((p) => (groups[p.id] = []));
    events.forEach((e) => groups[personFor(e)].push(e));

    const cards = [{ id: "family", name: "Family" }].concat(cfg.people);
    $.board.innerHTML = "";
    for (const c of cards) {
      const list = groups[c.id];
      const card = document.createElement("section");
      card.className = "card person-" + c.id;
      const open = list.filter((e) => state(e, now) !== "done").length;
      card.innerHTML =
        '<header><h2>' + esc(c.name) + '</h2><span class="count">' + (list.length ? open + " to go" : "") + "</span></header>";
      const ul = document.createElement("ul");
      if (!list.length) {
        ul.innerHTML = '<li class="empty">Nothing on</li>';
      }
      for (const e of list) {
        const li = document.createElement("li");
        const st = state(e, now);
        li.className = "ev " + st + (isRoutine(e) ? " routine" : "");
        li.innerHTML =
          '<span class="time">' + (e.allDay ? "All day" : fmtTime(e.start)) + "</span>" +
          '<span class="title">' + esc(stripPrefix(e)) + (e.location ? '<span class="loc"> · ' + esc(e.location) + "</span>" : "") + "</span>";
        ul.appendChild(li);
      }
      card.appendChild(ul);
      $.board.appendChild(card);
    }
  }

  function renderNowBanner(now) {
    if (!sameDay(viewDate, now)) {
      $.now.hidden = true;
      return;
    }
    const timed = events.filter((e) => !e.allDay && !isRoutine(e));
    const current = timed.filter((e) => e.start <= now && e.end > now);
    const next = timed.filter((e) => e.start > now).sort((a, b) => a.start - b.start)[0];
    let html = "";
    if (current.length) {
      html += '<div class="now"><span class="label">Now</span>' + current.map((e) => esc(e.title)).join(" · ") + "</div>";
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
      events = await data.eventsForDay(viewDate);
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

    if (data.mode() === "google") {
      await waitForGoogle();
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
