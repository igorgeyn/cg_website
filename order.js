(() => {
  "use strict";

  const config = window.NORIS_NIBBLES_CONFIG || {};
  const products = {
    small: { name: "Small 4×4", price: 6, units: 1 },
    large: { name: "Large 6×6", price: 8, units: 2 },
    xl: { name: "XL tray", price: 15, units: 8 },
  };
  const feeCities = new Set(["Alameda", "Concord", "El Cerrito", "Kensington", "Richmond", "San Leandro", "San Ramon"]);
  const batchGoal = 20;
  const quantities = { small: 0, large: 0, xl: 0 };

  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

  const byId = (id) => document.getElementById(id);
  const form = byId("noris-order-form");
  if (!form) return;

  const summaryItems = byId("summary-items");
  const summaryEmpty = byId("summary-empty");
  const summarySubtotal = byId("summary-subtotal");
  const summaryDelivery = byId("summary-delivery");
  const summaryTotal = byId("summary-total");
  const summaryUnits = byId("summary-units");
  const formMessage = byId("order-form-message");
  const submitButton = byId("submit-order-button");
  const verificationStatus = byId("order-verification-status");
  const verificationText = byId("order-verification-text");
  const verificationRetry = byId("order-verification-retry");
  const citySelect = byId("delivery-city");
  const noPreference = byId("no-preference");
  const slotInputs = [...document.querySelectorAll("input[name='delivery_slots']")];
  const modal = byId("order-modal");
  // Keep the fixed dialog out of the order section's stacking context so it
  // can cover the sticky site header and the rest of the page on every device.
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  const modalDialog = modal.querySelector(".order-modal-dialog");
  const openModalButton = byId("open-order-modal");
  const backButton = byId("order-back-button");
  const nextButton = byId("order-next-button");
  const wizardSteps = [...form.querySelectorAll("[data-order-step]")];
  const stepIndicators = [...modal.querySelectorAll("[data-step-indicator]")];
  let currentStep = 1;
  let lastFocusedElement = null;
  let orderTurnstileRendered = false;
  let orderTurnstileWidgetId = null;
  let orderTurnstileToken = "";
  let orderVerificationState = config.turnstileSiteKey ? "pending" : "ready";
  let orderIsSubmitting = false;

  function totals() {
    let subtotal = 0;
    let units = 0;
    Object.entries(quantities).forEach(([sku, quantity]) => {
      subtotal += products[sku].price * quantity;
      units += products[sku].units * quantity;
    });
    const deliveryFee = feeCities.has(citySelect.value) && units > 0 && units < 8 ? 5 : 0;
    return { subtotal, units, deliveryFee, total: subtotal + deliveryFee };
  }

  function updateSummary() {
    const calculated = totals();
    summaryItems.innerHTML = "";
    let hasItems = false;

    Object.entries(quantities).forEach(([sku, quantity]) => {
      const card = document.querySelector(`[data-product-card='${sku}']`);
      card?.classList.toggle("has-quantity", quantity > 0);
      const value = document.querySelector(`[data-quantity-value='${sku}']`);
      if (value) value.textContent = quantity;
      if (!quantity) return;
      hasItems = true;
      const row = document.createElement("div");
      row.className = "summary-line";
      row.innerHTML = `<span>${quantity} × ${products[sku].name}</span><strong>${money.format(quantity * products[sku].price)}</strong>`;
      summaryItems.appendChild(row);
    });

    summaryEmpty.hidden = hasItems;
    summarySubtotal.textContent = money.format(calculated.subtotal);
    summaryDelivery.textContent = calculated.deliveryFee ? money.format(calculated.deliveryFee) : "Free";
    summaryTotal.textContent = money.format(calculated.total);
    byId("mobile-summary-total").textContent = money.format(calculated.total);
    summaryUnits.textContent = `${calculated.units} of 20 batch units added by this order`;
    byId("delivery-fee-note").textContent = !citySelect.value
      ? "Choose a city to see delivery pricing."
      : feeCities.has(citySelect.value)
        ? calculated.units >= 8
          ? "Your $5 delivery fee is waived because this order contains 8 or more batch units."
          : "This area has a $5 delivery fee, waived at 8 batch units."
        : "Delivery is free in this area.";
  }

  document.querySelectorAll("[data-quantity-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const sku = button.dataset.product;
      const delta = button.dataset.quantityAction === "increase" ? 1 : -1;
      quantities[sku] = Math.max(0, Math.min(20, quantities[sku] + delta));
      updateSummary();
    });
  });

  citySelect.addEventListener("change", updateSummary);
  noPreference.addEventListener("change", () => {
    slotInputs.forEach((input) => {
      input.disabled = noPreference.checked;
      if (noPreference.checked) input.checked = false;
    });
  });
  slotInputs.forEach((input) => input.addEventListener("change", () => {
    if (input.checked) noPreference.checked = false;
  }));

  function clearMessage() {
    formMessage.textContent = "";
    formMessage.className = "form-message";
  }

  function setOrderVerificationState(state) {
    orderVerificationState = state;
    if (!config.turnstileSiteKey) {
      verificationStatus.hidden = true;
      return;
    }

    const copy = {
      pending: "Securely checking your order…",
      interactive: "Please complete the quick verification above.",
      ready: "Secure check complete. Your order is ready to place.",
      error: "The secure check didn’t finish. Please retry it.",
    };
    verificationStatus.hidden = false;
    verificationStatus.dataset.state = state;
    verificationText.textContent = copy[state];
    verificationRetry.hidden = state !== "error";
    if (!orderIsSubmitting) {
      submitButton.disabled = state !== "ready";
      submitButton.textContent = state === "pending" ? "Checking…" : "Place order";
    }
  }

  function renderOrderTurnstile() {
    if (!config.turnstileSiteKey) {
      setOrderVerificationState("ready");
      return;
    }
    setOrderVerificationState(orderTurnstileToken ? "ready" : "pending");
    if (orderTurnstileRendered || !window.turnstile) return;
    orderTurnstileWidgetId = window.turnstile.render("#turnstile-container", {
      sitekey: config.turnstileSiteKey,
      theme: "light",
      size: "flexible",
      appearance: "interaction-only",
      callback(token) {
        orderTurnstileToken = token;
        setOrderVerificationState("ready");
      },
      "before-interactive-callback"() {
        setOrderVerificationState("interactive");
      },
      "after-interactive-callback"() {
        if (!orderTurnstileToken) setOrderVerificationState("pending");
      },
      "expired-callback"() {
        orderTurnstileToken = "";
        setOrderVerificationState("pending");
      },
      "timeout-callback"() {
        orderTurnstileToken = "";
        setOrderVerificationState("error");
      },
      "error-callback"(errorCode) {
        console.warn("Order security check failed:", errorCode);
        orderTurnstileToken = "";
        setOrderVerificationState("error");
        return true;
      },
      "unsupported-callback"() {
        orderTurnstileToken = "";
        setOrderVerificationState("error");
      },
    });
    orderTurnstileRendered = true;
  }

  verificationRetry.addEventListener("click", () => {
    refreshOrderTurnstile();
    if (!window.turnstile || orderTurnstileWidgetId === null) {
      orderTurnstileRendered = false;
      renderOrderTurnstile();
    }
  });

  function refreshOrderTurnstile() {
    orderTurnstileToken = "";
    setOrderVerificationState("pending");
    if (window.turnstile && orderTurnstileWidgetId !== null) {
      window.turnstile.reset(orderTurnstileWidgetId);
    }
  }

  function setStep(step, moveFocus = true) {
    currentStep = Math.max(1, Math.min(4, step));
    wizardSteps.forEach((section) => {
      const isActive = Number(section.dataset.orderStep) === currentStep;
      section.hidden = !isActive;
      section.classList.toggle("is-active", isActive);
    });
    stepIndicators.forEach((indicator) => {
      const indicatorStep = Number(indicator.dataset.stepIndicator);
      indicator.classList.toggle("is-active", indicatorStep === currentStep);
      indicator.classList.toggle("is-complete", indicatorStep < currentStep);
      if (indicatorStep === currentStep) indicator.setAttribute("aria-current", "step");
      else indicator.removeAttribute("aria-current");
    });
    byId("order-step-label").textContent = `Step ${currentStep} of 4`;
    byId("order-step-current").textContent = currentStep;
    backButton.hidden = currentStep === 1;
    nextButton.hidden = currentStep === 4;
    submitButton.hidden = currentStep !== 4;
    clearMessage();
    if (currentStep === 4) renderOrderTurnstile();
    modal.querySelector(".order-layout").scrollTo({ top: 0, behavior: "smooth" });
    if (moveFocus) {
      const activeHeading = form.querySelector(`[data-order-step='${currentStep}'] h3`);
      if (activeHeading) {
        activeHeading.tabIndex = -1;
        activeHeading.focus({ preventScroll: true });
      }
    }
  }

  function validateStep(step) {
    clearMessage();
    if (step === 1 && totals().units < 1) {
      showMessage("Please add at least one cat grass item to your order.");
      return false;
    }
    if (step === 2) {
      const fields = [...form.querySelectorAll("[data-order-step='2'] input, [data-order-step='2'] select")];
      const invalidField = fields.find((field) => !field.checkValidity());
      if (invalidField) {
        invalidField.reportValidity();
        invalidField.focus();
        return false;
      }
    }
    if (step === 3 && !noPreference.checked && selectedSlots().length === 0) {
      showMessage("Please select at least one preferred delivery window or choose \u201cNo preference.\u201d");
      return false;
    }
    return true;
  }

  function openOrderModal() {
    lastFocusedElement = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("order-modal-open");
    setStep(currentStep, false);
    requestAnimationFrame(() => modalDialog.focus());
  }

  function closeOrderModal() {
    if (submitButton.disabled) return;
    modal.hidden = true;
    document.body.classList.remove("order-modal-open");
    lastFocusedElement?.focus();
  }

  openModalButton.addEventListener("click", openOrderModal);
  modal.querySelectorAll("[data-close-order-modal]").forEach((button) => {
    button.addEventListener("click", closeOrderModal);
  });
  backButton.addEventListener("click", () => setStep(currentStep - 1));
  nextButton.addEventListener("click", () => {
    if (validateStep(currentStep)) setStep(currentStep + 1);
  });

  form.addEventListener("keydown", (event) => {
    const advancesFromField = event.target.matches("input:not([type='checkbox']):not([type='radio']), select");
    if (event.key === "Enter" && currentStep < 4 && advancesFromField) {
      event.preventDefault();
      nextButton.click();
    }
  });

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOrderModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...modalDialog.querySelectorAll("button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), a[href]")]
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === modalDialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function setTracker(currentUnits, goalUnits = batchGoal, status = "collecting") {
    const safeGoal = Number(goalUnits) || batchGoal;
    const safeCurrent = Math.max(0, Number(currentUnits) || 0);
    const rawPercent = Math.min(100, Math.round((safeCurrent / safeGoal) * 100));
    const stageCopy = {
      goal_reached: { label: "Goal reached", units: "The batch goal is filled", caption: "Batch goal reached—growing will begin soon! New orders are still welcome." },
      growing: { label: "Growing now", units: "This fresh batch is in production", caption: "The grass is growing now and is typically ready for delivery within 10 days." },
      ready: { label: "Crop ready", units: "Fresh grass is ready", caption: "The crop is ready. We’re grouping deliveries around locations and customer preferences." },
      delivery_planning: { label: "Planning delivery", units: "Delivery routes are taking shape", caption: "Final delivery windows will be emailed after the route groups are approved." },
    };
    const resolvedStatus = rawPercent >= 100 && status === "collecting" ? "goal_reached" : status;
    const stage = stageCopy[resolvedStatus];
    const percent = stage ? 100 : rawPercent;
    byId("tracker-percentage").textContent = `${percent}%`;
    byId("tracker-units").textContent = stage?.units || `${safeCurrent} of ${safeGoal} batch units reserved`;
    byId("tracker-fill").style.width = `${percent}%`;
    byId("tracker-fill").parentElement.setAttribute("aria-valuenow", String(percent));
    byId("tracker-state").textContent = stage?.label || "Gathering orders";
    byId("tracker-caption").textContent = stage?.caption || `${Math.max(0, safeGoal - safeCurrent)} batch units to go. Every order moves the next fresh batch closer.`;
  }

  async function loadTracker() {
    setTracker(config.trackerFallbackUnits || 0);
    if (!config.apiBaseUrl) return;
    try {
      const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/batch-progress`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Progress unavailable");
      const data = await response.json();
      setTracker(data.current_units, data.goal_units, data.status);
    } catch (error) {
      console.warn("Using fallback batch progress:", error);
    }
  }

  function loadTurnstile() {
    if (!config.turnstileSiteKey || document.querySelector("script[data-turnstile-script]")) return;
    window.norisTurnstileReady = () => {
      if (byId("batch-alert-turnstile")) {
        window.turnstile.render("#batch-alert-turnstile", {
          sitekey: config.turnstileSiteKey,
          theme: "light",
          appearance: "interaction-only",
        });
      }
      if (!modal.hidden && currentStep === 4) renderOrderTurnstile();
    };
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=norisTurnstileReady&render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.turnstileScript = "true";
    script.addEventListener("error", () => {
      if (currentStep === 4) setOrderVerificationState("error");
    });
    document.head.appendChild(script);
  }

  function selectedSlots() {
    if (noPreference.checked) return ["no_preference"];
    return slotInputs.filter((input) => input.checked).map((input) => input.value);
  }

  function showMessage(message, type = "error") {
    formMessage.textContent = message;
    formMessage.className = `form-message is-visible is-${type}`;
    formMessage.focus();
  }

  function payload() {
    const data = new FormData(form);
    return {
      customer: {
        full_name: data.get("full_name")?.trim(),
        email: data.get("email")?.trim(),
        phone: data.get("phone")?.trim(),
      },
      address: {
        line1: data.get("address_line1")?.trim(),
        line2: data.get("address_line2")?.trim(),
        city: data.get("city"),
        zip: data.get("zip")?.trim(),
      },
      items: Object.entries(quantities)
        .filter(([, quantity]) => quantity > 0)
        .map(([sku, quantity]) => ({ sku, quantity })),
      payment_method: data.get("payment_method"),
      delivery_method: data.get("delivery_method"),
      delivery_slots: selectedSlots(),
      delivery_notes: data.get("delivery_notes")?.trim(),
      marketing_opt_in: data.get("marketing_opt_in") === "yes",
      turnstile_token: orderTurnstileToken || data.get("cf-turnstile-response") || "",
    };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessage();

    if (totals().units < 1) {
      showMessage("Please add at least one cat grass item to your order.");
      return;
    }
    if (!noPreference.checked && selectedSlots().length === 0) {
      showMessage("Please select at least one preferred delivery window or choose “No preference.”");
      return;
    }
    if (!form.reportValidity()) return;
    if (!config.apiBaseUrl) {
      showMessage(`Online submission is being connected. For now, please email ${config.inquiryEmail || "orders@igorgeyn.com"}.`);
      return;
    }
    if (config.turnstileSiteKey && orderVerificationState !== "ready") {
      showMessage("Your order is still being securely checked. Please wait a moment.");
      renderOrderTurnstile();
      return;
    }

    orderIsSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = "Placing order…";
    try {
      const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/submit-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const result = await response.json();
      if (!response.ok) {
        const errorMessage = result.error || "We couldn't place the order.";
        if (/anti-spam|turnstile|security check/i.test(errorMessage)) {
          refreshOrderTurnstile();
          throw new Error("The secure check expired, so we’re refreshing it now. Please wait for the Place order button to become ready.");
        }
        throw new Error(errorMessage);
      }

      form.hidden = true;
      document.querySelector(".order-summary").hidden = true;
      modal.querySelector(".order-progress").hidden = true;
      byId("order-step-label").textContent = "Order confirmed";
      byId("order-modal-title").textContent = "Thank you!";
      const success = byId("order-success");
      byId("success-order-number").textContent = result.order_number;
      byId("success-total").textContent = money.format(result.total);
      const venmo = byId("success-venmo");
      if (result.payment_method === "venmo_now") {
        venmo.hidden = false;
        byId("venmo-payment-link").href = `https://venmo.com/u/${encodeURIComponent(config.venmoUsername || "Igor-Geyn")}`;
      }
      success.classList.add("is-visible");
      success.focus();
      loadTracker();
    } catch (error) {
      showMessage(error.message || "Something went wrong. Please try again.");
    } finally {
      orderIsSubmitting = false;
      if (config.turnstileSiteKey) setOrderVerificationState(orderVerificationState);
      else {
        submitButton.disabled = false;
        submitButton.textContent = "Place order";
      }
    }
  });

  const batchAlertForm = byId("batch-alert-form");
  if (batchAlertForm) batchAlertForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = batchAlertForm.querySelector("button");
    const message = byId("batch-alert-message");
    const data = new FormData(batchAlertForm);
    if (!config.apiBaseUrl) {
      message.textContent = "Email updates are being connected. Please check back soon.";
      message.className = "batch-alert-message visible error";
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/subscribe-updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.get("email"), turnstile_token: data.get("cf-turnstile-response") || "" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Subscription failed");
      batchAlertForm.reset();
      message.textContent = "You’re on the list. Check your inbox for confirmation.";
      message.className = "batch-alert-message visible success";
    } catch (error) {
      message.textContent = error.message || "We couldn’t add that email. Please try again.";
      message.className = "batch-alert-message visible error";
    } finally {
      button.disabled = false;
    }
  });

  document.querySelectorAll("[data-inquiry-link]").forEach((link) => {
    const email = config.inquiryEmail || "orders@igorgeyn.com";
    link.href = `mailto:${email}?subject=${encodeURIComponent("Nori's Nibbles order question")}`;
    link.textContent = email;
  });

  setStep(1, false);
  updateSummary();
  loadTracker();
  loadTurnstile();
})();
