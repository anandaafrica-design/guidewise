// Starts a Paystack checkout for Guidewise Plus. Caller must be signed in.
// Secrets: PAYSTACK_SECRET_KEY, PAYSTACK_PLAN_MONTHLY, PAYSTACK_PLAN_YEARLY.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const ALLOWED_RETURN = /^https:\/\/(guidewise-app\.netlify\.app|deploy-preview-\d+--guidewise-app\.netlify\.app)$/;

async function paystack(path: string, init: RequestInit = {}) {
  const r = await fetch("https://api.paystack.co" + path, {
    ...init,
    headers: { Authorization: "Bearer " + (Deno.env.get("PAYSTACK_SECRET_KEY") || "").replace(/[^\x21-\x7E]/g, ""), "Content-Type": "application/json", ...(init.headers || {}) },
  });
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
  if (ue || !u?.user?.email) return json({ error: "unauthorised" }, 401);
  const user = u.user;

  const { plan } = await req.json().catch(() => ({}));
  const planCode = plan === "yearly" ? (Deno.env.get("PAYSTACK_PLAN_YEARLY") || "").replace(/[^\x21-\x7E]/g, "") : plan === "monthly" ? (Deno.env.get("PAYSTACK_PLAN_MONTHLY") || "").replace(/[^\x21-\x7E]/g, "") : null;
  if (!planCode) return json({ error: "plan" }, 400);
  if (!(Deno.env.get("PAYSTACK_SECRET_KEY") || "").replace(/[^\x21-\x7E]/g, "")) return json({ error: "not_configured" }, 503);

  const origin = req.headers.get("Origin") || "";
  const back = (ALLOWED_RETURN.test(origin) ? origin : "https://guidewise-app.netlify.app") + "/?paid=1";

  try {
    const { data: sub } = await admin.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();
    if (sub?.status === "active" && sub.paystack_subscription_code) return json({ error: "already_active" }, 409);

    // One Paystack customer per user, so every later webhook maps back by customer code.
    let customer = sub?.paystack_customer_code;
    if (!customer) {
      const c = await paystack("/customer", { method: "POST", body: JSON.stringify({ email: user.email, metadata: { user_id: user.id } }) });
      customer = c.customer_code;
      await admin.from("subscriptions").upsert({ user_id: user.id, paystack_customer_code: customer, updated_at: new Date().toISOString() });
    }
    const t = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({ email: user.email, amount: plan === "yearly" ? 79000 : 7900, plan: planCode, callback_url: back, metadata: { user_id: user.id, plan } }),
    });
    return json({ url: t.authorization_url });
  } catch (e) {
    console.error(e);
    return json({ error: "checkout_failed" }, 502);
  }
});
