(() => {
  "use strict";

  const DEFAULT_SITES = [];

  // DOM Elements
  const currentHostEl = document.getElementById("currentHost");
  const siteStatusPill = document.getElementById("siteStatusPill");
  const siteStatusText = document.getElementById("siteStatusText");
  const toggleCurrentBtn = document.getElementById("toggleCurrentBtn");
  const toggleCurrentBtnText = document.getElementById("toggleCurrentBtnText");
  const urlInput = document.getElementById("urlInput");
  const addUrlBtn = document.getElementById("addUrlBtn");
  const inputHint = document.getElementById("inputHint");
  const sitesListEl = document.getElementById("sitesList");
  const siteCountEl = document.getElementById("siteCount");
  const globalToggle = document.getElementById("globalToggle");
  const resetDefaultsBtn = document.getElementById("resetDefaultsBtn");
  const saveStatusEl = document.getElementById("saveStatus");
  const defaultReasonInput = document.getElementById("defaultReasonInput");
  const applySwipeUrlInput = document.getElementById("applySwipeUrlInput");

  let currentTab = null;
  let currentTabUrl = "";
  let currentTabHost = "";
  let allowedPatterns = [];
  let isGlobalActive = false;

  /* ==========================================================================
     Storage Helpers
     ========================================================================== */
  const STORAGE_DEFAULTS = {
    spine_allowed_patterns: DEFAULT_SITES,
    spine_global_active: false,
    spine_default_reason: "",
    spine_apply_swipe_url: ""
  };

  function getStorageData() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
        resolve({ ...STORAGE_DEFAULTS });
        return;
      }
      chrome.storage.sync.get(STORAGE_DEFAULTS, resolve);
    });
  }

  function setStorageData(data) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
        showSaveNotice();
        resolve();
        return;
      }
      chrome.storage.sync.set(data, () => {
        showSaveNotice();
        resolve();
      });
    });
  }

  let saveTimer = null;
  function showSaveNotice() {
    if (!saveStatusEl) return;
    saveStatusEl.textContent = "✓ Saved & synced";
    saveStatusEl.style.color = "#16a34a";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveStatusEl.textContent = "✓ Settings saved automatically";
      saveStatusEl.style.color = "";
    }, 2000);
  }

  function showHint(msg, isError = false) {
    if (!inputHint) return;
    inputHint.textContent = msg;
    if (isError) {
      inputHint.classList.add("error");
    } else {
      inputHint.classList.remove("error");
    }
  }

  /* ==========================================================================
     UI Rendering
     ========================================================================== */
  function render() {
    // 1. Site Count Badge
    siteCountEl.textContent = String(allowedPatterns.length);

    // 2. Global Toggle state
    globalToggle.checked = Boolean(isGlobalActive);

    // 3. Current Tab Evaluation
    const isSupportedWebpage = currentTabUrl.startsWith("http://") || currentTabUrl.startsWith("https://");
    const isMatch = isSupportedWebpage && window.SpineUrlMatcher.isMatch(currentTabUrl, allowedPatterns, isGlobalActive);

    if (!isSupportedWebpage) {
      currentHostEl.textContent = currentTabHost || "Non-web page (browser/system)";
      siteStatusPill.className = "status-pill inactive";
      siteStatusText.textContent = "Unavailable";
      toggleCurrentBtn.disabled = true;
      toggleCurrentBtn.className = "btn btn-primary";
      toggleCurrentBtnText.textContent = "Cannot run here";
    } else {
      currentHostEl.textContent = currentTabHost;
      toggleCurrentBtn.disabled = false;

      if (isMatch) {
        siteStatusPill.className = "status-pill active";
        siteStatusText.textContent = isGlobalActive ? "Active (Global)" : "Active";
        toggleCurrentBtn.className = "btn btn-primary btn-active-state";
        toggleCurrentBtnText.textContent = isGlobalActive ? "Active globally" : "✓ Active on this site";
      } else {
        siteStatusPill.className = "status-pill inactive";
        siteStatusText.textContent = "Inactive";
        toggleCurrentBtn.className = "btn btn-primary";
        toggleCurrentBtnText.textContent = "+ Enable on this site";
      }
    }

    // 4. Configured Sites List
    sitesListEl.innerHTML = "";

    if (allowedPatterns.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "sites-empty";
      emptyDiv.innerHTML = "No websites added yet.<br>Click <strong>+ Enable on this site</strong> above or enter your portal URL.";
      sitesListEl.appendChild(emptyDiv);
      return;
    }

    allowedPatterns.forEach((pattern, index) => {
      const itemEl = document.createElement("div");
      itemEl.className = "site-item";

      // Check if this specific item matches current tab
      if (currentTabUrl && window.SpineUrlMatcher.isMatch(currentTabUrl, [pattern], false)) {
        itemEl.classList.add("current-match");
      }

      const infoEl = document.createElement("div");
      infoEl.className = "site-item-info";

      const iconEl = document.createElement("span");
      iconEl.className = "site-item-icon";
      iconEl.textContent = "🌐";

      const textEl = document.createElement("span");
      textEl.className = "site-item-pattern";
      textEl.textContent = pattern;
      textEl.title = pattern;

      infoEl.appendChild(iconEl);
      infoEl.appendChild(textEl);

      const delBtn = document.createElement("button");
      delBtn.className = "site-delete-btn";
      delBtn.innerHTML = "🗑️";
      delBtn.title = `Remove ${pattern}`;
      delBtn.addEventListener("click", () => handleDelete(index));

      itemEl.appendChild(infoEl);
      itemEl.appendChild(delBtn);

      sitesListEl.appendChild(itemEl);
    });
  }

  /* ==========================================================================
     Actions
     ========================================================================== */
  async function handleAddUrl(rawInput) {
    const pattern = window.SpineUrlMatcher.cleanInput(rawInput);

    if (!pattern) {
      showHint("Please enter a valid website domain or URL pattern.", true);
      return;
    }

    if (allowedPatterns.some((p) => p.toLowerCase() === pattern.toLowerCase())) {
      showHint(`"${pattern}" is already in your active sites list.`, true);
      return;
    }

    allowedPatterns.push(pattern);
    await setStorageData({ spine_allowed_patterns: allowedPatterns });
    urlInput.value = "";
    showHint("Supports domains (example.com) or wildcards (*.example.com)", false);
    render();
  }

  async function handleDelete(index) {
    if (index < 0 || index >= allowedPatterns.length) return;
    const removed = allowedPatterns.splice(index, 1);
    await setStorageData({ spine_allowed_patterns: allowedPatterns });
    showHint(`Removed ${removed[0]}`, false);
    render();
  }

  async function handleToggleCurrent() {
    if (!currentTabUrl || !currentTabHost) return;

    if (isGlobalActive) {
      // If global is on, notify user they can turn off global
      showHint("Global mode is currently on (active everywhere).", false);
      return;
    }

    const isMatch = window.SpineUrlMatcher.isMatch(currentTabUrl, allowedPatterns, false);

    if (isMatch) {
      // Remove every pattern that matches the current page (the bare host is one of them)
      allowedPatterns = allowedPatterns.filter((p) => !window.SpineUrlMatcher.isMatch(currentTabUrl, [p], false));
      await setStorageData({ spine_allowed_patterns: allowedPatterns });
      showHint(`Disabled on ${currentTabHost}`, false);
    } else {
      // Add current host
      const hostToAdd = currentTabHost.toLowerCase();
      if (!allowedPatterns.includes(hostToAdd)) {
        allowedPatterns.unshift(hostToAdd);
        await setStorageData({ spine_allowed_patterns: allowedPatterns });
        showHint(`Added and enabled on ${currentTabHost}!`, false);
      }
    }

    render();
  }

  async function handleGlobalToggle(e) {
    isGlobalActive = e.target.checked;
    await setStorageData({ spine_global_active: isGlobalActive });
    render();
  }

  async function handleResetDefaults() {
    allowedPatterns = [...DEFAULT_SITES];
    isGlobalActive = false;
    await setStorageData({
      spine_allowed_patterns: allowedPatterns,
      spine_global_active: false
    });
    showHint("Reset active sites list", false);
    render();
  }

  /* ==========================================================================
     Initialization
     ========================================================================== */
  async function init() {
    // 1. Fetch current tab
    try {
      if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0]) {
          currentTab = tabs[0];
          currentTabUrl = currentTab.url || "";
          try {
            const parsed = new URL(currentTabUrl);
            currentTabHost = parsed.hostname;
          } catch {
            currentTabHost = "";
          }
        }
      }
    } catch (err) {
      console.warn("Could not query active tab:", err);
    }

    // 2. Fetch storage data
    const data = await getStorageData();
    allowedPatterns = Array.isArray(data.spine_allowed_patterns) ? data.spine_allowed_patterns : [...DEFAULT_SITES];
    isGlobalActive = Boolean(data.spine_global_active);

    if (defaultReasonInput && data.spine_default_reason) {
      defaultReasonInput.value = data.spine_default_reason;
    }

    if (applySwipeUrlInput && data.spine_apply_swipe_url) {
      applySwipeUrlInput.value = data.spine_apply_swipe_url;
    }

    // 3. Register listeners
    addUrlBtn.addEventListener("click", () => handleAddUrl(urlInput.value));
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddUrl(urlInput.value);
      }
    });

    if (defaultReasonInput) {
      let reasonTimer = null;
      defaultReasonInput.addEventListener("input", () => {
        clearTimeout(reasonTimer);
        reasonTimer = setTimeout(async () => {
          await setStorageData({ spine_default_reason: defaultReasonInput.value.trim() });
        }, 400);
      });
    }

    if (applySwipeUrlInput) {
      let urlTimer = null;
      applySwipeUrlInput.addEventListener("input", () => {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(async () => {
          await setStorageData({ spine_apply_swipe_url: applySwipeUrlInput.value.trim() });
        }, 400);
      });
    }

    toggleCurrentBtn.addEventListener("click", handleToggleCurrent);
    globalToggle.addEventListener("change", handleGlobalToggle);
    resetDefaultsBtn.addEventListener("click", handleResetDefaults);

    // 4. Initial Render
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
