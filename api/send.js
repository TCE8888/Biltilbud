const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { getReminderStore, REMINDER_KEY } = require("../reminderStore.js");
const { getOfferStore, offerKey, OFFER_TTL_SECONDS } = require("../offerStore.js");

// Vercel serverless function (Node runtime). Receives a model, a list of
// checked extras, and customer contact details as JSON, builds a one-page
// PDF price offer server-side, and emails it straight to the customer
// (with an optional BCC copy to the dealer) via Gmail SMTP.

// Logo (logo.png at the project root, served as a static asset) is read
// once at cold start via a literal fs path so Vercel's build tracing bundles
// it into the function automatically — no network call needed at request
// time. Falls back to a plain text heading if the file isn't there.
let LOGO_BYTES = null;
try {
  LOGO_BYTES = fs.readFileSync(path.join(__dirname, "..", "logo.png"));
} catch (e) {
  LOGO_BYTES = null;
}

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

// Standard annuity loan payment (Norway's usual "billån") — not leasing,
// which prices off a residual value instead. Mirrors the same formula used
// client-side in index.html so the number shown while building the offer
// matches what ends up on the PDF.
function monthlyPayment(principal, ratePct, months) {
  var p = Math.max(0, Number(principal) || 0);
  var monthlyRate = (Number(ratePct) || 0) / 100 / 12;
  if (p <= 0 || !months || months <= 0) return 0;
  if (monthlyRate === 0) return p / months;
  return (p * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
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
  const warn = rgb(0.659, 0.329, 0.122); // #a8541f — used for the trade-in deduction

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

  let logoDrawn = false;
  if (data.logoBytes) {
    try {
      const logoImage = await pdfDoc.embedPng(data.logoBytes);
      const maxWidth = 170;
      const maxHeight = 40;
      const scale = Math.min(maxWidth / logoImage.width, maxHeight / logoImage.height);
      const w = logoImage.width * scale;
      const h = logoImage.height * scale;
      page.drawImage(logoImage, { x: margin, y: y - h, width: w, height: h });
      y -= h + 16;
      logoDrawn = true;
    } catch (e) {
      logoDrawn = false; // fall through to the text heading below
    }
  }
  if (!logoDrawn) {
    text(data.companyName || "Autosalg", { font: bold, size: 20, color: accent, gap: 26 });
  }
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

  // A photo of the car in the selected color, if the seller's prices.json
  // has one for this paint. Capped to a modest height so the rest of the
  // offer still fits on the one page everything else here assumes.
  if (data.carImageBytes) {
    try {
      const carImage = data.carImageExt === "png"
        ? await pdfDoc.embedPng(data.carImageBytes)
        : await pdfDoc.embedJpg(data.carImageBytes);
      const maxWidth = pageWidth - margin * 2;
      const maxHeight = 170;
      const scale = Math.min(maxWidth / carImage.width, maxHeight / carImage.height);
      const w = carImage.width * scale;
      const h = carImage.height * scale;
      const x = margin + (maxWidth - w) / 2; // centered
      page.drawImage(carImage, { x: x, y: y - h, width: w, height: h });
      y -= h + 16;
    } catch (e) {
      // Bad or unsupported image file — skip it silently, the offer still sends.
    }
  }

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

  if (data.tradeIn && data.tradeIn.value) {
    text("Innbytte", { font: bold, size: 11, color: muted, gap: 16 });
    priceRow(data.tradeIn.description || "Innbyttebil", "-" + formatNOK(data.tradeIn.value), {
      labelSize: 12, priceSize: 12, priceColor: warn, rowGap: 18,
    });
    y -= 4;
  }

  if (data.discount && data.discount.value) {
    text("Rabatt", { font: bold, size: 11, color: muted, gap: 16 });
    priceRow(data.discount.description || "Rabatt", "-" + formatNOK(data.discount.value), {
      labelSize: 12, priceSize: 12, priceColor: warn, rowGap: 18,
    });
    y -= 4;
  }

  hr();
  var totalStr = formatNOK(data.total);
  var totalRowY = y; // draw label and price on the same baseline, like priceRow does
  page.drawText("Totalpris", { x: margin, y: totalRowY, size: 13, font: bold, color: ink });
  var totalWidth = bold.widthOfTextAtSize(totalStr, 20);
  page.drawText(totalStr, { x: pageWidth - margin - totalWidth, y: totalRowY - 3, size: 20, font: bold, color: accent });
  y -= 30;

  if (data.financing) {
    hr();
    text("Finansieringseksempel", { font: bold, size: 11, color: muted, gap: 16 });
    priceRow("Lånebeløp (inkl. gebyrer)", formatNOK(data.financing.principal), { labelSize: 12, priceSize: 12, rowGap: 16 });
    if (data.financing.downPayment) {
      priceRow("Egenkapital", formatNOK(data.financing.downPayment), { labelSize: 12, priceSize: 12, rowGap: 16 });
    }
    if (data.financing.establishmentFee) {
      priceRow("Etableringsgebyr", formatNOK(data.financing.establishmentFee), { labelSize: 12, priceSize: 12, rowGap: 16 });
    }
    if (data.financing.registrationFee) {
      priceRow("Tinglysningsgebyr", formatNOK(data.financing.registrationFee), { labelSize: 12, priceSize: 12, rowGap: 16 });
    }
    if (data.financing.monthlyFee) {
      priceRow("Termingebyr", formatNOK(data.financing.monthlyFee) + "/mnd", { labelSize: 12, priceSize: 12, rowGap: 16 });
    }
    priceRow("Rente / løpetid", data.financing.rate.toLocaleString("nb-NO") + " % p.a. · " + data.financing.months + " mnd", { labelSize: 12, priceSize: 12, rowGap: 18 });
    priceRow("Ca. per måned", formatNOK(data.financing.monthly) + "/mnd", {
      labelFont: bold, labelSize: 13, priceFont: bold, priceSize: 15, priceColor: accent, rowGap: 18,
    });
    text("Veiledende eksempel, ikke et bindende lånetilbud. Faktiske vilkår avtales med bank/finansieringsselskap.", {
      size: 9, color: muted, gap: 12,
    });
    y -= 4;
  }

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

  const { model, paint, interior, extras, tradeIn, discount, financing, customer, note, companyName, bcc, sellerName, sellerPhone } = body || {};

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
  function cleanItem(item, opts) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) return null;
    var n = Number(item.price);
    if (!isFinite(n)) n = 0;
    var result = { name: item.name, price: n };
    // Paint entries can carry an "image" field (a filename from prices.json,
    // e.g. "byd-evo-rod.jpg") naming a photo of the car in that color. Only
    // passed through for paint — kept here rather than trusted as-is because
    // it still has to be turned into a safe filesystem path later.
    if (opts && opts.withImage && typeof item.image === "string" && item.image.trim()) {
      result.image = item.image.trim();
    }
    return result;
  }
  const cleanPaint = cleanItem(paint, { withImage: true });
  const cleanInterior = cleanItem(interior);
  const cleanExtras = Array.isArray(extras) ? extras.map(function (e) { return cleanItem(e); }).filter(Boolean) : [];

  // Trade-in reduces the total rather than adding to it. A description
  // alone with no value, or a value with no description, is still valid —
  // only an entirely empty trade-in is dropped.
  let cleanTradeIn = null;
  if (tradeIn && (typeof tradeIn.description === "string" || tradeIn.value != null)) {
    var tiDesc = typeof tradeIn.description === "string" ? tradeIn.description.trim() : "";
    var tiValue = Number(tradeIn.value);
    if (!isFinite(tiValue) || tiValue < 0) tiValue = 0;
    if (tiDesc || tiValue) cleanTradeIn = { description: tiDesc, value: tiValue };
  }

  // Discount works the same way as trade-in — it reduces the total. Same
  // coercion rules: only an entirely empty discount is dropped.
  let cleanDiscount = null;
  if (discount && (typeof discount.description === "string" || discount.value != null)) {
    var dDesc = typeof discount.description === "string" ? discount.description.trim() : "";
    var dValue = Number(discount.value);
    if (!isFinite(dValue) || dValue < 0) dValue = 0;
    if (dDesc || dValue) cleanDiscount = { description: dDesc, value: dValue };
  }

  const total =
    model.price +
    (cleanPaint ? cleanPaint.price : 0) +
    (cleanInterior ? cleanInterior.price : 0) +
    cleanExtras.reduce(function (sum, e) { return sum + e.price; }, 0) -
    (cleanTradeIn ? cleanTradeIn.value : 0) -
    (cleanDiscount ? cleanDiscount.value : 0);

  // Financing example — a simple annuity loan ("billån"), not leasing.
  // Requires a rate and a loan term to mean anything; a down payment with
  // no term entered is dropped rather than guessed at.
  let cleanFinancing = null;
  if (financing && financing.months != null) {
    var finRate = Number(financing.rate);
    if (!isFinite(finRate) || finRate < 0) finRate = 0;
    var finMonths = Math.round(Number(financing.months));
    var finDown = Number(financing.downPayment);
    if (!isFinite(finDown) || finDown < 0) finDown = 0;
    var finEstFee = Number(financing.establishmentFee);
    if (!isFinite(finEstFee) || finEstFee < 0) finEstFee = 0;
    var finRegFee = Number(financing.registrationFee);
    if (!isFinite(finRegFee) || finRegFee < 0) finRegFee = 0;
    var finMonthlyFee = Number(financing.monthlyFee);
    if (!isFinite(finMonthlyFee) || finMonthlyFee < 0) finMonthlyFee = 0;
    if (isFinite(finMonths) && finMonths > 0) {
      // The establishment and registration ("tinglysning") fees are
      // financed together with the loan (added to the amount borrowed, the
      // way most Norwegian banks present it), so they're folded into the
      // principal before the annuity calculation. The monthly ("termin")
      // fee isn't part of the loan — it's billed on top of every payment —
      // so it's added after the annuity math instead.
      var finPrincipal = Math.max(0, total - finDown + finEstFee + finRegFee);
      cleanFinancing = {
        rate: finRate,
        months: finMonths,
        downPayment: finDown,
        establishmentFee: finEstFee,
        registrationFee: finRegFee,
        monthlyFee: finMonthlyFee,
        principal: finPrincipal,
        monthly: monthlyPayment(finPrincipal, finRate, finMonths) + finMonthlyFee,
      };
    }
  }

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

  // The seller only sends us a filename (e.g. "byd-evo-rod.jpg", taken from
  // prices.json). It has to resolve to a real image file living next to
  // logo.png at the project root — never trust it as a path outright, or a
  // crafted filename like "../../.env" could read arbitrary files. Stripping
  // to just the basename and requiring a plain image extension closes that
  // off; anything that doesn't match is quietly ignored (no photo, not a
  // crash) rather than rejecting the whole offer over a bad filename.
  function safeCarImagePath(filename) {
    if (typeof filename !== "string") return null;
    var base = path.basename(filename.trim());
    if (!/^[a-zA-Z0-9_.\-]+\.(jpe?g|png|webp)$/i.test(base)) return null;
    var isWebp = /\.webp$/i.test(base);
    return {
      full: path.join(__dirname, "..", base),
      ext: isWebp ? "webp" : (/\.png$/i.test(base) ? "png" : "jpg"),
    };
  }

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
            bcc: bcc && typeof bcc === "string" && bcc.trim() ? bcc.trim() : "",
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

  let carImageBytes = null;
  let carImageExt = null;
  if (cleanPaint && cleanPaint.image) {
    var imgInfo = safeCarImagePath(cleanPaint.image);
    if (imgInfo) {
      try {
        var rawImageBytes = fs.readFileSync(imgInfo.full);
        if (imgInfo.ext === "webp") {
          // pdf-lib can only embed JPEG/PNG, so webp is converted to PNG
          // first. Requiring sharp here (rather than at the top of the
          // file) means a problem with that optional dependency only costs
          // the photo, not the whole send — everything else still works.
          var sharp = require("sharp");
          carImageBytes = await sharp(rawImageBytes).png().toBuffer();
          carImageExt = "png";
        } else {
          carImageBytes = rawImageBytes;
          carImageExt = imgInfo.ext;
        }
      } catch (e) {
        carImageBytes = null; // file not uploaded yet, or couldn't convert — offer still sends, just without the photo
      }
    }
  }

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
          bcc: bcc && typeof bcc === "string" && bcc.trim() ? bcc.trim() : "",
          acceptUrl: acceptUrl || "",
          sentAt: Date.now(),
        })
      );
    }
  } catch (e) {
    // Non-fatal — see comment above.
  }
};
