// BuildBrowser Translation - read-only bridge health check (v1.9.16 T3).
//
// Purpose: a 30-second morning self-check for the "click → bridge" path that
// bba_translate.js now uses when the single 翻译 trigger is pressed. It does
// NOT start or stop anything and does NOT write — it only reports whether a
// bridge is actually reachable and whether the cert chain the in-game <HTML>
// panel needs is trusted.
//
// What it probes
//   1. TCP 8792 — the DeadlockLingua (BabelTower) bridge. If the player has
//      BabelTower installed (pak22 in addons) and the game's host app is up,
//      this is what bba_translate.js hits first.
//   2. TCP 8793 — this repo's own bridge (tools/bridge/bridge.js).
//   3. The trusted-root store — the in-game panel is served over HTTPS with a
//      locally self-signed cert; the engine reads the trust store ONLY at
//      startup, so a freshly imported cert needs a full Steam restart. We
//      surface which roots are present so the morning run knows what to do.
//
// Usage:
//   node tools/bridge/check.js
//
// Output (stdout, one line per finding):
//   8792 ready        — a bridge answered on the BabelTower port
//   8793 ready        — this repo's bridge answered on its port
//   8792 down / 8793 down
//   trust: <cn>       — each trusted root we care about that is present
//   ... plus a final human line stating the in-game consequence.
"use strict";

const net = require("net");
const { execFileSync } = require("child_process");
const os = require("os");

// Ports to probe, in the order bba_translate.js tries them.
const PORTS = [
  { port: 8792, who: "8792 (DeadlockLingua / BabelTower bridge)" },
  { port: 8793, who: "8793 (this repo bridge: tools/bridge/bridge.js)" },
];

// Cert subject common-names / hints we consider "the bridge cert". Both
// BabelTower and this repo ship a localhost cert; the exact CN varies. We
// match loosely so the check still names it whatever the player installed.
const TRUST_HINTS = ["bbt", "babeltower", "deadlocklingua", "localhost"];

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// Read the CurrentUser root store. Windows: certutil -store -user Root.
// Non-Windows (dev machines): fall back to a graceful "n/a" note.
function readTrustedRoots() {
  if (os.platform() !== "win32") {
    return { supported: false, lines: [] };
  }
  let out;
  try {
    out = execFileSync("certutil", ["-store", "-user", "Root"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
      shell: false,
    }).toString("utf8");
  } catch (e) {
    return { supported: true, lines: ["certutil unavailable: " + String(e.message || e)] };
  }
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { supported: true, lines };
}

function findBridgeCerts(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i].toLowerCase();
    if (TRUST_HINTS.some((h) => l.indexOf(h) >= 0)) {
      // The CN is usually on the "Certifies to:" / "  <name>" line right after
      // a "Cert: " block header. Capture the next few lines for context.
      found.push(lines.slice(i, i + 3).join(" | "));
    }
  }
  return found;
}

(async function main() {
  console.log("[BBT-check] bridge health check (read-only)");
  console.log("[BBT-check] " + new Date().toISOString());

  let anyUp = false;
  for (const p of PORTS) {
    const up = await tcpProbe("127.0.0.1", p.port, 2500);
    if (up) {
      anyUp = true;
      console.log(p.port + " ready        " + p.who);
    } else {
      console.log(p.port + " down          " + p.who);
    }
  }

  const store = readTrustedRoots();
  if (!store.supported) {
    console.log("trust: n/a (non-Windows host; import the cert into your OS trust store)");
  } else {
    const certs = findBridgeCerts(store.lines);
    if (certs.length === 0) {
      console.log("trust: no bridge cert found in CurrentUser\\Root");
      console.log("       -> import it (scripts/gen_bridge_cert.ps1 -Trust) then FULLY RESTART Steam");
    } else {
      for (const c of certs) console.log("trust: " + c);
    }
  }

  console.log("----");
  if (anyUp) {
    console.log("[BBT-check] OK: a bridge is reachable — the 翻译 trigger will send MISS text to it.");
    console.log("[BBT-check] In-game you should see: [BBT] live bridge: ready on <port>");
  } else {
    console.log("[BBT-check] No bridge is up. Start one before testing the in-game button:");
    console.log("   node tools/bridge/bridge.js            (8793, needs config/certs)");
    console.log("   or make sure the DeadlockLingua host app is running (8792).");
    console.log("   Until then the trigger falls back to the offline memory and shows 桥未连接.");
  }
  process.exit(0);
})();
