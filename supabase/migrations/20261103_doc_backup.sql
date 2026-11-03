-- Document backup: each file is encrypted on the phone (AES-256-GCM, same data key as the tour backup)
-- and stored as opaque bytes at docs/<user id>/<random id>. Names and types live only inside the encrypted tour backup.
insert into storage.buckets (id, name, public, file_size_limit)
values ('docs', 'docs', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = 15728640;

create policy "own docs: read" on storage.objects for select to authenticated
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- New uploads need consent and Plus, like the tour backup.
create policy "own docs: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text and public.has_consent() and public.has_plus());
-- Deleting is always allowed (POPIA erasure).
create policy "own docs: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text);
