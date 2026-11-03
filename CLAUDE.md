# Guidewise

Pre-tour prep PWA for tour guides, worldwide. Owner: Ananda van der Merwe (UK English, concise, no em dashes).
Tagline idea: "Guidewise. Tomorrow, sorted."

## Live
- https://guidewise-app.netlify.app
- Netlify site "guidewise-app", site-id 9e36a9ca-6f37-416e-8e51-31229de5132e, team spookstories

## Files
- index.html: whole app (vanilla JS, no build step)
- sw.js: service worker. Bump cache name tp-vN on every front-end change (currently tp-v3)
- manifest.webmanifest, icon-192.png, icon-512.png

## Features (v3)
- Day plan: depart time + drive/stay minutes per stop, all times cascade; lunch stops show guest dietaries
- Guests: room, birthday (MM-DD, alert on matching day), dietary, notes
- Checklist per day (cash, tickets, gear) with progress
- Briefing: WhatsApp evening message generated from the day plan, copy button. Never include birthdays or dietaries
- Documents: IndexedDB store "guidewise-docs", filed per day or whole tour, shown on day plan
- Local intel: private notes
- Light-only, high-contrast theme for outdoor reading. Keep it light

## Data
State in localStorage key tourPrepKit.v1; documents in IndexedDB. Device-only for now.

## Roadmap
1. Accounts + cloud backup (Supabase). POPIA consent gate before guest data leaves the device: dietaries are health data
2. Payments: Paystack (smoother subscriptions, card only) or PayFast (more SA methods). Free trial then ~R49/month
3. Custom domain (guidewise.app or .co, to be bought)
4. Live local intel for the tour's area

## Deploy
Netlify MCP deploy-site with the site-id, run the returned npx command from this folder. If the proxy URL contains "//proxy/", change it to "/proxy/". Verify sw.js shows the new tp-vN.
