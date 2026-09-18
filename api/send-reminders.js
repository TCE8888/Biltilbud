const nodemailer = require("nodemailer");
const { getReminderStore, REMINDER_KEY } = require("../lib/reminderStore.js");

// Triggered once a day by Vercel Cron (see vercel.json). Goes through every
// offer queued by api/send.js and, for the ones sent roughly a day ago,
// sends the customer a short "any questions?" follow-up — then removes them
// from the queue so they're only reminded once.

function formatNOK(n) {
  var v = Math.round(Number(n) || 0);
  return v.toLocaleString("nb-NO") + " kr";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// A once-a-day cron can't hit exactly 24h00m after every offer, so we use a
// window: anything at least 20h old is "the day after" as far as a daily
// job is concerned. Anything over 4 days old is treated as missed (e.g. the
// cron was broken for a few days) and quietly dropped rather than sent very
// late.
const MIN_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  // Vercel automatically sends "Authorization: Bearer <CRON_SECRET>" when
  // it invokes a cron job, if CRON_SECRET is set as a project env var. The
  // x-app-secret path is there so it can also be triggered manually (e.g.
  // for testing) the same way /api/send is protected.
  const cronSecret = process.env.CRON_SECRET;
  const appSecret = process.env.APP_SECRET;
  const authHeader = req.headers["authorization"] || "";
  const viaCron = !!cronSecret && authHeader === "Bearer " + cronSecret;
  const viaAppSecret = !!appSecret && req.headers["x-app-secret"] === appSecret;
  if (!viaCron && !viaAppSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    res.status(500).json({ error: "server_not_configured" });
    return;
  }

  const store = getReminderStore();
  if (!store) {
    // No reminder database connected yet — not an error, the feature is
    // just inactive until one is.
    res.status(200).json({ ok: true, sent: 0, note: "reminder_store_not_configured" });
    return;
  }

  let rawList;
  try {
    rawList = (await store.lrange(REMINDER_KEY, 0, -1)) || [];
  } catch (e) {
    res.status(500).json({ error: "store_read_failed", message: String((e && e.message) || e) });
    return;
  }

  const now = Date.now();
  const toSend = [];
  const toKeep = [];
  rawList.forEach(function (raw) {
    var rec;
    try {
      rec = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      return; // drop unparseable entries
    }
    if (!rec || !rec.sentAt || !rec.customerEmail) return;
    var age = now - rec.sentAt;
    if (age >= MIN_AGE_MS && age <= MAX_AGE_MS) toSend.push(rec);
    else if (age < MIN_AGE_MS) toKeep.push(rec); // too soon — check again next run
    // else: past the window, drop silently
  });

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });
  const fromName = process.env.FROM_NAME || "Autosalg";
  const fromEmail = process.env.FROM_EMAIL || gmailUser;

  let sentCount = 0;
  for (const rec of toSend) {
    try {
      var greetName = rec.customerName ? String(rec.customerName).split(" ")[0] : "";
      var signOff = rec.sellerName || rec.companyName || "Autosalg";
      var contactSuffix = rec.replyToEmail ? " (" + rec.replyToEmail + ")" : "";

      var text =
        "Hei" + (greetName ? " " + greetName : "") + ",\n\n" +
        "Bare en liten påminnelse om tilbudet vi sendte deg på " + rec.modelName + ".\n" +
        "Er det noe du lurer på, bare si ifra" + contactSuffix + "!\n\n" +
        "Mvh " + signOff;

      var mailtoHref = rec.replyToEmail
        ? "mailto:" +
          encodeURIComponent(rec.replyToEmail) +
          "?subject=" +
          encodeURIComponent("Spørsmål om tilbud – " + rec.modelName)
        : "";

      var html =
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2420;max-width:480px;">' +
        "<p>Hei" + (greetName ? " " + escapeHtml(greetName) : "") + ",</p>" +
        "<p>Bare en liten påminnelse om tilbudet vi sendte deg på <strong>" +
        escapeHtml(rec.modelName) +
        "</strong>. Er det noe du lurer på, bare si ifra!</p>" +
        (mailtoHref
          ? '<p style="margin:22px 0;"><a href="' +
            mailtoHref +
            '" style="display:inline-block;background:#2f6f5e;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Svar her</a></p>'
          : "") +
        "<p>Mvh " + escapeHtml(signOff) + "</p>" +
        "</div>";

      var mailOptions = {
        from: fromName + " <" + fromEmail + ">",
        to: rec.customerEmail,
        subject: "Noe du lurer på? – " + rec.modelName,
        text: text,
        html: html,
      };
      if (rec.bcc) mailOptions.bcc = rec.bcc;
      if (rec.replyToEmail) {
        mailOptions.replyTo = rec.sellerName ? rec.sellerName + " <" + rec.replyToEmail + ">" : rec.replyToEmail;
      }

      await transporter.sendMail(mailOptions);
      sentCount++;
    } catch (e) {
      toKeep.push(rec); // send failed — retry on the next run instead of losing it
    }
  }

  try {
    await store.del(REMINDER_KEY);
    if (toKeep.length) {
      await store.rpush(REMINDER_KEY, ...toKeep.map(function (r) { return JSON.stringify(r); }));
    }
  } catch (e) {
    // Best effort — worst case a few reminders get re-sent on the next run.
  }

  res.status(200).json({ ok: true, sent: sentCount, kept: toKeep.length });
};
