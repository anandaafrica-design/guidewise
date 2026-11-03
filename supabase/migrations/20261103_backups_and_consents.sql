-- Consent log: append-only record of POPIA consent per user.
create table public.consents (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  version text not null check (version in ('popia-v1')),
  accepted_at timestamptz not null default now()
);
create index consents_user_idx on public.consents(user_id);

-- One encrypted backup per user. The server only ever sees ciphertext.
create table public.backups (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  ciphertext text not null check (length(ciphertext) <= 4000000),
  iv text not null,
  salt text not null,
  kdf_iter integer not null default 600000,
  format integer not null default 1,
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.consents enable row level security;
alter table public.backups enable row level security;

revoke all on public.consents, public.backups from anon, public;
grant select, insert on public.consents to authenticated;
grant select, insert, update, delete on public.backups to authenticated;

create policy "own consents: read" on public.consents
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own consents: add" on public.consents
  for insert to authenticated with check (user_id = (select auth.uid()));

-- Backups can only be written by users who have given current consent.
create or replace function public.has_consent()
returns boolean language sql stable security invoker set search_path = ''
as $$ select exists (select 1 from public.consents c where c.user_id = (select auth.uid()) and c.version = 'popia-v1') $$;
revoke all on function public.has_consent() from public, anon;
grant execute on function public.has_consent() to authenticated;

create policy "own backup: read" on public.backups
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own backup: create" on public.backups
  for insert to authenticated with check (user_id = (select auth.uid()) and public.has_consent());
create policy "own backup: update" on public.backups
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.has_consent());
create policy "own backup: delete" on public.backups
  for delete to authenticated using (user_id = (select auth.uid()));

-- Server sets the timestamp, not the client.
create or replace function public.touch_backup()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;
create trigger backups_touch before insert or update on public.backups
  for each row execute function public.touch_backup();
