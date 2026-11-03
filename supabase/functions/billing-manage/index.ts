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

  const { action, reference } = await req.json().catch(() => ({}));
  const { data: sub } = await admin.from("subscriptions").select("*").eq("user_id", u.user.id).maybeSingle();

  // Back from checkout: confirm with Paystack directly, so the app does not depend on the webhook alone.
  if (action === "verify") {
    if (!reference || !/^[\w.-]{4,100}$/.test(reference)) return json({ error: "reference" }, 400);
    try {
      const t = await paystack("/transaction/verify/" + encodeURIComponent(reference));
      if (t.status !== "success" || t.metadata?.user_id !== u.user.id) return json({ status: "unpaid" });
      if (sub?.status === "comp") return json({ status: "comp" });
      const list = await paystack("/subscription?customer=" + encodeURIComponent(String(t.customer?.id)) + "&perPage=20");
      const s = (list || []).filter((x: any) => x.status === "active").sort((a: any, b: any) => (b.id || 0) - (a.id || 0))[0];
      if (!s) return json({ status: "pending" }); // subscription is created a few seconds after the charge
      await admin.from("subscriptions").upsert({
        user_id: u.user.id,
        status: "active",
        plan: s.plan?.interval === "annually" ? "yearly" : "monthly",
        current_period_end: s.next_payment_date || null,
        paystack_customer_code: t.customer?.customer_code,
        paystack_subscription_code: s.subscription_code,
        paystack_email_token: s.email_token,
        updated_at: new Date().toISOString(),
      });
      return json({ status: "active" });
    } catch (e) {
      console.error(e);
      return json({ error: "verify_failed" }, 502);
    }
  }

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
