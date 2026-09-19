const nodemailer = require("nodemailer");
const { getOfferStore, offerKey, OFFER_TTL_SECONDS } = require("../offerStore.js");

// Customer-facing endpoint: godta.html posts here when the customer types
// their name, ticks the confirmation checkbox, and presses "Godta tilbud".
// This is a documented confirmation (name + timestamp + IP), not a legally
// binding e-signature like BankID — good enough to lock a car in for
// preparation, not a substitute for a signed contract.

function formatNOK(n) {
  var v = Math.round(Number(n) || 0);
  return v.toLocaleString("nb-NO") + " kr";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!id || !/^[a-f0-9]{16,64}$/i.test(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "missing_name" });
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

  // Idempotent: a repeated tap (double-click, refresh, back button) must not
  // error out or overwrite who originally accepted it.
  if (offer.status === "accepted") {
    res.status(200).json({
      ok: true,
      alreadyAccepted: true,
      acceptedName: offer.acceptedName,
      acceptedAt: offer.acceptedAt,
    });
    return;
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : "") ||
    (req.socket && req.socket.remoteAddress) ||
    "";

  offer.status = "accepted";
  offer.acceptedAt = Date.now();
  offer.acceptedName = name;
  offer.acceptedIp = ip;

  try {
    await store.set(offerKey(id), JSON.stringify(offer), { ex: OFFER_TTL_SECONDS });
  } catch (e) {
    res.status(500).json({ error: "store_write_failed" });
    return;
  }

  // Best-effort dealer notification — the acceptance is already saved
  // above, so a failure here must not make the customer's tap look like it
  // failed.
  try {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const notifyTo = offer.bcc || offer.replyToEmail;
    if (gmailUser && gmailPass && notifyTo) {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser, pass: gmailPass },
      });
      const fromName = process.env.FROM_NAME || offer.companyName || "Autosalg";
      const fromEmail = process.env.FROM_EMAIL || gmailUser;
      const modelName = (offer.model && offer.model.name) || "tilbudet";
      const whenStr = new Date(offer.acceptedAt).toLocaleString("nb-NO");

      const text =
        (offer.customerName || "Kunden") + " har akseptert tilbudet på " + modelName +
        ", totalpris " + formatNOK(offer.total) + ".\n" +
        "Navn oppgitt ved aksept: " + name + "\n" +
        "Tidspunkt: " + whenStr + "\n" +
        (offer.customerEmail ? "Kunde-e-post: " + offer.customerEmail + "\n" : "");

      const html =
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2420;max-width:480px;">' +
        "<p><strong>" + escapeHtml(offer.customerName || "Kunden") + "</strong> har akseptert tilbudet på <strong>" +
        escapeHtml(modelName) + "</strong>, totalpris <strong>" + formatNOK(offer.total) + "</strong>.</p>" +
        "<p>Navn oppgitt ved aksept: " + escapeHtml(name) + "<br>" +
        "Tidspunkt: " + escapeHtml(whenStr) +
        (offer.customerEmail ? "<br>Kunde-e-post: " + escapeHtml(offer.customerEmail) : "") +
        "</p>" +
        "</div>";

      await transporter.sendMail({
        from: fromName + " <" + fromEmail + ">",
        to: notifyTo,
        subject: "✅ Tilbud akseptert – " + modelName,
        text: text,
        html: html,
      });
    }
  } catch (e) {
    // Non-fatal — see comment above.
  }

  res.status(200).json({ ok: true, alreadyAccepted: false });
};
