# Nori's Nibbles

Static GitHub Pages site and made-to-order cat-grass ordering experience.

The public form includes a live 20-unit batch tracker, three products, delivery-area pricing, delivery-window preferences, Venmo/pay-later choices, and mobile-first styling. A private admin page supports batch status, order status, payment confirmation, delivery grouping, and approved delivery schedules.

## Local preview

Serve the folder rather than opening the HTML directly:

```powershell
python -m http.server 8765
```

Then open `http://127.0.0.1:8765/index.html#order`.

Until the hosted services are configured, the page operates as a safe preview: totals and delivery fees work, but the form will not claim to have recorded an order.

## Hosted-service setup

See [SETUP.md](SETUP.md) for Supabase, Resend, Turnstile, and deployment instructions.
