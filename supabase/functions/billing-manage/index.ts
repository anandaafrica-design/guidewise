// Returns Paystack's hosted page where the subscriber can update their card or cancel.
// Also re-syncs the subscription so the app shows the latest status after returning.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const STATUS: Record<string, string> = { active: "active", "non-renewing": "non_renewing", attention: "attention", completed: "cancelled", cancelled: "cancelled" };

async function paystack(path: string) {
  const r = await fetch("https://api.paystack.co" + path, { headers: { Authorization: "Bearer " + (Deno.env.get("PAYSTACK_SECRET_KEY") || "").replace(/[^\x21-\x7E]/g, "") } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.status === false) throw new Error("paystack " + path + ": " + (b.message || r.status));
  return b.data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: u, error: ue } = await admin.auth.getUser(jwt);
  if (ue || !u?.user) return json({ error: "unauthorised" }, 401);

  const { action } = await req.json().catch(() => ({}));
  const { data: sub } = await admin.from("subscriptions").select("*").eq("user_id", u.user.id).maybeSingle();
  if (!sub?.paystack_subscription_code) return json({ error: "no_subscription" }, 404);
  try {
    const s = await paystack("/subscription/" + encodeURIComponent(sub.paystack_subscription_code));
    if (sub.status !== "comp") {
      await admin.from("subscriptions").update({
        status: STATUS[s.status] || sub.status,
        current_period_end: s.next_payment_date || sub.current_period_end,
        updated_at: new Date().toISOString(),
      }).eq("user_id", u.user.id);
    }
    if (action === "sync") return json({ ok: true });
    const link = await paystack("/subscription/" + encodeURIComponent(sub.paystack_subscription_code) + "/manage/link");
    return json({ url: link.link });
  } catch (e) {
    console.error(e);
    return json({ error: "manage_failed" }, 502);
  }
});
