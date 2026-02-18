"use strict";

try {
  chrome.runtime.sendMessage({ type: "bootstrap-auto-rules" }, () => {
    // Best-effort bootstrap; ignore response/errors.
  });
} catch (error) {
  // Ignore bootstrap errors.
}
