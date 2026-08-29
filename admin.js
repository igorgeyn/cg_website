(() => {
  "use strict";
  const config = window.NORIS_NIBBLES_CONFIG || {};
  const login = document.getElementById("admin-login");
  const dashboard = document.getElementById("admin-dashboard");
  const loginMessage = document.getElementById("login-message");
  const dashboardMessage = document.getElementById("dashboard-message");
  let client;
  let activeBatch;
  let orders = [];

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

  function message(element, text, type = "error") {
    element.textContent = text;
    element.className = `admin-message visible ${type}`;
  }

  function configure() {
    if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase) {
      message(loginMessage, "Admin services are not configured yet. Add the Supabase URL and publishable key to order-config.js.");
      document.getElementById("admin-login-button").disabled = true;
      return false;
    }
    client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    return true;
  }

  async function authenticate() {
    const email = document.getElementById("admin-email").value.trim().toLowerCase();
    if (email !== (config.adminEmail || "igorgeyn@gmail.com").toLowerCase()) {
      message(loginMessage, "This email is not approved for administration.");
      return;
    }
    const button = document.getElementById("admin-login-button");
    button.disabled = true;
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split("#")[0], shouldCreateUser: false } });
    button.disabled = false;
    if (error) return message(loginMessage, error.message);
    message(loginMessage, "Sign-in link sent. Check your email and open it on this device.", "success");
  }

  async function loadData() {
    const [{ data: batches, error: batchError }, { data: orderData, error: orderError }] = await Promise.all([
      client.from("batches").select("*").eq("is_active", true).single(),
      client.from("orders").select("*, order_items(*), delivery_preferences(*)").order("created_at", { ascending: false }),
    ]);
    if (batchError || orderError) throw batchError || orderError;
    activeBatch = batches;
    orders = orderData || [];
    render();
  }

  function activeOrders() {
    return orders.filter((order) => !["cancelled", "spam"].includes(order.order_status));
  }

  function renderMetrics() {
    const current = activeOrders().filter((order) => order.batch_id === activeBatch.id);
    const units = current.reduce((sum, order) => sum + order.tracker_units, 0);
    const value = current.reduce((sum, order) => sum + order.total_cents, 0);
    document.getElementById("metric-orders").textContent = current.length;
    document.getElementById("metric-units").textContent = units;
    document.getElementById("metric-value").textContent = money.format(value / 100);
    document.getElementById("metric-paid").textContent = current.filter((order) => order.payment_status === "paid").length;
    const percent = Math.min(100, Math.round((units / activeBatch.goal_units) * 100));
    document.getElementById("batch-percent").textContent = `${percent}%`;
    document.getElementById("batch-progress-fill").style.width = `${percent}%`;
    document.getElementById("batch-progress-copy").textContent = `${units} of ${activeBatch.goal_units} batch units reserved`;
    document.getElementById("batch-status").value = activeBatch.status;
  }

  function topSlot(group) {
    const counts = new Map();
    group.forEach((order) => order.delivery_preferences.forEach(({ slot_code: slot }) => counts.set(slot, (counts.get(slot) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ["No common preference", 0];
  }

  function readableSlot(slot) {
    if (slot === "no_preference") return "No preference";
    const [day, start, end] = slot.split("_");
    const days = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
    const times = { "8_11": "8–11 a.m.", "11_2": "11 a.m.–2 p.m.", "2_5": "2–5 p.m.", "5_8": "5–8 p.m." };
    return `${days[day] || day} ${times[`${start}_${end}`] || ""}`.trim();
  }

  function renderRoutes() {
    const groups = new Map();
    activeOrders().filter((order) => order.batch_id === activeBatch.id && order.order_status !== "delivered").forEach((order) => {
      const key = `${order.city} · ${order.zip}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(order);
    });
    const container = document.getElementById("route-suggestions");
    if (!groups.size) {
      container.innerHTML = '<p class="order-meta">No open orders to group yet.</p>';
      return;
    }
    container.innerHTML = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([place, group]) => {
      const [slot, count] = topSlot(group);
      return `<div class="route-row"><div><strong>${escapeHtml(place)}</strong><span>${group.length} order${group.length === 1 ? "" : "s"} · ${group.reduce((sum, order) => sum + order.tracker_units, 0)} units</span></div><span>${escapeHtml(readableSlot(slot))}${count ? ` · ${count} match` : ""}</span></div>`;
    }).join("");
  }

  function renderOrders(filter = "") {
    const needle = filter.trim().toLowerCase();
    const filtered = orders.filter((order) => [order.order_number, order.full_name, order.email, order.city, order.zip].join(" ").toLowerCase().includes(needle));
    document.getElementById("orders-list").innerHTML = filtered.length ? filtered.map((order) => {
      const items = order.order_items.map((item) => `${item.quantity}× ${item.product_name}`).join(", ");
      return `<article class="order-row" data-order-id="${order.id}">
        <div class="order-row-top"><div><div class="order-number">${escapeHtml(order.order_number)} · ${escapeHtml(order.full_name)}</div><div class="order-meta">${escapeHtml(items)}<br>${escapeHtml(order.city)}, ${escapeHtml(order.zip)} · ${escapeHtml(order.email)} · ${escapeHtml(order.phone)}</div></div><div class="order-amount">${money.format(order.total_cents / 100)}<div class="order-meta">${order.tracker_units} units</div></div></div>
        <div class="order-controls">
          <label><span>Order status</span><select class="admin-select" data-field="order_status"><option value="received">Received</option><option value="confirmed">Confirmed</option><option value="growing">Growing</option><option value="ready">Ready</option><option value="scheduled">Scheduled</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option><option value="spam">Spam</option></select></label>
          <label><span>Payment</span><select class="admin-select" data-field="payment_status"><option value="unpaid">Unpaid</option><option value="awaiting_confirmation">Awaiting confirmation</option><option value="paid">Paid</option></select></label>
          <label><span>Delivery date</span><input class="admin-input" data-field="assigned_delivery_date" type="date" value="${order.assigned_delivery_date || ""}"></label>
          <label><span>Final window</span><select class="admin-select" data-field="assigned_delivery_window"><option value="">Not assigned</option><option value="8_11">8–11 a.m.</option><option value="11_2">11 a.m.–2 p.m.</option><option value="2_5">2–5 p.m.</option><option value="5_8">5–8 p.m.</option></select></label>
        </div>
        <div class="order-actions"><button class="admin-button" data-save-order="${order.id}">Save order</button></div>
      </article>`;
    }).join("") : '<p class="order-meta">No matching orders.</p>';

    filtered.forEach((order) => {
      const row = document.querySelector(`[data-order-id='${order.id}']`);
      row.querySelector("[data-field='order_status']").value = order.order_status;
      row.querySelector("[data-field='payment_status']").value = order.payment_status;
      row.querySelector("[data-field='assigned_delivery_window']").value = order.assigned_delivery_window || "";
    });
    document.querySelectorAll("[data-save-order]").forEach((button) => button.addEventListener("click", () => saveOrder(button.dataset.saveOrder)));
  }

  function render() {
    renderMetrics();
    renderRoutes();
    renderOrders(document.getElementById("order-search").value);
  }

  async function saveOrder(id) {
    const row = document.querySelector(`[data-order-id='${id}']`);
    const values = Object.fromEntries([...row.querySelectorAll("[data-field]")].map((input) => [input.dataset.field, input.value || null]));
    values.schedule_approved = Boolean(values.assigned_delivery_date && values.assigned_delivery_window);
    try {
      await adminUpdate({ action: "order_update", order_id: id, ...values });
    } catch (error) { return message(dashboardMessage, error.message); }
    message(dashboardMessage, values.schedule_approved ? "Order saved and the delivery window was emailed if it changed." : "Order saved.", "success");
    await loadData();
  }

  async function adminUpdate(body) {
    if (!config.apiBaseUrl) throw new Error("Admin service endpoint is not configured.");
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error("Your admin session has expired. Sign in again.");
    const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/admin-update`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Admin update failed");
    return result;
  }

  async function saveBatch() {
    const status = document.getElementById("batch-status").value;
    let result;
    try { result = await adminUpdate({ action: "batch_status", batch_id: activeBatch.id, status }); }
    catch (error) { return message(dashboardMessage, error.message); }
    message(dashboardMessage, `Batch status saved${result.notified ? `; ${result.notified} customer email${result.notified === 1 ? "" : "s"} sent` : ""}.`, "success");
    await loadData();
  }

  async function newBatch() {
    if (!window.confirm("Close the active batch and open a fresh 20-unit batch?")) return;
    try { await adminUpdate({ action: "new_batch" }); }
    catch (error) { return message(dashboardMessage, error.message); }
    await loadData();
  }

  async function start() {
    if (!configure()) return;
    document.getElementById("admin-login-button").addEventListener("click", authenticate);
    document.getElementById("admin-signout").addEventListener("click", async () => { await client.auth.signOut(); window.location.reload(); });
    document.getElementById("refresh-orders").addEventListener("click", loadData);
    document.getElementById("save-batch").addEventListener("click", saveBatch);
    document.getElementById("new-batch").addEventListener("click", newBatch);
    document.getElementById("order-search").addEventListener("input", (event) => renderOrders(event.target.value));
    const { data: { session } } = await client.auth.getSession();
    if (session?.user?.email?.toLowerCase() === (config.adminEmail || "igorgeyn@gmail.com").toLowerCase()) {
      login.classList.add("hidden");
      dashboard.classList.remove("hidden");
      try { await loadData(); } catch (error) { message(dashboardMessage, error.message); }
    }
  }

  start();
})();
