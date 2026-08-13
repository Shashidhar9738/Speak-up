const os = require("os");
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

app.listen(config.port, config.host, () => {
  console.log(`SpeakUp API listening on http://127.0.0.1:${config.port}`);

  if (config.host === "0.0.0.0") {
    localAddresses().forEach((address) => {
      console.log(`  reachable on your network at http://${address}:${config.port}`);
    });

    // Exposing this beyond localhost without TLS means submissions travel the
    // network in cleartext, which breaks the anonymity the product promises.
    if (!config.trustProxyTls) {
      console.warn("");
      console.warn("  WARNING: bound to all interfaces without TLS.");
      console.warn("  Complaint text and session tokens are sent in cleartext and can be");
      console.warn("  captured on the network, along with the submitter's IP address.");
      console.warn("  Put this behind HTTPS before inviting real reporters.");
    }
  }
});
