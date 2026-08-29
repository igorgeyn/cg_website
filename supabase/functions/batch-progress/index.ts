import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function corsHeaders(origin: string | null) {
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      projectSecretKey(),
    );
    const { data: batch, error: batchError } = await supabase
      .from("batches")
      .select("id, goal_units, status")
      .eq("is_active", true)
      .single();
    if (batchError || !batch) throw new Error("No active batch is configured");

    const { data: orders, error: ordersError } = await supabase
      .from("orders")
      .select("tracker_units")
      .eq("batch_id", batch.id)
      .not("order_status", "in", "(cancelled,spam)");
    if (ordersError) throw ordersError;

    const currentUnits = (orders || []).reduce((total, order) => total + order.tracker_units, 0);
    return new Response(JSON.stringify({
      current_units: currentUnits,
      goal_units: batch.goal_units,
      status: currentUnits >= batch.goal_units && batch.status === "collecting" ? "goal_reached" : batch.status,
    }), { headers });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "Progress is temporarily unavailable" }), { status: 500, headers });
  }
});
