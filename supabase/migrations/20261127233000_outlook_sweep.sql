-- Outlook sweep: state table and the three SQL entry points used by the daily scheduled task.
create table if not exists public.outlook_seen (
  message_id text primary key,
  decision text not null check (decision in ('ticket','ignore')),
  received_at timestamptz,
  seen_at timestamptz not null default now()
);
alter table public.outlook_seen enable row level security;
revoke all on public.outlook_seen from anon, authenticated;

-- settings.outlook_target_email is set in the database (the account whose Tickets list receives Outlook tickets).

create or replace function public.outlook_state()
returns jsonb language sql security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'after', coalesce((select value #>> '{}' from public.settings where key = 'outlook_last_sweep_at'), to_char((now() - interval '7 days') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'now', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'seen_total', (select count(*) from public.outlook_seen)
  );
$$;

create or replace function public.outlook_submit(p_items jsonb, p_swept_until timestamptz)
returns bigint language plpgsql security definer set search_path to 'public', 'extensions', 'vault', 'net' as $$
declare
  v_key text;
  v_nonce text := encode(extensions.gen_random_bytes(24), 'hex');
  v_id bigint;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'items must be a JSON array'; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'anon_key' limit 1;
  insert into public.settings(key, value) values ('admin_nonce', to_jsonb(v_nonce))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  select net.http_post(
    url := 'https://dxvzirwrgivwlfbvzcdp.supabase.co/functions/v1/outlook-file',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('nonce', v_nonce, 'swept_until', p_swept_until, 'items', p_items),
    timeout_milliseconds := 120000
  ) into v_id;
  return v_id;
end;
$$;

create or replace function public.outlook_result(p_request bigint)
returns jsonb language sql security definer set search_path to 'public', 'net' as $$
  select coalesce(
    (select jsonb_build_object('status', status_code, 'body', left(content, 2000), 'error', error_msg, 'timed_out', timed_out) from net._http_response where id = p_request),
    jsonb_build_object('status', null, 'body', 'no response yet')
  );
$$;

revoke execute on function public.outlook_state() from public, anon, authenticated;
revoke execute on function public.outlook_submit(jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.outlook_result(bigint) from public, anon, authenticated;
