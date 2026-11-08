// Unit tests for SpineUrlMatcher
const path = require("path");

// Load url-matcher
require(path.join(__dirname, "url-matcher.js"));
const matcher = globalThis.SpineUrlMatcher;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

console.log("=== Testing SpineUrlMatcher.cleanInput ===");
assert(
  matcher.cleanInput("https://company.spinehrms.in/attendance") === "company.spinehrms.in",
  "cleanInput extracts hostname from full URL"
);
assert(
  matcher.cleanInput("company.spinehrms.in") === "company.spinehrms.in",
  "cleanInput handles bare domain"
);
assert(
  matcher.cleanInput("*.spinehrms.in") === "*.spinehrms.in",
  "cleanInput preserves wildcard prefix"
);

console.log("\n=== Testing SpineUrlMatcher.isMatch ===");
const patterns = ["spine.mycompany.com", "*.hrmsportal.in", "https://custom.app.com/*"];

assert(
  matcher.isMatch("https://spine.mycompany.com/Attendance/DailyPunch", patterns),
  "Matches exact hostname"
);
assert(
  matcher.isMatch("https://sub.spine.mycompany.com/view", patterns),
  "Matches parent domain hierarchy"
);
assert(
  matcher.isMatch("https://prod.hrmsportal.in/dashboard", patterns),
  "Matches wildcard subdomain (*.hrmsportal.in)"
);
assert(
  matcher.isMatch("https://custom.app.com/attendance", patterns),
  "Matches glob URL pattern (https://custom.app.com/*)"
);
assert(
  !matcher.isMatch("https://google.com", patterns),
  "Rejects non-matching domain"
);
assert(
  matcher.isMatch("https://any-site.com", [], true),
  "Matches any URL when globalActive is enabled"
);

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

