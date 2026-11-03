-- Guidewise Plus. Rows are written only by triggers and edge functions (service role); users can read their own.
create table public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'trialing'
    check (status in ('trialing','active','non_renewing','attention','cancelled','comp')),
  plan text check (plan in ('monthly','yearly')),
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  current_period_end timestamptz,
  paystack_customer_code text,
  paystack_subscription_code text,
  paystack_email_token text,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from anon, public, authenticated;
grant select on public.subscriptions to authenticated;
create policy "own subscription: read" on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.start_trial()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin insert into public.subscriptions(user_id) values (new.id) on conflict do nothing; return new; end $$;
revoke all on function public.start_trial() from public, anon, authenticated;
create trigger on_auth_user_created_trial after insert on auth.users
  for each row execute function public.start_trial();
insert into public.subscriptions(user_id) select id from auth.users on conflict do nothing;

create or replace function public.has_plus()
returns boolean language sql stable security invoker set search_path = ''
as $$ select exists (select 1 from public.subscriptions s where s.user_id = (select auth.uid()) and (
  s.status = 'comp'
  or (s.status = 'trialing' and s.trial_ends_at > now())
  or (s.status in ('active','non_renewing') and coalesce(s.current_period_end, now() + interval '1 day') > now())
  or (s.status = 'attention' and coalesce(s.current_period_end, now()) + interval '7 days' > now())
)) $$;
revoke all on function public.has_plus() from public, anon;
grant execute on function public.has_plus() to authenticated;

drop policy "own backup: create" on public.backups;
create policy "own backup: create" on public.backups
  for insert to authenticated with check (user_id = (select auth.uid()) and public.has_consent() and public.has_plus());

-- Updates: consent only at policy level; uploading new ciphertext additionally needs Plus (trigger),
-- so lapsed users can still re-wrap keys (change passphrase, recovery), restore and delete.
drop policy "own backup: update" on public.backups;
create policy "own backup: update" on public.backups
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.has_consent());
create or replace function public.require_plus_for_data()
returns trigger language plpgsql security invoker set search_path = ''
as $$ begin
  if new.ciphertext is distinct from old.ciphertext and not public.has_plus() then
    raise exception 'plus_required' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger backups_plus_check before update on public.backups
  for each row execute function public.require_plus_for_data();

-- Owner account: complimentary (run once, by email):
-- update public.subscriptions s set status='comp' from auth.users u where u.id=s.user_id and u.email='<owner>';
