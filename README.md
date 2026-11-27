# Life OS

The family's single source of truth, starting with **Today on every screen**: phone, laptop and TV all show the same day from the shared family Google Calendar.

Version 1 is a static web app. There is no server and no database. Each screen signs in to Google itself and reads the calendar directly, so no family data ever passes through anything in this repository or any third party. Everything that reads the outside world goes through `data/calendar.js`, so a server can be added later without touching the screens.

## Files

| File | What it does |
|---|---|
| `index.html` | Today screen for phone and laptop (installable as an app) |
| `tv.html` | Same data, big type, no scrolling, for the Fire Stick / Nest Hub browser |
| `app.js` | Rendering: header, day strip, Now/Next banner, one card per person |
| `data/calendar.js` | The data layer: Google sign-in and calendar reads (demo data until configured) |
| `intray.html`, `intray.js`, `data/tasks.js` | The in-tray: capture by typing or voice, priority/tag/time markers, backed by a Google Tasks list called "In-tray" on the family account |
| `config.js` | Client ID, calendar, people and their title prefixes |
| `styles.css`, `manifest.webmanifest`, `icons/` | Look, install metadata, icons |

## How events are shown

- Titles starting with a person's name and a colon go on that person's card: `Dad: train to London`, `Kini: karate`. Anything else goes under **Family**.
- Titles starting with `Routine:` or `[Block]` are shown smaller but never hidden.
- Past events are struck through; the current one is green; the banner shows what is on now and what is next.
- The phone view has a day strip for yesterday to five days ahead. The TV view only ever shows today and rolls over at midnight.

## Setup (one-off, about 15 minutes, £0)

Until a client ID is set the app runs with made-up demo data, so it can be opened anywhere safely.

1. **Google Cloud project** (free): go to console.cloud.google.com with the family account, create a project called `Life OS`.
2. **Enable the Calendar API**: APIs & Services → Library → Google Calendar API → Enable.
3. **OAuth consent screen**: External, app name `Life OS`, your email as contact. Under *Audience / Test users* add every Google account that will sign in on a screen (the family account and any personal ones). Scope: `.../auth/calendar.readonly`. The app can stay in *Testing*; it does not need Google verification for your own use.
4. **Create the client**: Credentials → Create credentials → OAuth client ID → *Web application*. Under **Authorised JavaScript origins** add the exact URL the app will be served from (see Hosting). No redirect URI is needed.
5. Paste the client ID into `config.js` → `googleClientId` and commit.
6. Open the app on each screen and press **Sign in with Google**. Sign-in is a redirect through the brain's `app-login` function (no pop-ups, so it works in installed apps and on TVs); the device gets a 180-day Life OS session and asks the server for short-lived Google tokens limited to calendar read, tasks and email. The Google client needs the redirect URI `https://<project>.supabase.co/functions/v1/app-login/callback`.

## Hosting

The app is plain files, so any static host works. The URL must be `https` and must match the origin added in step 4.

- **GitHub Pages**: Settings → Pages → Deploy from branch `main` / root. On a free account Pages is only available for *public* repositories. That exposes the code, not any data (the repo never contains family data; the client ID is public by design). A GitHub Pro plan allows Pages on a private repo.
- **Chosen (25 Nov 2026): GitHub Pages.** The repository is public so that Pages is free; it holds code only.

## Install on each screen

- **Android**: open the URL in Chrome → menu → *Add to Home screen*.
- **iPhone**: Safari → Share → *Add to Home Screen*.
- **Mac**: Chrome → menu → *Install Life OS*, or Safari → File → *Add to Dock*.
- **Fire Stick**: Silk browser → open `/tv.html`, sign in once, bookmark it; set Silk to open it on launch.
- **Nest Hub**: "Hey Google, open <URL>" in the Hub's browser, or cast a Chrome tab showing `/tv.html`.

## In-tray

Tickets live in a Google Tasks list called **Tickets** (or **Ticket**, **In-tray**, **Inbox** or **Entry**; "ticket list" is what the voice assistant hears best, and the app reads all of them) on whichever account is signed in on that device (the app creates it): each person signs in with their own Gmail on their phone and gets their own in-tray; the TV and Hubs use the family account and get the household one. Lists cannot be seen across accounts; that is the point at which a shared database would be needed. Priority, tag, time, "big" and "blocked" are short markers in the task's notes (`!high #home ~30m big blocked: reason`), written and read by the app, so the list is also usable from the Google Tasks app and by voice on Google Home ("Hey Google, add … to my In-tray list"). Ticking a ticket marks it completed in Google Tasks; nothing is ever deleted.

Sign-in scope is calendar read-only plus Google Tasks. Changing scope made every browser sign in again once.

## Saved for version 2

- A Life OS home-screen and lock-screen widget on the phone (KWGT or similar), so today is visible without opening anything.
- Screens around the house that show today without anyone remembering to look or switching anything on: a wall tablet in kiosk mode on `tv.html`; pictures of today pushed to the Nest Hubs' ambient mode.
- A proper UI and UX pass (Nick is adding a design doc to the project).

## Rules for this repository

- No passwords, tokens, policy numbers, account numbers or family data, ever.
- Keep the data layer (`data/calendar.js`) as the only place that talks to Google.
- UK English throughout.
