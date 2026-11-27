// Activity screen: everything the brain did, newest first, with Undo and Approve.
(function () {
  const data = window.LifeOSData, act = window.LifeOSActivity;
  const el = (id) => document.getElementById(id);
  const $ = { status: el("status"), gate: el("gate"), gateMsg: el("gate-message"), signin: el("signin"), main: el("main"), list: el("list"), mode: el("mode") };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KIND = { ticket_filed: "Filed a ticket", event_created: "Added to calendar", suggested: "Suggestion", flagged: "Needs you", noted: "Skipped", undone: "Undone" };
  const nice = (text) => String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?/g, (m) => { const d = new Date(m); return isNaN(d) ? m : d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: window.LIFE_OS_CONFIG.timeZone }); });
  const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: window.LIFE_OS_CONFIG.timeZone });

  function render(res) {
    $.mode.textContent = res.brain_enabled ? ({ suggest: "Brain is watching only", suggest_then_act: "Brain files tickets; calendar changes wait for your approval", full: "Brain files tickets and calendar" }[res.autonomy] || res.autonomy) : "Brain is switched off";
    $.list.innerHTML = "";
    if (!res.actions.length) { $.list.innerHTML = '<li class="state"><h3>Nothing yet</h3><p>When the brain files a ticket or proposes a calendar change, it shows up here with an undo.</p></li>'; return; }
    for (const a of res.actions) {
      const li = document.createElement("li");
      li.className = "act kind-" + a.kind + (a.undone_at ? " done" : "");
      li.innerHTML =
        '<div class="body"><div class="kind">' + esc(KIND[a.kind] || a.kind) + ' <span class="who">' + esc(a.account || "") + " · " + fmt(a.created_at) + "</span></div>" +
        '<div class="title">' + esc(nice(a.summary)) + "</div>" +
        (a.details && a.details.reason ? '<div class="why">' + esc(a.details.reason) + "</div>" : "") + "</div>" +
        '<div class="btns">' +
        (a.can_approve ? '<button class="approve">Approve</button>' : "") +
        (a.can_undo ? '<button class="undo">Undo</button>' : "") +
        (a.undone_at && a.kind !== "suggested" ? '<span class="pill">undone</span>' : a.undone_at ? '<span class="pill">handled</span>' : "") +
        "</div>";
      const b1 = li.querySelector(".undo"), b2 = li.querySelector(".approve");
      if (b1) b1.onclick = async () => { b1.disabled = true; try { await act.undo(a.id); await load(); } catch (e) { $.status.textContent = e.message; b1.disabled = false; } };
      if (b2) b2.onclick = async () => { b2.disabled = true; try { await act.approve(a.id); await load(); } catch (e) { $.status.textContent = e.message; b2.disabled = false; } };
      $.list.appendChild(li);
    }
  }
  function gate(on, msg) { $.gate.hidden = !on; $.main.hidden = on; if (msg) $.gateMsg.textContent = msg; }
  async function load() {
    try { $.status.textContent = "Updating…"; const res = await act.list(); $.status.textContent = "Activity for " + res.me; gate(false); render(res); }
    catch (e) { if (String(e.message).includes("not signed in")) gate(true, "Sign in with your own Google account to see what the brain did."); else $.status.textContent = "Could not update: " + e.message; }
  }
  $.signin.onclick = async () => { try { await data.signIn(); await load(); } catch (e) { $.gateMsg.textContent = "Sign-in did not complete: " + e.message; } };
  (async function start() {
    if (data.mode() !== "google") { gate(true, "Activity needs the Google sign-in."); $.signin.hidden = true; return; }
    await new Promise((r) => { const t = setInterval(() => { if (window.google && google.accounts && google.accounts.oauth2) { clearInterval(t); r(); } }, 100); setTimeout(() => { clearInterval(t); r(); }, 8000); });
    const ok = await data.signInSilently();
    if (!ok) gate(true, "Sign in with your own Google account to see what the brain did.");
    await load();
    setInterval(load, 2 * 60000);
  })();
})();
