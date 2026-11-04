# Guidewise

Pre-tour prep PWA for tour guides, worldwide. Owner: Ananda van der Merwe (UK English, concise, no em dashes).
Tagline idea: "Guidewise. Tomorrow, sorted."

## Live
- https://guidewiseapp.co.za (custom domain, owner bought it; DNS set up by owner) and https://guidewise-app.netlify.app
- Netlify site "guidewise-app", site-id 9e36a9ca-6f37-416e-8e51-31229de5132e, team spookstories

## Files
- site/: everything public (Netlify publish dir, set in netlify.toml). Nothing outside site/ is served
- site/index.html: whole app (vanilla JS, no build step)
- site/sw.js: service worker. Bump cache name tp-vN on every front-end change (currently tp-v30; own files are fetched network-first, cache when offline). New precached files go in its F list
- site/backup.js: cloud backup (sign-in, POPIA consent, passphrase, encrypt, sync). Shares globals with index.html
- site/import.js: AI import (tab 'import', from Tours > Import from documents or the Docs tab; can use documents already saved in the tour). Loaded after backup.js and uses its globals (sb, user, plan, plus, refresh, SB_URL, SB_KEY)
- site/vendor/xlsx-mini-0.18.5.js: SheetJS (Apache-2.0), lazy-loaded by import.js for .xlsx/.csv
- site/vendor/supabase-2.45.4.js: vendored so it works offline; site/privacy.html: POPIA notice; site/terms.html: terms, pricing, refunds (Paystack needs it); site/setup.html: setup guide to send to guides (install, first tour, backup, help). Keep it in step with the UI
- supabase/: record of the deployed migration and edge function
- site/guides.html: public landing page for other guides (features, pricing, FAQ); screenshots in site/img/app-*.jpg are from the sample tour only, never real guest data. Linked from More > About Guidewise
- site/manifest.webmanifest, site/icon-192.png, site/icon-512.png

## Design (v10)
- Bottom bar: Today, Day, Guests, Briefing, More (More holds Checklist, Docs, Local intel, Import, All tours, Backup). Tour switcher at the top (tab name + dates ▾ opens #tpanel: tours ordered on tour, upcoming, undated, finished; + New tour, Import, rename, Manage tours). Day chips only on Day/Checklist/Briefing/Docs
- Today (tab 'today', opening screen): focusDay() = today's tour day, else the next one; hero with now/next; nextSteps() gives up to 4 predictive actions (data-go="tab:dayIndex"); tiles; compact install hint
- Look (v11): topo.svg / topo-w.svg contour graphics (body and Today hero), green-to-ochre accent line under the header, coloured next-step icons and tiles. Stop types inferred by kindOf() (meal, flight, wildlife, stay, free) colour the timeline
- Briefing: 'Send on WhatsApp' opens wa.me/?text=… (data-wa=dayIndex), also from the Today hero; Copy stays as fallback
- Tour-day tools (v12): stop.phone and stop.addr with Call (tel:) and Directions (Google Maps) buttons; venue library T.venues (by place name, refilled on later tours, backed up with T). day.area drives a free Open-Meteo forecast (ensureWx, cache guidewise.wx 3 h, up to 15 days ahead); fills day.weather when empty or wxAuto; strong wind/rain becomes a Today step. Same call gives sunrise/sunset (w.sr, w.ss); geocode country code (g.cc) drives public holidays from Nager.Date (ensureHols, cached per country+year in guidewise.wx; holiday on a near day becomes a Today step). Local intel shows 'Found for this tour' (holidays, wind/rain, sun) above the guide's own notes. Headcount tab 'count' (in-memory, Today shows it on tour days). SW does not intercept other sites
- Running late (tab 'late'): pick minutes and the stop; at the current stop on a tour day its stay grows, otherwise the drive to it; WhatsApp update with new times; Undo
- Cash and tips (tab 'cash', S.cash [{id,date,cat,amt,what}], S.cur): categories float in, entrance, meals, tips paid, transport, other, tips received (kept out of the float balance); summary to WhatsApp or copy. Duplicate clears cash
- First run (tab 'welcome', key guidewise.onb): shown once when only the sample tour exists; import, new tour, or explore
- End-of-day report (tab 'report'): programme, changes (day.log, written by Running late), cash that day, float balance, day.report notes; WhatsApp, email (mailto) or copy. Never includes guest birthdays, dietaries or notes
- Briefing translation (Plus): edge function ai-translate (JWT, has_plus, 30 a month, Claude Haiku 5.5, logged in ai_usage as '<model>:translate'; ai-import's 5-a-month count excludes these). S.lang per tour; send translation or both. Only the briefing text is sent, never guest data
- Messages: dietText() to the lunch venue (waTo(phone): SA 0xx becomes 27xx; first names + dietaries, birthday that day), planText() to the driver (no guest details). Departure reminders (key guidewise.remind): remindTick every 30 s while open, 10 min before leaving the current stop: toast, vibrate, SW notification if permitted. No server schedule (would need tour data on the server)
- Venues (tab 'venues'): T.venues {key:{name,phone,addr,note}}, gathered from every tour's stops with a phone or address; add, edit, search, delete
- Day and Guests are read-first (timeline / guest cards) with Edit day / tap-to-edit (editDay, editG). Keep new screens read-first with a clear primary action

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
- Document backup (v13): storage bucket 'docs' (private, 15 MB limit). Each file encrypted on the phone with the tour data key, AAD user id + ':doc:' + sid, stored at docs/<uid>/<sid> as iv+ciphertext. Names, types and filing only in the encrypted backup's 'docs' manifest. sync.up (uploaded sids), sync.man (last manifest, keeps other devices' files listed), sync.docDel (tombstones: only these are deleted remotely). Restore downloads missing files. Toggle 'Back up documents too' (sync.docs). Storage policies: own folder; insert needs has_consent() and has_plus(). Delete backup, replace backup and delete-account remove the files
- Never add a server feature that needs to read guest data without revisiting consent and encryption
- Changing consent wording: bump to popia-v3 in backup.js, privacy.html and the consents check constraint and has_consent()

## Payments (v8): Guidewise Plus via Paystack
- Free: everything on device. Plus: cloud backup and AI import. R79/month or R790/year (was R49/R490 before AI import), ZAR. 30-day trial for every new account (trigger on auth.users), no card needed
- Table subscriptions (read-only to users; written by triggers and edge functions). has_plus() is mirrored by plus() in backup.js
- Uploading new backup data needs Plus (insert policy + trigger on ciphertext change). Restore, delete, passphrase/recovery re-wraps always allowed (POPIA access and erasure)
- Welcome screen (tab 'plus', renderPlus in backup.js): 'Congratulations! You're in!' plus what's included; shown once per subscription after payment (key guidewise.welcomed), and via "What's included" on the Plus card. Keep the list in step with what Plus really includes
- A Paystack 'cancelled' with a future period end is stored as non_renewing, so the paid period is honoured
- Owner account anandaafrica@gmail.com is status 'comp'; billing never downgrades comp
- Edge functions: billing-checkout (JWT; Paystack customer + transaction with plan; returns to /?paid=1), billing-webhook (no JWT; HMAC-SHA512 signature check; re-fetches the subscription from Paystack), billing-manage (JWT; in-app cancel (Paystack disable) and resume (Paystack cannot reactivate a cancelled subscription, so resume creates a new one on the same card with start_date = paid period end); hosted page for changing card; sync, run once per session when Backup opens so status does not depend on the webhook; verify on return from checkout). delete-account also disables the Paystack subscription
- Secrets in Supabase (owner enters them, never in code): PAYSTACK_SECRET_KEY, PAYSTACK_PLAN_MONTHLY, PAYSTACK_PLAN_YEARLY. Webhook URL: https://bqevxxhdtzlywjoqbogt.supabase.co/functions/v1/billing-webhook

## AI import (v9, Plus)
- Edge function ai-import (verify_jwt false, does its own auth): JWT + has_plus() + consent 'ai-v1' in the body + 5 successful imports per calendar month (ai_usage). Claude Opus 5.5, effort low (64s, about R3 per tour; medium took 134s, too close to the 150s edge limit), structured JSON output, server-side fallback beta. Secret ANTHROPIC_API_KEY. Optional env AI_MODEL, AI_EFFORT
- Never stores documents or drafts; ai_usage keeps only counts and tokens
- On the phone first: spreadsheets lose passport/visa/flight/phone/email/address/insurance columns (heading row detection), DOB becomes MM-DD; text files lose emails and phone numbers; photos resized; PDFs sent as is. Any year in a returned bday is dropped
- AI returns per stop: kind (visit/meal/activity/hotel/transfer/flight/free), arrive/leave clock times, travel (estimated minutes from previous stop). import.js build() converts once: stops sorted by time, source times kept exactly, travel from the estimate (never from gaps), gaps over 30 min become a 'Free time' stop (or extend an airport/station/hotel stop), overlaps trim the previous stop, flights are '✈' stops, guessed times marked '⚠ Time estimated'. The review screen renders build()'s output, so preview = saved. Day notes and warnings go to Local intel. An untouched empty 'New tour' is reused, not left behind
- Acceptance check: window.gwImportBuild(draft) in the browser; expect no drive over 90 min except road transfers, times ascending, source times kept
- Per-import consent ticks (operator policy + transfer to Anthropic, USA); privacy.html#ai explains. Changing that wording: bump ai-v1 in import.js, ai-import and privacy.html
- Test path: header x-gw-test with a row in admin_test_tokens (owner only); delete tokens after testing

## Status (end of 3 Nov 2026)
- Live (main): everything up to PR #9 (Today, switcher, WhatsApp, weather, headcount, running late, cash, report, welcome, landing page)
- Open: PR #10 (branch claude/docs-venues-qa): document backup, venues, translation, venue/driver messages, reminders, sun times, holidays, tests. Owner to test document upload and a German translation on the preview, then merge
- Owner to do: run the clean-up SQL in Supabase SQL Editor (delete admin_test_tokens rows, drop ai_test_payload, delete net._http_response); finish guidewiseapp.co.za (Netlify domain, DNS, Supabase Site URL + redirect URLs), then switch links; Paystack live mode
- Paystack test plans are R79/R790 (updated via a retired one-off function admin-plans, now a 410 stub)

## Roadmap
1. Accounts + cloud backup: done in v4; documents backed up in v13
2. Payments: done in v8 (Paystack). AI import: done in v9
3. Custom domain guidewiseapp.co.za bought; owner to finish Netlify + DNS + Supabase Site URL
4. Live local intel: weather, sun times and public holidays done (v14); road closures and events still open

## Tests
- `node tests/smoke.js` (see tests/README.md). Run before every PR; add a check for each new feature

## Deploy
Git-linked: merging to main deploys to production; PRs get a Netlify deploy preview. Repo: anandaafrica-design/guidewise.
Work on a branch, open a PR, check the preview, then merge. Verify sw.js shows the new tp-vN.
