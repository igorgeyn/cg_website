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

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  if (origin && !allowedOrigins.includes(origin)) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers });
  try {
    const body = await request.json();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid unsubscribe token");
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, projectSecretKey());
    const { error } = await supabase.from("batch_subscribers").update({ is_active: false }).eq("unsubscribe_token", token);
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unsubscribe failed";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers });
  }
});
