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

### Bulk search (`omni x-search`)

`omni x-search "<query>" [--max N]` searches recent posts over the X API v2
`GET /2/tweets/search/recent` (same OAuth 1.0a signing, same `X_*` env vars) —
the agent-platform answer to Grok Bot's native X search. Prints
`id · @author · created_at` plus text, newest first. `--max` defaults to 10
and is clamped to 1–100 (API limit). A 429 backs off once on `retry-after`
before failing loudly.

## Slack (`@omni/channels-slack`)

Serves the agent in Slack workspaces over the Events API — zero dependencies,
HMAC-SHA256 request verification on every inbound call.

Setup (one-time, at [api.slack.com/apps](https://api.slack.com/apps)):

1. **Create an app** (from scratch), note the **Signing Secret**
   (`SLACK_SIGNING_SECRET`) under *Basic Information*.
2. Under **OAuth & Permissions**, add the bot scopes
   `app_mentions:read`, `chat:write`, `im:history` (add `channels:history`
   if the bot should read channel messages it isn't mentioned in).
3. **Install the app** to your workspace; copy the **Bot User OAuth Token**
   (`xoxb-…` → `SLACK_BOT_TOKEN`).
4. Under **Event Subscriptions**: enable events, set the **Request URL** to
   `https://<your-public-url>/slack/events` (use a tunnel like `cloudflared`
   for local dev), and subscribe to bot events `app_mention` and `message.im`.
   Slack will send a `url_verification` challenge — the channel answers it
   automatically.
5. Run: `omni slack <agent-id> [--port 3000]`.

How it works:
- Every inbound request is verified with the signing secret (`v0=` HMAC
  scheme, 5-minute timestamp tolerance); unverified requests get a 401.
- `app_mention` events and fresh human `message` events (bot messages, edits,
  and deletes are ignored) go to the agent with the leading `<@bot>` mention
  stripped; the agent's reply is posted via `chat.postMessage`, threaded on
  the incoming message (`thread_ts`).
- `send(text)` posts to the channel/thread of the most recent inbound message.
- Approvals for Slack-originated runs use the console y/n prompt
  (`askApproval`) — run it where you can see the terminal.

## Email — Gmail API (`@omni/channels-email`)

Serves the agent over email, backed by the Gmail REST API v1 — zero
dependencies. Deliberately NOT hand-rolled IMAP (error-prone); the Gmail API
is the supported path. Inbound: polls for unread mail (configurable Gmail
search query), parses From/Subject/body, dispatches each new message to the
agent, and marks it read afterwards (configurable). Outbound: the agent's
reply goes back as a threaded email reply (`In-Reply-To` / `References`).

Setup (one-time, at [console.cloud.google.com](https://console.cloud.google.com)):

1. **Create a project**, enable the **Gmail API**.
2. Under **APIs & Services → Credentials**, create an **OAuth client ID**
   (Desktop app): note the **client id** (`GMAIL_CLIENT_ID`) and **client
   secret** (`GMAIL_CLIENT_SECRET`).
3. Under **OAuth consent screen**, add the scopes
   `https://www.googleapis.com/auth/gmail.readonly`,
   `https://www.googleapis.com/auth/gmail.send`, and
   `https://www.googleapis.com/auth/gmail.modify`.
4. Get a **refresh token**: use the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   (select the same scopes, exchange the code) or `gcloud auth
   application-default login --scopes=...`. Store it as
   `GMAIL_REFRESH_TOKEN`. Expect an "unverified app" warning for personal
   use — click through only for your own account.
5. Run: `omni email <agent-id> [--poll 5] [--query "is:unread newer_than:1d"]`.

How it works:
- Access tokens are refreshed automatically via the refresh token; secrets
  are only ever sent to Google's token endpoint and Gmail API, never logged.
- Seen message ids are in-memory — a restart may re-see recent mail.
- The agent's own sent mail is skipped (no self-reply loops).
- `send(text)` replies (threaded) to the most recent inbound email.
- **Sending limits / anti-spam:** automated sending must respect Gmail's
  sending limits (a few hundred/day for consumer accounts, higher for
  Workspace) and anti-spam rules — keep replies to genuine inbound mail,
  never bulk-send. Abuse risks the Google account.

## Approvals over channels

- **Telegram:** interactive approval prompts (`ask` policy) arrive as
  Approve/Deny inline buttons in the chat itself (v1.0).
- **Console / web:** approvals ask on the console where the command runs, or
  via the web console's Approve/Deny queue (`omni web`).
- For unattended operation use `omni routine run` (auto-skip, logged).
- WhatsApp approvals as interactive messages are still future work.
