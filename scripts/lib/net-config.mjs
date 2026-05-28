// scripts/lib/net-config.mjs
// Node 18 has undici happy-eyeballs (autoSelectFamily) OFF by default; an
// endpoint with a black-holed AAAA hangs until connect-timeout. Node 18.13+
// exposes the public net.setDefaultAutoSelectFamily — enable it process-wide so
// the built-in fetch races A/AAAA and falls back. No-op on older runtimes.
export function enableHappyEyeballs(net) {
  if (net && typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(true);
    return true;
  }
  return false;
}
