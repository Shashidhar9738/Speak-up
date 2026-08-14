const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const db = require("./services/db");
const { sweep } = require("./middleware/rateLimitMiddleware");
const audit = require("./services/auditService");
const mail = require("./services/mailService");
const webhooks = require("./services/webhookService");
const app = require("./app");
const config = require("./config");

function localAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

/**
 * Serve TLS directly when a key and certificate are configured. Behind a proxy
 * that already terminates TLS — Render, nginx, IIS — leave them unset and set
 * SPEAKUP_BEHIND_TLS=true instead.
 */
function createServer() {
  if (!config.tlsKeyFile || !config.tlsCertFile) {
    return { server: http.createServer(app), scheme: "http" };
  }

  for (const [label, file] of [["key", config.tlsKeyFile], ["certificate", config.tlsCertFile]]) {
    if (!fs.existsSync(file)) {
      // Quietly falling back to plaintext when TLS was explicitly asked for is
      // the worst outcome: it looks configured and is not.
      throw new Error(`TLS ${label} not found at ${file}`);
    }
  }

  return {
    server: https.createServer({
      key: fs.readFileSync(config.tlsKeyFile),
      cert: fs.readFileSync(config.tlsCertFile)
    }, app),
    scheme: "https"
  };
}

// Fail at boot rather than on the first request if the database cannot open.
db.open();
sweep();
audit.record("server.start", "system", { port: config.port, env: config.nodeEnv });

const { server, scheme } = createServer();

server.listen(config.port, config.host, async () => {
  console.log(`SpeakUp API listening on ${scheme}://127.0.0.1:${config.port}`);

  if (config.host === "0.0.0.0") {
    localAddresses().forEach((address) => {
      console.log(`  reachable on your network at ${scheme}://${address}:${config.port}`);
    });
  }

  const secure = scheme === "https" || config.trustProxyTls;
  console.log(`  email     ${mail.isConfigured() ? "configured" : "not configured — verification codes cannot be sent"}`);
  console.log(`  webhook   ${webhooks.isConfigured() ? "configured" : "not configured"}`);
  console.log(`  transport ${secure ? "encrypted" : "PLAINTEXT"}`);

  if (mail.isConfigured()) { await mail.verify(); }

  // Exposed beyond localhost without TLS, submissions cross the network in
  // cleartext together with the submitter's IP — which defeats the anonymity
  // the product exists to provide.
  if (config.host === "0.0.0.0" && !secure) {
    console.warn("");
    console.warn("  WARNING: reachable on the network without TLS.");
    console.warn("  Complaint text, session tokens and submitter IPs are all in cleartext.");
    console.warn("  Run `npm run tls:generate` for a local certificate, or put this behind HTTPS.");
  }
});
