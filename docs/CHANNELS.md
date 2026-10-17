# Omni Channels (v0.2)

Omni agents talk through a `Channel` interface (`send` / `onMessage` / `start` / `stop`).
v0.1 shipped the console channel; v0.2 adds **Telegram** and **WhatsApp Cloud API**.
The agent is the same on every channel — only the adapter changes.

## Telegram (`@omni/channels-telegram`)

Long-polling (no webhook server needed — works behind NAT).

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token.
2. `TELEGRAM_BOT_TOKEN=<token>` (env; never commit it).
3. Optional allowlist: `TELEGRAM_ALLOWED_USERS=12345,67890` (your Telegram user ids —
   find yours via [@userinfobot](https://t.me/userinfobot)). Without it, anyone who
   finds the bot can chat with your agent.
4. Run: `omni telegram <agent-id>`

Notes:
- Messages longer than Telegram's 4096-char limit are split automatically.
- The bot token is never logged.
- Poll errors back off (1s → 30s); `Ctrl+C` stops cleanly.
- **Inline approvals (v1.0):** when a run hits an `ask`-gated tool, the
  question arrives in the chat with **Approve / Deny buttons**. Tapping one
  resolves the approval and edits the message to show the decision. No
  console access needed. If the bot stops with approvals pending, they
  resolve as denied so runs never hang.

## WhatsApp Cloud API (`@omni/channels-whatsapp`)

Uses the official Meta WhatsApp Business Cloud API. Setup (one-time, in the
[Meta developer dashboard](https://developers.facebook.com)):

1. Create an app → add the **WhatsApp** product → note the **phone number id**
   and generate an access token (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`).
   Prefer a long-lived system-user token for production.
2. Choose a **verify token** (any random string) → `WHATSAPP_VERIFY_TOKEN`.
3. Start the webhook: `omni whatsapp <agent-id> [--port 3000]`
4. In the dashboard, set the webhook callback URL to your public URL
   (`https://<host>:<port>/`) and the same verify token, then subscribe to the
   `messages` field. For local dev, expose the port with a tunnel
   (e.g. `cloudflared tunnel --url http://localhost:3000`).

How it works:
- `GET /?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` → returns the
  challenge only when the token matches (else 403).
- `POST /` → acked with `200 OK` immediately (Meta redelivers on slow
  responses), then inbound text messages go to the agent and the reply is sent
  via `POST https://graph.facebook.com/v21.0/<phoneNumberId>/messages`.
- The reply recipient defaults to the last inbound sender; `setRecipient()`
  overrides it for proactive messages.

Security notes:
- Never commit tokens; all three values come from env.
- The Cloud API is a business product with its own pricing/terms — sending
  outside the 24h customer-service window requires template messages (the
  channel sends free-form text; use it accordingly).
- WhatsApp automation is subject to Meta's policies; prefer the official API
  (this channel) over unofficial bridges.

## Approvals over channels

- **Telegram:** interactive approval prompts (`ask` policy) arrive as
  Approve/Deny inline buttons in the chat itself (v1.0).
- **Console / web:** approvals ask on the console where the command runs, or
  via the web console's Approve/Deny queue (`omni web`).
- For unattended operation use `omni routine run` (auto-skip, logged).
- WhatsApp approvals as interactive messages are still future work.
