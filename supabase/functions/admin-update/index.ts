import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const adminEmail = (Deno.env.get("ADMIN_EMAIL") || "igorgeyn@gmail.com").toLowerCase();
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "https://igorgeyn.github.io")
  .split(",")
  .map((origin) => origin.trim());
const batchStatuses = new Set(["collecting", "goal_reached", "growing", "ready", "delivery_planning", "complete"]);
const orderStatuses = new Set(["received", "confirmed", "growing", "ready", "scheduled", "delivered", "cancelled", "spam"]);
const paymentStatuses = new Set(["unpaid", "awaiting_confirmation", "paid"]);
const windows = new Set(["8_11", "11_2", "2_5", "5_8", null]);

function corsHeaders(origin: string | null) {
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function html(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

async function sendEmail(to: string[], subject: string, body: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL");
  if (!apiKey || !from || !to.length) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html: body }),
  });
  if (!response.ok) throw new Error(`Email provider error: ${await response.text()}`);
}

function batchCopy(status: string) {
  const copy: Record<string, { subject: string; body: string } | undefined> = {
    goal_reached: { subject: "The Next Fresh Batch goal is reached", body: "We’ve gathered enough demand for the next fresh batch and will schedule growing soon." },
    growing: { subject: "Your Nori’s Nibbles batch is growing", body: "Growing has begun. The grass is typically ready for delivery within 10 days, and we’ll contact you when delivery planning starts." },
    ready: { subject: "Your fresh cat grass is ready", body: "The crop is ready, and we’re now grouping deliveries around customer locations and preferred windows." },
    delivery_planning: { subject: "Delivery planning is underway", body: "We’re arranging efficient delivery groups now. You’ll receive a final window once yours is approved." },
  };
  return copy[status];
}

function readableWindow(window: string) {
  return ({ "8_11": "8–11 a.m.", "11_2": "11 a.m.–2 p.m.", "2_5": "2–5 p.m.", "5_8": "5–8 p.m." } as Record<string, string>)[window] || window;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  if (origin && !allowedOrigins.includes(origin)) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers });

  try {
    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("Sign-in required");

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || userData.user?.email?.toLowerCase() !== adminEmail) throw new Error("Not authorized");

    const body = await request.json();
    if (body.action === "batch_status") {
      if (!batchStatuses.has(body.status)) throw new Error("Invalid batch status");
      const updates: Record<string, unknown> = { status: body.status };
      if (body.status === "growing") updates.growing_at = new Date().toISOString();
      if (body.status === "ready") updates.ready_at = new Date().toISOString();
      if (body.status === "complete") updates.completed_at = new Date().toISOString();
      const { data: batch, error } = await admin.from("batches").update(updates).eq("id", body.batch_id).select("id").single();
      if (error || !batch) throw error || new Error("Batch not found");

      const notification = batchCopy(body.status);
      let notified = 0;
      if (notification) {
        const [{ data: orders, error: ordersError }, { data: subscribers, error: subscribersError }] = await Promise.all([
          admin.from("orders").select("email, full_name").eq("batch_id", batch.id).not("order_status", "in", "(cancelled,spam)"),
          admin.from("batch_subscribers").select("email, unsubscribe_token").eq("is_active", true),
        ]);
        if (ordersError || subscribersError) throw ordersError || subscribersError;
        const unique = new Map<string, { name: string; unsubscribeToken?: string }>();
        (orders || []).forEach((order) => unique.set(order.email, { name: order.full_name }));
        (subscribers || []).forEach((subscriber) => { if (!unique.has(subscriber.email)) unique.set(subscriber.email, { name: "there", unsubscribeToken: subscriber.unsubscribe_token }); });
        const siteUrl = (Deno.env.get("SITE_URL") || "https://igorgeyn.github.io/cg_website").replace(/\/$/, "");
        await Promise.all([...unique.entries()].map(([email, recipient]) => {
          const unsubscribe = recipient.unsubscribeToken ? `<p style="font-size:12px"><a href="${siteUrl}/unsubscribe.html?token=${encodeURIComponent(recipient.unsubscribeToken)}">Unsubscribe from optional batch alerts</a></p>` : "";
          return sendEmail([email], notification.subject, `<h2>${notification.subject}</h2><p>Hi ${html(recipient.name)},</p><p>${notification.body}</p><p>Thanks for supporting Nori’s Nibbles.</p>${unsubscribe}`);
        }));
        notified = unique.size;
      }
      return new Response(JSON.stringify({ ok: true, notified }), { headers });
    }

    if (body.action === "order_update") {
      if (!orderStatuses.has(body.order_status) || !paymentStatuses.has(body.payment_status)) throw new Error("Invalid order or payment status");
      const deliveryDate = typeof body.assigned_delivery_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.assigned_delivery_date) ? body.assigned_delivery_date : null;
      const deliveryWindow = windows.has(body.assigned_delivery_window) ? body.assigned_delivery_window : null;
      const scheduleApproved = Boolean(deliveryDate && deliveryWindow);
      const { data: existing, error: existingError } = await admin.from("orders").select("email, full_name, order_number, assigned_delivery_date, assigned_delivery_window, schedule_notified_at").eq("id", body.order_id).single();
      if (existingError || !existing) throw existingError || new Error("Order not found");
      const scheduleChanged = scheduleApproved && (existing.assigned_delivery_date !== deliveryDate || existing.assigned_delivery_window !== deliveryWindow || !existing.schedule_notified_at);
      const updates: Record<string, unknown> = {
        order_status: body.order_status,
        payment_status: body.payment_status,
        assigned_delivery_date: deliveryDate,
        assigned_delivery_window: deliveryWindow,
        schedule_approved: scheduleApproved,
      };
      if (scheduleChanged) updates.schedule_notified_at = new Date().toISOString();
      const { error } = await admin.from("orders").update(updates).eq("id", body.order_id);
      if (error) throw error;
      if (scheduleChanged) {
        const date = new Date(`${deliveryDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
        await sendEmail([existing.email], `Delivery scheduled for order ${existing.order_number}`, `<h2>Your delivery window is ready</h2><p>Hi ${html(existing.full_name)},</p><p>We plan to deliver your Nori’s Nibbles order on <strong>${html(date)}</strong> between <strong>${html(readableWindow(deliveryWindow!))}</strong>.</p><p>If this falls outside the preferences you submitted, please reply so we can make sure the plan works for you. Contactless drop-off is the default; if you requested an in-person handoff and no one is available, we’ll leave the order safely at your doorstep.</p>`);
      }
      return new Response(JSON.stringify({ ok: true, notified: scheduleChanged ? 1 : 0 }), { headers });
    }

    if (body.action === "new_batch") {
      const authenticated = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data, error } = await authenticated.rpc("start_new_batch");
      if (error) throw error;
      const { data: subscribers, error: subscribersError } = await admin.from("batch_subscribers").select("email, unsubscribe_token").eq("is_active", true);
      if (subscribersError) throw subscribersError;
      const siteUrl = (Deno.env.get("SITE_URL") || "https://igorgeyn.github.io/cg_website").replace(/\/$/, "");
      await Promise.all((subscribers || []).map((subscriber) => sendEmail([subscriber.email], "A new Nori’s Nibbles batch is open", `<h2>The Next Fresh Batch is open.</h2><p>Fresh reservations are now being collected. Visit <a href="${siteUrl}/index.html#order">the batch tracker</a> to follow progress or place an order.</p><p style="font-size:12px"><a href="${siteUrl}/unsubscribe.html?token=${encodeURIComponent(subscriber.unsubscribe_token)}">Unsubscribe from optional batch alerts</a></p>`)));
      return new Response(JSON.stringify({ ok: true, batch: data, notified: subscribers?.length || 0 }), { headers });
    }

    throw new Error("Unknown action");
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Admin update failed";
    return new Response(JSON.stringify({ error: message }), { status: /authorized|required/.test(message) ? 403 : 400, headers });
  }
});
