# Demo Merchant Payments (Lagos / Paystack)

Payment links for small businesses: sign up, create a link, share it, customer pays via Paystack, dashboard shows payments, refund from dashboard.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your Paystack keys:
   - `PAYSTACK_SECRET_KEY` — backend calls (required to accept real payments)
   - `PAYSTACK_PUBLIC_KEY` — Paystack inline popup (exposed to the browser)
3. `npm start`, open http://localhost:3000

## How it works

- Auth: email + password, bcrypt hash, httpOnly session cookie (demo, single server).
- Data: SQLite (`data.db`, auto-created) with tables `merchants`, `links`, `payments`.
- Money: amounts in **kobo**; Paystack inline popup on `/pay/:code`; server verifies with Paystack `GET /transaction/verify/:reference` before marking `paid`.
- Webhook: `POST /webhook/paystack` verifies `x-paystack-signature` (HMAC-SHA512 of raw body) and marks `charge.success` references paid. Works in parallel with the client-side verify — both are idempotent.
- Refunds: `POST /api/payments/:id/refund` calls Paystack `POST /refund` with the transaction id; status becomes `refunded` (or `refund_pending` if Paystack queues it).

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/signup | no | `{businessName, email, password}` |
| POST | /api/auth/login | no | `{email, password}` |
| POST | /api/auth/logout | yes | clear session |
| GET | /api/me | yes | current merchant + Paystack public key flag |
| POST | /api/links | yes | `{amountNaira, title, description?}` → link |
| GET | /api/links | yes | own links |
| GET | /api/payments | yes | own payments, newest first |
| POST | /api/payments/:id/refund | yes | refund a paid payment |
| GET | /pay/:code | no | public pay page (JSON embedded) |
| POST | /api/pay/:code/initiate | no | returns Paystack public key + email/amount for inline popup |
| POST | /api/pay/:code/verify | no | `{reference}` → verify with Paystack, mark paid |
| POST | /webhook/paystack | signature | Paystack webhook receiver |

Without `PAYSTACK_SECRET_KEY`, initiate/verify/refund return `503 { error: "paystack_not_configured" }` so you can still demo signup → link creation → dashboard with `pending` payments.
