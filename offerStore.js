// Shared helper for the "digital godkjenning" (customer acceptance) feature.
// Each sent offer is stored under a random id so a link in the customer's
// email (godta.html?id=...) can look it up, show a summary, and let them
// accept it — and so api/accept.js can find and update that same record.
//
// Uses the same free Redis database as reminderStore.js (Vercel Marketplace
// → Upstash or similar). If it isn't connected yet, api/send.js simply skips
// generating an accept link (the offer still sends as a plain PDF email) —
// this feature is additive, never a reason to fail a send.
const { Redis } = require("@upstash/redis");

const OFFER_KEY_PREFIX = "biltilbud:offer:";
// 60 days — comfortably past the offer's 14-day validity window, kept a
// little longer so an accepted offer still shows up as a record afterwards.
const OFFER_TTL_SECONDS = 60 * 24 * 60 * 60;

function getOfferStore() {
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

function offerKey(id) {
  return OFFER_KEY_PREFIX + id;
}

module.exports = { getOfferStore, offerKey, OFFER_TTL_SECONDS };
