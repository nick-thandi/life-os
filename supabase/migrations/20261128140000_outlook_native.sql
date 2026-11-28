-- Native Outlook sweep: each legacy Outlook mailbox signs in once through Microsoft and is swept
-- every 5 minutes, like Gmail. Read-only (Mail.Read). Tickets go to the owner's Google Tasks.
create table if not exists public.ms_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  owner_account_id uuid not null references public.accounts(id),
  vault_secret_id uuid,
  active boolean not null default true,
  last_sweep_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table public.ms_accounts enable row level security;
revoke all on public.ms_accounts from anon, authenticated;

create or replace function public.store_ms_token(p_email text, p_owner_account_id uuid, p_token text)
returns uuid language plpgsql security definer set search_path to 'public', 'vault' as $$
declare v public.ms_accounts%rowtype; v_secret uuid;
begin
  select * into v from public.ms_accounts where email = lower(p_email);
  if found and v.vault_secret_id is not null then
    perform vault.update_secret(v.vault_secret_id, p_token, 'microsoft:' || lower(p_email), 'Microsoft refresh token');
    update public.ms_accounts set active = true, last_error = null, owner_account_id = p_owner_account_id where id = v.id;
    return v.id;
  end if;
  v_secret := vault.create_secret(p_token, 'microsoft:' || lower(p_email), 'Microsoft refresh token');
  insert into public.ms_accounts (email, owner_account_id, vault_secret_id) values (lower(p_email), p_owner_account_id, v_secret)
    on conflict (email) do update set vault_secret_id = excluded.vault_secret_id, active = true, last_error = null
    returning id into v.id;
  return v.id;
end $$;

create or replace function public.get_ms_token(p_id uuid)
returns text language sql security definer set search_path to 'public', 'vault' as $$
  select s.decrypted_secret from public.ms_accounts a join vault.decrypted_secrets s on s.id = a.vault_secret_id where a.id = p_id;
$$;

create or replace function public.call_outlook_sweep()
returns void language plpgsql security definer set search_path to 'public', 'extensions', 'vault', 'net' as $$
declare v_key text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'anon_key' limit 1;
  perform net.http_post(
    url := 'https://dxvzirwrgivwlfbvzcdp.supabase.co/functions/v1/outlook-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;

revoke all on function public.store_ms_token(text, uuid, text) from public, anon, authenticated;
revoke all on function public.get_ms_token(uuid) from public, anon, authenticated;
revoke all on function public.call_outlook_sweep() from public, anon, authenticated;
grant execute on function public.store_ms_token(text, uuid, text) to service_role;
grant execute on function public.get_ms_token(uuid) to service_role;

-- Which Outlook mailboxes may connect, and whose in-tray their tickets go to. Anything else is refused.
insert into public.settings (key, value) values
  ('outlook_owners', '{"athandi1": "nickthandi7@gmail.com", "sbagri90": "s16thandi7165@gmail.com"}'::jsonb)
on conflict (key) do nothing;

-- Runs at minutes 2, 7, 12 ... so it never lands on the brain's own run.
select cron.schedule('life-os-outlook-sweep', '2-59/5 * * * *', 'select public.call_outlook_sweep();');
