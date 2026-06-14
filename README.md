# 🧠 LLM-Wiki — your own AI notes friend inside Telegram

Imagine texting a smart friend who **remembers everything you tell it**, keeps your notes tidy,
reminds you about things, and can even look stuff up on the internet — all inside Telegram, and
**free forever**.

That's LLM-Wiki.

```
You:  remember my passport expires in March
Bot:  Got it 👍

You:  when does my passport expire?
Bot:  March.

You:  remind me to call mom tomorrow at 6pm
Bot:  Done — I'll ping you 10 minutes before and at 6pm. ⏰
```

## ✨ What it can do
- 💬 **Talk like ChatGPT** — just chat normally, no commands to memorize.
- 🧠 **Remember** — tell it things; it files them away neatly and answers later.
- 🗂 **Organize big lists** — paste 100 things; it sorts them into categories for you.
- ⏰ **Remind you** — "ping me tomorrow morning" and it actually messages you, on time.
- 🌐 **Search the web** — if it doesn't know, it looks it up and tells you the source.
- 📒 **Tap-button menu** — browse notes, send a note to yourself, delete, recover from trash.
- 🔒 **Private** — your notes live on **your own Google Drive**. Nobody else sees them.

## 🧩 How it works (the simple picture)
```
You text it  →  a tiny free relay  →  a free Google script  →  your Google Drive
 (Telegram)      (Cloudflare)          (the "brain")            (your notes)
```
- Nothing to install, no computer to leave on. Google runs it for you, 24/7, for free.
- It uses free AI keys (Groq / Google Gemini). Add several so it never runs out.

## 🚀 Want your own?
Setting it up is mostly **copy-paste**. Two ways:

1. **Easiest — let an AI do it for you.** Give this repo link to an AI assistant (or paste
   `AGENTS.md`) and say *"set this up for me."* It will walk you through every step and do the
   technical parts. → see **[AGENTS.md](AGENTS.md)**.

2. **By hand** — follow **[SETUP.md](SETUP.md)** (plain steps, ~15 minutes, no coding needed).

You'll need (all free, no credit card):
- A Telegram account + a bot from **@BotFather**
- A Google account (for Drive + the script)
- A free **Groq** key (groq.com) — and optionally Google **Gemini** keys
- A free **Cloudflare** account (for the relay)

## 🙋 Common questions
- **Is it really free?** Yes — Google Apps Script, Drive, Groq's free tier and Cloudflare's free
  tier cover everything for personal use.
- **Does it stay on?** Yes, always. There's no server you keep running — Google does it.
- **Who can see my notes?** Only you. They're files in your own Google Drive.
- **What if the AI is busy?** Your message is still saved; it tidies up once a key frees up. Add
  more keys (in the menu → Settings) so this basically never happens.

---
Built to be honest: it never claims to have done something it didn't actually do. If it can't, it
says so plainly.
