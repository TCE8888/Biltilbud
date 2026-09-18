const nodemailer = require("nodemailer");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// Vercel serverless function (Node runtime). Receives a model, a list of
// checked extras, and customer contact details as JSON, builds a one-page
// PDF price offer server-side, and emails it straight to the customer
// (with an optional BCC copy to the dealer) via Gmail SMTP.

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

function formatNOK(n) {
  var v = Math.round(Number(n) || 0);
  return v.toLocaleString("nb-NO").replace(/ /g, " ") + " kr";
}

async function buildOfferPdf(data) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28;
  const margin = 48;
  let page = pdfDoc.addPage([pageWidth, 841.89]); // A4
  let y = 841.89 - margin;

  const accent = rgb(0.184, 0.435, 0.369); // #2f6f5e
  const ink = rgb(0.11, 0.14, 0.13);
  const muted = rgb(0.42, 0.46, 0.43);
  const line = rgb(0.89, 0.87, 0.82);

  function text(str, opts) {
    opts = opts || {};
    page.drawText(str, {
      x: opts.x != null ? opts.x : margin,
      y: y,
      size: opts.size || 11,
      font: opts.font || font,
      color: opts.color || ink,
    });
    y -= opts.gap != null ? opts.gap : (opts.size || 11) + 6;
  }

  function hr() {
    page.drawLine({
      start: { x: margin, y: y },
      end: { x: pageWidth - margin, y: y },
      thickness: 1,
      color: line,
    });
    y -= 16;
  }

  text(data.companyName || "Autosalg", { font: bold, size: 20, color: accent, gap: 26 });
  text("Tilbud på ny bil", { size: 13, color: muted, gap: 22 });
  hr();

  text("Kunde", { font: bold, size: 11, color: muted, gap: 16 });
  text(data.customer.name || "–", { size: 13, gap: 16 });
  if (data.customer.phone) text("Tlf: " + data.customer.phone, { size: 11, color: muted, gap: 14 });
  if (data.customer.email) text("E-post: " + data.customer.email, { size: 11, color: muted, gap: 14 });
  y -= 6;
  hr();

  // Draws a "label ... price" row. If the label text would run into the
  // right-aligned price on the same line (long model/option names), the
  // price is dropped to its own line below instead of overlapping it.
  function priceRow(label, priceStr, opts) {
    opts = opts || {};
    var lblFont = opts.labelFont || font;
    var lblSize = opts.labelSize || 12;
    var lblColor = opts.labelColor || ink;
    var priceFont = opts.priceFont || font;
    var priceSize = opts.priceSize || lblSize;
    var priceColor = opts.priceColor || ink;
    var rowGap = opts.rowGap != null ? opts.rowGap : 18;
    var minGap = 14; // minimum horizontal gap required between label and price on one line

    var labelWidth = lblFont.widthOfTextAtSize(label, lblSize);
    var priceWidth = priceFont.widthOfTextAtSize(priceStr, priceSize);
    var availableWidth = pageWidth - margin * 2;

    page.drawText(label, { x: margin, y: y, size: lblSize, font: lblFont, color: lblColor });

    if (labelWidth + minGap + priceWidth <= availableWidth) {
      page.drawText(priceStr, { x: pageWidth - margin - priceWidth, y: y, size: priceSize, font: priceFont, color: priceColor });
      y -= rowGap;
    } else {
      // Label too long to share the line with the price — wrap price below.
      y -= priceSize + 4;
      page.drawText(priceStr, { x: pageWidth - margin - priceWidth, y: y, size: priceSize, font: priceFont, color: priceColor });
      y -= rowGap;
    }
  }

  text("Modell", { font: bold, size: 11, color: muted, gap: 16 });
  priceRow(data.model.name, formatNOK(data.model.price), {
    labelFont: bold, labelSize: 15, labelColor: ink,
    priceFont: bold, priceSize: 15, priceColor: accent,
    rowGap: 26,
  });

  function lineItem(label, item) {
    if (!item || !item.name) return;
    var priceStr = item.price ? formatNOK(item.price) : "Inkludert";
    priceRow(label + ": " + item.name, priceStr, { labelSize: 12, priceSize: 12, rowGap: 18 });
  }
  lineItem("Lakk", data.paint);
  lineItem("Interiør", data.interior);
  if ((data.paint && data.paint.name) || (data.interior && data.interior.name)) y -= 4;

  if (data.extras && data.extras.length) {
    text("Ekstrautstyr", { font: bold, size: 11, color: muted, gap: 16 });
    data.extras.forEach(function (ex) {
      priceRow(ex.name, formatNOK(ex.price), { labelSize: 12, priceSize: 12, rowGap: 18 });
    });
    y -= 4;
  }

  hr();
  var totalStr = formatNOK(data.total);
  text("Totalpris", { font: bold, size: 13, gap: 4 });
  var totalWidth = bold.widthOfTextAtSize(totalStr, 20);
  page.drawText(totalStr, { x: pageWidth - margin - totalWidth, y: y + 22, size: 20, font: bold, color: accent });
  y -= 30;

  if (data.note) {
    hr();
    text("Notat", { font: bold, size: 11, color: muted, gap: 16 });
    text(data.note, { size: 11, gap: 16 });
  }

  y -= 10;
  text("Dato: " + data.date, { size: 10, color: muted, gap: 14 });
  text("Gyldig til: " + data.validUntil + " (14 dager fra tilbudsdato)", { size: 10, color: muted, gap: 14 });
  text("Tilbudet er veiledende og uforpliktende frem til skriftlig avtale er inngått.", {
    size: 9,
    color: muted,
    gap: 12,
  });

  if (data.sellerLine) {
    y -= 6;
    hr();
    text("Kontakt", { font: bold, size: 11, color: muted, gap: 16 });
    text(data.sellerLine, { size: 12, gap: 14 });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
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

  const appSecret = process.env.APP_SECRET;
  if (appSecret && req.headers["x-app-secret"] !== appSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
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

  const { model, paint, interior, extras, customer, note, companyName, bcc, sellerName, sellerPhone } = body || {};

  if (!model || typeof model.name !== "string" || typeof model.price !== "number") {
    res.status(400).json({ error: "missing_model" });
    return;
  }
  if (!customer || typeof customer.email !== "string" || !customer.email.trim()) {
    res.status(400).json({ error: "missing_customer_email" });
    return;
  }

  // Coerce rather than silently drop: a price that arrives as a numeric
  // string (e.g. "12500" instead of 12500, which can happen if prices.json
  // is hand-edited) should still count, not vanish from the offer.
  function cleanItem(item) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) return null;
    var n = Number(item.price);
    if (!isFinite(n)) n = 0;
    return { name: item.name, price: n };
  }
  const cleanPaint = cleanItem(paint);
  const cleanInterior = cleanItem(interior);
  const cleanExtras = Array.isArray(extras) ? extras.map(cleanItem).filter(Boolean) : [];
  const total =
    model.price +
    (cleanPaint ? cleanPaint.price : 0) +
    (cleanInterior ? cleanInterior.price : 0) +
    cleanExtras.reduce(function (sum, e) { return sum + e.price; }, 0);

  function fmtDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  const today = new Date();
  const dateStr = fmtDate(today);
  const validUntilDate = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  const validUntilStr = fmtDate(validUntilDate);

  // Who the customer should actually contact — shown in the PDF and the
  // email text, and used as the Reply-To address so a reply reaches the
  // salesperson instead of the shared sending account.
  const cleanSellerName = typeof sellerName === "string" ? sellerName.trim() : "";
  const cleanSellerPhone = typeof sellerPhone === "string" ? sellerPhone.trim() : "";
  const replyToEmail = (typeof bcc === "string" && bcc.trim()) || process.env.REPLY_TO_EMAIL || "";
  var sellerLineParts = [];
  if (cleanSellerName) sellerLineParts.push(cleanSellerName);
  if (cleanSellerPhone) sellerLineParts.push("tlf " + cleanSellerPhone);
  if (replyToEmail) sellerLineParts.push(replyToEmail);
  const sellerLine = sellerLineParts.join(" · ");

  let pdfBuffer;
  try {
    pdfBuffer = await buildOfferPdf({
      companyName: companyName || "Autosalg",
      model: model,
      paint: cleanPaint,
      interior: cleanInterior,
      extras: cleanExtras,
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
  const bodyText =
    "Hei" + (greetName ? " " + greetName : "") + ",\n\n" +
    "Vedlagt følger tilbud på " + model.name + ", totalpris " + formatNOK(total) + ".\n" +
    "Tilbudet er gyldig til " + validUntilStr + " (14 dager fra i dag).\n\n" +
    contactLine +
    "Mvh " + signOff + (cleanSellerName ? " / " + (companyName || "Autosalg") : "");

  const fromName = process.env.FROM_NAME || companyName || "Autosalg";
  const fromEmail = process.env.FROM_EMAIL || gmailUser;
  const mailOptions = {
    from: fromName + " <" + fromEmail + ">",
    to: customer.email,
    subject: "Tilbud – " + model.name,
    text: bodyText,
    attachments: [
      {
        filename: "tilbud-" + model.name.replace(/[^a-z0-9æøå]+/gi, "-").toLowerCase() + ".pdf",
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  };
  if (bcc && typeof bcc === "string" && bcc.trim()) {
    mailOptions.bcc = bcc.trim();
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
  }
};
