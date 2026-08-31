import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const products = {
  small: { name: "Small 4×4", priceCents: 600, units: 1 },
  large: { name: "Large 6×6", priceCents: 800, units: 2 },
  xl: { name: "XL tray", priceCents: 1500, units: 8 },
} as const;

const freeCities = new Set(["Alamo", "Albany", "Berkeley", "Danville", "Emeryville", "Lafayette", "Moraga", "Oakland", "Orinda", "Piedmont", "Pleasant Hill", "Walnut Creek"]);
const feeCities = new Set(["Concord", "El Cerrito", "Kensington"]);
const paymentMethods = new Set(["venmo_now", "pay_on_delivery"]);
const deliveryMethods = new Set(["contactless", "in_person"]);
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "https://igorgeyn.github.io")
  .split(",")
  .map((origin) => origin.trim());

function projectSecretKey() {
  const modernKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modernKeys) {
    const key = JSON.parse(modernKeys).default;
    if (key) return key;
  }
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacyKey) throw new Error("Supabase server key is unavailable");
  return legacyKey;
}

type SubmittedItem = { sku: keyof typeof products; quantity: number };

function corsHeaders(origin: string | null) {
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function clean(value: unknown, max = 250) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function html(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

function orderNumber() {
  const day = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  const random = crypto.getRandomValues(new Uint8Array(3));
  const suffix = [...random].map((byte) => (byte % 36).toString(36).toUpperCase()).join("");
  return `NN-${day}-${suffix}`;
}

async function fingerprint(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const salt = Deno.env.get("RATE_LIMIT_SALT") || "noris-nibbles";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(token: string, request: Request) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return;
  if (!token) throw new Error("Please complete the anti-spam check");
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) form.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const result = await response.json();
  if (!result.success) throw new Error("Anti-spam verification failed. Please try again.");
}

async function sendEmail(to: string[], subject: string, body: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL");
  if (!apiKey || !from) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html: body }),
  });
  if (!response.ok) console.error("Resend error", await response.text());
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  if (origin && !allowedOrigins.includes(origin)) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers });

  let cleanupOrderId: string | undefined;
  try {
    const body = await request.json();
    await verifyTurnstile(clean(body.turnstile_token, 2200), request);

    const fullName = clean(body.customer?.full_name, 120);
    const email = clean(body.customer?.email, 254).toLowerCase();
    const phone = clean(body.customer?.phone, 40);
    const line1 = clean(body.address?.line1, 160);
    const line2 = clean(body.address?.line2, 100);
    const city = clean(body.address?.city, 80);
    const zip = clean(body.address?.zip, 5);
    const paymentMethod = clean(body.payment_method, 30);
    const deliveryMethod = clean(body.delivery_method, 30);
    const deliveryNotes = clean(body.delivery_notes, 1200);
    const submittedSlots: unknown[] = Array.isArray(body.delivery_slots) ? body.delivery_slots : [];
    const slots: string[] = [...new Set(submittedSlots.map((slot) => clean(slot, 30)).filter((slot) => slot.length > 0))];
    const submittedItems = Array.isArray(body.items) ? body.items : [];

    if (!fullName || !email || !phone || !line1 || !city || !/^\d{5}$/.test(zip)) throw new Error("Please complete all required contact and address fields");
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Please enter a valid email address");
    if (!freeCities.has(city) && !feeCities.has(city)) throw new Error("That city is outside the current delivery area");
    if (!paymentMethods.has(paymentMethod) || !deliveryMethods.has(deliveryMethod)) throw new Error("Please select valid payment and delivery options");
    const validSlot = /^(mon|tue|wed|thu|fri|sat|sun)_(8_11|11_2|2_5|5_8)$/;
    if (!slots.length || slots.length > 28 || slots.some((slot) => slot !== "no_preference" && !validSlot.test(slot))) throw new Error("Please select valid delivery preferences");
    if (slots.includes("no_preference") && slots.length > 1) throw new Error("No preference cannot be combined with specific delivery windows");

    const items: SubmittedItem[] = submittedItems.map((item: { sku?: string; quantity?: number }) => ({
      sku: item.sku as keyof typeof products,
      quantity: Number(item.quantity),
    })).filter((item: SubmittedItem) => products[item.sku] && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 20);
    if (!items.length || items.length !== submittedItems.length) throw new Error("Please add a valid item to your order");

    const subtotalCents = items.reduce((sum, item) => sum + products[item.sku].priceCents * item.quantity, 0);
    const trackerUnits = items.reduce((sum, item) => sum + products[item.sku].units * item.quantity, 0);
    const deliveryFeeCents = feeCities.has(city) && trackerUnits < 8 ? 500 : 0;
    const totalCents = subtotalCents + deliveryFeeCents;
    const requestFingerprint = await fingerprint(request);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, projectSecretKey());
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count } = await supabase.from("orders").select("id", { count: "exact", head: true }).eq("request_fingerprint", requestFingerprint).gte("created_at", cutoff);
    if ((count || 0) >= 3) return new Response(JSON.stringify({ error: "Too many recent submissions. Please wait and try again." }), { status: 429, headers });

    const { data: batch, error: batchError } = await supabase.from("batches").select("id").eq("is_active", true).single();
    if (batchError || !batch) throw new Error("Ordering is temporarily unavailable because no batch is open");

    const number = orderNumber();
    const { data: order, error: orderError } = await supabase.from("orders").insert({
      order_number: number,
      batch_id: batch.id,
      full_name: fullName,
      email,
      phone,
      address_line1: line1,
      address_line2: line2 || null,
      city,
      zip,
      delivery_method: deliveryMethod,
      payment_method: paymentMethod,
      payment_status: paymentMethod === "venmo_now" ? "awaiting_confirmation" : "unpaid",
      subtotal_cents: subtotalCents,
      delivery_fee_cents: deliveryFeeCents,
      total_cents: totalCents,
      tracker_units: trackerUnits,
      delivery_notes: deliveryNotes || null,
      marketing_opt_in: body.marketing_opt_in === true,
      request_fingerprint: requestFingerprint,
    }).select("id").single();
    if (orderError || !order) throw orderError || new Error("Order could not be stored");
    cleanupOrderId = order.id;

    const { error: itemsError } = await supabase.from("order_items").insert(items.map((item) => ({
      order_id: order.id,
      sku: item.sku,
      product_name: products[item.sku].name,
      quantity: item.quantity,
      unit_price_cents: products[item.sku].priceCents,
      tracker_units_each: products[item.sku].units,
    })));
    if (itemsError) throw itemsError;
    const { error: slotsError } = await supabase.from("delivery_preferences").insert(slots.map((slot: string) => ({ order_id: order.id, slot_code: slot })));
    if (slotsError) throw slotsError;
    cleanupOrderId = undefined;

    const itemText = items.map((item) => `${item.quantity} × ${html(products[item.sku].name)}`).join("<br>");
    const formattedTotal = `$${(totalCents / 100).toFixed(2)}`;
    const paymentText = paymentMethod === "venmo_now"
      ? `Send ${formattedTotal} to <strong>@Igor-Geyn</strong> and include <strong>${number}</strong> in the note.`
      : "You selected payment upon delivery.";
    await Promise.allSettled([
      sendEmail([email], `Nori's Nibbles order ${number}`, `<h2>Thanks, ${html(fullName)}—your order is in.</h2><p>${itemText}</p><p><strong>Total: ${formattedTotal}</strong></p><p>${paymentText}</p><p>Your order counts toward the Next Fresh Batch immediately. We’ll email you as the batch moves forward and announce delivery timing after the crop is ready.</p>`),
      sendEmail([Deno.env.get("ADMIN_EMAIL") || "igorgeyn@gmail.com"], `New Nori's Nibbles order ${number}`, `<h2>New order: ${number}</h2><p>${html(fullName)} · ${html(email)} · ${html(phone)}</p><p>${itemText}</p><p>${html(line1)}${line2 ? `<br>${html(line2)}` : ""}<br>${html(city)}, CA ${html(zip)}</p><p><strong>${formattedTotal} · ${trackerUnits} batch units</strong></p>`),
    ]);

    return new Response(JSON.stringify({
      order_number: number,
      total: totalCents / 100,
      tracker_units: trackerUnits,
      payment_method: paymentMethod,
    }), { status: 201, headers });
  } catch (error) {
    console.error(error);
    if (cleanupOrderId) {
      const cleanupClient = createClient(Deno.env.get("SUPABASE_URL")!, projectSecretKey());
      const { error: cleanupError } = await cleanupClient.from("orders").delete().eq("id", cleanupOrderId);
      if (cleanupError) console.error("Could not clean up partial order", cleanupError);
    }
    const message = error instanceof Error ? error.message : "Order could not be placed";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers });
  }
});
