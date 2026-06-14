# SETUP.md — set up your own LLM-Wiki (by hand, ~15 min, no coding)

Everything here is free and needs no credit card. Just follow in order. (Prefer letting an AI do it?
Hand it `AGENTS.md` instead.)

## What you'll collect first
1. **Telegram bot token** — open Telegram, message **@BotFather**, send `/newbot`, pick a name, and
   copy the long token it gives you.
2. **Your Telegram ID** — message **@userinfobot**, copy the number it replies with.
3. **A Groq key** — go to **console.groq.com**, sign in, API Keys → Create Key, copy it
   (starts with `gsk_`). Make 2–3 if you can; more keys = it never runs out.
4. *(Optional)* **Gemini key(s)** — **aistudio.google.com/apikey** → Create.
5. **Two passwords you invent** — any two random strings, e.g. `wh_mysecret123` and `tg_mysecret456`.

## Step 1 — Put the brain on Google
1. Go to **script.google.com** → **New project**.
2. Delete the sample code, paste in everything from **`Code.gs`**.
3. Click the gear (Project Settings) → check **"Show appsscript.json"**, then paste in the
   `appsscript.json` from this repo (over the existing one).
4. **Deploy** → **New deployment** → type **Web app** → set **"Who has access" = Anyone** → Deploy.
   **Copy the web-app URL** (ends in `/exec`). Keep it handy.

## Step 2 — Tell it your secrets
In the same editor: **Project Settings → Script Properties → Add property**, add each of these:

| Name | Value |
|---|---|
| `BOT_TOKEN` | your bot token |
| `USER_ID` | your Telegram number |
| `WEBHOOK_SECRET` | your first invented password (e.g. `wh_mysecret123`) |
| `TG_SECRET` | your second invented password (e.g. `tg_mysecret456`) |
| `GROQ_KEYS` | `["gsk_your_key_here"]` (keep the brackets/quotes; add more keys comma-separated) |
| `GEMINI_KEYS` | `["your_gemini_key"]` or just `[]` if you have none |
| `RELAY_URL` | leave blank for now — you'll fill it in Step 3 |

## Step 3 — The little relay (Cloudflare)
1. Sign up free at **dash.cloudflare.com** → **Workers & Pages** → **Create Worker** → name it
   `llm-wiki-relay` → **Deploy**.
2. **Edit code** → delete everything → paste in **`cloudflare-worker.js`** → **Deploy**.
3. Worker **Settings → Variables → Add**:
   - `TG_SECRET` = your second password (same as above)
   - `GAS_URL` = your `/exec` URL from Step 1, with `?s=` and your first password added to the end,
     e.g. `https://script.google.com/.../exec?s=wh_mysecret123`
   - Deploy again.
4. Copy the Worker URL (looks like `https://llm-wiki-relay.yourname.workers.dev/`).
5. Back in Script Properties (Step 2), set **`RELAY_URL`** to that Worker URL. Then in the editor,
   **Deploy → Manage deployments → edit (pencil) → New version → Deploy** (so the change goes live).

## Step 4 — Turn it on
In the Apps Script editor, pick the function **`setup`** from the dropdown at the top and click
**Run** (approve the Google permission prompt the first time). Then pick **`setupWebhook`** and
**Run**. You should get a Telegram message: *"Ready. Just talk to me, or tap /menu."*

## Step 5 — Try it
- Send your bot **"hi"** → it should reply.
- Send **"remind me to stretch in 2 minutes"** → it should ping you in ~2 minutes. ⏰
- Send **"/menu"** → buttons for Notes, Reminders, Trash, Identity, Settings.

## If something's off
- No reply? Re-check `BOT_TOKEN`, that the web app is **Anyone**-access, and that `GAS_URL` in the
  Worker ends with `?s=<your WEBHOOK_SECRET>`.
- "AI limit" messages? Add more Groq/Gemini keys in **/menu → Settings → ➕ Add API key**.
- Changed the code later? In Apps Script you must **Deploy → Manage deployments → New version**
  for changes to take effect.

That's it — enjoy your private AI notes friend. 🎉
