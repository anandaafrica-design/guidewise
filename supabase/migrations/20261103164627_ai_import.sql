-- AI import: usage counts for the monthly fair-use limit. No document content is ever stored.
create table public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  model text not null,
  files int not null default 1,
  input_tokens int, output_tokens int, ok boolean not null default true
);
create index ai_usage_user_month on public.ai_usage(user_id, created_at);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, public, authenticated;
grant select on public.ai_usage to authenticated;
create policy "own ai usage: read" on public.ai_usage for select to authenticated using (user_id = (select auth.uid()));

-- Owner-only test tokens for the model comparison (service role reads them; nobody else can).
create table public.admin_test_tokens (token text primary key, note text, expires_at timestamptz not null);
alter table public.admin_test_tokens enable row level security;
revoke all on public.admin_test_tokens from anon, public, authenticated;

create extension if not exists pg_net;
