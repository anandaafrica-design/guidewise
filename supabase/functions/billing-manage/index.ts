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

// A cancelled subscription keeps Plus until the end of the period already paid for.
function mapStatus(paystackStatus: string, periodEnd?: string | null) {
  const m = STATUS[paystackStatus] || "attention";
  if (m === "cancelled" && periodEnd && new Date(periodEnd).getTime() > Date.now()) return "non_renewing";
  return m;
}
async function paystack(path: string, init: RequestInit = {}) {
  const r = await fetch("https://api.paystack.co" + path, { ...init, headers: { Authorization: "Bearer " + (Deno.env.get("PAYSTACK_SECRET_KEY") || "").replace(/[^\x21-\x7E]/g, ""), "Content-Type": "application/json" } });
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
    if (sub?.status === "comp") return json({ status: "comp" });
    try {
      // With a checkout reference: confirm that charge belongs to this user. Without one: look up
      // the Paystack customer we created for this user at checkout (never one the client names).
      let customerId: string | number | undefined, customerCode: string | undefined;
      if (reference) {
        if (!/^[\w.-]{4,100}$/.test(reference)) return json({ error: "reference" }, 400);
        const t = await paystack("/transaction/verify/" + encodeURIComponent(reference));
        if (t.status !== "success" || t.metadata?.user_id !== u.user.id) return json({ status: "unpaid" });
        customerId = t.customer?.id; customerCode = t.customer?.customer_code;
      } else {
        if (!sub?.paystack_customer_code) return json({ status: "none" });
        const c = await paystack("/customer/" + encodeURIComponent(sub.paystack_customer_code));
        customerId = c.id; customerCode = c.customer_code;
      }
      const list = await paystack("/subscription?customer=" + encodeURIComponent(String(customerId)) + "&perPage=20");
      const s = (list || []).filter((x: any) => x.status === "active").sort((a: any, b: any) => (b.id || 0) - (a.id || 0))[0];
      if (!s) return json({ status: "pending" }); // subscription is created a few seconds after the charge
      await admin.from("subscriptions").upsert({
        user_id: u.user.id,
        status: "active",
        plan: s.plan?.interval === "annually" ? "yearly" : "monthly",
        current_period_end: s.next_payment_date || null,
        paystack_customer_code: customerCode,
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
    // Cancel (stop renewing) or resume, in the app rather than on Paystack's page.
    if (action === "cancel" && sub.status !== "comp") {
      if (!sub.paystack_email_token) return json({ error: "no_token" }, 409);
      await paystack("/subscription/disable", { method: "POST", body: JSON.stringify({ code: sub.paystack_subscription_code, token: sub.paystack_email_token }) });
    }
    if (action === "resume" && sub.status !== "comp") {
      // Paystack cannot reactivate a cancelled subscription. Start a new one on the same card,
      // beginning when the paid period ends: nothing is charged now and there is no gap.
      const old = await paystack("/subscription/" + encodeURIComponent(sub.paystack_subscription_code));
      if (old.status === "active") return json({ ok: true });
      const auth = old.authorization?.authorization_code;
      const end = sub.current_period_end && new Date(sub.current_period_end).getTime() > Date.now() ? sub.current_period_end : null;
      if (!auth || !old.plan?.plan_code) return json({ error: "resubscribe" }, 409);
      const created = await paystack("/subscription", {
        method: "POST",
        body: JSON.stringify({ customer: old.customer?.customer_code, plan: old.plan.plan_code, authorization: auth, ...(end ? { start_date: end } : {}) }),
      });
      await admin.from("subscriptions").update({
        status: "active",
        paystack_subscription_code: created.subscription_code,
        paystack_email_token: created.email_token,
        current_period_end: end || created.next_payment_date || null,
        updated_at: new Date().toISOString(),
      }).eq("user_id", u.user.id);
      return json({ ok: true });
    }
    const s = await paystack("/subscription/" + encodeURIComponent(sub.paystack_subscription_code));
    if (sub.status !== "comp") {
      const end = s.next_payment_date || sub.current_period_end;
      await admin.from("subscriptions").update({
        status: mapStatus(s.status, end),
        current_period_end: end,
        updated_at: new Date().toISOString(),
      }).eq("user_id", u.user.id);
    }
    if (action === "sync" || action === "cancel" || action === "resume") return json({ ok: true });
    const link = await paystack("/subscription/" + encodeURIComponent(sub.paystack_subscription_code) + "/manage/link");
    return json({ url: link.link });
  } catch (e) {
    console.error(e);
    return json({ error: "manage_failed" }, 502);
  }
});
