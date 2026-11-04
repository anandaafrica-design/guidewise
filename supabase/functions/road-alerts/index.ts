// Road alerts along a tour day: closures, roadworks, accidents, lane closures and flooding near the day's stops
// (TomTom Search + Traffic Incidents v5). Receives only stop places/addresses and coordinates, never guest data.
// Secret: TOMTOM_API_KEY. TomTom's free allowance (2,500 requests a day) is shared by the whole app, so the app
// keeps stop coordinates it was given back, and incident results are cached here per area for 20 minutes.
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const KEEP: Record<number, string> = { 8: "closed", 9: "works", 1: "accident", 7: "lane", 11: "flood" };
const RANK: Record<string, number> = { closed: 0, flood: 1, accident: 2, works: 3, lane: 4 };
const FIELDS = "{incidents{geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description},startTime,endTime,from,to,roadNumbers}}}";
const NEAR_KM = 3, TILE = 0.8, MAX_STOPS = 15, MAX_TILES = 3;
const incCache = new Map<string, { at: number; list: any[] }>();
const geoCache = new Map<string, { lat: number; lon: number } | null>();
const hits = new Map<string, number[]>();
const km = (a: number[], b: number[]) => { // [lat, lon]
  const R = 6371, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const okCoord = (la: number, lo: number) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 85 && Math.abs(lo) <= 180;

async function geocode(key: string, q: string, near?: { lat: number; lon: number }) {
  const ck = q.toLowerCase() + "|" + (near ? near.lat.toFixed(1) + "," + near.lon.toFixed(1) : "");
  if (geoCache.has(ck)) return geoCache.get(ck)!;
  const bias = near ? `&lat=${near.lat}&lon=${near.lon}&radius=150000` : "";
  const r = await fetch(`https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json?key=${encodeURIComponent(key)}&limit=1${bias}`);
  const p = r.ok ? (await r.json()).results?.[0]?.position : null;
  const g = p && okCoord(p.lat, p.lon) ? { lat: p.lat, lon: p.lon } : null;
  geoCache.set(ck, g);
  if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value!);
  return g;
}

async function incidents(key: string, bbox: number[]) { // [minLon, minLat, maxLon, maxLat]
  const ck = bbox.map((x) => x.toFixed(2)).join(",");
  const c = incCache.get(ck);
  if (c && Date.now() - c.at < 20 * 60e3) return c.list;
  const url = "https://api.tomtom.com/traffic/services/5/incidentDetails?key=" + encodeURIComponent(key) + "&bbox=" + ck +
    "&fields=" + encodeURIComponent(FIELDS) + "&language=en-GB&categoryFilter=1,7,8,9,11&timeValidityFilter=present,future";
  const t = await fetch(url);
  if (!t.ok) throw new Error("tomtom " + t.status);
  const list = (await t.json()).incidents || [];
  incCache.set(ck, { at: Date.now(), list });
  if (incCache.size > 500) incCache.delete(incCache.keys().next().value!);
  return list;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
  const now = Date.now(), recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= 60) return json({ error: "rate" }, 429);
  recent.push(now); hits.set(ip, recent);
  const key = (Deno.env.get("TOMTOM_API_KEY") || "").replace(/[^\x21-\x7E]/g, "");
  if (!key) return json({ error: "not_configured" }, 503);

  const b = await req.json().catch(() => ({}));
  const area = b.area && okCoord(Number(b.area.lat), Number(b.area.lon)) ? { lat: Number(b.area.lat), lon: Number(b.area.lon) } : undefined;
  const raw = Array.isArray(b.stops) ? b.stops.slice(0, MAX_STOPS) : [];
  if (!raw.length && !area) return json({ error: "input" }, 400);

  try {
    // 1. Where is each stop? Use coordinates the app already has, else look the place up near the day's area.
    const stops: ({ lat: number; lon: number } | null)[] = [];
    for (const s of raw) {
      const la = Number(s?.lat), lo = Number(s?.lon);
      if (okCoord(la, lo)) { stops.push({ lat: la, lon: lo }); continue; }
      const q = String(s?.q || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
      stops.push(q ? await geocode(key, q, area) : null);
    }
    const pts = stops.filter(Boolean) as { lat: number; lon: number }[];
    if (!pts.length && area) pts.push(area);
    if (!pts.length) return json({ at: now, stops, list: [] });

    // 2. Incidents in tiles that hold a stop (each tile well under TomTom's 10,000 km² box limit).
    const m = 0.04, tiles = new Map<string, number[]>();
    for (const p of pts) {
      const ty = Math.floor(p.lat / TILE), tx = Math.floor(p.lon / TILE), tk = ty + "," + tx;
      const t = tiles.get(tk) || [Infinity, Infinity, -Infinity, -Infinity];
      tiles.set(tk, [Math.min(t[0], p.lon - m), Math.min(t[1], p.lat - m), Math.max(t[2], p.lon + m), Math.max(t[3], p.lat + m)]);
    }
    const all: any[] = [];
    for (const bb of [...tiles.values()].slice(0, MAX_TILES)) all.push(...await incidents(key, bb));

    // 3. Keep incidents within NEAR_KM of a stop, labelled with the nearest stop.
    const seen = new Set<string>(), list: any[] = [];
    for (const i of all) {
      const p = i.properties || {}, type = KEEP[p.iconCategory];
      if (!type) continue;
      let c = i.geometry?.coordinates || [];
      if (i.geometry?.type === "Point") c = [c];
      const step = Math.max(1, Math.floor(c.length / 20));
      let best = Infinity, near = -1;
      for (let k = 0; k < c.length; k += step) {
        const q = [Number(c[k][1]), Number(c[k][0])];
        stops.forEach((s, si) => { if (s) { const dd = km([s.lat, s.lon], q); if (dd < best) { best = dd; near = si; } } });
        if (!stops.some(Boolean) && area) { const dd = km([area.lat, area.lon], q); if (dd < best) { best = dd; near = -1; } }
      }
      if (best > NEAR_KM && !(near === -1 && best <= 25)) continue;
      const item = {
        type,
        what: String(p.events?.[0]?.description || "").slice(0, 80),
        road: String((p.roadNumbers || [])[0] || "").slice(0, 20),
        from: String(p.from || "").slice(0, 60),
        to: String(p.to || "").slice(0, 60),
        start: p.startTime || null,
        end: p.endTime || null,
        delay: Number(p.magnitudeOfDelay) || 0,
        stop: near,
        km: Math.round(best * 10) / 10,
      };
      const sig = item.type + item.road + item.from + item.to + item.start;
      if (seen.has(sig)) continue;
      seen.add(sig); list.push(item);
    }
    list.sort((a, b) => RANK[a.type] - RANK[b.type] || b.delay - a.delay || a.km - b.km);
    return json({ at: now, stops, list: list.slice(0, 12) });
  } catch (e) {
    console.error(e);
    return json({ error: "upstream" }, 502);
  }
});
