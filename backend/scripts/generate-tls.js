/**
 * Generate a self-signed certificate for local HTTPS.
 *
 *   npm run tls:generate
 *   # then in .env:
 *   #   SPEAKUP_TLS_KEY=backend/certs/localhost-key.pem
 *   #   SPEAKUP_TLS_CERT=backend/certs/localhost-cert.pem
 *
 * A self-signed certificate encrypts the connection but proves nothing about
 * who is on the other end, so browsers show a warning. That is honest: it is
 * fine for development and for a LAN demo, and it is NOT a substitute for a
 * real certificate in front of real reporters.
 *
 * Needs the openssl binary, which ships with Git for Windows.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DIR = path.join(__dirname, "..", "certs");
const KEY = path.join(DIR, "localhost-key.pem");
const CERT = path.join(DIR, "localhost-cert.pem");
const DAYS = 365;

function findOpenssl() {
  const candidates = [
    "openssl",
    "C:/Program Files/Git/usr/bin/openssl.exe",
    "C:/Program Files/Git/mingw64/bin/openssl.exe",
    "/usr/bin/openssl"
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["version"], { stdio: "pipe" });
      return candidate;
    } catch (error) { /* try the next one */ }
  }
  return null;
}

function main() {
  const openssl = findOpenssl();
  if (!openssl) {
    console.error("  openssl not found.");
    console.error("  It ships with Git for Windows — install that, or generate a certificate another way.");
    process.exit(1);
  }

  fs.mkdirSync(DIR, { recursive: true });

  if (fs.existsSync(CERT) && !process.argv.includes("--force")) {
    console.log(`  certificate already exists at ${path.relative(process.cwd(), CERT)}`);
    console.log("  pass --force to replace it");
    return;
  }

  // Both localhost and 127.0.0.1 as SANs: browsers reject a certificate that
  // does not name the host actually typed into the bar.
  const config = [
    "[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no",
    "[dn]", "CN=localhost", "O=SpeakUp Development", "C=IN",
    "[v3]", "subjectAltName=DNS:localhost,IP:127.0.0.1", "basicConstraints=CA:FALSE",
    "keyUsage=digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth"
  ].join("\n");

  const configFile = path.join(DIR, "openssl.cnf");
  fs.writeFileSync(configFile, config);

  try {
    execFileSync(openssl, [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256",
      "-days", String(DAYS), "-nodes",
      "-keyout", KEY, "-out", CERT,
      "-config", configFile
    ], { stdio: "pipe" });
  } finally {
    fs.rmSync(configFile, { force: true });
  }

  console.log();
  console.log("  certificate generated, valid " + DAYS + " days");
  console.log("    " + path.relative(process.cwd(), KEY).replace(/\\/g, "/"));
  console.log("    " + path.relative(process.cwd(), CERT).replace(/\\/g, "/"));
  console.log();
  console.log("  Add to .env:");
  console.log("    SPEAKUP_TLS_KEY=backend/certs/localhost-key.pem");
  console.log("    SPEAKUP_TLS_CERT=backend/certs/localhost-cert.pem");
  console.log();
  console.log("  Your browser will warn that the certificate is not trusted. That is expected:");
  console.log("  it encrypts the connection but proves nothing about who is serving it.");
  console.log("  Use a real certificate before real reporters use this.");
  console.log();
}

main();
