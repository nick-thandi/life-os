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
