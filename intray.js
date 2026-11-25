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

  function render() {
    $.count.textContent = items.length ? items.length + " in the tray" : "In-tray is empty";
    $.list.innerHTML = "";
    if (!items.length) { $.list.innerHTML = '<li class="empty">Nothing waiting. Add something above or say it.</li>'; return; }
    for (const t of items) {
      const li = document.createElement("li");
      li.className = "ticket p-" + (t.priority || "none");
      li.innerHTML =
        '<button class="done" title="Done" aria-label="Done">✓</button>' +
        '<div class="body"><div class="title">' + esc(t.title) + "</div>" +
        '<div class="meta">' +
        (t.priority ? '<span class="pill pr">' + esc(t.priority) + "</span>" : '<span class="pill pr unset">no priority</span>') +
        (t.tag ? '<span class="pill">' + esc(t.tag) + "</span>" : "") +
        (t.minutes ? '<span class="pill">' + fmtMin(t.minutes) + "</span>" : "") +
        (t.big ? '<span class="pill big">Big</span>' : "") +
        (t.blocked ? '<span class="pill blocked">Blocked: ' + esc(t.blocked) + "</span>" : "") +
        "</div></div>";
      li.querySelector(".done").onclick = async () => {
        li.classList.add("gone");
        try { await tasks.complete(t.id); items = items.filter((x) => x.id !== t.id); render(); }
        catch (e) { li.classList.remove("gone"); $.status.textContent = e.message; }
      };
      $.list.appendChild(li);
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
      $.status.textContent = "In-tray of " + ((await data.who()) || "this account");
      gate(false);
      render();
    } catch (e) {
      if (String(e.message).includes("not signed in")) gate(true, "Sign in with the family Google account to see the in-tray.");
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
    await new Promise((r) => { const t = setInterval(() => { if (window.google && google.accounts && google.accounts.oauth2) { clearInterval(t); r(); } }, 100); setTimeout(() => { clearInterval(t); r(); }, 8000); });
    const ok = await data.signInSilently();
    if (!ok) gate(true, "Sign in with the family Google account to see the in-tray.");
    await load();
    setInterval(load, 5 * 60000);
  })();
})();
