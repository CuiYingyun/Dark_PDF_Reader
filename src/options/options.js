"use strict";

const SETTINGS_STORAGE_KEY = "autoTakeoverSettings";
const CUSTOM_THEME_CARD_ID = "custom-theme-card";
const THEME_PRESETS = Object.freeze([
  {
    id: "graphite-gray",
    name: "石墨灰",
    color: "#121212",
    description: "默认推荐，低眩光"
  },
  {
    id: "midnight-black",
    name: "极夜黑",
    color: "#000000",
    description: "最高对比，聚焦正文"
  },
  {
    id: "deep-sea-blue",
    name: "深海蓝",
    color: "#0f172a",
    description: "冷静理性，适合长读"
  },
  {
    id: "pine-ink-green",
    name: "松林墨绿",
    color: "#102017",
    description: "缓解疲劳，夜读友好"
  },
  {
    id: "warm-umber-night",
    name: "暖褐夜读",
    color: "#1e1812",
    description: "纸感柔和，舒缓视觉"
  }
]);

const PRESET_ID_SET = new Set(THEME_PRESETS.map(item => item.id));
const DEFAULT_SETTINGS = {
  autoTakeoverEnabled: true,
  autoOutlineAutoFitEnabled: true,
  themeMode: "preset",
  themePresetId: "graphite-gray",
  customThemeColor: "#121212",
  whitelist: [],
  blacklist: []
};

const els = {
  autoTakeoverEnabled: document.getElementById("autoTakeoverEnabled"),
  autoOutlineAutoFitEnabled: document.getElementById("autoOutlineAutoFitEnabled"),
  themePresetList: document.getElementById("themePresetList"),
  customThemeDropdown: document.getElementById("customThemeDropdown"),
  customColorPicker: document.getElementById("customColorPicker"),
  customRInput: document.getElementById("customRInput"),
  customGInput: document.getElementById("customGInput"),
  customBInput: document.getElementById("customBInput"),
  customHexInput: document.getElementById("customHexInput"),
  whitelistInput: document.getElementById("whitelistInput"),
  blacklistInput: document.getElementById("blacklistInput"),
  saveBtn: document.getElementById("saveBtn"),
  resetBtn: document.getElementById("resetBtn"),
  statusText: document.getElementById("statusText")
};

const themeState = {
  mode: DEFAULT_SETTINGS.themeMode,
  presetId: DEFAULT_SETTINGS.themePresetId,
  customColor: DEFAULT_SETTINGS.customThemeColor
};

init();

function init() {
  renderThemePresets();
  bindThemeEvents();

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

function renderThemePresets() {
  els.themePresetList.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const preset of THEME_PRESETS) {
    fragment.appendChild(
      createThemeButton({
        mode: "preset",
        id: preset.id,
        name: preset.name,
        description: preset.description,
        color: preset.color
      })
    );
  }

  fragment.appendChild(
    createThemeButton({
      mode: "custom",
      id: CUSTOM_THEME_CARD_ID,
      name: "自定义颜色",
      description: "点击后下拉编辑 RGB / HEX / 色板",
      color: themeState.customColor,
      withCaret: true
    })
  );

  els.themePresetList.appendChild(fragment);
}

function createThemeButton({ mode, id, name, description, color, withCaret = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "theme-preset";
  button.dataset.themeMode = mode;
  button.dataset.themePresetId = id;
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", "false");

  const dot = document.createElement("span");
  dot.className = "theme-dot";
  dot.style.background = color;
  if (mode === "custom") {
    dot.id = "customThemeDot";
  }

  const meta = document.createElement("span");
  meta.className = "theme-meta";

  const title = document.createElement("span");
  title.className = "theme-name";
  title.textContent = name;

  const text = document.createElement("span");
  text.className = "theme-desc";
  text.textContent = description;

  const caret = document.createElement("span");
  caret.className = "theme-caret";
  caret.textContent = withCaret ? "▼" : "";
  caret.setAttribute("aria-hidden", "true");

  meta.appendChild(title);
  meta.appendChild(text);
  button.appendChild(dot);
  button.appendChild(meta);
  button.appendChild(caret);

  button.addEventListener("click", () => {
    themeState.mode = mode;
    if (mode === "preset") {
      themeState.presetId = id;
    }
    updateThemeControls();
  });

  return button;
}

function bindThemeEvents() {
  els.customColorPicker.addEventListener("input", () => {
    setCustomColor(els.customColorPicker.value, true);
  });

  const onRgbInput = () => {
    const rgb = {
      r: clampByte(els.customRInput.value),
      g: clampByte(els.customGInput.value),
      b: clampByte(els.customBInput.value)
    };
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    setCustomColor(hex, true);
  };
  els.customRInput.addEventListener("input", onRgbInput);
  els.customGInput.addEventListener("input", onRgbInput);
  els.customBInput.addEventListener("input", onRgbInput);

  els.customHexInput.addEventListener("change", () => {
    const normalized = normalizeHexColor(els.customHexInput.value);
    if (!normalized) {
      els.customHexInput.value = themeState.customColor;
      return;
    }
    setCustomColor(normalized, true);
  });
}

async function loadSettings() {
  const settings = await getStoredSettings();
  applySettingsToForm(settings);
}

function applySettingsToForm(settings) {
  const normalized = normalizeSettings(settings);
  els.autoTakeoverEnabled.checked = normalized.autoTakeoverEnabled;
  els.autoOutlineAutoFitEnabled.checked = normalized.autoOutlineAutoFitEnabled;
  els.whitelistInput.value = normalized.whitelist.join("\n");
  els.blacklistInput.value = normalized.blacklist.join("\n");

  themeState.mode = normalized.themeMode;
  themeState.presetId = normalized.themePresetId;
  themeState.customColor = normalized.customThemeColor;
  updateThemeControls();
}

function updateThemeControls() {
  const presetButtons = Array.from(els.themePresetList.querySelectorAll(".theme-preset"));
  for (const button of presetButtons) {
    const mode = button.dataset.themeMode;
    const selected =
      mode === "custom"
        ? themeState.mode === "custom"
        : themeState.mode === "preset" && button.dataset.themePresetId === themeState.presetId;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-checked", selected ? "true" : "false");
  }

  const rgb = hexToRgb(themeState.customColor);
  els.customColorPicker.value = themeState.customColor;
  els.customHexInput.value = themeState.customColor;
  els.customRInput.value = String(rgb.r);
  els.customGInput.value = String(rgb.g);
  els.customBInput.value = String(rgb.b);

  const customDot = document.getElementById("customThemeDot");
  if (customDot) {
    customDot.style.background = themeState.customColor;
  }
  setCustomDropdownVisibility(themeState.mode === "custom");
}

function setCustomColor(color, activateCustomMode) {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return;
  }
  themeState.customColor = normalized;
  if (activateCustomMode) {
    themeState.mode = "custom";
  }
  updateThemeControls();
}

function setCustomDropdownVisibility(visible) {
  els.customThemeDropdown.hidden = !visible;
}

async function saveSettings() {
  const next = normalizeSettings({
    autoTakeoverEnabled: els.autoTakeoverEnabled.checked,
    autoOutlineAutoFitEnabled: els.autoOutlineAutoFitEnabled.checked,
    themeMode: themeState.mode,
    themePresetId: themeState.presetId,
    customThemeColor: themeState.customColor,
    whitelist: normalizeRuleList(els.whitelistInput.value),
    blacklist: normalizeRuleList(els.blacklistInput.value)
  });

  await storageSet(SETTINGS_STORAGE_KEY, next);
  await requestBootstrap();
  applySettingsToForm(next);
  showStatus("设置已保存。", "ok");
}

function normalizeSettings(raw) {
  return {
    autoTakeoverEnabled: raw?.autoTakeoverEnabled !== false,
    autoOutlineAutoFitEnabled: raw?.autoOutlineAutoFitEnabled !== false,
    themeMode: normalizeThemeMode(raw?.themeMode),
    themePresetId: normalizeThemePresetId(raw?.themePresetId),
    customThemeColor: normalizeHexColor(raw?.customThemeColor) || DEFAULT_SETTINGS.customThemeColor,
    whitelist: normalizeRuleList(raw?.whitelist),
    blacklist: normalizeRuleList(raw?.blacklist)
  };
}

function normalizeThemeMode(value) {
  return value === "custom" ? "custom" : "preset";
}

function normalizeThemePresetId(value) {
  const id = String(value || "").trim().toLowerCase();
  return PRESET_ID_SET.has(id) ? id : DEFAULT_SETTINGS.themePresetId;
}

function normalizeRuleList(rawText) {
  const set = new Set();
  const lines = Array.isArray(rawText)
    ? rawText.map(item => String(item || "").trim()).filter(Boolean)
    : String(rawText || "")
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

function normalizeHexColor(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1]}` : null;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex) || DEFAULT_SETTINGS.customThemeColor;
  const value = normalized.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function rgbToHex(r, g, b) {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function toHexByte(value) {
  return clampByte(value).toString(16).padStart(2, "0");
}

function clampByte(value) {
  const numeric = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(255, Math.max(0, numeric));
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
  return normalizeSettings(stored || DEFAULT_SETTINGS);
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
