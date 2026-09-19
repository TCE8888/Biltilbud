const { getOfferStore, offerKey } = require("../offerStore.js");

// Public, read-only endpoint that godta.html calls to show the customer a
// summary of their own offer before they accept it. Deliberately returns
// only what the page needs to render — never the seller's bcc/reply-to
// address, the customer's phone/email, or the accepted-from IP.
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let id;
  try {
    id = new URL(req.url, "http://placeholder").searchParams.get("id");
  } catch (e) {
    id = null;
  }
  if (!id || !/^[a-f0-9]{16,64}$/i.test(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  const store = getOfferStore();
  if (!store) {
    res.status(503).json({ error: "store_not_configured" });
    return;
  }

  let raw;
  try {
    raw = await store.get(offerKey(id));
  } catch (e) {
    res.status(500).json({ error: "store_read_failed" });
    return;
  }
  if (!raw) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let offer;
  try {
    offer = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    res.status(500).json({ error: "corrupt_record" });
    return;
  }

  res.status(200).json({
    ok: true,
    companyName: offer.companyName,
    model: offer.model,
    paint: offer.paint,
    interior: offer.interior,
    extras: offer.extras,
    tradeIn: offer.tradeIn,
    discount: offer.discount,
    financing: offer.financing,
    total: offer.total,
    customerName: offer.customerName,
    validUntil: offer.validUntil,
    sellerLine: offer.sellerLine,
    status: offer.status,
    acceptedAt: offer.acceptedAt || null,
    acceptedName: offer.acceptedName || null,
  });
};
