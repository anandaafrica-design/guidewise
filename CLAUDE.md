# Guidewise

Pre-tour prep PWA for tour guides, worldwide. Owner: Ananda van der Merwe (UK English, concise, no em dashes).
Tagline idea: "Guidewise. Tomorrow, sorted."

## Live
- https://guidewise-app.netlify.app
- Netlify site "guidewise-app", site-id 9e36a9ca-6f37-416e-8e51-31229de5132e, team spookstories

## Files
- site/: everything public (Netlify publish dir, set in netlify.toml). Nothing outside site/ is served
- site/index.html: whole app (vanilla JS, no build step)
- site/sw.js: service worker. Bump cache name tp-vN on every front-end change (currently tp-v4). New precached files go in its F list
- site/backup.js: cloud backup (sign-in, POPIA consent, passphrase, encrypt, sync). Shares globals with index.html
- site/vendor/supabase-2.45.4.js: vendored so it works offline; site/privacy.html: POPIA notice
- supabase/: record of the deployed migration and edge function
- site/manifest.webmanifest, site/icon-192.png, site/icon-512.png

## Features (v3)
- Day plan: depart time + drive/stay minutes per stop, all times cascade; lunch stops show guest dietaries
- Guests: room, birthday (MM-DD, alert on matching day), dietary, notes
- Checklist per day (cash, tickets, gear) with progress
- Briefing: WhatsApp evening message generated from the day plan, copy button. Never include birthdays or dietaries
- Documents: IndexedDB store "guidewise-docs", filed per day or whole tour, shown on day plan
- Local intel: private notes
- Light-only, high-contrast theme for outdoor reading. Keep it light

## Data
State in localStorage key tourPrepKit.v1; documents in IndexedDB (device only).
Optional backup (v4): Supabase project "guidewise" (ref bqevxxhdtzlywjoqbogt, London, org Spot-it Kruger).
- Email code sign-in. POPIA consent (version popia-v1) required before anything is uploaded; RLS also refuses backups without a consent row
- Tour JSON encrypted on device: PBKDF2-SHA256 600k -> AES-256-GCM, user id as AAD. Key kept non-extractable in IndexedDB "guidewise-keys". Server never sees plaintext
- Never add a server feature that needs to read guest data without revisiting consent and encryption
- Changing consent wording: bump to popia-v2 in backup.js, privacy.html and the consents check constraint and has_consent()

## Roadmap
1. Accounts + cloud backup: done in v4 (documents not yet backed up: phase 2 via Supabase Storage, encrypted the same way)
2. Payments: Paystack (smoother subscriptions, card only) or PayFast (more SA methods). Free trial then ~R49/month
3. Custom domain (guidewise.app or .co, to be bought)
4. Live local intel for the tour's area

## Deploy
Git-linked: merging to main deploys to production; PRs get a Netlify deploy preview. Repo: anandaafrica-design/guidewise.
Work on a branch, open a PR, check the preview, then merge. Verify sw.js shows the new tp-vN.
