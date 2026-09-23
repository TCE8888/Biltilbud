// Maps each seller's own personal code to their real name and phone number,
// so a sent or printed offer always shows who actually sent it — never just
// whatever name happens to be typed into Settings on the sending phone,
// which could be wrong or (in theory) faked.
//
// Configured via one environment variable on Vercel, SELLER_KEYS, holding a
// JSON object like:
//   {"thomas9064": {"name": "Thomas Ebbesvik", "phone": "93022064"}}
// Add more sellers later by adding more entries to that same JSON object —
// no code changes needed, just edit the environment variable in Vercel.
//
// Kept deliberately simple (a shared-but-personal code per seller, not a
// username/password login) to match how the rest of this app works: no
// accounts, no sessions, just a code typed once into Settings ⚙ on each
// seller's own phone.

function loadSellerKeys() {
  var raw = process.env.SELLER_KEYS;
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null; // malformed env var — treated as "not configured" rather than crashing
  }
}

// Looks up the seller for a given code. Returns { name, phone } (phone may
// be "") or null if the code isn't recognized — or if SELLER_KEYS isn't
// configured at all yet, in which case per-seller identification is simply
// not active and callers should fall back to the old shared-secret check.
function resolveSeller(key) {
  var sellers = loadSellerKeys();
  if (!sellers || typeof key !== "string" || !key) return null;
  var entry = sellers[key];
  if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name.trim()) return null;
  return {
    name: entry.name.trim(),
    phone: typeof entry.phone === "string" ? entry.phone.trim() : "",
  };
}

// True once SELLER_KEYS is set at all (even if empty/malformed) — used to
// decide whether per-seller codes are required, or whether the app should
// still fall back to the single shared APP_SECRET while nobody has set
// SELLER_KEYS up yet.
function sellerKeysConfigured() {
  return !!process.env.SELLER_KEYS;
}

module.exports = { resolveSeller, sellerKeysConfigured };
