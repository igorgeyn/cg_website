# Order system setup

The repository contains the complete frontend and deployable service code, but no private credentials. Complete these steps before enabling live submissions.

## 1. Supabase

1. Create a free Supabase project.
2. Open the SQL editor and run `supabase/schema.sql`.
3. In Authentication → Users, invite `igorgeyn@gmail.com` so the admin magic-link flow has an existing user.
4. Add this redirect URL to the authentication URL configuration:
   `https://igorgeyn.github.io/cg_website/admin.html`
5. Deploy the six Edge Functions:

   ```text
   supabase functions deploy batch-progress --no-verify-jwt
   supabase functions deploy submit-order --no-verify-jwt
   supabase functions deploy admin-update --no-verify-jwt
   supabase functions deploy subscribe-updates --no-verify-jwt
   supabase functions deploy unsubscribe-updates --no-verify-jwt
   supabase functions deploy resend-inbound --no-verify-jwt
   ```

`admin-update` still validates the signed-in administrator inside the function. The public functions validate allowed origins, input, prices, delivery fees, rate limits, and Turnstile tokens server-side.

## 2. Resend

1. Create a free Resend account.
2. Add a domain you own and add the supplied SPF/DKIM DNS records.
3. Create a sending API key.
4. Choose a sender such as `Nori's Nibbles <orders@example.com>`. Use an address that can receive replies.
5. To forward inbound mail, enable receiving for the domain, create a full-access API key, and add an `email.received` webhook pointing to the deployed `resend-inbound` function.

## 3. Cloudflare Turnstile

1. Create a free managed-mode widget.
2. Authorize `igorgeyn.github.io` as a hostname. Add a future custom hostname when applicable.
3. Save the public site key and private secret key separately.

## 4. Function secrets

Set these values in the Supabase project. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are provided to hosted functions automatically.

```text
ALLOWED_ORIGINS=https://igorgeyn.github.io
ADMIN_EMAIL=igorgeyn@gmail.com
FROM_EMAIL=Nori's Nibbles <orders@example.com>
RESEND_API_KEY=...
RESEND_INBOUND_API_KEY=...
RESEND_WEBHOOK_SECRET=...
INBOUND_EMAIL=orders@example.com
INBOUND_FORWARD_TO=you@example.com
TURNSTILE_SECRET_KEY=...
RATE_LIMIT_SALT=use-a-long-random-value
SITE_URL=https://igorgeyn.github.io/cg_website
```

Never add the Resend key, Turnstile secret, service-role key, or rate-limit salt to a browser JavaScript file or Git.

## 5. Public browser configuration

Edit `order-config.js`. These values are designed to be public:

```js
window.NORIS_NIBBLES_CONFIG = {
  apiBaseUrl: "https://PROJECT_REF.supabase.co/functions/v1",
  supabaseUrl: "https://PROJECT_REF.supabase.co",
  supabasePublishableKey: "YOUR_PUBLISHABLE_KEY",
  turnstileSiteKey: "YOUR_PUBLIC_SITE_KEY",
  venmoUsername: "Igor-Geyn",
  inquiryEmail: "orders@example.com",
  adminEmail: "igorgeyn@gmail.com",
  trackerFallbackUnits: 0,
};
```

## 6. Acceptance checks

Before publishing:

1. Place a Venmo-now test order and a pay-on-delivery test order.
2. Confirm server totals for Small ($6/1 unit), Large ($8/2 units), and XL ($15/8 units).
3. Confirm the $5 fee for Concord, El Cerrito, and Kensington, including the waiver at eight units.
4. Confirm free delivery for every other listed city.
5. Verify confirmation and administrator emails.
6. Mark an order paid in `admin.html`.
7. Assign a delivery date/window and verify the customer email.
8. Change the batch status and verify batch-update emails.
9. Mark a test order cancelled and confirm its units disappear from the public tracker.
