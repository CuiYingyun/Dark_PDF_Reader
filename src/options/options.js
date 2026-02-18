"use strict";

const SETTINGS_STORAGE_KEY = "autoTakeoverSettings";
const DEFAULT_SETTINGS = {
  autoTakeoverEnabled: true,
  autoOutlineAutoFitEnabled: true,
  whitelist: [],
  blacklist: []
};

const els = {
  autoTakeoverEnabled: document.getElementById("autoTakeoverEnabled"),
  autoOutlineAutoFitEnabled: document.getElementById("autoOutlineAutoFitEnabled"),
  whitelistInput: document.getElementById("whitelistInput"),
  blacklistInput: document.getElementById("blacklistInput"),
  saveBtn: document.getElementById("saveBtn"),
  resetBtn: document.getElementById("resetBtn"),
  statusText: document.getElementById("statusText")
};

init();

function init() {
  void requestBootstrap();

  els.saveBtn.addEventListener("click", () => {
    void saveSettings();
  });
  els.resetBtn.addEventListener("click", () => {
    applySettingsToForm(DEFAULT_SETTINGS);
    showStatus("已恢复为默认值，点击“保存设置”生效。");
  });

  void loadSettings();
}

async function loadSettings() {
  const settings = await getStoredSettings();
  applySettingsToForm(settings);
}

function applySettingsToForm(settings) {
  els.autoTakeoverEnabled.checked = settings.autoTakeoverEnabled !== false;
  els.autoOutlineAutoFitEnabled.checked = settings.autoOutlineAutoFitEnabled !== false;
  els.whitelistInput.value = settings.whitelist.join("\n");
  els.blacklistInput.value = settings.blacklist.join("\n");
}

async function saveSettings() {
  const next = {
    autoTakeoverEnabled: els.autoTakeoverEnabled.checked,
    autoOutlineAutoFitEnabled: els.autoOutlineAutoFitEnabled.checked,
    whitelist: normalizeRuleList(els.whitelistInput.value),
    blacklist: normalizeRuleList(els.blacklistInput.value)
  };

  await storageSet(SETTINGS_STORAGE_KEY, next);
  await requestBootstrap();
  applySettingsToForm(next);
  showStatus("设置已保存。", "ok");
}

function normalizeRuleList(rawText) {
  const set = new Set();
  const lines = String(rawText || "")
    .split(/[\n,]+/g)
    .map(item => item.trim())
    .filter(Boolean);

  for (const line of lines) {
    const normalized = normalizeRuleEntry(line);
    if (normalized) {
      set.add(normalized);
    }
  }
  return Array.from(set);
}

function normalizeRuleEntry(value) {
  let rule = String(value || "").trim().toLowerCase();
  if (!rule) {
    return null;
  }
  if (rule === "*") {
    return "*";
  }

  if (rule.startsWith("http://") || rule.startsWith("https://")) {
    try {
      rule = new URL(rule).hostname.toLowerCase();
    } catch (error) {
      return null;
    }
  } else {
    rule = rule.replace(/^https?:\/\//, "");
    rule = rule.split("/")[0];
    rule = rule.replace(/:\d+$/, "");
  }

  if (!rule) {
    return null;
  }
  if (rule.startsWith("*.")) {
    const domain = rule.slice(2);
    return domain ? `*.${domain}` : null;
  }
  if (rule.startsWith(".")) {
    rule = rule.slice(1);
  }
  return rule || null;
}

function showStatus(message, type = "") {
  els.statusText.textContent = message;
  els.statusText.className = type;
  if (type === "ok") {
    setTimeout(() => {
      if (els.statusText.textContent === message) {
        els.statusText.textContent = "";
        els.statusText.className = "";
      }
    }, 2500);
  }
}

async function getStoredSettings() {
  const stored = await storageGet(SETTINGS_STORAGE_KEY);
  return {
    autoTakeoverEnabled: stored?.autoTakeoverEnabled !== false,
    autoOutlineAutoFitEnabled: stored?.autoOutlineAutoFitEnabled !== false,
    whitelist: Array.isArray(stored?.whitelist) ? stored.whitelist : [],
    blacklist: Array.isArray(stored?.blacklist) ? stored.blacklist : []
  };
}

function storageGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get([key], result => {
      resolve(result[key] || null);
    });
  });
}

function storageSet(key, value) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: value }, () => {
      resolve();
    });
  });
}

function requestBootstrap() {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "bootstrap-auto-rules" }, () => {
        resolve();
      });
    } catch (error) {
      resolve();
    }
  });
}
