/**
 * Spine Hours Helper - URL Pattern Matcher
 * Provides unified URL normalization and matching logic for both Popup and Content Scripts.
 */
(() => {
  "use strict";

  const SpineUrlMatcher = {
    /**
     * Normalizes user-entered URL or domain into a clean pattern string.
     */
    cleanInput(input) {
      if (!input || typeof input !== "string") return "";
      let val = input.trim();
      if (!val) return "";

      // If user pasted a full URL without wildcards
      if (!val.includes("*")) {
        try {
          const withProtocol = val.startsWith("http://") || val.startsWith("https://") ? val : "https://" + val;
          const parsed = new URL(withProtocol);
          return parsed.hostname.toLowerCase();
        } catch {
          return val.toLowerCase();
        }
      }
      return val.toLowerCase();
    },

    /**
     * Checks if currentUrl matches any configured patterns or if global active is enabled.
     */
    isMatch(currentUrl, patterns, globalAll = false) {
      if (globalAll) return true;
      if (!Array.isArray(patterns) || patterns.length === 0) return false;

      let parsedCurrent;
      try {
        parsedCurrent = new URL(currentUrl);
      } catch {
        return false;
      }

      const currentHost = parsedCurrent.hostname.toLowerCase();
      const currentHref = parsedCurrent.href.toLowerCase();

      return patterns.some((pattern) => {
        if (!pattern || typeof pattern !== "string") return false;
        const p = pattern.trim().toLowerCase();
        if (!p) return false;

        // 1. Hostname match or subdomain
        if (!p.includes("/") && !p.includes("*")) {
          return currentHost === p || currentHost.endsWith("." + p);
        }

        // 2. Wildcard domain like *.domain.com
        if (p.startsWith("*.") && !p.includes("/")) {
          const base = p.slice(2);
          return currentHost === base || currentHost.endsWith("." + base);
        }

        // 3. Glob match (e.g. https://example.com/* or *://example.com/*)
        try {
          const regexPattern =
            "^" +
            p
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$";
          const re = new RegExp(regexPattern, "i");
          return re.test(currentHref) || re.test(parsedCurrent.origin + "/") || re.test(currentHost);
        } catch {
          return false;
        }
      });
    }
  };

  // Attach to global scope for extension contexts
  if (typeof window !== "undefined") {
    window.SpineUrlMatcher = SpineUrlMatcher;
  }
  if (typeof globalThis !== "undefined") {
    globalThis.SpineUrlMatcher = SpineUrlMatcher;
  }
})();
