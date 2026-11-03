# Supabase (project "guidewise", ref bqevxxhdtzlywjoqbogt, eu-west-2 London)

Applied via the Supabase MCP. These files are the record of what is deployed.
- migrations/: schema, RLS, consent check
- functions/delete-account: deletes the caller's account (backups and consents cascade)

The server only stores AES-256-GCM ciphertext. The key is derived on the phone from the
guide's backup passphrase (PBKDF2-SHA256, 600k iterations) and never leaves the device.
