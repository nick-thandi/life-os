# Life OS brain (Supabase)

Project `life-os`, region London (eu-west-2), free plan. Deployed from this folder through the Supabase connector; the files here are the record.

## Pieces
- `functions/google-connect`: one-off page per account that asks Google for standing permission (calendar + tasks) and stores the refresh token in Supabase Vault. Only emails in `CONNECT_ALLOWLIST` are accepted.
- `functions/brain`: runs every 5 minutes (pg_cron → pg_net). For each connected account it reads open Google Tasks without markers, asks Claude what each one is, then files it as a ticket (markers in the task notes) or a calendar event. Every change is logged in `actions` with undo data. Nothing is ever deleted; a task that becomes an event is completed, not removed.
- Tables: `accounts`, `captures`, `actions`, `runs`, `settings`, `heartbeat`. Row level security on all, no policies: only the brain (service role) can read or write. Public roles have all table privileges revoked.

## Settings (table `settings`)
- `brain_enabled`: `false` until switched on.
- `autonomy`: `suggest` (log only) · `suggest_then_act` (file tickets, only suggest events) · `full` (tickets and events).
- `model`: defaults to `claude-haiku-5-5`.
- `family_calendar`, `time_zone`.

## Secrets (Edge Functions → Secrets; entered in the dashboard, never in chat or this repo)
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CONNECT_ALLOWLIST`, `ANTHROPIC_API_KEY`.

## Connect an account
`https://<project>.supabase.co/functions/v1/google-connect?label=dad|mum|family`
Google Cloud client needs the redirect URI `https://<project>.supabase.co/functions/v1/google-connect/callback`, and the consent screen must be *In production* (unverified is fine) or tokens expire weekly.

## Outlook sweep (daily)
Nick's old Outlook account is not connected to the brain: a personal Microsoft account cannot register an app without an Azure directory. Instead a scheduled Claude task ("Life OS Outlook sweep", daily 04:43 UK) reads the Outlook inbox through the Microsoft 365 connector (sender, subject, date and the short preview; never full emails), decides ticket or ignore, and submits tickets only.
- `outlook_state()`: where the last sweep ended.
- `outlook_submit(items jsonb, swept_until timestamptz)`: sets a one-time nonce and posts to `functions/outlook-file`; returns a request id.
- `outlook_result(request_id)`: the function's response.
- `functions/outlook-file`: dedupes against `outlook_seen`, adds tickets to the Tickets list of `settings.outlook_target_email`, logs each in `actions` with undo, and moves `settings.outlook_last_sweep_at` only when every ticket landed.
- Table `outlook_seen` (RLS, deny-all). The three SQL functions are not executable by `anon` or `authenticated`.
Nothing is ever sent, moved, labelled or deleted in Outlook.
