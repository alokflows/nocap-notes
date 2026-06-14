// ===== LLM-Wiki Cloudflare relay =====
// Telegram POSTs here. We answer 200 instantly (so Telegram never retries / never duplicates —
// Apps Script's 302 would otherwise trigger retries), then forward the update to Apps Script in
// the background, following its 302 so doPost runs fully.
//
// Configure two Worker variables (Cloudflare dashboard → Settings → Variables, or `wrangler secret`):
//   TG_SECRET : the same secret_token you pass to Telegram's setWebhook (and in Apps Script).
//   GAS_URL   : your Apps Script web-app /exec URL, including ?s=<WEBHOOK_SECRET>.

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("LLM-Wiki relay is up.");
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const body = await request.text();
    ctx.waitUntil(
      fetch(env.GAS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "follow" }).catch(() => {})
    );
    return new Response("ok"); // immediate 200 → Telegram is satisfied, no retries
  },
};
