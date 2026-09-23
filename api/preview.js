const { LOGO_BYTES, buildOfferPdf, prepareOffer, loadCarImage } = require("../pdfBuilder.js");
const { resolveSeller, sellerKeysConfigured } = require("../sellerAuth.js");

// Vercel serverless function (Node runtime). Builds the exact same PDF as
// api/send.js, using the same shared pdfBuilder.js, but just returns the PDF
// bytes directly instead of emailing anything — no offerStore write, no
// reminder queued, no Gmail login needed. Used by the "Skriv ut" (print)
// button in index.html so a seller can hand a printed offer to a customer
// who wants paper instead of email, even before a customer email is filled
// in (requireCustomerEmail is left off on purpose).

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-secret");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  // Same two-tier auth as api/send.js — see the comment there for why.
  const providedKey = req.headers["x-app-secret"] || "";
  const seller = resolveSeller(providedKey);
  if (sellerKeysConfigured()) {
    if (!seller) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  } else {
    const appSecret = process.env.APP_SECRET;
    if (appSecret && providedKey !== appSecret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  if (seller) {
    body = Object.assign({}, body, { sellerName: seller.name, sellerPhone: seller.phone });
  }

  const offer = prepareOffer(body, { requireCustomerEmail: false });
  if (offer.error) {
    res.status(400).json({ error: offer.error });
    return;
  }
  const {
    model, cleanPaint, cleanInterior, cleanExtras, cleanTradeIn, cleanDiscount, cleanFinancing, total,
    dateStr, validUntilStr, sellerLine, customer, note, companyName,
  } = offer;

  const { carImageBytes, carImageExt } = await loadCarImage(cleanPaint);

  let pdfBuffer;
  try {
    pdfBuffer = await buildOfferPdf({
      companyName: companyName || "Autosalg",
      logoBytes: LOGO_BYTES,
      carImageBytes: carImageBytes,
      carImageExt: carImageExt,
      model: model,
      paint: cleanPaint,
      interior: cleanInterior,
      extras: cleanExtras,
      tradeIn: cleanTradeIn,
      discount: cleanDiscount,
      financing: cleanFinancing,
      total: total,
      customer: customer,
      note: note || "",
      date: dateStr,
      validUntil: validUntilStr,
      sellerLine: sellerLine,
    });
  } catch (e) {
    res.status(500).json({ error: "pdf_failed", message: String((e && e.message) || e) });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="tilbud.pdf"');
  res.status(200).send(pdfBuffer);
};
