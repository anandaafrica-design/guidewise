// Deletes the calling user's account. Backups and consents cascade via foreign keys.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "unauthorised" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "unauthorised" }, 401);
  // Stop any Paystack subscription first, so the card is not charged after the account is gone.
  const { data: sub } = await admin.from("subscriptions").select("paystack_subscription_code,paystack_email_token,status").eq("user_id", data.user.id).maybeSingle();
  if (sub?.paystack_subscription_code && sub.paystack_email_token && ["active", "attention", "non_renewing"].includes(sub.status)) {
    const r = await fetch("https://api.paystack.co/subscription/disable", {
      method: "POST",
      headers: { Authorization: "Bearer " + (Deno.env.get("PAYSTACK_SECRET_KEY") || "").replace(/[^\x21-\x7E]/g, ""), "Content-Type": "application/json" },
      body: JSON.stringify({ code: sub.paystack_subscription_code, token: sub.paystack_email_token }),
    });
    if (!r.ok && sub.status !== "non_renewing") return json({ error: "cancel_failed" }, 502);
  }
  const del = await admin.auth.admin.deleteUser(data.user.id);
  if (del.error) return json({ error: "delete failed" }, 500);
  return json({ deleted: true });
});
