-- Consent wording changed (recovery code). Backups now require popia-v2.
alter table public.consents drop constraint consents_version_check;
alter table public.consents add constraint consents_version_check check (version in ('popia-v1','popia-v2'));
create or replace function public.has_consent()
returns boolean language sql stable security invoker set search_path = ''
as $$ select exists (select 1 from public.consents c where c.user_id = (select auth.uid()) and c.version = 'popia-v2') $$;
