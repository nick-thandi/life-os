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
  const TOKEN_KEY = "lifeos.google.token.v2";
  const SCOPE = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/userinfo.email";

  let tokenClient = null;
  let token = loadToken();

  function loadToken() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      if (!t.access_token || !t.expires_at || t.expires_at < Date.now() + 60000) return null;
      return t;
    } catch (e) {
      return null;
    }
  }

  function saveToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* storage unavailable: token lives in memory only */
    }
  }

  function mode() {
    return cfg.googleClientId ? "google" : "demo";
  }

  function isSignedIn() {
    return mode() === "demo" ? true : !!(token && token.expires_at > Date.now() + 60000);
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      throw new Error("Google's sign-in script did not load (blocked or offline); reload the page");
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.googleClientId,
      scope: SCOPE,
      callback: () => {},
    });
    return tokenClient;
  }

  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      const client = ensureTokenClient();
      client.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        token = {
          access_token: resp.access_token,
          expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
        };
        saveToken(token);
        resolve();
      };
      client.error_callback = (err) => {
        const t = err && err.type;
        const msg = t === "popup_failed_to_open" ? "the sign-in pop-up was blocked; allow pop-ups for this site in the browser settings"
          : t === "popup_closed" ? "the sign-in window was closed before finishing"
          : t || "sign-in failed";
        reject(new Error(msg));
      };
      client.requestAccessToken({ prompt });
    });
  }

  async function signIn() {
    if (mode() === "demo") return;
    await requestToken("consent");
  }

  async function signInSilently() {
    if (mode() === "demo") return true;
    if (isSignedIn()) return true;
    try {
      await requestToken("");
      return true;
    } catch (e) {
      return false;
    }
  }

  function signOut() {
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(token.access_token, () => {}); } catch (e) { /* ignore */ }
    }
    token = null;
    saveToken(null);
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
      token = null;
      saveToken(null);
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

  // The signed-in person's own calendar, when it is not the family one. Empty in demo mode.
  async function ownEventsForDay(date) {
    if (mode() === "demo") return [];
    const me = await who();
    if (!me || me.toLowerCase() === String(cfg.calendarId).toLowerCase()) return [];
    try { return (await googleEvents(date, "primary")).map((e) => Object.assign(e, { own: true })); }
    catch (e) { return []; }
  }

  function accessToken() {
    return isSignedIn() && token ? token.access_token : null;
  }
  function dropToken() {
    whoCache = null;
    token = null;
    saveToken(null);
  }

  let whoCache = null;
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

  window.LifeOSData = { mode, signIn, signInSilently, signOut, isSignedIn, eventsForDay, ownEventsForDay, accessToken, dropToken, who };
})();
