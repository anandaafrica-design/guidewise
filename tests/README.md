# Tests

`node tests/smoke.js` runs about 70 checks in a headless browser: first run, navigation, day plan cascade, weather, running late, cash, headcount, tour switcher, AI import conversion (on `fixture-draft.json`, anonymised), document backup encryption, phone layout at 320 and 390 px, large text, button names, the landing page and offline start.

It needs Playwright and Python 3. Supabase, weather and WhatsApp are faked, so it never touches real data. Run it before every PR.
