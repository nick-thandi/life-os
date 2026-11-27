// Activity screen: everything the brain did, newest first, with Undo and Approve.
(function () {
  const data = window.LifeOSData, act = window.LifeOSActivity;
  const el = (id) => document.getElementById(id);
  const $ = { status: el("status"), gate: el("gate"), gateMsg: el("gate-message"), signin: el("signin"), main: el("main"), list: el("list"), mode: el("mode") };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KIND = { ticket_filed: "Filed a ticket", event_created: "Added to calendar", suggested: "Suggestion", flagged: "Needs you", noted: "Skipped", undone: "Undone" };
  const nice = (text) => String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?/g, (m) => { const d = new Date(m); return isNaN(d) ? m : d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: window.LIFE_OS_CONFIG.timeZone }); });
  const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: window.LIFE_OS_CONFIG.timeZone });

  const C = window.LIFE_OS_CONFIG;
  const av = (label) => { const p = (C.people || []).find((x) => x.id === label); return '<span class="av av-' + (p ? p.id : "family") + '">' + (p ? p.avatar : C.familyAvatar || "") + "</span>"; };
  // "From email: Pay Octopus (!high #money ~15m)" -> title + plain-words detail
  function tidy(a) {
    let t = nice(a.summary).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => new Date(Date.UTC(+y, +mo - 1, +d, 12)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })).replace(/^(Filed|From email|Added from chat|Needs you|Skipped|Would file ticket|Would file from email|Would add to \w+ calendar|Approved by [^:]+|Undone by [^:]+):\s*/i, "");
    const m = t.match(/\s*\(([!#~][^)]*)\)\s*$/);
    let meta = "";
    if (m) { t = t.slice(0, m.index); meta = m[1].replace(/!(\w+)/, "$1 priority").replace(/#(\w+)/, "$1").replace(/~(\d+)m/, "$1 min").replace(/~(\d+)h/, "$1 h").split(/\s+(?=\w+ priority|[a-z]+$|\d)/).join(" · "); }
    t = t.replace(/^Would add check on /i, "Reminder on ");
    return { title: t.charAt(0).toUpperCase() + t.slice(1), meta };
  }
  function item(a) {
    const li = document.createElement("li"), x = tidy(a);
    li.className = "tk act" + (a.undone_at ? " done" : "");
    const why = a.details && a.details.reason ? a.details.reason : "";
    li.innerHTML = av(a.account) +
      '<div class="what"><span class="title">' + esc(x.title) + "</span>" +
      '<span class="sup">' + esc([KIND[a.kind] || a.kind, fmt(a.created_at)].join(" · ")) + "</span>" +
      (why ? '<span class="sup">' + esc(why) + "</span>" : "") + "</div>" +
      '<div class="btns">' + (a.can_approve ? '<button class="approve">Approve</button>' : "") + (a.can_undo ? '<button class="undo">Undo</button>' : "") + "</div>";
    const b1 = li.querySelector(".undo"), b2 = li.querySelector(".approve");
    if (b1) b1.onclick = async () => { b1.disabled = true; try { await act.undo(a.id); await load(); } catch (e) { $.status.textContent = e.message; b1.disabled = false; } };
    if (b2) b2.onclick = async () => { b2.disabled = true; try { await act.approve(a.id); await load(); } catch (e) { $.status.textContent = e.message; b2.disabled = false; } };
    return li;
  }
  function section(title, tone, list) {
    const sec = document.createElement("section");
    sec.className = "card tone-" + tone;
    sec.innerHTML = '<div class="card-head"><span class="head-text"><span class="name">' + title + '</span></span><span class="count">' + list.length + "</span></div>";
    const ul = document.createElement("ul");
    list.forEach((a) => ul.appendChild(item(a)));
    sec.appendChild(ul);
    return sec;
  }
  function render(res) {
    KIND.ticket_filed = "Ticket filed"; KIND.event_created = "Added to the calendar"; KIND.suggested = "Suggestion"; KIND.flagged = "Could not tell what this is"; KIND.noted = "Note"; KIND.undone = "Undone";
    $.mode.textContent = "";
    $.list.innerHTML = "";
    const banner = document.createElement("p");
    banner.className = "note";
    banner.textContent = res.brain_enabled ? ({ suggest: "The brain is only watching. It changes nothing.", suggest_then_act: "The brain files tickets itself. Calendar changes wait for your approval.", full: "The brain files tickets and makes calendar changes itself." }[res.autonomy] || "") : "The brain is switched off.";
    $.list.appendChild(banner);
    const waiting = res.actions.filter((a) => !a.undone_at && (a.kind === "suggested" || a.kind === "flagged"));
    const history = res.actions.filter((a) => !waiting.includes(a) && a.kind !== "noted");
    if (!waiting.length && !history.length) { const d = document.createElement("div"); d.className = "state"; d.innerHTML = "<h3>Nothing yet</h3><p>When the brain files a ticket or suggests a calendar change, it shows here with an undo.</p>"; $.list.appendChild(d); return; }
    if (waiting.length) $.list.appendChild(section("Waiting for you", "high", waiting));
    if (history.length) $.list.appendChild(section("Done by the brain", "sort", history));
  }
  function gate(on, msg) { $.gate.hidden = !on; $.main.hidden = on; if (msg) $.gateMsg.textContent = msg; }
  async function load() {
    try { $.status.textContent = "Updating…"; const res = await act.list(); $.status.textContent = res.me; gate(false); render(res); }
    catch (e) { if (String(e.message).includes("not signed in")) gate(true, "Sign in with your own Google account to see what the brain did."); else $.status.textContent = "Could not update: " + e.message; }
  }
  $.signin.onclick = async () => { try { await data.signIn(); await load(); } catch (e) { $.gateMsg.textContent = "Sign-in did not complete: " + e.message; } };
  (async function start() {
    if (data.mode() !== "google") { gate(true, "Activity needs the Google sign-in."); $.signin.hidden = true; return; }
    const ok = await data.signInSilently();
    if (!ok) gate(true, "Sign in with your own Google account to see what the brain did.");
    await load();
    setInterval(load, 2 * 60000);
  })();
})();
