// Data layer. Everything that reads the outside world goes through here, so a
// server or a database can replace the Google calls later without touching
// the screens.
//
// Public API:
//   LifeOSData.mode()                     -> "demo" | "google"
//   LifeOSData.signIn()                   -> Promise<void>   (interactive)
//   LifeOSData.signInSilently()           -> Promise<boolean>
//   LifeOSData.signOut()
//   LifeOSData.isSignedIn()               -> boolean
//   LifeOSData.eventsForDay(date)         -> Promise<Event[]>
//
// Event shape:
//   { id, title, start: Date, end: Date, allDay: boolean, location, description }

(function () {
  const cfg = window.LIFE_OS_CONFIG;
  const TOKEN_KEY = "lifeos.google.token.v3";
  const SESSION_KEY = "lifeos.session";

  let token = loadToken();
  let whoCache = null;
  let session = null;
  try { session = localStorage.getItem(SESSION_KEY) || null; } catch (e) { session = null; }

  // Returning from the sign-in page: the session arrives in the URL fragment.
  (function pickUpSession() {
    const h = window.location.hash || "";
    const m = h.match(/lifeos_session=([a-f0-9]+)/);
    const err = h.match(/lifeos_error=([^&]+)/);
    if (m) {
      session = m[1];
      try { localStorage.setItem(SESSION_KEY, session); } catch (e) { /* memory only */ }
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } else if (err) {
      window.__lifeosSignInError = decodeURIComponent(err[1]);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  })();

  function loadToken() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      if (!t.access_token || !t.expires_at || t.expires_at < Date.now() + 60000) return null;
      return t;
    } catch (e) { return null; }
  }
  function saveToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  function mode() { return cfg.googleClientId ? "google" : "demo"; }
  function isSignedIn() { return mode() === "demo" ? true : !!(token && token.expires_at > Date.now() + 60000); }
  function hasSession() { return mode() === "demo" || !!session; }

  // Ask the brain's server for a short-lived Google token for this device's session.
  async function fetchToken() {
    if (!session) return false;
    const res = await fetch(cfg.brainUrl + "/app-login/token", { method: "POST", headers: { Authorization: "Bearer " + session } });
    if (res.status === 401) { session = null; try { localStorage.removeItem(SESSION_KEY); } catch (e) {} return false; }
    if (!res.ok) throw new Error("Sign-in server said " + res.status);
    const j = await res.json();
    token = { access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    whoCache = j.email || null;
    try { localStorage.setItem('lifeos.label', j.label || ''); } catch (e) {}
    saveToken(token);
    return true;
  }

  // Interactive sign-in: leave for Google, come back with a session.
  async function signIn() {
    if (mode() === "demo") return;
    const here = window.location.href.split("#")[0];
    window.location.assign(cfg.brainUrl + "/app-login?return=" + encodeURIComponent(here));
    await new Promise(() => {}); // navigation takes over
  }

  async function signInSilently() {
    if (mode() === "demo") return true;
    if (isSignedIn()) return true;
    try { return await fetchToken(); } catch (e) { return false; }
  }

  function signOut() {
    if (session) fetch(cfg.brainUrl + "/app-login/logout", { method: "POST", headers: { Authorization: "Bearer " + session } }).catch(() => {});
    session = null; token = null; whoCache = null;
    saveToken(null);
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function dayBounds(date) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    return { start, end };
  }

  async function googleEvents(date, calendarId) {
    if (!isSignedIn()) throw new Error("not signed in");
    const { start, end } = dayBounds(date);
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
      timeZone: cfg.timeZone,
    });
    const url =
      "https://www.googleapis.com/calendar/v3/calendars/" +
      encodeURIComponent(calendarId || cfg.calendarId) +
      "/events?" +
      params.toString();
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token.access_token } });
    if (res.status === 401) {
      token = null; saveToken(null);
      if (await signInSilently()) return googleEvents(date, calendarId);
      throw new Error("not signed in");
    }
    if (!res.ok) {
      let reason = "";
      try { const j = await res.json(); reason = (j.error && j.error.message) || ""; } catch (e) { /* no body */ }
      if (res.status === 403 && /insufficient/i.test(reason)) { token = null; saveToken(null); throw new Error("not signed in"); }
      if (res.status === 404 || /not found/i.test(reason)) throw new Error("the family calendar is not shared with this account");
      throw new Error("Google Calendar said: " + (reason || res.status));
    }
    const body = await res.json();
    return (body.items || [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => {
        const allDay = !!(e.start && e.start.date);
        const s = allDay ? parseLocalDate(e.start.date) : new Date(e.start.dateTime);
        const en = allDay ? parseLocalDate(e.end.date) : new Date(e.end.dateTime);
        return {
          id: e.id,
          title: e.summary || "(no title)",
          start: s,
          end: en,
          allDay,
          location: e.location || "",
          description: e.description || "",
        };
      });
  }

  function parseLocalDate(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  // Demo data: made up, nothing real. Used until a client ID is configured.
  function demoEvents(date) {
    const d = (h, m) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
    const mk = (title, sh, sm, eh, em, extra) =>
      Object.assign({ id: title, title, start: d(sh, sm), end: d(eh, em), allDay: false, location: "", description: "" }, extra || {});
    const { start, end } = dayBounds(date);
    return Promise.resolve([
      { id: "a1", title: "Family: bins out tonight", start, end, allDay: true, location: "", description: "" },
      mk("Routine: school run", 8, 15, 8, 45),
      mk("Dad: train to London", 7, 5, 8, 30),
      mk("Dad: sign the agreement that is overdue", 8, 30, 8, 45),
      mk("Mum: gym", 6, 0, 7, 0),
      mk("Kini: karate", 16, 30, 17, 30, { location: "Leisure centre" }),
      mk("Pooks: nursery", 8, 0, 15, 30),
      mk("Family: dinner together", 18, 0, 18, 45),
      mk("Routine: kids' bedtime", 19, 15, 19, 45),
    ]);
  }

  function eventsForDay(date) {
    return mode() === "demo" ? demoEvents(date) : googleEvents(date, cfg.calendarId);
  }

  // Each person's own calendar, where this sign-in is allowed to read it (their own, or one shared with them).
  async function peopleEventsForDay(date) {
    if (mode() === "demo") return [];
    const out = [];
    await Promise.all((cfg.people || []).filter((p) => p.calendar && p.calendar.toLowerCase() !== String(cfg.calendarId).toLowerCase()).map(async (p) => {
      try { (await googleEvents(date, p.calendar)).forEach((e) => out.push(Object.assign(e, { owner: p.id }))); } catch (e) { /* not shared with this account */ }
    }));
    return out;
  }

  function accessToken() {
    return isSignedIn() && token ? token.access_token : null;
  }
  function dropToken() {
    token = null;
    saveToken(null);
  }

  async function who() {
    if (mode() === "demo") return "demo";
    if (whoCache) return whoCache;
    if (!isSignedIn()) return "";
    try {
      const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + token.access_token } });
      if (!r.ok) return "";
      const j = await r.json();
      whoCache = j.email || "";
      return whoCache;
    } catch (e) { return ""; }
  }

  function label() { try { return localStorage.getItem('lifeos.label') || ''; } catch (e) { return ''; } }
  window.LifeOSData = { label, mode, signIn, signInSilently, signOut, isSignedIn, hasSession, eventsForDay, peopleEventsForDay, accessToken, dropToken, who };
})();
