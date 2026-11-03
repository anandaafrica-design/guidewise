// AI import: turns itineraries, rooming lists and confirmations into a draft Guidewise tour.
// The documents and the result are never stored or logged; only usage counts are kept.
// Secrets: ANTHROPIC_API_KEY. Optional: AI_MODEL ("opus" | "haiku", default "opus"), AI_EFFORT ("low" | "medium" | "high", default "low").
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-gw-test",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const MODELS: Record<string, string> = { opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" };
const PRICE: Record<string, [number, number]> = { opus: [4, 20], haiku: [0.1, 0.5] }; // USD per 1M tokens in/out
const MONTHLY_LIMIT = 5;
const EFFORTS = ["low", "medium", "high"];
const MAX_FILES = 5, MAX_BYTES = 12_000_000;

const str = { type: "string" };
const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["tour", "days", "guests", "warnings"],
  properties: {
    tour: { type: "string", description: "Tour name, e.g. 'Southern Africa Safari & Rail · May 2026'" },
    days: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["date", "title", "area", "meet", "start", "stops", "checklist", "notes"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD, or empty if unknown" },
          title: { type: "string", description: "Short day title, e.g. 'Cape Peninsula'" },
          area: { type: "string", description: "Town or region where most of the day happens, for a weather forecast, e.g. 'Simon's Town', 'Kasane'. On a train or flight day: where the group sleeps." },
          meet: { type: "string", description: "Meeting point for the group, or empty" },
          start: { type: "string", description: "Group departure time HH:MM (24h), or empty" },
          stops: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              required: ["place", "kind", "arrive", "leave", "travel", "note", "lunch", "check"],
              properties: {
                place: { type: "string" },
                kind: { type: "string", enum: ["visit", "meal", "activity", "hotel", "transfer", "flight", "free"], description: "meal for breakfast/lunch/dinner/drinks; activity for game drives, tours, tastings; transfer for road or rail legs that are the activity; flight for a flight leg" },
                arrive: { type: "string", description: "HH:MM arrival, or empty" },
                leave: { type: "string", description: "HH:MM departure, or empty. For a flight: landing time" },
                travel: { type: "integer", description: "Realistic minutes of travel from the previous stop to this one (road time, walking, or to the airport). 0 if in the same place. Never include waiting or free time." },
                note: { type: "string", description: "Bookings, tickets, transfers, what to know. Short." },
                lunch: { type: "boolean", description: "True if this stop is lunch" },
                check: { type: "boolean", description: "True if a time or detail was unclear and the guide should check it" },
              },
            },
          },
          checklist: { type: "array", items: str, description: "Things the guide must have or do that day: vouchers, cash, confirmations" },
          notes: { type: "string", description: "Anything else useful for the day, e.g. meal plan, dress code. Short." },
        },
      },
    },
    guests: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "room", "diet", "bday", "notes", "check"],
        properties: {
          name: { type: "string", description: "Name as it should appear to the guide" },
          room: { type: "string", description: "Room number or room type/sharing, or empty" },
          diet: { type: "string", description: "Dietary needs and food allergies only, or empty" },
          bday: { type: "string", description: "Birthday as MM-DD only, or empty. Never the year." },
          notes: { type: "string", description: "Mobility, medical points relevant on tour, celebrations, preferences. Short." },
          check: { type: "boolean" },
        },
      },
    },
    warnings: { type: "array", items: str, description: "Short notes on anything missing, conflicting or hard to read" },
  },
};

const SYSTEM = `You prepare a tour guide's working plan from tour documents (itineraries, rooming lists, recaps, confirmations).
Extract only what the documents say. Never invent places, times, names or needs. Leave a field empty when it is not given, and set "check" when something is ambiguous.
Merge information about the same guest or day across documents.
Write in UK English, concisely.
Privacy: never output passport, visa or ID numbers, full dates of birth or years of birth, phone numbers, email addresses, flight booking codes, or insurance details, even if present. Birthdays only as MM-DD.
Times are local, 24-hour HH:MM. For each day, list stops in order with arrival and departure times where known; put hotel check-in or the overnight stay as the last stop.
Include meals and drinks that have a time or a venue as stops, and mark lunches.
If a date of birth or a "Birthday (MM-DD)" is given, put it in bday as MM-DD.
Never state a guest's age or a numbered milestone ("75th birthday", "turning 60"), as that reveals the birth year: write "milestone birthday" instead. Wedding anniversary numbers are fine.
If the documents give the tour dates but no day-by-day programme, still output one day per tour date with its date, a short title from the hotel or services that day, and the overnight hotel as the only stop. Never leave days empty when dates are known.
Put medication and medical allergies in the guest's notes, starting with "Medical:".
Stops: in time order. Parse times written inside text ("Depart for Constantia 15:00") into arrive/leave. A flight is its own stop (kind flight, place like "Flight Johannesburg to Victoria Falls", arrive = departure time, leave = landing time); if a time is "to be advised", leave it empty and set check. Give each stop a realistic travel estimate from the previous stop using your knowledge of the area (e.g. Chapman's Peak to Cape Point about 45 minutes; border crossings add time). Multi-hour activities: give both arrive and leave when the documents give a duration.
List every guest named in a rooming list, recap or guest list.
Do not put tour or booking codes in notes. Do not repeat the same point in several places: put each warning once. Pre-trip reminders (passport validity, visas to arrange) go in warnings, not in day checklists.`;

function usdCost(key: string, inTok: number, outTok: number) {
  const [pi, po] = PRICE[key];
  return Math.round(((inTok * pi + outTok * po) / 1e6) * 10000) / 10000;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.files) || !body.files.length) return json({ error: "files" }, 400);

  // Who is calling: a signed-in Plus user, or the owner's short-lived test token (model comparison).
  let userId: string | null = null, modelKey = (Deno.env.get("AI_MODEL") || "opus").trim();
  let effort = (Deno.env.get("AI_EFFORT") || "low").trim();
  const testTok = req.headers.get("x-gw-test");
  if (testTok) {
    const { data } = await admin.from("admin_test_tokens").select("expires_at").eq("token", testTok).maybeSingle();
    if (!data || new Date(data.expires_at).getTime() < Date.now()) return json({ error: "unauthorised" }, 401);
    if (body.model && MODELS[body.model]) modelKey = body.model;
    if (body.effort && EFFORTS.includes(body.effort)) effort = body.effort;
  } else {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "unauthorised" }, 401);
    userId = u.user.id;
    if (body.consent !== "ai-v1") return json({ error: "consent" }, 400); // agreed on the phone for this import
    const { data: plus } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + jwt } },
    }).rpc("has_plus");
    if (!plus) return json({ error: "plus_required" }, 402);
    const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
    const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("ok", true).not("model", "like", "%:translate").gte("created_at", since.toISOString());
    if ((count || 0) >= MONTHLY_LIMIT) return json({ error: "limit", limit: MONTHLY_LIMIT }, 429);
  }
  if (!MODELS[modelKey]) modelKey = "opus";

  // Build the content: PDFs and images as-is, spreadsheets already converted to text on the phone.
  if (body.files.length > MAX_FILES) return json({ error: "too_many_files", max: MAX_FILES }, 400);
  let bytes = 0;
  const content: any[] = [];
  for (const f of body.files) {
    const name = String(f.name || "document").slice(0, 120);
    if (f.kind === "pdf" && typeof f.data === "string") {
      bytes += f.data.length * 0.75;
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data }, title: name });
    } else if (f.kind === "image" && typeof f.data === "string" && /^image\/(png|jpeg|webp|gif)$/.test(f.media_type)) {
      bytes += f.data.length * 0.75;
      content.push({ type: "image", source: { type: "base64", media_type: f.media_type, data: f.data } });
      content.push({ type: "text", text: `(The image above is "${name}".)` });
    } else if (f.kind === "text" && typeof f.text === "string") {
      bytes += f.text.length;
      content.push({ type: "text", text: `Document "${name}":\n${f.text.slice(0, 400_000)}` });
    }
  }
  if (!content.length) return json({ error: "unsupported" }, 400);
  if (bytes > MAX_BYTES) return json({ error: "too_large" }, 413);
  content.push({ type: "text", text: "Build the tour plan from these documents." });

  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").replace(/[^\x21-\x7E]/g, "");
  if (!apiKey) return json({ error: "not_configured" }, 503);
  const client = new Anthropic({ apiKey });
  const started = Date.now();
  try {
    const params: any = {
      model: MODELS[modelKey],
      max_tokens: 32000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: EFFORTS.includes(effort) ? effort : "low" },
    };
    let msg: any;
    if (modelKey === "opus") {
      // Server-side fallback: if a safety check wrongly declines a document, another model reads it.
      msg = await client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }).finalMessage();
    } else {
      msg = await client.messages.stream(params).finalMessage();
    }
    const inTok = msg.usage?.input_tokens || 0, outTok = msg.usage?.output_tokens || 0;
    await admin.from("ai_usage").insert({ user_id: userId, model: MODELS[modelKey], files: body.files.length, input_tokens: inTok, output_tokens: outTok, ok: msg.stop_reason === "end_turn" });
    if (msg.stop_reason === "refusal") return json({ error: "declined" }, 422);
    if (msg.stop_reason === "max_tokens") return json({ error: "too_long" }, 422);
    const text = (msg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    let draft;
    try { draft = JSON.parse(text); } catch { return json({ error: "bad_output" }, 502); }
    return json({ draft, usage: { model: MODELS[modelKey], input_tokens: inTok, output_tokens: outTok, usd: usdCost(modelKey, inTok, outTok), effort, seconds: Math.round((Date.now() - started) / 1000) } });
  } catch (e) {
    console.error("ai-import", modelKey, (e as Error).message);
    return json({ error: "ai_failed" }, 502);
  }
});
