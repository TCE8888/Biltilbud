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

  text("Modell", { font: bold, size: 11, color: muted, gap: 16 });
  text(data.model.name, { font: bold, size: 15, gap: 4 });
  text(formatNOK(data.model.price), { size: 13, color: accent, gap: 20 });

  if (data.extras && data.extras.length) {
    text("Ekstrautstyr", { font: bold, size: 11, color: muted, gap: 16 });
    data.extras.forEach(function (ex) {
      var priceStr = formatNOK(ex.price);
      page.drawText(ex.name, { x: margin, y: y, size: 12, font: font, color: ink });
      var priceWidth = font.widthOfTextAtSize(priceStr, 12);
      page.drawText(priceStr, { x: pageWidth - margin - priceWidth, y: y, size: 12, font: font, color: ink });
      y -= 18;
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
  text("Tilbudet er veiledende og uforpliktende frem til skriftlig avtale er inngått.", {
    size: 9,
    color: muted,
    gap: 12,
  });

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

  const { model, extras, customer, note, companyName, bcc } = body || {};

  if (!model || typeof model.name !== "string" || typeof model.price !== "number") {
    res.status(400).json({ error: "missing_model" });
    return;
  }
  if (!customer || typeof customer.email !== "string" || !customer.email.trim()) {
    res.status(400).json({ error: "missing_customer_email" });
    return;
  }

  const cleanExtras = Array.isArray(extras)
    ? extras.filter(function (e) { return e && typeof e.name === "string" && typeof e.price === "number"; })
    : [];
  const total = model.price + cleanExtras.reduce(function (sum, e) { return sum + e.price; }, 0);

  const today = new Date();
  const dateStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");

  let pdfBuffer;
  try {
    pdfBuffer = await buildOfferPdf({
      companyName: companyName || "Autosalg",
      model: model,
      extras: cleanExtras,
      total: total,
      customer: customer,
      note: note || "",
      date: dateStr,
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
  const bodyText =
    "Hei" + (greetName ? " " + greetName : "") + ",\n\n" +
    "Vedlagt følger tilbud på " + model.name + ", totalpris " + formatNOK(total) + ".\n\n" +
    "Ta gjerne kontakt om du har spørsmål.\n\n" +
    "Mvh " + (companyName || "Autosalg");

  const mailOptions = {
    from: gmailUser,
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

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "send_failed", message: String((e && e.message) || e) });
  }
};
