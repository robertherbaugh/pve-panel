# Customer billing

Billing is disabled by default. User limits are legacy quotas, not prices. A customer organization owns its cost summary, drafts, Stripe customer, and subscription. Only its administrators can manage payment details. Platform administrators configure rates and payment requirements.

Monthly charges cover the service tier, each VM size, reserved VM disk by Basic / Standard / Fast class, optional HA, optional backup service, and reserved Basic backup capacity. Compute size prices exclude disk. Stopped VMs retain their reservations and charges. Ridge and Summit include backup service; backup capacity is always charged separately. Backup quantities use reserved logical capacity rounded up to GiB, including retained archives after VM deletion. Pending compute allocations enter the estimate only after completion.

Prices use integer minor units. Blank means unpriced; zero explicitly includes a service. The initial supported currencies are USD, EUR, GBP, CAD, and AUD. No prices are supplied by default. Existing VMs, including shared pool VMs, must be adopted into the compute catalog before activating payments. Pool visibility failures block verification.

## Activate Stripe

1. Test in an isolated staging database with Stripe test keys and test cards. The HTTP simulator used by automated tests is available only in `NODE_ENV=test` on loopback.
2. Set `PANEL_PUBLIC_URL` to the HTTPS customer portal. Choose the production Stripe account, currency, and mode before linking the first production customer. Mode and currency are locked after linkage; use separate databases for staging and production.
3. In Administration → Billing → Stripe, save the secret key and webhook signing secret while billing is disabled. Credentials are encrypted with the panel's existing secret encryption mechanism. Preserve that encryption key with database backups. Keep the key restricted to the required Stripe Billing, Checkout, customer, product, price, invoice, and portal operations.
4. Create a Stripe webhook for `https://<customer-portal>/api/billing/webhook` using API version `2026-10-28.endive`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.*`, `invoice.*`, and `customer.updated`. If an identity gateway fronts the panel, exempt only this exact webhook path from interactive authentication. Other customer and admin paths retain their existing authentication.
5. Save monthly draft prices and publish them to Stripe. Published prices are immutable; a later publication uses new price IDs. Only explicitly priced items can be subscribed.
6. Enable billing. Review each customer's catalog adoption and summary, set its billing email, and enable its payment requirement when ready. The customer administrator opens Billing and completes Stripe-hosted Checkout.

The account is pinned to the first verified Stripe account ID. A key from a different account is rejected. Test and live events cannot be mixed. Card details never pass through the panel.

## Payment and invoices

Returning from Checkout does not establish payment. Signed webhooks and a periodic reconciliation retrieve current Stripe state. Payment admission also refreshes that state, then rechecks the reservation hash immediately before committing a new reservation. An active subscription needs a settled latest invoice; a trial needs a payment method. Overdue invoices, incomplete payments, pauses, scheduled cancellation, stale verification, and API failures block new billable reservations. Existing reads and deletion remain available. Safe reductions, HA removal, and backup-service removal remain available when overdue. The panel does not automatically destroy resources after payment failure.

Stripe reconciliation runs every minute and when payment admission or manual verification requests it. It updates subscription quantities to match reservations, immediately invoices prorated changes, and verifies the resulting state. A newly accepted compute operation can complete before its incremental invoice is reconciled. Delinquent reservations still reconcile reductions for future billing without credits for unpaid time. Failed collection blocks further increases and requires payment recovery; it does not roll back a provisioned VM. Publishing new rates affects current subscriptions at reconciliation and can produce prorated invoices. Provider price publication therefore requires confirmation.

Stripe owns invoice totals, payment collection, discounts, taxes configured in Stripe, and proration. The panel does not calculate tax or enable Stripe Tax automatically. Local draft invoices are immutable, nonpayable reservation estimates before subscription, or snapshots of Stripe's upcoming invoice preview after subscription. They do not create a second charge. Draft history uses customer-scoped cursor pagination. Real invoices and payment links come from Stripe. The hosted portal supports payment-method updates, invoice history, and cancellation at period end.

A customer cannot be deleted while it has an active subscription, unfinished Checkout, or resource reservations. Financial history remains linked to the customer tombstone after deletion.

## Uncertain requests

Checkout and quantity updates retain their exact payload and idempotency key until the result is known. Duplicate webhooks are recorded durably; failed events remain retryable. Out-of-order payload status never grants access. Requests older than 23 hours with an unknown outcome require provider reconciliation in Stripe before retry, because Stripe can expire idempotency records after 24 hours. Inspect the recorded customer, Checkout, or subscription IDs and Stripe request history before resolving such a record. Do not clear an uncertain request and blindly submit it again.

Stripe keys and a reachable signed webhook are required for live validation. Automated HTTP simulation validates integration behavior, not a real card-network payment. Refunds, disputes, credit adjustments, and tax configuration remain managed in the Stripe Dashboard.
