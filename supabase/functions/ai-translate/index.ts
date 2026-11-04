// Translates a WhatsApp briefing (no guest personal data: the app never puts birthdays or dietaries in it).
// Plus only, 30 a month, logged in ai_usage with model "<id>:translate" (not counted towards AI import).
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const MODEL = "claude-haiku-5-5", TAG = MODEL + ":translate", LIMIT = 30;
const LANGS = ["German", "French", "Spanish", "Italian", "Dutch", "Portuguese", "Afrikaans", "isiZulu", "isiXhosa", "Swedish", "Danish", "Norwegian", "Polish", "Russian", "Hebrew", "Arabic", "Hindi", "Mandarin Chinese", "Japanese", "Korean"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "unauthorised" }, 401);
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "").slice(0, 4000), lang = String(body.lang || "");
  if (!text.trim() || !LANGS.includes(lang)) return json({ error: "input" }, 400);
  const { data: plus } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + jwt } } }).rpc("has_plus");
  if (!plus) return json({ error: "plus_required" }, 402);
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", u.user.id).eq("model", TAG).eq("ok", true).gte("created_at", since.toISOString());
  if ((count || 0) >= LIMIT) return json({ error: "limit", limit: LIMIT }, 429);
  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").replace(/[^\x21-\x7E]/g, "");
  if (!apiKey) return json({ error: "not_configured" }, 503);
  try {
    const msg: any = await new Anthropic({ apiKey }).messages.create({
      model: MODEL, max_tokens: 2000,
      system: `You translate a tour guide's WhatsApp briefing for their guests into ${lang}. Keep it warm and natural, as a local guide would write it. Keep every emoji, line break, time (HH:MM), *bold* marker and place or business name exactly as given. Translate only; add nothing. Reply with the translated message only.`,
      messages: [{ role: "user", content: text }],
    });
    const out = (msg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    await admin.from("ai_usage").insert({ user_id: u.user.id, model: TAG, files: 0, input_tokens: msg.usage?.input_tokens || 0, output_tokens: msg.usage?.output_tokens || 0, ok: !!out && msg.stop_reason === "end_turn" });
    if (!out) return json({ error: "ai_failed" }, 502);
    return json({ text: out, left: LIMIT - (count || 0) - 1 });
  } catch (e) {
    console.error("ai-translate", (e as Error).message);
    return json({ error: "ai_failed" }, 502);
  }
});
