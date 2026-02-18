"use strict";

const VIEWER_PATH = "src/viewer/viewer.html";
const SETTINGS_STORAGE_KEY = "autoTakeoverSettings";
const MENU_OPEN_LINK_ID = "open-link-pdf";
const MENU_OPEN_CURRENT_ID = "open-current-pdf";
const MAX_COLLECTED_CANDIDATES = 40;
const MAX_VERIFICATION_CANDIDATES = 16;
const AUTO_HINT_DURATION_MS = 5000;
const REDIRECT_TTL_MS = 8000;
const AUTO_REDIRECT_MAX_ATTEMPTS = 3;
const AUTO_RULE_IDS = [1001, 1002];
const IS_EDGE = /\bEdg\//i.test(globalThis.navigator?.userAgent || "");
const DEFAULT_THEME_MODE = "preset";
const DEFAULT_THEME_PRESET_ID = "graphite-gray";
const DEFAULT_CUSTOM_THEME_COLOR = "#121212";
const PRESET_THEME_IDS = new Set([
  "graphite-gray",
  "midnight-black",
  "deep-sea-blue",
  "pine-ink-green",
  "warm-umber-night"
]);

const DEFAULT_SETTINGS = Object.freeze({
  autoTakeoverEnabled: true,
  autoOutlineAutoFitEnabled: true,
  themeMode: DEFAULT_THEME_MODE,
  themePresetId: DEFAULT_THEME_PRESET_ID,
  customThemeColor: DEFAULT_CUSTOM_THEME_COLOR,
  whitelist: [],
  blacklist: []
});

let settingsCache = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;
const recentRedirects = new Map();
const badgeTimers = new Map();
const pendingAutoChecks = new Map();
const pendingAutoRedirects = new Map();
const lastNonPdfPageByTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  bootstrapStateBestEffort();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapStateBestEffort();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_STORAGE_KEY]) {
    return;
  }
  settingsCache = normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue || DEFAULT_SETTINGS);
  settingsLoaded = true;
  void syncAutoTakeoverRules();
});

chrome.action.onClicked.addListener(tab => {
  void handleActionClick(tab);
});

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleContextMenuClick(info, tab);
  });
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(tabId => {
    recentRedirects.delete(tabId);
    clearBadgeHint(tabId);
    pendingAutoChecks.delete(tabId);
    pendingAutoRedirects.delete(tabId);
    lastNonPdfPageByTab.delete(tabId);
  });
}

if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const nonPdfCandidate = changeInfo.url || (changeInfo.status === "complete" ? tab?.url : "");
    if (isTrackableSourcePage(nonPdfCandidate)) {
      lastNonPdfPageByTab.set(tabId, nonPdfCandidate);
    }

    const candidateUrl = changeInfo.url || (changeInfo.status === "loading" ? tab?.url : "");
    if (!candidateUrl || !looksLikePdfUrl(candidateUrl)) {
      if (changeInfo.status === "complete") {
        const pending = pendingAutoRedirects.get(tabId);
        if (pending) {
          void attemptQueuedAutoRedirect(tabId, pending.url);
        }
      }
      return;
    }
    void handlePotentialPdfTabUpdate(tabId, candidateUrl);
  });
}

if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId !== 0) {
      return;
    }

    if (isTrackableSourcePage(details.url)) {
      lastNonPdfPageByTab.set(details.tabId, details.url);
      return;
    }

    if (!looksLikePdfUrl(details.url)) {
      return;
    }
    void handlePotentialPdfTabUpdate(details.tabId, details.url);
  });
}

if (chrome.webRequest?.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(
    details => {
      void handleMainFrameHeaders(details);
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"]
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "bootstrap-auto-rules") {
    return false;
  }
  bootstrapStateBestEffort()
    .then(() => {
      sendResponse({ ok: true });
    })
    .catch(error => {
      sendResponse({ ok: false, error: error?.message || "bootstrap failed" });
    });
  return true;
});

bootstrapStateBestEffort();

function bootstrapStateBestEffort() {
  return new Promise(resolve => {
    chrome.storage.local.get([SETTINGS_STORAGE_KEY], result => {
      const normalized = normalizeSettings(result[SETTINGS_STORAGE_KEY] || DEFAULT_SETTINGS);
      settingsCache = normalized;
      settingsLoaded = true;

      chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized }, () => {
        resolve();
        void syncAutoTakeoverRules();
        void recreateContextMenus();
      });
    });
  });
}

async function loadSettingsIntoCache(force) {
  if (settingsLoaded && !force) {
    return settingsCache;
  }
  const stored = await storageGet(SETTINGS_STORAGE_KEY);
  settingsCache = normalizeSettings(stored || DEFAULT_SETTINGS);
  settingsLoaded = true;
  return settingsCache;
}

async function getSettings() {
  return loadSettingsIntoCache(false);
}

function normalizeSettings(raw) {
  return {
    autoTakeoverEnabled: raw?.autoTakeoverEnabled !== false,
    autoOutlineAutoFitEnabled: raw?.autoOutlineAutoFitEnabled !== false,
    themeMode: normalizeThemeMode(raw?.themeMode),
    themePresetId: normalizeThemePresetId(raw?.themePresetId),
    customThemeColor: normalizeHexColor(raw?.customThemeColor) || DEFAULT_CUSTOM_THEME_COLOR,
    whitelist: normalizeRuleList(raw?.whitelist),
    blacklist: normalizeRuleList(raw?.blacklist)
  };
}

function normalizeThemeMode(value) {
  return value === "custom" ? "custom" : DEFAULT_THEME_MODE;
}

function normalizeThemePresetId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return PRESET_THEME_IDS.has(normalized) ? normalized : DEFAULT_THEME_PRESET_ID;
}

function normalizeHexColor(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1]}` : null;
}

function normalizeRuleList(value) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? splitRuleString(value) : [];
  const set = new Set();
  for (const item of source) {
    const normalized = normalizeRuleEntry(item);
    if (normalized) {
      set.add(normalized);
    }
  }
  return Array.from(set);
}

function splitRuleString(value) {
  return String(value || "")
    .split(/[\n,]+/g)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeRuleEntry(value) {
  if (typeof value !== "string") {
    return null;
  }
  let rule = value.trim().toLowerCase();
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

async function syncAutoTakeoverRules() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    return;
  }

  if (IS_EDGE) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: AUTO_RULE_IDS,
        addRules: []
      });
    } catch (error) {
      console.warn("Failed to clear Edge-incompatible DNR auto-takeover rules.", error);
    }
    return;
  }

  const settings = await getSettings();
  const addRules = buildAutoTakeoverRules(settings);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: AUTO_RULE_IDS,
      addRules
    });
  } catch (error) {
    console.warn("Failed to sync auto-takeover rules.", error);
  }
}

function buildAutoTakeoverRules(settings) {
  if (!settings.autoTakeoverEnabled) {
    return [];
  }

  const dnrDomains = buildDnrDomains(settings);
  if (dnrDomains.disableAll) {
    return [];
  }

  const redirectTarget = `${chrome.runtime.getURL(VIEWER_PATH)}#\\0`;
  const baseCondition = {
    resourceTypes: ["main_frame"]
  };
  if (dnrDomains.requestDomains.length > 0) {
    baseCondition.requestDomains = dnrDomains.requestDomains;
  }
  if (dnrDomains.excludedRequestDomains.length > 0) {
    baseCondition.excludedRequestDomains = dnrDomains.excludedRequestDomains;
  }

  return [
    {
      id: AUTO_RULE_IDS[0],
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution: redirectTarget
        }
      },
      condition: {
        ...baseCondition,
        regexFilter: "^https?://[^\\\\s#?]+\\\\.pdf(?:[?#].*)?$"
      }
    },
    {
      id: AUTO_RULE_IDS[1],
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution: redirectTarget
        }
      },
      condition: {
        ...baseCondition,
        regexFilter: "^https?://[^\\\\s#]*/pdf/[^\\\\s#]*$"
      }
    }
  ];
}

function buildDnrDomains(settings) {
  const blacklist = normalizeRulesForDnr(settings.blacklist);
  if (blacklist.includes("*")) {
    return {
      disableAll: true,
      requestDomains: [],
      excludedRequestDomains: []
    };
  }

  const whitelist = normalizeRulesForDnr(settings.whitelist);
  const requestDomains = whitelist.includes("*") ? [] : whitelist;
  const excludedRequestDomains = blacklist;

  return {
    disableAll: false,
    requestDomains,
    excludedRequestDomains
  };
}

function normalizeRulesForDnr(rules) {
  const set = new Set();
  for (const rule of rules) {
    if (rule === "*") {
      set.add("*");
      continue;
    }
    const domain = rule.startsWith("*.") ? rule.slice(2) : rule;
    if (/^[a-z0-9.-]+$/.test(domain)) {
      set.add(domain);
    }
  }
  return Array.from(set);
}

async function handleActionClick(tab) {
  if (!tab?.id) {
    await openLocalViewer();
    return;
  }

  const tabUrl = tab.url || "";
  const embeddedPdfUrl = resolvePdfUrlHint(tabUrl);
  if (embeddedPdfUrl) {
    await openPdfInViewer({
      tabId: tab.id,
      pdfUrl: embeddedPdfUrl,
      sourceUrl: tabUrl || embeddedPdfUrl,
      reason: "manual"
    });
    return;
  }

  if (!isSupportedWebPage(tabUrl)) {
    await openLocalViewer();
    return;
  }

  if (await isPdfUrl(tabUrl)) {
    await openPdfInViewer({
      tabId: tab.id,
      pdfUrl: tabUrl,
      sourceUrl: tabUrl,
      reason: "manual"
    });
    return;
  }

  let candidates = [];
  try {
    candidates = await collectCandidateUrls(tab.id, tabUrl);
  } catch (error) {
    console.warn("Failed to collect PDF candidates from page.", error);
    await showPageHint(tab.id, "无法自动识别该页面中的 PDF，请复制 PDF 链接到扩展中打开。");
    return;
  }

  const verifiedCandidates = await verifyPdfCandidates(candidates);
  if (!verifiedCandidates.length) {
    await showPageHint(tab.id, "未识别到可访问的 PDF 链接。请在 PDF 页面再次点击扩展图标。");
    return;
  }

  let selectedUrl = verifiedCandidates[0].url;
  if (verifiedCandidates.length > 1) {
    const pickedUrl = await promptCandidateSelection(tab.id, verifiedCandidates);
    if (!pickedUrl) {
      return;
    }
    selectedUrl = pickedUrl;
  }

  await openPdfInViewer({
    tabId: tab.id,
    pdfUrl: selectedUrl,
    sourceUrl: tabUrl,
    reason: "manual"
  });
}

async function handleContextMenuClick(info, tab) {
  if (!tab?.id) {
    return;
  }

  if (info.menuItemId === MENU_OPEN_LINK_ID) {
    const targetUrl = await resolvePdfUrlForOpen(info.linkUrl || "");
    if (!targetUrl) {
      await showBadgeHint(tab.id, "该链接不是可访问的 PDF");
      return;
    }
    await openPdfInViewer({
      tabId: tab.id,
      pdfUrl: targetUrl,
      sourceUrl: tab.url || info.pageUrl || targetUrl,
      reason: "manual",
      openInNewTab: true
    });
    return;
  }

  if (info.menuItemId === MENU_OPEN_CURRENT_ID) {
    const pageCandidate = info.pageUrl || tab.url || "";
    const targetUrl = await resolvePdfUrlForOpen(pageCandidate);
    if (!targetUrl) {
      await showBadgeHint(tab.id, "当前页面未识别到可访问的 PDF");
      return;
    }
    await openPdfInViewer({
      tabId: tab.id,
      pdfUrl: targetUrl,
      sourceUrl: pageCandidate,
      reason: "manual",
      openInNewTab: true
    });
  }
}

async function handleMainFrameHeaders(details) {
  if (!Number.isInteger(details.tabId) || details.tabId < 0) {
    return;
  }
  if (!isSupportedWebPage(details.url)) {
    return;
  }

  const isPdfByUrl = looksLikePdfUrl(details.url);
  const isPdfByHeader = hasPdfContentType(details.responseHeaders);
  if (!isPdfByUrl && !isPdfByHeader) {
    return;
  }

  if (wasRecentlyRedirected(details.tabId, details.url)) {
    return;
  }

  const settings = await getSettings();
  if (!isAutoTakeoverAllowedForUrl(details.url, settings)) {
    return;
  }

  const statusCode = Number(details.statusCode || 0);
  if (statusCode >= 400) {
    await showBadgeHint(details.tabId, `PDF 请求失败（${statusCode}），自动接管已跳过`);
    return;
  }

  const sourcePageUrl = getSourcePageUrlForTab(details.tabId, details.url) || details.url;
  const opened = await openPdfInViewer({
    tabId: details.tabId,
    pdfUrl: details.url,
    sourceUrl: sourcePageUrl,
    reason: "auto",
    openInNewTab: true,
    preserveSourceTab: true
  });

  if (!opened) {
    queueAutoRedirect(details.tabId, details.url, sourcePageUrl);
  }
}

async function handlePotentialPdfTabUpdate(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }
  if (!isSupportedWebPage(url)) {
    return;
  }
  if (wasRecentlyRedirected(tabId, url)) {
    return;
  }

  const pending = pendingAutoChecks.get(tabId);
  if (pending === url) {
    return;
  }
  pendingAutoChecks.set(tabId, url);

  try {
    const settings = await getSettings();
    if (!isAutoTakeoverAllowedForUrl(url, settings)) {
      return;
    }
    if (!(await isPdfUrl(url))) {
      return;
    }
    const sourcePageUrl = getSourcePageUrlForTab(tabId, url) || url;
    queueAutoRedirect(tabId, url, sourcePageUrl);
  } finally {
    if (pendingAutoChecks.get(tabId) === url) {
      pendingAutoChecks.delete(tabId);
    }
  }
}

function queueAutoRedirect(tabId, url, sourceUrl) {
  const pending = pendingAutoRedirects.get(tabId);
  if (pending?.url === url) {
    if (!pending.sourceUrl && sourceUrl) {
      pending.sourceUrl = sourceUrl;
      pendingAutoRedirects.set(tabId, pending);
    }
    return;
  }
  pendingAutoRedirects.set(tabId, {
    url,
    sourceUrl: normalizeHttpUrl(sourceUrl) || "",
    attempts: 0
  });
  void attemptQueuedAutoRedirect(tabId, url);
}

async function attemptQueuedAutoRedirect(tabId, url) {
  const pending = pendingAutoRedirects.get(tabId);
  if (!pending || pending.url !== url) {
    return;
  }

  const opened = await openPdfInViewer({
    tabId,
    pdfUrl: url,
    sourceUrl: pending.sourceUrl || url,
    reason: "auto",
    openInNewTab: true,
    preserveSourceTab: true
  });

  if (opened) {
    pendingAutoRedirects.delete(tabId);
    return;
  }

  pending.attempts += 1;
  if (pending.attempts >= AUTO_REDIRECT_MAX_ATTEMPTS) {
    pendingAutoRedirects.delete(tabId);
    await showBadgeHint(tabId, "自动接管失败，已保留当前页面");
  } else {
    pendingAutoRedirects.set(tabId, pending);
  }
}

function hasPdfContentType(responseHeaders) {
  if (!Array.isArray(responseHeaders)) {
    return false;
  }
  for (const header of responseHeaders) {
    if (!header?.name) {
      continue;
    }
    if (header.name.toLowerCase() !== "content-type") {
      continue;
    }
    const value = String(header.value || "").toLowerCase();
    if (value.includes("application/pdf")) {
      return true;
    }
  }
  return false;
}

function isAutoTakeoverAllowedForUrl(url, settings) {
  if (!settings.autoTakeoverEnabled) {
    return false;
  }

  const host = getHostFromUrl(url);
  if (!host) {
    return false;
  }

  if (matchesAnyRule(host, settings.blacklist)) {
    return false;
  }

  if (settings.whitelist.length > 0) {
    return matchesAnyRule(host, settings.whitelist);
  }

  return true;
}

function getHostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (error) {
    return null;
  }
}

function matchesAnyRule(host, rules) {
  for (const rule of rules) {
    if (hostMatchesRule(host, rule)) {
      return true;
    }
  }
  return false;
}

function hostMatchesRule(host, rule) {
  if (!rule) {
    return false;
  }
  if (rule === "*") {
    return true;
  }

  if (rule.startsWith("*.")) {
    const domain = rule.slice(2);
    return host === domain || host.endsWith(`.${domain}`);
  }

  return host === rule || host.endsWith(`.${rule}`);
}

function markRecentRedirect(tabId, url) {
  recentRedirects.set(tabId, {
    url,
    at: Date.now()
  });
}

function wasRecentlyRedirected(tabId, url) {
  const item = recentRedirects.get(tabId);
  if (!item) {
    return false;
  }
  if (Date.now() - item.at > REDIRECT_TTL_MS) {
    recentRedirects.delete(tabId);
    return false;
  }
  return item.url === url;
}

async function openLocalViewer() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(VIEWER_PATH)
  });
}

async function openPdfInViewer({ tabId, pdfUrl, sourceUrl, reason, openInNewTab = false, preserveSourceTab = false }) {
  const normalizedPdfUrl = normalizeHttpUrl(pdfUrl);
  if (!normalizedPdfUrl) {
    if (tabId) {
      await showBadgeHint(tabId, "链接无效，无法通过插件打开");
    }
    return false;
  }

  const normalizedSource = normalizeHttpUrl(sourceUrl) || normalizedPdfUrl;
  const viewerUrl = buildViewerUrl({
    pdfUrl: normalizedPdfUrl,
    sourceUrl: normalizedSource
  });

  try {
    if (reason === "auto" && Number.isInteger(tabId)) {
      markRecentRedirect(tabId, normalizedPdfUrl);
    }

    if (openInNewTab || !Number.isInteger(tabId)) {
      await chrome.tabs.create({ url: viewerUrl });
      if (reason === "auto" && preserveSourceTab && Number.isInteger(tabId)) {
        void restoreSourceTabAfterAutoOpen(tabId, normalizedPdfUrl);
      }
      return true;
    }

    if (Number.isInteger(tabId)) {
      await chrome.tabs.update(tabId, { url: viewerUrl });
      if (reason === "auto" && !(await confirmTabRedirect(tabId))) {
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn("Failed to open viewer tab.", error);
    return false;
  }
}

async function restoreSourceTabAfterAutoOpen(tabId, pdfUrl) {
  let sourceTab = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      sourceTab = await chrome.tabs.get(tabId);
    } catch (error) {
      return;
    }
    const currentUrl = sourceTab?.url || "";
    if (currentUrl && looksLikePdfUrl(currentUrl)) {
      break;
    }
    if (attempt < 11) {
      await sleep(140);
    }
  }

  const currentUrl = sourceTab?.url || "";
  if (!currentUrl || !looksLikePdfUrl(currentUrl)) {
    return;
  }

  const sourcePageUrl = getSourcePageUrlForTab(tabId, pdfUrl);

  if (chrome.tabs?.goBack) {
    try {
      await chrome.tabs.goBack(tabId);
      return;
    } catch (error) {
      // Ignore no-history / non-navigable cases.
    }
  }

  if (sourcePageUrl) {
    try {
      await chrome.tabs.update(tabId, { url: sourcePageUrl });
      return;
    } catch (error) {
      // Ignore update failures and fallback to tab close when possible.
    }
  }

  if (Number.isInteger(sourceTab?.openerTabId)) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      // Ignore removal failures.
    }
  }
}

async function confirmTabRedirect(tabId) {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await sleep(120);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      return false;
    }
    const currentUrl = tab?.url || "";
    if (currentUrl.startsWith(chrome.runtime.getURL(VIEWER_PATH))) {
      return true;
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function buildViewerUrl({ pdfUrl, sourceUrl }) {
  const params = new URLSearchParams();
  params.set("url", pdfUrl);
  if (sourceUrl) {
    params.set("from", sourceUrl);
  }
  return `${chrome.runtime.getURL(VIEWER_PATH)}?${params.toString()}`;
}

function isSupportedWebPage(url) {
  return /^https?:\/\//i.test(url);
}

function isTrackableSourcePage(url) {
  return isSupportedWebPage(url) && !looksLikePdfUrl(url);
}

function getSourcePageUrlForTab(tabId, pdfUrl) {
  if (!Number.isInteger(tabId)) {
    return null;
  }
  const sourceUrl = normalizeHttpUrl(lastNonPdfPageByTab.get(tabId));
  if (!sourceUrl) {
    return null;
  }
  if (sourceUrl === normalizeHttpUrl(pdfUrl)) {
    return null;
  }
  return sourceUrl;
}

async function collectCandidateUrls(tabId, tabUrl) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPdfCandidatesFromPage,
    args: [MAX_COLLECTED_CANDIDATES]
  });
  const [firstResult] = injected;
  const pageCandidates = Array.isArray(firstResult?.result) ? firstResult.result : [];
  pageCandidates.push({
    url: tabUrl,
    source: "current",
    label: "当前页面",
    score: 120
  });

  const merged = new Map();
  for (const candidate of pageCandidates) {
    const normalizedUrl = normalizeHttpUrl(candidate?.url);
    if (!normalizedUrl) {
      continue;
    }

    const existing = merged.get(normalizedUrl);
    const next = {
      url: normalizedUrl,
      source: String(candidate?.source || "link"),
      label: normalizeLabel(candidate?.label, normalizedUrl),
      score: Number(candidate?.score) || 0
    };

    if (!existing || next.score > existing.score) {
      merged.set(normalizedUrl, next);
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_VERIFICATION_CANDIDATES);
}

async function verifyPdfCandidates(candidates) {
  const checks = await Promise.all(
    candidates.map(async candidate => {
      const isPdf = await isPdfUrl(candidate.url);
      return isPdf ? candidate : null;
    })
  );
  return checks.filter(Boolean);
}

async function isPdfUrl(url) {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) {
    return false;
  }

  if (looksLikePdfUrl(normalized)) {
    return true;
  }

  const headResult = await probeContentType(normalized);
  return headResult.isPdf;
}

async function probeContentType(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "HEAD",
      redirect: "follow",
      cache: "no-store"
    });

    const contentType = response.headers.get("content-type") || "";
    const isPdf = contentType.toLowerCase().includes("application/pdf");
    return {
      isPdf,
      status: response.status
    };
  } catch (error) {
    return {
      isPdf: false,
      status: 0
    };
  }
}

function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function looksLikePdfUrl(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
    if (/\.pdf(?:$|[?#])/i.test(path)) {
      return true;
    }
    return /\/pdf(?:\/|$)/i.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

async function resolvePdfUrlForOpen(rawUrl) {
  const hintedUrl = resolvePdfUrlHint(rawUrl);
  if (hintedUrl) {
    return hintedUrl;
  }

  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) {
    return null;
  }
  if (await isPdfUrl(normalized)) {
    return normalized;
  }
  return null;
}

function resolvePdfUrlHint(rawUrl) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (normalized && looksLikePdfUrl(normalized)) {
    return normalized;
  }
  return extractEmbeddedPdfUrl(rawUrl);
}

function extractEmbeddedPdfUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (error) {
    return null;
  }

  const candidates = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const loweredKey = key.toLowerCase();
    const loweredValue = String(value || "").toLowerCase();
    if (loweredKey === "file" || loweredKey === "src" || loweredKey === "url" || loweredValue.includes(".pdf")) {
      candidates.push(value);
    }
  }

  const hashValue = parsed.hash.replace(/^#/, "").trim();
  if (hashValue) {
    candidates.push(hashValue);
  }

  for (const candidate of candidates) {
    const normalizedCandidate = decodeWrappedHttpUrl(candidate);
    if (normalizedCandidate && looksLikePdfUrl(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }

  return null;
}

function decodeWrappedHttpUrl(rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }

  for (let index = 0; index < 3; index += 1) {
    const normalized = normalizeHttpUrl(value);
    if (normalized) {
      return normalized;
    }

    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch (error) {
      break;
    }
    if (decoded === value) {
      break;
    }
    value = decoded.trim();
  }

  const match = value.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? normalizeHttpUrl(match[0]) : null;
}

async function promptCandidateSelection(tabId, candidates) {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: showCandidatePickerInPage,
      args: [candidates]
    });
    const [firstResult] = injected;
    return typeof firstResult?.result === "string" ? firstResult.result : null;
  } catch (error) {
    console.warn("Failed to show candidate picker, fallback to first candidate.", error);
    return candidates[0]?.url || null;
  }
}

async function showPageHint(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showHintInPage,
      args: [message]
    });
  } catch (error) {
    await showBadgeHint(tabId, message);
  }
}

async function showBadgeHint(tabId, message) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  clearBadgeHint(tabId);

  try {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: "#5f6670"
    });
    await chrome.action.setBadgeText({
      tabId,
      text: "!"
    });
    await chrome.action.setTitle({
      tabId,
      title: `Dark PDF Reader: ${message}`
    });
  } catch (error) {
    return;
  }

  const timer = setTimeout(() => {
    clearBadgeHint(tabId);
  }, AUTO_HINT_DURATION_MS);
  badgeTimers.set(tabId, timer);
}

function clearBadgeHint(tabId) {
  const timer = badgeTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    badgeTimers.delete(tabId);
  }

  try {
    chrome.action.setBadgeText({
      tabId,
      text: ""
    });
  } catch (error) {
    // Ignore errors when tab is gone.
  }
}

async function recreateContextMenus() {
  await removeAllContextMenus();
  await createContextMenu({
    id: MENU_OPEN_LINK_ID,
    title: "使用 Dark PDF Reader 打开链接 PDF",
    contexts: ["link"],
    visible: true
  });
  await createContextMenu({
    id: MENU_OPEN_CURRENT_ID,
    title: "使用 Dark PDF Reader 打开当前 PDF",
    contexts: ["page"],
    visible: true
  });
}

function removeAllContextMenus() {
  return new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      resolve();
    });
  });
}

function createContextMenu(options) {
  return new Promise(resolve => {
    try {
      chrome.contextMenus.create(options, () => {
        resolve();
      });
    } catch (error) {
      resolve();
    }
  });
}

function updateContextMenu(menuId, props) {
  return new Promise(resolve => {
    try {
      chrome.contextMenus.update(menuId, props, () => {
        resolve();
      });
    } catch (error) {
      resolve();
    }
  });
}

function normalizeLabel(value, fallbackUrl) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized) {
    return normalized.slice(0, 120);
  }
  return fallbackUrl;
}

function normalizeHttpUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!/^https?:$/i.test(url.protocol)) {
      return null;
    }
    return url.href;
  } catch (error) {
    return null;
  }
}

function storageGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get([key], result => {
      resolve(result[key]);
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

function extractPdfCandidatesFromPage(limit) {
  const maxCount = Math.max(5, Math.min(Number(limit) || 40, 80));
  const byUrl = new Map();

  const normalize = raw => {
    try {
      const normalized = new URL(raw, window.location.href);
      if (!/^https?:$/i.test(normalized.protocol)) {
        return null;
      }
      return normalized.href;
    } catch (error) {
      return null;
    }
  };

  const addCandidate = (rawUrl, source, label, score) => {
    const normalizedUrl = normalize(rawUrl);
    if (!normalizedUrl) {
      return;
    }
    const next = {
      url: normalizedUrl,
      source,
      label: String(label || normalizedUrl).trim().slice(0, 120),
      score: Number(score) || 0
    };
    const existing = byUrl.get(normalizedUrl);
    if (!existing || next.score > existing.score) {
      byUrl.set(normalizedUrl, next);
    }
  };

  addCandidate(window.location.href, "current", document.title || "当前页面", 100);

  const linkElements = Array.from(document.querySelectorAll("a[href]")).slice(0, 1200);
  for (const link of linkElements) {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
      continue;
    }
    const text = (link.textContent || link.title || "").replace(/\s+/g, " ").trim();
    const hint = `${href} ${text} ${link.type || ""}`.toLowerCase();
    const likelyPdf =
      hint.includes(".pdf") || hint.includes("/pdf/") || hint.includes("application/pdf") || hint.includes(" pdf");
    if (!likelyPdf) {
      continue;
    }
    const score = hint.includes(".pdf") ? 80 : 50;
    addCandidate(href, "link", text || href, score);
    if (byUrl.size >= maxCount) {
      break;
    }
  }

  const embedElements = Array.from(document.querySelectorAll("iframe[src], embed[src], object[data]")).slice(0, 100);
  for (const element of embedElements) {
    const src = element.getAttribute("src") || element.getAttribute("data");
    if (!src) {
      continue;
    }
    const name = (element.getAttribute("title") || element.getAttribute("name") || "").trim();
    const hint = `${src} ${element.getAttribute("type") || ""}`.toLowerCase();
    const score =
      hint.includes(".pdf") || hint.includes("/pdf/") || hint.includes("application/pdf") ? 95 : 65;
    addCandidate(src, "embed", name || src, score);
    if (byUrl.size >= maxCount) {
      break;
    }
  }

  return Array.from(byUrl.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, maxCount);
}

function showCandidatePickerInPage(candidates) {
  const rootId = "__dark_pdf_reader_picker_root__";
  const existing = document.getElementById(rootId);
  if (existing) {
    existing.remove();
  }

  return new Promise(resolve => {
    const cleanup = value => {
      document.removeEventListener("keydown", onKeyDown, true);
      root.remove();
      resolve(value || null);
    };

    const root = document.createElement("div");
    root.id = rootId;
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.background = "rgba(0, 0, 0, 0.62)";
    root.style.zIndex = "2147483647";
    root.style.display = "flex";
    root.style.alignItems = "center";
    root.style.justifyContent = "center";
    root.style.fontFamily = "IBM Plex Sans, Segoe UI, sans-serif";

    const panel = document.createElement("div");
    panel.style.width = "min(720px, calc(100vw - 32px))";
    panel.style.maxHeight = "min(640px, calc(100vh - 32px))";
    panel.style.overflow = "auto";
    panel.style.background = "#111111";
    panel.style.color = "#f1f1f1";
    panel.style.border = "1px solid rgba(149, 149, 149, 0.34)";
    panel.style.borderRadius = "12px";
    panel.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.45)";
    panel.style.padding = "16px";

    const title = document.createElement("h2");
    title.textContent = "选择要打开的 PDF";
    title.style.margin = "0 0 6px";
    title.style.fontSize = "20px";

    const subtitle = document.createElement("p");
    subtitle.textContent = "检测到多个 PDF 候选链接，请选择一个。";
    subtitle.style.margin = "0 0 12px";
    subtitle.style.color = "#a8a8a8";
    subtitle.style.fontSize = "14px";

    const list = document.createElement("div");
    list.style.display = "grid";
    list.style.gap = "8px";

    candidates.forEach((candidate, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.style.textAlign = "left";
      row.style.padding = "10px 12px";
      row.style.border = "1px solid rgba(150, 150, 150, 0.42)";
      row.style.borderRadius = "10px";
      row.style.background = "#1a1a1a";
      row.style.color = "#f1f1f1";
      row.style.cursor = "pointer";
      row.style.display = "grid";
      row.style.gap = "4px";

      const main = document.createElement("div");
      main.textContent = `${index + 1}. ${candidate.label || candidate.url}`;
      main.style.fontWeight = "600";
      main.style.fontSize = "14px";

      const detail = document.createElement("div");
      detail.textContent = `${candidate.source || "link"} | ${candidate.url}`;
      detail.style.fontSize = "12px";
      detail.style.color = "#a8a8a8";
      detail.style.wordBreak = "break-all";

      row.addEventListener("click", () => cleanup(candidate.url));
      row.appendChild(main);
      row.appendChild(detail);
      list.appendChild(row);
    });

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "12px";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "取消";
    cancelButton.style.border = "1px solid rgba(150, 150, 150, 0.42)";
    cancelButton.style.background = "#1a1a1a";
    cancelButton.style.color = "#f1f1f1";
    cancelButton.style.borderRadius = "8px";
    cancelButton.style.padding = "8px 12px";
    cancelButton.style.cursor = "pointer";
    cancelButton.addEventListener("click", () => cleanup(null));

    actions.appendChild(cancelButton);
    panel.appendChild(title);
    panel.appendChild(subtitle);
    panel.appendChild(list);
    panel.appendChild(actions);
    root.appendChild(panel);
    document.documentElement.appendChild(root);

    root.addEventListener("click", event => {
      if (event.target === root) {
        cleanup(null);
      }
    });

    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
      }
      if (event.key >= "1" && event.key <= "9") {
        const index = Number.parseInt(event.key, 10) - 1;
        if (candidates[index]) {
          event.preventDefault();
          cleanup(candidates[index].url);
        }
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
  });
}

function showHintInPage(message) {
  const toastId = "__dark_pdf_reader_hint__";
  const old = document.getElementById(toastId);
  if (old) {
    old.remove();
  }

  const toast = document.createElement("div");
  toast.id = toastId;
  toast.textContent = String(message || "");
  toast.style.position = "fixed";
  toast.style.top = "18px";
  toast.style.right = "18px";
  toast.style.maxWidth = "420px";
  toast.style.padding = "10px 12px";
  toast.style.color = "#ececec";
  toast.style.background = "#111111";
  toast.style.border = "1px solid rgba(148, 148, 148, 0.46)";
  toast.style.borderRadius = "10px";
  toast.style.zIndex = "2147483647";
  toast.style.font = "13px/1.4 IBM Plex Sans, Segoe UI, sans-serif";
  toast.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.45)";

  document.documentElement.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4500);
}
