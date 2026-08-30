import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = [
  "Order number",
  "Submitted at",
  "Order status",
  "Payment method",
  "Payment status",
  "Customer name",
  "Email",
  "Phone",
  "Street address",
  "Address line 2",
  "City",
  "ZIP code",
  "Handoff preference",
  "Small quantity",
  "Large quantity",
  "XL quantity",
  "Subtotal",
  "Delivery fee",
  "Total",
  "Batch units",
  "Preferred delivery windows",
  "Delivery instructions",
  "Marketing opt-in",
  "Assigned delivery date",
  "Assigned delivery window",
  "Schedule approved",
  "Last updated",
];

const dayLabels: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const windowLabels: Record<string, string> = {
  "8_11": "8–11 a.m.",
  "11_2": "11 a.m.–2 p.m.",
  "2_5": "2–5 p.m.",
  "5_8": "5–8 p.m.",
};

function projectSecretKey() {
  const modernKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modernKeys) {
    const key = JSON.parse(modernKeys).default;
    if (key) return key;
  }
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacyKey) throw new Error("Supabase secret key is unavailable");
  return legacyKey;
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function secretsMatch(provided: string, expected: string) {
  const [providedHash, expectedHash] = await Promise.all([sha256(provided), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < expectedHash.length; index += 1) difference |= providedHash[index] ^ expectedHash[index];
  return difference === 0;
}

function readablePayment(value: string) {
  return value === "venmo_now" ? "Venmo up front" : value === "pay_on_delivery" ? "Pay upon delivery" : value;
}

function readableHandoff(value: string) {
  return value === "contactless" ? "Contactless drop-off" : value === "in_person" ? "In-person requested" : value;
}

function readableSlot(value: string) {
  if (value === "no_preference") return "No preference";
  const match = value.match(/^(mon|tue|wed|thu|fri|sat|sun)_(8_11|11_2|2_5|5_8)$/);
  return match ? `${dayLabels[match[1]]} ${windowLabels[match[2]]}` : value;
}

function cents(value: unknown) {
  return Number(value || 0) / 100;
}

function sheetSafe(value: unknown) {
  return typeof value === "string" && /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

Deno.serve(async (request) => {
  const responseHeaders = {
    "Access-Control-Allow-Headers": "content-type, x-export-key",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS") return new Response("ok", { headers: responseHeaders });
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { ...responseHeaders, "Content-Type": "application/json" },
  });

  try {
    const expectedKey = Deno.env.get("ORDERS_EXPORT_KEY") || "";
    const providedKey = request.headers.get("x-export-key") || "";
    if (!expectedKey || !providedKey || !(await secretsMatch(providedKey, expectedKey))) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 401,
        headers: { ...responseHeaders, "Content-Type": "application/json" },
      });
    }

    const client = createClient(Deno.env.get("SUPABASE_URL")!, projectSecretKey());
    const allOrders: Record<string, any>[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from("orders")
        .select(`
          order_number, created_at, order_status, payment_method, payment_status,
          full_name, email, phone, address_line1, address_line2, city, zip,
          delivery_method, subtotal_cents, delivery_fee_cents, total_cents,
          tracker_units, delivery_notes, marketing_opt_in, assigned_delivery_date,
          assigned_delivery_window, schedule_approved, updated_at,
          order_items (sku, quantity),
          delivery_preferences (slot_code)
        `)
        .order("created_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      allOrders.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }

    const rows = allOrders.map((order) => {
      const quantities = { small: 0, large: 0, xl: 0 };
      for (const item of order.order_items || []) {
        if (item.sku in quantities) quantities[item.sku as keyof typeof quantities] += Number(item.quantity || 0);
      }
      const slots = (order.delivery_preferences || []).map((preference: { slot_code: string }) => readableSlot(preference.slot_code));
      return [
        order.order_number,
        order.created_at,
        order.order_status,
        readablePayment(order.payment_method),
        order.payment_status,
        order.full_name,
        order.email,
        order.phone,
        order.address_line1,
        order.address_line2 || "",
        order.city,
        order.zip,
        readableHandoff(order.delivery_method),
        quantities.small,
        quantities.large,
        quantities.xl,
        cents(order.subtotal_cents),
        cents(order.delivery_fee_cents),
        cents(order.total_cents),
        order.tracker_units,
        slots.join("; "),
        order.delivery_notes || "",
        Boolean(order.marketing_opt_in),
        order.assigned_delivery_date || "",
        order.assigned_delivery_window ? windowLabels[order.assigned_delivery_window] || order.assigned_delivery_window : "",
        Boolean(order.schedule_approved),
        order.updated_at,
      ].map(sheetSafe);
    });

    const generatedAt = new Date().toISOString();
    const format = new URL(request.url).searchParams.get("format");
    if (format === "csv") {
      const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
      return new Response(csv, {
        headers: {
          ...responseHeaders,
          "Content-Disposition": `attachment; filename="noris-nibbles-orders-${generatedAt.slice(0, 10)}.csv"`,
          "Content-Type": "text/csv; charset=utf-8",
        },
      });
    }

    return new Response(JSON.stringify({ generated_at: generatedAt, count: rows.length, headers, rows }), {
      headers: { ...responseHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "Order export failed" }), {
      status: 500,
      headers: { ...responseHeaders, "Content-Type": "application/json" },
    });
  }
});
