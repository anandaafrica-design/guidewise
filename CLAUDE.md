# Guidewise

Pre-tour prep PWA for tour guides, worldwide. Owner: Ananda van der Merwe (UK English, concise, no em dashes).
Tagline idea: "Guidewise. Tomorrow, sorted."

## Live
- https://guidewise-app.netlify.app
- Netlify site "guidewise-app", site-id 9e36a9ca-6f37-416e-8e51-31229de5132e, team spookstories

## Files
- site/: everything public (Netlify publish dir, set in netlify.toml). Nothing outside site/ is served
- site/index.html: whole app (vanilla JS, no build step)
- site/sw.js: service worker. Bump cache name tp-vN on every front-end change (currently tp-v9). New precached files go in its F list
- site/backup.js: cloud backup (sign-in, POPIA consent, passphrase, encrypt, sync). Shares globals with index.html
- site/vendor/supabase-2.45.4.js: vendored so it works offline; site/privacy.html: POPIA notice; site/terms.html: terms, pricing, refunds (Paystack needs it); site/setup.html: setup guide to send to guides (install, first tour, backup, help). Keep it in step with the UI
- supabase/: record of the deployed migration and edge function
- site/manifest.webmanifest, site/icon-192.png, site/icon-512.png

## Features (v3)
- Day plan: depart time + drive/stay minutes per stop, all times cascade; lunch stops show guest dietaries
- Guests: room, birthday (MM-DD, alert on matching day), dietary, notes
- Checklist per day (cash, tickets, gear) with progress
- Briefing: WhatsApp evening message generated from the day plan, copy button. Never include birthdays or dietaries
- Documents: IndexedDB store "guidewise-docs", filed per day or whole tour, shown on day plan
- Local intel: private notes
- Tours home screen (tab 'home': Home in the bottom menu and Tours button top left): new, duplicate (no guests, checklists unticked), archive, delete (also deletes that tour's documents)
- Install banner (hidden once installed or dismissed, key guidewise.inst), one-tap install via beforeinstallprompt
- Light-only, high-contrast theme for outdoor reading. Keep it light

## Data
All tours in localStorage key guidewise.tours.v2: {v:2, cur, legacyDocs, tours:[{id, tour, day, days, guests, intel, archived}]}. S is the open tour. The old single-tour key tourPrepKit.v1 is migrated once and kept as a safety copy. Documents in IndexedDB (device only), tagged with tour id (untagged = legacyDocs tour). Backups encrypt the whole {T}; restore also accepts v1 {S}.
Optional backup (v4): Supabase project "guidewise" (ref bqevxxhdtzlywjoqbogt, London, org Spot-it Kruger).
- Email code sign-in. POPIA consent (version popia-v2) required before anything is uploaded; RLS also refuses backups without a consent row
- Format 2: random data key (AES-256-GCM, user id as AAD) encrypts the tour. It is stored wrapped twice: by the passphrase (PBKDF2 600k, min 8 chars) and by a one-time recovery code (20 chars, PBKDF2 100k). Device keeps it non-extractable in IndexedDB "guidewise-keys". Changing passphrase or recovery code only re-wraps; other devices keep working. Server never sees a key or plaintext
- Never add a server feature that needs to read guest data without revisiting consent and encryption
- Changing consent wording: bump to popia-v3 in backup.js, privacy.html and the consents check constraint and has_consent()

## Payments (v8): Guidewise Plus via Paystack
- Free: everything on device. Plus: cloud backup (and later AI import). R49/month or R490/year, ZAR. 30-day trial for every new account (trigger on auth.users), no card needed
- Table subscriptions (read-only to users; written by triggers and edge functions). has_plus() is mirrored by plus() in backup.js
- Uploading new backup data needs Plus (insert policy + trigger on ciphertext change). Restore, delete, passphrase/recovery re-wraps always allowed (POPIA access and erasure)
- Owner account anandaafrica@gmail.com is status 'comp'; billing never downgrades comp
- Edge functions: billing-checkout (JWT; Paystack customer + transaction with plan; returns to /?paid=1), billing-webhook (no JWT; HMAC-SHA512 signature check; re-fetches the subscription from Paystack), billing-manage (JWT; hosted manage link, sync). delete-account also disables the Paystack subscription
- Secrets in Supabase (owner enters them, never in code): PAYSTACK_SECRET_KEY, PAYSTACK_PLAN_MONTHLY, PAYSTACK_PLAN_YEARLY. Webhook URL: https://bqevxxhdtzlywjoqbogt.supabase.co/functions/v1/billing-webhook

## Roadmap
1. Accounts + cloud backup: done in v4 (documents not yet backed up: phase 2 via Supabase Storage, encrypted the same way)
2. Payments: done in v8 (Paystack, see Payments section). Next: AI document import for Plus, with per-document consent
3. Custom domain (guidewise.app or .co, to be bought)
4. Live local intel for the tour's area

## Deploy
Git-linked: merging to main deploys to production; PRs get a Netlify deploy preview. Repo: anandaafrica-design/guidewise.
Work on a branch, open a PR, check the preview, then merge. Verify sw.js shows the new tp-vN.
