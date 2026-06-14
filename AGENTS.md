# AGENTS.md — set up LLM-Wiki for a user (instructions for an AI agent)

You are setting up **LLM-Wiki**: a personal notes assistant that lives in Telegram. Architecture:

```
Telegram ──► Cloudflare Worker (relay) ──► Google Apps Script web app (Code.gs) ──► Google Drive
```

Two code files: **`Code.gs`** (the whole bot, deployed as a Google Apps Script web app) and
**`cloudflare-worker.js`** (a relay that returns HTTP 200 instantly so Telegram never retries
Apps Script's 302). **No secrets live in the source** — they go into Apps Script *Script Properties*
and Cloudflare *Worker variables*.

## Your job
Either (a) guide the human through each step, doing every technical part you can, or (b) if you have
shell/clasp/wrangler access, do it directly. Confirm each external account action with the user.

## 0. Collect from the user (all free, no card)
| Secret | Where to get it |
|---|---|
| `BOT_TOKEN` | Telegram → talk to **@BotFather** → `/newbot` → copy the token |
| `USER_ID` | Telegram → **@userinfobot** → copy the numeric id (only this user may use the bot) |
| `GROQ_KEYS` | **console.groq.com** → API Keys → Create (collect 1+; more = more capacity) |
| `GEMINI_KEYS` | **aistudio.google.com/apikey** (optional fallback; collect any number) |

Also generate two random secrets yourself: `WEBHOOK_SECRET` and `TG_SECRET`
(e.g. `wh_` / `tg_` + 24 url-safe random chars).

## 1. Deploy the Apps Script web app
- Create a Google Apps Script project (script.google.com) and put `Code.gs` in it. Manifest
  `appsscript.json` must have webapp `access: "ANYONE_ANONYMOUS"`, `executeAs: "USER_DEPLOYING"`,
  and oauth scopes for `drive`, `script.external_request`, `script.scriptapp`.
  (With clasp: `clasp create`/`clasp push`, then `clasp deploy`.)
- Deploy as a **Web app** (versioned). Copy the **`/exec` URL**. Re-deploy to the SAME deployment id
  on every code change (`clasp deploy -i <id>`) so the URL stays stable.
- ⚠️ Do NOT use the `/dev` or `@HEAD` URL — they require Google login and Telegram can't pass it.

## 2. Set Script Properties (Project Settings → Script Properties)
```
BOT_TOKEN       = <token>
USER_ID         = <numeric id>
WEBHOOK_SECRET  = <wh_...>
TG_SECRET       = <tg_...>
RELAY_URL       = <fill in step 3>
GROQ_KEYS       = ["gsk_aaa","gsk_bbb"]      # JSON array
GEMINI_KEYS     = ["AIza...","AIza..."]      # JSON array (or [])
```
(Optional: `GROQ_MODEL` default `openai/gpt-oss-120b`; `PRIMARY` `groq`|`gemini`.)

## 3. Deploy the Cloudflare relay
- Cloudflare dashboard → Workers & Pages → Create Worker → paste `cloudflare-worker.js` → Deploy.
- Set two Worker **Variables** (Settings → Variables): `TG_SECRET` (= the one above) and
  `GAS_URL` (= the Apps Script `/exec` URL **+** `?s=<WEBHOOK_SECRET>`).
- Copy the Worker URL (e.g. `https://llm-wiki-relay.<name>.workers.dev/`) → put it in `RELAY_URL`
  (step 2) and re-deploy the Apps Script.

## 4. Initialize
Run these two functions from the Apps Script editor (or via the web app):
- **`setup()`** — creates the Drive folders (`archives/ wiki/ trash/`), the identity file, the bot
  command list, and the time-based triggers (reminders watchdog every minute; daily maintenance).
- **`setupWebhook()`** — points Telegram at the relay with the secret token.

## 5. Verify
- `GET <exec-url>` → returns `LLM-Wiki is live.`
- Telegram `getWebhookInfo` → url is the Worker, `pending_update_count: 0`, no `last_error`.
- Send the bot "hi" → it replies fast. Send "remind me to test in 2 minutes" → it pings you.
- `/menu` → menu opens; Notes / Trash / Reminders / Identity / Settings all respond in one tap.

## Key facts to remember while operating
- **Code changes need `push` + `deploy` to the same deployment id** (the web app serves the
  *deployed* version, not the latest saved code).
- **Reminders/proactivity** run via Apps Script time triggers (no server needed; Google runs them 24/7).
- **Honesty contract**: the bot acts only through verified tools and never claims an action it
  didn't perform; on AI-quota exhaustion it says so plainly and still saves the raw message.
- **Adding API keys**: the user can add more keys from Telegram (Settings → ➕ Add API key) — they're
  appended to `GROQ_KEYS`/`GEMINI_KEYS` and the bot rolls to the next key when one hits its limit.

## How to explain it to a human (if asked)
"It's a private AI notes assistant in Telegram. You text it; it remembers and organizes your notes
on your own Google Drive, reminds you about things, and searches the web when needed. It runs free
on Google + Cloudflare with no server to maintain, and it's built to never lie about what it did."
