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

## X (Twitter) (`@omni/channels-x`)

Watches your mentions and replies in-thread, over the X API v2 with
hand-rolled OAuth 1.0a (user context) — zero dependencies.

Setup (one-time, in the [X developer portal](https://developer.x.com)):

1. Create a **Project + App** with read+write permissions.
2. Under the app's **Keys and tokens**: note the **API Key / API Key Secret**
   (`X_API_KEY`, `X_API_SECRET`).
3. Under **Authentication Tokens**: generate an **Access Token / Access Token
   Secret** for your user (`X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`).
   The app needs the free/basic tier with v2 write access.
4. Run: `omni x <agent-id> [--poll 120]` (poll interval in seconds, ≥ 15;
   `X_POLL_SECONDS` env also works).

How it works:
- On start, the channel resolves your user id via `GET /2/users/me`.
- Every poll it fetches `GET /2/users/:id/mentions` (newest first, handled
  oldest-first so reply order is natural), advancing `since_id` each time.
- Each mention goes to the agent; the agent's reply is posted as a threaded
  reply (`in_reply_to_tweet_id`). Your own tweets are never answered.
- `send(text)` posts a standalone tweet (≤ 280 chars; longer text is
  truncated with `…`).

Automation rules — read this before going live:
- **X's automation rules apply.** Only reply to genuine mentions, keep replies
  useful and non-spammy, and respect rate limits (the channel backs off on
  HTTP 429 using `retry-after`). Aggressive auto-replying gets accounts
  suspended — start with a small audience and watch the behavior.
- `since_id` tracking is in-memory: a restart may re-see the most recent
  mentions (they get re-handled, not duplicated as new replies — but the
  agent will run again). For production, keep the process running.
- Approvals for X-originated runs use the console y/n prompt (`askApproval`) —
  run it where you can see the terminal, or keep write-class tools deny-gated.

## Approvals over channels

- **Telegram:** interactive approval prompts (`ask` policy) arrive as
  Approve/Deny inline buttons in the chat itself (v1.0).
- **Console / web:** approvals ask on the console where the command runs, or
  via the web console's Approve/Deny queue (`omni web`).
- For unattended operation use `omni routine run` (auto-skip, logged).
- WhatsApp approvals as interactive messages are still future work.
