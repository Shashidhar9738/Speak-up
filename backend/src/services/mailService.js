const nodemailer = require("nodemailer");
const config = require("../config");
const audit = require("./auditService");

/**
 * Outbound email.
 *
 * Only ever used for dashboard accounts — verification codes and password
 * resets. It is never used to contact a reporter: they have no email address
 * on file, by design, and adding one would make every report attributable.
 *
 * Configure with a single URL, e.g.
 *   SPEAKUP_SMTP_URL=smtps://user:pass@smtp.gmail.com:465
 *   SPEAKUP_MAIL_FROM="SpeakUp <noreply@comviva.com>"
 *
 * With no URL set, sending is a no-op that returns { sent: false } — the caller
 * decides whether that is acceptable. Development shows the code on screen;
 * production refuses to register instead.
 */

let transport = null;
let verified = null;

function isConfigured() {
  return Boolean(config.smtpUrl);
}

function getTransport() {
  if (!isConfigured()) { return null; }
  if (!transport) {
    transport = nodemailer.createTransport(config.smtpUrl);
  }
  return transport;
}

/**
 * Checks the connection once at boot so a misconfigured server is a startup
 * warning rather than a failure discovered by the first person to register.
 */
async function verify() {
  if (!isConfigured()) { return { ok: false, reason: "not configured" }; }
  if (verified) { return verified; }

  try {
    await getTransport().verify();
    verified = { ok: true };
    console.log("[speakup] SMTP connection verified");
  } catch (error) {
    verified = { ok: false, reason: error.message };
    console.warn(`[speakup] SMTP configured but unreachable: ${error.message}`);
  }
  return verified;
}

async function send({ to, subject, text, html }) {
  if (!isConfigured()) {
    return { sent: false, reason: "SMTP is not configured" };
  }

  try {
    const info = await getTransport().sendMail({
      from: config.mailFrom,
      to,
      subject,
      text,
      html: html || undefined
    });
    // Recipients are dashboard accounts, never reporters, so logging the
    // address here cannot deanonymise anyone.
    audit.record("mail.sent", "system", { to, subject });
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.warn(`[speakup] could not send mail to ${to}: ${error.message}`);
    audit.record("mail.failed", "system", { to, subject, error: error.message });
    return { sent: false, reason: error.message };
  }
}

function shell(title, body, footer) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
  <tr><td style="background:linear-gradient(135deg,#14162a,#1b1e35);border-radius:14px 14px 0 0;padding:22px 26px;">
    <div style="font:700 18px Inter,Arial,sans-serif;color:#fff;">SpeakUp</div>
    <div style="font:400 12px Inter,Arial,sans-serif;color:#8b93a7;margin-top:2px;">${title}</div>
  </td></tr>
  <tr><td style="background:#fff;border:1px solid #e8ebf0;border-top:0;border-radius:0 0 14px 14px;padding:24px 26px;">
    ${body}
  </td></tr>
  <tr><td style="font:400 11px Inter,Arial,sans-serif;color:#98a1b0;padding:14px 26px;text-align:center;">
    ${footer}
  </td></tr>
</table></body></html>`;
}

function sendVerificationCode(email, code, ttlMinutes) {
  return send({
    to: email,
    subject: `Your SpeakUp verification code: ${code}`,
    text: `Your SpeakUp verification code is ${code}. It expires in ${ttlMinutes} minutes.\n\n` +
          `If you did not request access, ignore this message — nothing happens without the code.`,
    html: shell("Verify your email", `
      <div style="font:400 14px/1.6 Inter,Arial,sans-serif;color:#0f1420;">
        Enter this code to finish setting up your dashboard account:
      </div>
      <div style="font:700 30px ui-monospace,Menlo,monospace;letter-spacing:7px;color:#4f46e5;
                  text-align:center;padding:20px 0;">${code}</div>
      <div style="font:400 12.5px/1.6 Inter,Arial,sans-serif;color:#5b6474;">
        It expires in ${ttlMinutes} minutes. If you did not request access, ignore this —
        nothing happens without the code.
      </div>`,
      "Sent by SpeakUp. Reports remain anonymous; this address is only used for dashboard accounts.")
  });
}

function sendPasswordChanged(email) {
  return send({
    to: email,
    subject: "Your SpeakUp password was changed",
    text: "Your SpeakUp dashboard password was just changed. If this was not you, " +
          "tell a SpeakUp owner immediately — someone else may have access to your account.",
    html: shell("Password changed", `
      <div style="font:400 14px/1.6 Inter,Arial,sans-serif;color:#0f1420;">
        Your dashboard password was just changed.
      </div>
      <div style="font:400 13px/1.6 Inter,Arial,sans-serif;color:#991b1b;background:#fdeeee;
                  border-radius:9px;padding:12px 14px;margin-top:14px;">
        If this was not you, tell a SpeakUp owner immediately — someone else may have
        access to your account.
      </div>`,
      "Sent by SpeakUp.")
  });
}

module.exports = { isConfigured, verify, send, sendVerificationCode, sendPasswordChanged };
