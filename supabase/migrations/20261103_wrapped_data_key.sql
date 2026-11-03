-- Format 2: a random data key encrypts the tour; that key is stored twice, wrapped by the
-- passphrase and by a one-time recovery code. The server still never sees any key.
alter table public.backups alter column salt drop not null;
alter table public.backups
  add column key_id text check (length(key_id) <= 64),
  add column pass_salt text check (length(pass_salt) <= 64),
  add column pass_wrap text check (length(pass_wrap) <= 256),
  add column rec_salt text check (length(rec_salt) <= 64),
  add column rec_wrap text check (length(rec_wrap) <= 256),
  add constraint backups_format2_complete check (
    format < 2 or (key_id is not null and pass_salt is not null and pass_wrap is not null
                   and rec_salt is not null and rec_wrap is not null));
