// Paystack webhook. Verifies the signature, then syncs the subscription from Paystack itself
// (never trusts the event body for status or dates). Deployed with verify_jwt = false.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const KEY = () => (Deno.env.get("PAYSTACK_SECRET_KEY") || "").replace(/[^\x21-\x7E]/g, "");
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function hmac512(key: string, body: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function paystack(path: string) {
  const r = await fetch("https://api.paystack.co" + path, { headers: { Authorization: "Bearer " + KEY() } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.status === false) throw new Error("paystack " + path + ": " + (b.message || r.status));
  return b.data;
}
const STATUS: Record<string, string> = { active: "active", "non-renewing": "non_renewing", attention: "attention", completed: "cancelled", cancelled: "cancelled" };

async function userFor(customerCode?: string, metaUser?: string) {
  if (metaUser) return metaUser;
  if (!customerCode) return null;
  const { data } = await admin.from("subscriptions").select("user_id").eq("paystack_customer_code", customerCode).maybeSingle();
  return data?.user_id || null;
}

async function syncSubscription(code: string, metaUser?: string) {
  const s = await paystack("/subscription/" + encodeURIComponent(code));
  const userId = await userFor(s.customer?.customer_code, metaUser);
  if (!userId) { console.warn("no user for subscription", code); return; }
  const { data: cur } = await admin.from("subscriptions").select("status,current_period_end").eq("user_id", userId).maybeSingle();
  if (cur?.status === "comp") return; // owner/complimentary accounts are never downgraded by billing
  const end = s.next_payment_date || s.most_recent_invoice?.period_end || cur?.current_period_end || null;
  let status = STATUS[s.status] || "attention";
  if (status === "cancelled" && end && new Date(end).getTime() > Date.now()) status = "non_renewing"; // keep the paid period
  await admin.from("subscriptions").upsert({
    user_id: userId,
    status,
    plan: s.plan?.interval === "annually" ? "yearly" : "monthly",
    current_period_end: end,
    paystack_customer_code: s.customer?.customer_code,
    paystack_subscription_code: s.subscription_code,
    paystack_email_token: s.email_token,
    updated_at: new Date().toISOString(),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const raw = await req.text();
  const sig = req.headers.get("x-paystack-signature") || "";
  if (!KEY() || !safeEqual(await hmac512(KEY(), raw), sig)) return new Response("bad signature", { status: 401 });

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const d = ev.data || {};
  try {
    switch (ev.event) {
      case "subscription.create":
      case "subscription.not_renew":
      case "subscription.disable":
      case "subscription.expiring_cards":
        if (d.subscription_code) await syncSubscription(d.subscription_code);
        break;
      case "invoice.create":
      case "invoice.update":
      case "invoice.payment_failed":
        if (d.subscription?.subscription_code) await syncSubscription(d.subscription.subscription_code);
        break;
      case "charge.success": {
        // First payment carries our user id; remember the customer so later events map back.
        const userId = d.metadata?.user_id;
        const cust = d.customer?.customer_code;
        if (userId && cust) await admin.from("subscriptions").update({ paystack_customer_code: cust, updated_at: new Date().toISOString() }).eq("user_id", userId);
        // The subscription itself arrives as subscription.create; nothing else to do here.
        break;
      }
    }
  } catch (e) {
    console.error(ev.event, e);
    return new Response("retry", { status: 500 }); // Paystack retries failed webhooks
  }
  return new Response("ok");
});
