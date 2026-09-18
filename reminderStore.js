// Shared helper for the "day after" reminder feature. Not an API route
// itself (no leading verb export) — used by api/send.js (to queue a
// reminder) and api/send-reminders.js (the daily cron job that sends them).
//
// Requires a small free Redis database connected to the Vercel project
// (Vercel Marketplace → a Redis provider such as Upstash). Different
// providers/integrations have used slightly different environment variable
// names over time, so we check the common ones rather than assuming one.
const { Redis } = require("@upstash/redis");

const REMINDER_KEY = "biltilbud:reminders";

function getReminderStore() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch (e) {
    return null;
  }
}

module.exports = { getReminderStore, REMINDER_KEY };
