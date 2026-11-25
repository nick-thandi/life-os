// Life OS configuration.
// Nothing here is secret: a Google OAuth *client ID* is public by design.
// Never put passwords, API keys with write access, or family data in this repo.
window.LIFE_OS_CONFIG = {
  // Paste the OAuth 2.0 Web client ID from Google Cloud Console here.
  // Leave empty to run in demo mode with made-up data.
  googleClientId: "267063610765-60nthkltc39dtmqp5n3916hjbnr4beo0.apps.googleusercontent.com",

  // The shared family calendar that every screen reads.
  calendarId: "oceansfamily2018@gmail.com",

  // People shown as cards. "prefixes" are matched against the start of an
  // event title, e.g. "Dad: off work" or "Kini - karate". Anything that does
  // not match a person is shown under "Family".
  people: [
    { id: "dad",   name: "Dad",   prefixes: ["dad", "nick"] },
    { id: "mum",   name: "Mum",   prefixes: ["mum", "sam"] },
    { id: "kini",  name: "Kini",  prefixes: ["kini"] },
    { id: "pooks", name: "Pooks", prefixes: ["pooks"] },
  ],

  // Event titles starting with any of these are treated as routine and are
  // shown smaller (they still appear, nothing is hidden).
  routinePrefixes: ["routine", "[block]"],

  // Google Tasks lists that count as the in-tray, in order of preference.
  // Tickets are read from every one that exists and added to the first that
  // exists (created with the first name if none do). Several names because
  // voice assistants mishear "in-tray".
  taskListNames: ["Tickets", "Ticket", "In-tray", "Inbox", "Entry"],

  // Refresh interval in minutes for the live view.
  refreshMinutes: 5,

  timeZone: "Europe/London",
};
