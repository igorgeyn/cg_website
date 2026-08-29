import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "https://igorgeyn.github.io").split(",").map((origin) => origin.trim());

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

function corsHeaders(origin: string | null) {
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
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

async function sendConfirmation(email: string, token: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL");
  const siteUrl = (Deno.env.get("SITE_URL") || "https://igorgeyn.github.io/cg_website").replace(/\/$/, "");
  if (!apiKey || !from) return;
  const unsubscribeUrl = `${siteUrl}/unsubscribe.html?token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Nori's Nibbles batch alerts",
      html: `<h2>You’re on the fresh-batch list.</h2><p>We’ll email you when a new Nori’s Nibbles batch begins growing. This signup is separate from promotional discounts.</p><p><a href="${unsubscribeUrl}">Unsubscribe from optional batch alerts</a></p>`,
    }),
  });
  if (!response.ok) console.error("Resend error", await response.text());
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  if (origin && !allowedOrigins.includes(origin)) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers });
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Please enter a valid email address");
    await verifyTurnstile(typeof body.turnstile_token === "string" ? body.turnstile_token : "", request);
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, projectSecretKey());
    const { data, error } = await supabase.from("batch_subscribers").upsert({ email, is_active: true }, { onConflict: "email" }).select("unsubscribe_token").single();
    if (error || !data) throw error || new Error("Subscription could not be saved");
    await sendConfirmation(email, data.unsubscribe_token);
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Subscription failed";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers });
  }
});
