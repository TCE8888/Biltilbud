const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { getReminderStore, REMINDER_KEY } = require("../reminderStore.js");
const { getOfferStore, offerKey, OFFER_TTL_SECONDS } = require("../offerStore.js");
const { LOGO_BYTES, formatNOK, buildOfferPdf, prepareOffer, loadCarImage } = require("../pdfBuilder.js");
const { resolveSeller, sellerKeysConfigured } = require("../sellerAuth.js");

// Vercel serverless function (Node runtime). Receives a model, a list of
// checked extras, and customer contact details as JSON, builds a one-page
// PDF price offer server-side (via pdfBuilder.js, shared with api/preview.js
// so the two can never drift out of sync again), and emails it straight to
// the customer (with an optional BCC copy to the dealer) via Gmail SMTP.

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

  // Two ways to authenticate a request, tried in this order:
  //  1. Per-seller codes (SELLER_KEYS env var) — once that's configured,
  //     every request must match a known seller's own code, and the
  //     seller's real name/phone (from the env var, not from whatever the
  //     sending phone typed into Settings) is used on the offer from here
  //     on, so it can't be faked.
  //  2. The old single shared APP_SECRET — kept as a fallback for as long
  //     as SELLER_KEYS isn't set up yet, so nothing breaks mid-transition.
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

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    res.status(500).json({ error: "server_not_configured" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  // A verified seller's real name/phone always overrides whatever the
  // sending phone had typed into Settings — that's the whole point of
  // per-seller codes: the name on the offer can't be spoofed.
  if (seller) {
    body = Object.assign({}, body, { sellerName: seller.name, sellerPhone: seller.phone });
  }

  const offer = prepareOffer(body, { requireCustomerEmail: true });
  if (offer.error) {
    res.status(400).json({ error: offer.error });
    return;
  }
  const {
    model, cleanPaint, cleanInterior, cleanExtras, cleanTradeIn, cleanDiscount, cleanFinancing, total,
    dateStr, validUntilStr, cleanSellerName, replyToEmail, sellerLine, customer, note, companyName, bcc,
  } = offer;

  // Store a copy of this offer under a random id so the customer can open a
  // link in their email and accept it digitally later. Best-effort: if the
  // Redis database isn't connected, or we can't work out this deployment's
  // own URL from the request, the offer still sends as normal — it just
  // won't have an "accept" link this time.
  let offerId = null;
  let acceptUrl = null;
  try {
    const offerStore = getOfferStore();
    if (offerStore) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const baseUrl = process.env.APP_BASE_URL || (host ? proto + "://" + host : "");
      if (baseUrl) {
        offerId = crypto.randomBytes(16).toString("hex");
        acceptUrl = baseUrl.replace(/\/$/, "") + "/godta.html?id=" + offerId;
        await offerStore.set(
          offerKey(offerId),
          JSON.stringify({
            status: "pending",
            createdAt: Date.now(),
            companyName: companyName || "Autosalg",
            model: model,
            paint: cleanPaint,
            interior: cleanInterior,
            extras: cleanExtras,
            tradeIn: cleanTradeIn,
            discount: cleanDiscount,
            financing: cleanFinancing,
            total: total,
            customerName: customer.name || "",
            customerEmail: customer.email,
            sellerLine: sellerLine,
            bcc: bcc || "",
            replyToEmail: replyToEmail || "",
            validUntil: validUntilStr,
          }),
          { ex: OFFER_TTL_SECONDS }
        );
      }
    }
  } catch (e) {
    offerId = null;
    acceptUrl = null; // best effort — see comment above
  }

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

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  const greetName = customer.name ? customer.name.split(" ")[0] : "";
  const signOff = cleanSellerName ? cleanSellerName : (companyName || "Autosalg");
  const contactLine = sellerLine
    ? "Har du spørsmål, ta kontakt: " + sellerLine + ".\n\n"
    : "Ta gjerne kontakt om du har spørsmål.\n\n";
  const acceptLine = acceptUrl
    ? "Vil du godta tilbudet? Trykk her: " + acceptUrl + "\n\n"
    : "";
  const bodyText =
    "Hei" + (greetName ? " " + greetName : "") + ",\n\n" +
    "Vedlagt følger tilbud på " + model.name + ", totalpris " + formatNOK(total) + ".\n" +
    "Tilbudet er gyldig til " + validUntilStr + " (14 dager fra i dag).\n\n" +
    acceptLine +
    contactLine +
    "Mvh " + signOff + (cleanSellerName ? " / " + (companyName || "Autosalg") : "");

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // A real "Svar her" button (mailto link) for email clients that render
  // HTML, so the customer doesn't have to hit the ordinary Reply button —
  // it opens a fresh email already addressed and with a subject filled in.
  // Falls back to plain text (bodyText) automatically if the client can't
  // show HTML.
  let mailtoHref = "";
  if (replyToEmail) {
    var mailtoSubject = encodeURIComponent("Spørsmål om tilbud – " + model.name);
    var mailtoBody = encodeURIComponent(
      "Hei" + (cleanSellerName ? " " + cleanSellerName : "") + ",\n\nJeg har et spørsmål om tilbudet på " + model.name + ".\n\n"
    );
    mailtoHref = "mailto:" + encodeURIComponent(replyToEmail) + "?subject=" + mailtoSubject + "&body=" + mailtoBody;
  }

  const htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2420;max-width:480px;">' +
    "<p>Hei" + (greetName ? " " + escapeHtml(greetName) : "") + ",</p>" +
    "<p>Vedlagt følger tilbud på <strong>" + escapeHtml(model.name) + "</strong>, totalpris <strong>" + formatNOK(total) + "</strong>.<br>" +
    "Tilbudet er gyldig til " + validUntilStr + " (14 dager fra i dag).</p>" +
    (acceptUrl
      ? '<p style="margin:24px 0;"><a href="' + acceptUrl + '" style="display:inline-block;background:#2f6f5e;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Godta tilbudet digitalt</a></p>'
      : "") +
    (mailtoHref
      ? '<p style="margin:' + (acceptUrl ? "0 0 24px" : "24px 0") + ';"><a href="' + mailtoHref + '" style="color:#2f6f5e;font-weight:600;text-decoration:none;">Har du spørsmål? Svar her</a></p>' +
        (sellerLine ? '<p style="color:#6c756e;font-size:13px;">Eller ta kontakt direkte: ' + escapeHtml(sellerLine) + "</p>" : "")
      : "<p>" + (sellerLine ? "Ta gjerne kontakt: " + escapeHtml(sellerLine) + "." : "Ta gjerne kontakt om du har spørsmål.") + "</p>") +
    "<p>Mvh " + escapeHtml(signOff) + (cleanSellerName ? " / " + escapeHtml(companyName || "Autosalg") : "") + "</p>" +
    "</div>";

  const fromName = process.env.FROM_NAME || companyName || "Autosalg";
  const fromEmail = process.env.FROM_EMAIL || gmailUser;
  const mailOptions = {
    from: fromName + " <" + fromEmail + ">",
    to: customer.email,
    subject: "Tilbud – " + model.name,
    text: bodyText,
    html: htmlBody,
    attachments: [
      {
        filename: "tilbud-" + model.name.replace(/[^a-z0-9æøå]+/gi, "-").toLowerCase() + ".pdf",
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  };
  if (bcc) {
    mailOptions.bcc = bcc;
  }
  // So a reply from the customer goes to the salesperson, not the shared
  // sending account. Falls back to a general REPLY_TO_EMAIL env var if the
  // salesperson hasn't set "Kopi til deg" in settings.
  if (replyToEmail) {
    mailOptions.replyTo = cleanSellerName ? cleanSellerName + " <" + replyToEmail + ">" : replyToEmail;
  }

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "send_failed", message: String((e && e.message) || e) });
    return;
  }

  // Queue a "day after" reminder — best effort. If no reminder database is
  // connected yet (getReminderStore() returns null) or the write fails for
  // any reason, the offer has already been sent successfully above, so we
  // must not fail the request over this; the reminder feature just stays
  // inactive until a database is connected.
  try {
    const store = getReminderStore();
    if (store) {
      await store.rpush(
        REMINDER_KEY,
        JSON.stringify({
          customerEmail: customer.email,
          customerName: customer.name || "",
          modelName: model.name,
          companyName: companyName || "Autosalg",
          sellerName: cleanSellerName || "",
          replyToEmail: replyToEmail || "",
          bcc: bcc || "",
          acceptUrl: acceptUrl || "",
          sentAt: Date.now(),
        })
      );
    }
  } catch (e) {
    // Non-fatal — see comment above.
  }
};
