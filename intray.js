// In-tray screen: capture by typing or voice, list by priority, tick off.
(function () {
  const data = window.LifeOSData;
  const tasks = window.LifeOSTasks;
  const el = (id) => document.getElementById(id);
  const $ = {
    status: el("status"), gate: el("gate"), gateMsg: el("gate-message"), signin: el("signin"),
    form: el("add-form"), input: el("add-input"), mic: el("mic"), preview: el("preview"),
    list: el("list"), count: el("count"), main: el("main"),
  };
  let items = [];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtMin = (m) => (!m ? "" : m % 60 === 0 ? m / 60 + " h" : m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + " min");

  const SECTIONS = [["urgent", "🔥 Urgent"], ["high", "⚡ High"], ["medium", "📌 Medium"], ["low", "🐢 Low"], ["", "📦 Backlog"]];
  const AREA = Object.assign({ home: "🏠", money: "💷", health: "💪", family: "👨‍👩‍👧‍👦", career: "💼", growth: "🌱", fun: "🎉" }, (window.LIFE_OS_CONFIG || {}).areaEmoji || {});
  const areaLabel = (g) => (AREA[g] ? AREA[g] + " " : "") + cap(g);
  const open = new Set();
  // Which area is showing ("" = all, "none" = tickets with no area) and which priority cards are folded away. Remembered per device.
  const store = { get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } } };
  let area = store.get("lifeos.intray.area", "");
  const shut = new Set(store.get("lifeos.intray.shut", []));
  function chips() {
    const present = (tasks.TAGS || []).filter((g) => items.some((t) => t.tag === g));
    const none = items.filter((t) => !t.tag).length;
    if (area && area !== "none" && !present.includes(area)) area = "";
    if (area === "none" && !none) area = "";
    if (present.length + (none ? 1 : 0) < 2) return null;
    const row = document.createElement("div");
    row.className = "day-strip chips";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Show one area");
    const add = (key, label, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label + " " + n;
      if (area === key) b.className = "active";
      b.setAttribute("aria-pressed", String(area === key));
      b.onclick = () => { area = key; store.set("lifeos.intray.area", area); render(); };
      row.appendChild(b);
    };
    add("", "All", items.length);
    present.forEach((g) => add(g, areaLabel(g), items.filter((t) => t.tag === g).length));
    if (none) add("none", "📥 No area", none);
    return row;
  }
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  // Notes without the marker line; links become a tappable "Open the email".
  function notesHTML(t) {
    const lines = String(t.notes || "").split("\n").filter((l) => l.trim() && !/^\s*(!|#|~|big\b|blocked:)/i.test(l.trim()));
    return lines.map((l) => /^https?:\/\//.test(l.trim()) ? '<a href="' + esc(l.trim()) + '" target="_blank" rel="noopener">Open the email</a>' : esc(l)).join("<br>");
  }
  function render() {
    $.count.textContent = items.length ? items.length + (items.length === 1 ? " ticket" : " tickets") : "";
    $.list.innerHTML = "";
    if (!items.length) {
      const cleared = sessionStorage.getItem("lifeos.intray.hadItems") === "1";
      $.list.innerHTML = cleared
        ? '<div class="state"><h3>All clear</h3><p>Everything in the tray is done or scheduled.</p></div>'
        : '<div class="state"><h3>Nothing in the tray yet</h3><p>Type or say the first thing on your mind: "Book the dentist, high, health, 10 min".</p></div>';
      return;
    }
    try { sessionStorage.setItem("lifeos.intray.hadItems", "1"); } catch (e) { /* ignore */ }
    const row = chips();
    if (row) $.list.appendChild(row);
    const shown = !area ? items : area === "none" ? items.filter((t) => !t.tag) : items.filter((t) => t.tag === area);
    for (const [key, label] of SECTIONS) {
      const group = shown.filter((t) => (t.priority || "") === key);
      if (!group.length) continue;
      const sec = document.createElement("section");
      const isShut = shut.has(key || "backlog");
      sec.className = "card tone-" + (key || "sort") + (isShut ? " shut" : " unfolded");
      sec.innerHTML = '<button type="button" class="card-head sec-toggle" aria-expanded="' + !isShut + '"><span class="head-text"><span class="name">' + label + '</span></span><span class="count">' + group.length + '</span><span class="chev" aria-hidden="true"></span></button>';
      sec.querySelector(".sec-toggle").onclick = () => { const k = key || "backlog"; shut.has(k) ? shut.delete(k) : shut.add(k); store.set("lifeos.intray.shut", [...shut]); render(); };
      const ul = document.createElement("ul");
      for (const t of group) {
        const li = document.createElement("li");
        const meta = [t.tag ? areaLabel(t.tag) : "", t.minutes ? "⏱ " + fmtMin(t.minutes) : "", t.big ? "🏗 Big job" : ""].filter(Boolean).join(" · ");
        const notes = notesHTML(t), isOpen = open.has(t.id);
        li.className = "tk";
        li.innerHTML =
          '<button class="done" aria-label="Mark done: ' + esc(t.title) + '"></button>' +
          '<div class="what"' + (notes ? ' role="button" tabindex="0" aria-expanded="' + isOpen + '"' : "") + '><span class="title">' + esc(t.title) + "</span>" +
          (meta ? '<span class="sup">' + esc(meta) + "</span>" : "") +
          (t.blocked ? '<span class="sup blocked">Blocked: ' + esc(t.blocked) + "</span>" : "") +
          (notes && isOpen ? '<span class="sup notes">' + notes + "</span>" : "") + "</div>" +
          (notes ? '<span class="chev' + (isOpen ? " up" : "") + '" aria-hidden="true"></span>' : "");
        li.querySelector(".done").onclick = async () => {
          li.classList.add("gone");
          try { await tasks.complete(t.id, t.listId); items = items.filter((x) => x.id !== t.id); render(); }
          catch (e) { li.classList.remove("gone"); $.status.textContent = e.message; }
        };
        if (notes) { const w = li.querySelector(".what"); const tog = (ev) => { if (ev.target.tagName === "A") return; open.has(t.id) ? open.delete(t.id) : open.add(t.id); render(); }; w.onclick = tog; w.onkeydown = (ev) => { if (ev.key === "Enter") tog(ev); }; }
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      $.list.appendChild(sec);
    }
  }

  function showPreview() {
    const v = $.input.value.trim();
    if (!v) { $.preview.textContent = ""; return; }
    const p = tasks.parse(v);
    const bits = [p.priority || "no priority", p.tag || "no tag", p.minutes ? fmtMin(p.minutes) : "no time", p.big ? "big" : "", p.blocked ? "blocked" : ""].filter(Boolean);
    $.preview.textContent = (p.title || "…") + "  ·  " + bits.join(" · ");
  }

  async function load() {
    try {
      $.status.textContent = "Updating…";
      items = await tasks.list();
      $.status.textContent = ((await data.who()) || "This account");
      gate(false);
      render();
    } catch (e) {
      if (String(e.message).includes("not signed in")) gate(true, "Sign in with your own Google account (or the family account on the TV) to see your in-tray.");
      else $.status.textContent = "Could not update: " + e.message;
    }
  }

  function gate(on, msg) {
    $.gate.hidden = !on;
    $.main.hidden = on;
    if (msg) $.gateMsg.textContent = msg;
  }

  async function addFromInput() {
    const text = $.input.value.trim();
    if (!text) return;
    $.input.value = "";
    $.preview.textContent = "";
    $.status.textContent = "Adding…";
    try {
      // Several lines = several tickets (handy for pasting a list).
      const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) await tasks.add(line);
      await load();
    } catch (e) {
      $.status.textContent = "Could not add: " + e.message;
      $.input.value = text;
    }
  }

  // ---- voice ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $.mic.hidden = true;
  } else {
    let rec = null;
    $.mic.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = "en-GB";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      $.mic.classList.add("listening");
      $.status.textContent = "Listening… say the task, then a priority, a tag and a time.";
      let finalText = "";
      rec.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
          else interim += ev.results[i][0].transcript;
        }
        $.input.value = (finalText + " " + interim).trim();
        showPreview();
      };
      rec.onerror = (ev) => { $.status.textContent = "Voice: " + ev.error; };
      rec.onend = () => {
        $.mic.classList.remove("listening");
        rec = null;
        if ($.input.value.trim()) { $.status.textContent = "Heard it. Check, then press Add."; $.input.focus(); }
        else $.status.textContent = "Nothing heard.";
      };
      rec.start();
    };
  }

  // ---- wiring ----
  $.form.onsubmit = (e) => { e.preventDefault(); addFromInput(); };
  $.input.oninput = showPreview;
  $.input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addFromInput(); } };
  $.signin.onclick = async () => { try { await data.signIn(); await load(); } catch (e) { $.gateMsg.textContent = "Sign-in did not complete: " + e.message; } };

  (async function start() {
    if (data.mode() !== "google") { gate(true, "The in-tray needs the Google sign-in; demo mode has no in-tray."); $.signin.hidden = true; return; }
    const ok = await data.signInSilently();
    if (!ok) gate(true, "Sign in with your own Google account (or the family account on the TV) to see your in-tray.");
    await load();
    setInterval(load, 5 * 60000);
  })();
})();
