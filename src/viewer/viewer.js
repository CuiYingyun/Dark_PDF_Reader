"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "../../vendor/pdfjs/build/pdf.worker.js";

const DEFAULT_SCALE_VALUE = "page-width";
const STORAGE_PREFIX = "dark-pdf-reader:";
const SETTINGS_STORAGE_KEY = "autoTakeoverSettings";
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.1;
const REMOTE_SOURCE_LABEL = "网页 PDF";
const DEFAULT_VIEWER_SETTINGS = Object.freeze({
  autoOutlineAutoFitEnabled: true,
  themeMode: "preset",
  themePresetId: "graphite-gray",
  customThemeColor: "#121212"
});
const THEME_PRESETS = Object.freeze({
  "graphite-gray": "#121212",
  "midnight-black": "#000000",
  "deep-sea-blue": "#0f172a",
  "pine-ink-green": "#102017",
  "warm-umber-night": "#1e1812"
});

const els = {
  openFileBtn: document.getElementById("openFileBtn"),
  returnSourceBtn: document.getElementById("returnSourceBtn"),
  fileInput: document.getElementById("fileInput"),
  fileName: document.getElementById("fileName"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageNumberInput: document.getElementById("pageNumberInput"),
  pageCountLabel: document.getElementById("pageCountLabel"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomSelect: document.getElementById("zoomSelect"),
  customZoomOption: document.getElementById("customZoomOption"),
  searchInput: document.getElementById("searchInput"),
  searchPrevBtn: document.getElementById("searchPrevBtn"),
  searchNextBtn: document.getElementById("searchNextBtn"),
  searchResult: document.getElementById("searchResult"),
  colorToggleBtn: document.getElementById("colorToggleBtn"),
  optionsBtn: document.getElementById("optionsBtn"),
  outlineToggleBtn: document.getElementById("outlineToggleBtn"),
  outlinePanel: document.getElementById("outlinePanel"),
  outlineContainer: document.getElementById("outlineContainer"),
  viewerSection: document.getElementById("viewerSection"),
  viewerContainer: document.getElementById("viewerContainer"),
  viewer: document.getElementById("viewer"),
  errorBanner: document.getElementById("errorBanner"),
  errorMessage: document.getElementById("errorMessage"),
  errorActionLink: document.getElementById("errorActionLink"),
  errorCloseBtn: document.getElementById("errorCloseBtn"),
  passwordDialogBackdrop: document.getElementById("passwordDialogBackdrop"),
  passwordPrompt: document.getElementById("passwordPrompt"),
  passwordInput: document.getElementById("passwordInput"),
  passwordCancelBtn: document.getElementById("passwordCancelBtn"),
  passwordConfirmBtn: document.getElementById("passwordConfirmBtn")
};

const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container: els.viewerContainer,
  viewer: els.viewer,
  eventBus,
  linkService,
  findController,
  removePageBorders: false,
  imageResourcesPath: "../../vendor/pdfjs/web/images/"
});

linkService.setViewer(pdfViewer);

let currentLoadingTask = null;
let currentDocument = null;
let currentObjectUrl = null;
let currentStorageKey = null;
let currentScaleSetting = DEFAULT_SCALE_VALUE;
let saveStateTimer = null;
let searchDebounceTimer = null;
let openToken = 0;
let pendingPasswordUpdate = null;
let passwordCancelledLoad = false;
let returnSourceUrl = null;
let autoOutlineAutoFitEnabled = DEFAULT_VIEWER_SETTINGS.autoOutlineAutoFitEnabled;
let outlineAutoFitTimer = null;
let outlineAutoFitVersion = 0;
let currentThemeMode = DEFAULT_VIEWER_SETTINGS.themeMode;
let currentThemePresetId = DEFAULT_VIEWER_SETTINGS.themePresetId;
let currentCustomThemeColor = DEFAULT_VIEWER_SETTINGS.customThemeColor;
let colorEnhancementEnabled = true;

init();

function init() {
  bootstrapAutoRules();
  bindUiEvents();
  bindViewerEvents();
  clearOutline();
  updatePageControls(1, 0);
  updateZoomUi({ scale: 1, presetValue: DEFAULT_SCALE_VALUE });
  applyThemeTint(DEFAULT_VIEWER_SETTINGS.customThemeColor);
  applyColorEnhancementState();
  bindSettingsEvents();
  void initializeViewerState();
}

async function initializeViewerState() {
  await loadViewerSettings();
  applyLaunchContext();
}

function bootstrapAutoRules() {
  try {
    chrome.runtime.sendMessage({ type: "bootstrap-auto-rules" }, () => {
      // Best-effort bootstrap; ignore response/errors.
    });
  } catch (error) {
    // Ignore bootstrap errors.
  }
}

function applyLaunchContext() {
  const params = new URLSearchParams(window.location.search);
  const sourceUrlParam = params.get("from");
  const hashSource = normalizeHttpUrl(window.location.hash.replace(/^#/, ""));
  returnSourceUrl = normalizeHttpUrl(sourceUrlParam) || hashSource;
  els.returnSourceBtn.hidden = !returnSourceUrl;

  const remotePdfParam = params.get("url");
  const remotePdfUrl = normalizeHttpUrl(remotePdfParam) || hashSource;
  if (!remotePdfUrl) {
    return;
  }

  void openRemotePdf(remotePdfUrl);
}

function bindUiEvents() {
  els.openFileBtn.addEventListener("click", () => els.fileInput.click());
  els.returnSourceBtn.addEventListener("click", () => {
    if (returnSourceUrl) {
      window.location.href = returnSourceUrl;
    }
  });

  els.fileInput.addEventListener("change", async () => {
    const [file] = els.fileInput.files || [];
    els.fileInput.value = "";
    if (!file) {
      return;
    }
    await openLocalPdf(file);
  });

  els.prevPageBtn.addEventListener("click", () => {
    if (!currentDocument) {
      return;
    }
    pdfViewer.currentPageNumber = clamp(pdfViewer.currentPageNumber - 1, 1, currentDocument.numPages);
  });

  els.nextPageBtn.addEventListener("click", () => {
    if (!currentDocument) {
      return;
    }
    pdfViewer.currentPageNumber = clamp(pdfViewer.currentPageNumber + 1, 1, currentDocument.numPages);
  });

  els.pageNumberInput.addEventListener("change", () => {
    jumpToPage(els.pageNumberInput.value);
  });

  els.zoomOutBtn.addEventListener("click", () => adjustZoom(1 / SCALE_STEP));
  els.zoomInBtn.addEventListener("click", () => adjustZoom(SCALE_STEP));

  els.zoomSelect.addEventListener("change", () => {
    if (!currentDocument) {
      return;
    }
    const value = els.zoomSelect.value;
    if (value === "page-width" || value === "page-fit") {
      pdfViewer.currentScaleValue = value;
      return;
    }
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric)) {
      return;
    }
    pdfViewer.currentScaleValue = String(clamp(numeric, MIN_SCALE, MAX_SCALE));
  });

  els.searchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    runFind({ type: "again", findPrevious: event.shiftKey });
  });

  els.searchInput.addEventListener("input", () => {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = setTimeout(() => {
      runFind({ type: "" });
    }, 200);
  });

  els.searchPrevBtn.addEventListener("click", () => runFind({ type: "again", findPrevious: true }));
  els.searchNextBtn.addEventListener("click", () => runFind({ type: "again", findPrevious: false }));

  els.optionsBtn.addEventListener("click", () => {
    if (chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });

  els.colorToggleBtn.addEventListener("click", () => {
    colorEnhancementEnabled = !colorEnhancementEnabled;
    applyColorEnhancementState();
  });

  els.outlineToggleBtn.addEventListener("click", () => {
    els.outlinePanel.classList.toggle("collapsed");
  });

  els.errorCloseBtn.addEventListener("click", () => clearError());

  els.passwordCancelBtn.addEventListener("click", () => {
    closePasswordDialog();
    if (currentLoadingTask) {
      passwordCancelledLoad = true;
      currentLoadingTask.destroy();
    }
    showError("已取消密码输入，文档未打开。");
  });

  els.passwordConfirmBtn.addEventListener("click", submitPassword);
  els.passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitPassword();
    }
  });

  els.viewerSection.addEventListener("dragover", event => {
    event.preventDefault();
  });

  els.viewerSection.addEventListener("drop", async event => {
    event.preventDefault();
    const [file] = event.dataTransfer?.files || [];
    if (!file) {
      return;
    }
    await openLocalPdf(file);
  });

  window.addEventListener("keydown", event => {
    const isCmd = event.ctrlKey || event.metaKey;
    if (!isCmd) {
      return;
    }
    if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      els.fileInput.click();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
  });

  els.viewerContainer.addEventListener(
    "scroll",
    () => {
      queueStateSave();
    },
    { passive: true }
  );
}

function bindSettingsEvents() {
  if (!chrome.storage?.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTINGS_STORAGE_KEY]) {
      return;
    }
    const normalized = normalizeViewerSettings(changes[SETTINGS_STORAGE_KEY].newValue || DEFAULT_VIEWER_SETTINGS);
    applyViewerSettings(normalized);
  });
}

function bindViewerEvents() {
  eventBus.on("pagechanging", event => {
    updatePageControls(event.pageNumber, currentDocument?.numPages || 0);
    queueStateSave();
  });

  eventBus.on("scalechanging", event => {
    updateZoomUi(event);
    queueStateSave();
  });

  eventBus.on("updatefindmatchescount", event => {
    updateSearchCount(event.matchesCount);
  });

  eventBus.on("updatefindcontrolstate", event => {
    updateSearchCount(event.matchesCount);
  });
}

async function openLocalPdf(file) {
  if (!isLikelyPdf(file)) {
    showError("请选择 PDF 文件（.pdf）。");
    return;
  }

  const token = ++openToken;
  clearError();
  els.fileName.textContent = `正在打开：${file.name}`;

  await resetCurrentDocument();
  if (token !== openToken) {
    return;
  }

  currentObjectUrl = URL.createObjectURL(file);
  const loadingTask = pdfjsLib.getDocument({
    url: currentObjectUrl,
    cMapUrl: "../../vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "../../vendor/pdfjs/standard_fonts/",
    isEvalSupported: false,
    enableXfa: false
  });
  currentLoadingTask = loadingTask;
  passwordCancelledLoad = false;

  loadingTask.onPassword = (updatePassword, reason) => {
    if (token !== openToken) {
      return;
    }
    showPasswordDialog(updatePassword, reason);
  };

  let pdfDocument;
  try {
    pdfDocument = await loadingTask.promise;
  } catch (error) {
    currentLoadingTask = null;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    if (passwordCancelledLoad) {
      passwordCancelledLoad = false;
      return;
    }
    if (token !== openToken) {
      return;
    }
    handlePdfOpenError(error, { source: "local" });
    return;
  }

  if (token !== openToken) {
    try {
      await pdfDocument.destroy();
    } catch (error) {
      console.warn("Failed to destroy stale PDF document.", error);
    }
    return;
  }

  currentDocument = pdfDocument;
  currentLoadingTask = null;
  closePasswordDialog();

  const fingerprint = Array.isArray(pdfDocument.fingerprints) ? pdfDocument.fingerprints[0] : "";
  const fallbackKey = `${file.name}:${file.size}:${file.lastModified}`;
  currentStorageKey = `${STORAGE_PREFIX}${fingerprint || fallbackKey}`;

  const savedState = await storageGet(currentStorageKey);
  eventBus.on(
    "pagesinit",
    () => {
      applySavedState(savedState, pdfDocument.numPages);
      queueStateSave();
    },
    { once: true }
  );

  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);

  els.fileName.textContent = file.name;
  updatePageControls(1, pdfDocument.numPages);
  updateSearchCount({ current: 0, total: 0 });
  setDocumentVisible(true);

  try {
    const hasOutline = await renderOutline(pdfDocument);
    applyAutoOutlineBehavior(hasOutline);
  } catch (error) {
    console.warn("Failed to render outline.", error);
    clearOutline("目录读取失败");
    applyAutoOutlineBehavior(false);
  }
}

async function openRemotePdf(remoteUrl) {
  const normalizedUrl = normalizeHttpUrl(remoteUrl);
  if (!normalizedUrl) {
    showError("网页 PDF 链接无效。");
    return;
  }

  const token = ++openToken;
  clearError();
  const displayName = getDisplayNameFromUrl(normalizedUrl);
  els.fileName.textContent = `正在打开：${displayName}`;

  await resetCurrentDocument();
  if (token !== openToken) {
    return;
  }

  const loadingTask = pdfjsLib.getDocument({
    url: normalizedUrl,
    cMapUrl: "../../vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "../../vendor/pdfjs/standard_fonts/",
    isEvalSupported: false,
    enableXfa: false
  });
  currentLoadingTask = loadingTask;
  passwordCancelledLoad = false;

  loadingTask.onPassword = (updatePassword, reason) => {
    if (token !== openToken) {
      return;
    }
    showPasswordDialog(updatePassword, reason);
  };

  let pdfDocument;
  try {
    pdfDocument = await loadingTask.promise;
  } catch (error) {
    currentLoadingTask = null;
    if (passwordCancelledLoad) {
      passwordCancelledLoad = false;
      return;
    }
    if (token !== openToken) {
      return;
    }
    handlePdfOpenError(error, { source: "remote", url: normalizedUrl });
    return;
  }

  if (token !== openToken) {
    try {
      await pdfDocument.destroy();
    } catch (error) {
      console.warn("Failed to destroy stale PDF document.", error);
    }
    return;
  }

  currentDocument = pdfDocument;
  currentLoadingTask = null;
  currentStorageKey = null;
  closePasswordDialog();

  eventBus.on(
    "pagesinit",
    () => {
      pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
      pdfViewer.currentPageNumber = 1;
      els.viewerContainer.scrollTop = 0;
    },
    { once: true }
  );

  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, normalizedUrl);

  els.fileName.textContent = `${REMOTE_SOURCE_LABEL}：${displayName}`;
  updatePageControls(1, pdfDocument.numPages);
  updateSearchCount({ current: 0, total: 0 });
  setDocumentVisible(true);

  try {
    const hasOutline = await renderOutline(pdfDocument);
    applyAutoOutlineBehavior(hasOutline);
  } catch (error) {
    console.warn("Failed to render outline.", error);
    clearOutline("目录读取失败");
    applyAutoOutlineBehavior(false);
  }
}

async function resetCurrentDocument() {
  clearTimeout(saveStateTimer);
  saveStateTimer = null;
  cancelOutlineAutoFit();
  closePasswordDialog();
  currentStorageKey = null;
  currentScaleSetting = DEFAULT_SCALE_VALUE;
  passwordCancelledLoad = false;

  pdfViewer.setDocument(null);
  linkService.setDocument(null, null);

  const loadingTask = currentLoadingTask;
  currentLoadingTask = null;
  if (loadingTask) {
    try {
      await loadingTask.destroy();
    } catch (error) {
      console.warn("Failed to destroy loading task.", error);
    }
  }

  const oldDocument = currentDocument;
  currentDocument = null;
  if (oldDocument) {
    try {
      await oldDocument.destroy();
    } catch (error) {
      console.warn("Failed to destroy old PDF document.", error);
    }
  }

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  clearOutline();
  updatePageControls(1, 0);
  updateSearchCount({ current: 0, total: 0 });
  setDocumentVisible(false);
}

function applySavedState(savedState, pageCount) {
  if (!savedState) {
    pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    pdfViewer.currentPageNumber = 1;
    els.viewerContainer.scrollTop = 0;
    return;
  }

  const page = clamp(Number.parseInt(savedState.page, 10) || 1, 1, pageCount);
  const scaleSetting = savedState.scaleSetting || DEFAULT_SCALE_VALUE;
  currentScaleSetting = String(scaleSetting);

  try {
    pdfViewer.currentScaleValue = String(scaleSetting);
  } catch (error) {
    pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    currentScaleSetting = DEFAULT_SCALE_VALUE;
  }

  pdfViewer.currentPageNumber = page;

  if (Number.isFinite(savedState.scrollTop)) {
    requestAnimationFrame(() => {
      els.viewerContainer.scrollTop = Math.max(0, savedState.scrollTop);
    });
  }
}

function adjustZoom(ratio) {
  if (!currentDocument) {
    return;
  }
  const nextScale = clamp(Number((pdfViewer.currentScale * ratio).toFixed(2)), MIN_SCALE, MAX_SCALE);
  pdfViewer.currentScaleValue = String(nextScale);
}

function jumpToPage(value) {
  if (!currentDocument) {
    return;
  }
  let page = Number.parseInt(value, 10);
  if (!Number.isFinite(page)) {
    page = pdfViewer.currentPageNumber;
  }
  pdfViewer.currentPageNumber = clamp(page, 1, currentDocument.numPages);
}

function runFind({ type = "", findPrevious = false }) {
  const query = els.searchInput.value.trim();
  if (!query) {
    updateSearchCount({ current: 0, total: 0 });
    eventBus.dispatch("findbarclose", { source: window });
    return;
  }
  eventBus.dispatch("find", {
    source: window,
    type,
    query,
    phraseSearch: true,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false
  });
}

async function renderOutline(pdfDocument) {
  const outline = await pdfDocument.getOutline();
  if (!outline?.length) {
    clearOutline("此文档没有目录");
    return false;
  }

  els.outlineContainer.textContent = "";
  const root = document.createElement("ul");
  appendOutlineItems(root, outline);
  els.outlineContainer.appendChild(root);
  return true;
}

function appendOutlineItems(parent, items) {
  for (const item of items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outline-item";
    button.textContent = item.title || "（无标题）";
    button.addEventListener("click", () => {
      if (item.dest) {
        linkService.goToDestination(item.dest);
      } else if (item.url) {
        window.open(item.url, "_blank", "noopener");
      }
    });
    li.appendChild(button);

    if (item.items?.length) {
      const childList = document.createElement("ul");
      appendOutlineItems(childList, item.items);
      li.appendChild(childList);
    }

    parent.appendChild(li);
  }
}

function clearOutline(message = "请先打开 PDF 文件") {
  els.outlineContainer.textContent = "";
  const empty = document.createElement("div");
  empty.className = "outline-empty";
  empty.textContent = message;
  els.outlineContainer.appendChild(empty);
}

function applyAutoOutlineBehavior(hasOutline) {
  if (!autoOutlineAutoFitEnabled) {
    return;
  }

  if (hasOutline) {
    els.outlinePanel.classList.remove("collapsed");
    scheduleOutlineAwarePageWidth();
    return;
  }

  cancelOutlineAutoFit();
  els.outlinePanel.classList.add("collapsed");
}

function scheduleOutlineAwarePageWidth() {
  cancelOutlineAutoFit();
  const runId = outlineAutoFitVersion;
  const panel = els.outlinePanel;

  const applyPageWidth = () => {
    if (runId !== outlineAutoFitVersion) {
      return;
    }
    if (!currentDocument || !autoOutlineAutoFitEnabled || panel.classList.contains("collapsed")) {
      return;
    }
    // Nudge once, then compute page-width against the already-expanded outline layout.
    pdfViewer.currentScaleValue = "page-fit";
    requestAnimationFrame(() => {
      if (runId !== outlineAutoFitVersion) {
        return;
      }
      if (!currentDocument || !autoOutlineAutoFitEnabled || panel.classList.contains("collapsed")) {
        return;
      }
      pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    });
  };

  const onTransitionEnd = event => {
    if (event.target !== panel) {
      return;
    }
    if (event.propertyName !== "width" && event.propertyName !== "opacity") {
      return;
    }
    panel.removeEventListener("transitionend", onTransitionEnd);
    clearTimeout(outlineAutoFitTimer);
    outlineAutoFitTimer = null;
    applyPageWidth();
  };

  panel.addEventListener("transitionend", onTransitionEnd);
  const transitionMs = getMaxTransitionTimeMs(panel);
  outlineAutoFitTimer = setTimeout(() => {
    panel.removeEventListener("transitionend", onTransitionEnd);
    outlineAutoFitTimer = null;
    applyPageWidth();
  }, Math.max(120, transitionMs + 80));
}

function cancelOutlineAutoFit() {
  outlineAutoFitVersion += 1;
  if (outlineAutoFitTimer) {
    clearTimeout(outlineAutoFitTimer);
    outlineAutoFitTimer = null;
  }
}

function getMaxTransitionTimeMs(element) {
  const style = getComputedStyle(element);
  const durations = parseTransitionTimeList(style.transitionDuration);
  const delays = parseTransitionTimeList(style.transitionDelay);
  if (!durations.length) {
    return 0;
  }

  const count = Math.max(durations.length, delays.length || 1);
  let maxTime = 0;
  for (let index = 0; index < count; index += 1) {
    const duration = durations[index % durations.length] || 0;
    const delay = (delays.length ? delays[index % delays.length] : 0) || 0;
    maxTime = Math.max(maxTime, duration + delay);
  }
  return maxTime;
}

function parseTransitionTimeList(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      if (item.endsWith("ms")) {
        const ms = Number.parseFloat(item.slice(0, -2));
        return Number.isFinite(ms) ? ms : 0;
      }
      if (item.endsWith("s")) {
        const seconds = Number.parseFloat(item.slice(0, -1));
        return Number.isFinite(seconds) ? seconds * 1000 : 0;
      }
      const fallback = Number.parseFloat(item);
      return Number.isFinite(fallback) ? fallback * 1000 : 0;
    });
}

function updatePageControls(pageNumber, pageCount) {
  const hasDocument = pageCount > 0;
  els.pageNumberInput.max = String(Math.max(pageCount, 1));
  els.pageNumberInput.value = String(Math.max(pageNumber, 1));
  els.pageCountLabel.textContent = `/ ${pageCount}`;
  els.prevPageBtn.disabled = !hasDocument || pageNumber <= 1;
  els.nextPageBtn.disabled = !hasDocument || pageNumber >= pageCount;
}

function updateZoomUi({ scale, presetValue }) {
  const optionValues = new Set(Array.from(els.zoomSelect.options, option => option.value));
  if (presetValue && optionValues.has(String(presetValue))) {
    currentScaleSetting = String(presetValue);
    els.customZoomOption.hidden = true;
    els.zoomSelect.value = String(presetValue);
    return;
  }

  const numericScale = clamp(Number(scale) || 1, MIN_SCALE, MAX_SCALE);
  const value = String(Number(numericScale.toFixed(2)));
  currentScaleSetting = value;
  els.customZoomOption.hidden = false;
  els.customZoomOption.value = value;
  els.customZoomOption.textContent = `${Math.round(numericScale * 100)}%`;
  els.zoomSelect.value = value;
}

function updateSearchCount(matchesCount) {
  const current = Number(matchesCount?.current || 0);
  const total = Number(matchesCount?.total || 0);
  els.searchResult.textContent = `${current} / ${total}`;
}

function setDocumentVisible(visible) {
  els.viewerSection.classList.toggle("has-document", visible);
}

function queueStateSave() {
  if (!currentDocument || !currentStorageKey) {
    return;
  }
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    void persistReadingState();
  }, 250);
}

async function persistReadingState() {
  if (!currentDocument || !currentStorageKey) {
    return;
  }
  const state = {
    page: pdfViewer.currentPageNumber,
    scrollTop: els.viewerContainer.scrollTop,
    scaleSetting: currentScaleSetting
  };
  await storageSet(currentStorageKey, state);
}

function showPasswordDialog(updatePassword, reason) {
  pendingPasswordUpdate = updatePassword;
  const prompt =
    reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? "密码错误，请重新输入。"
      : "该 PDF 已加密，请输入密码。";
  els.passwordPrompt.textContent = prompt;
  els.passwordInput.value = "";
  els.passwordDialogBackdrop.hidden = false;
  els.passwordInput.focus();
}

function closePasswordDialog() {
  pendingPasswordUpdate = null;
  els.passwordDialogBackdrop.hidden = true;
  els.passwordInput.value = "";
}

function submitPassword() {
  const password = els.passwordInput.value;
  if (!pendingPasswordUpdate) {
    closePasswordDialog();
    return;
  }
  if (!password) {
    els.passwordInput.focus();
    return;
  }
  pendingPasswordUpdate(password);
  closePasswordDialog();
}

function showError(summary, detail = "", action = null) {
  els.errorMessage.textContent = "";
  const summaryNode = document.createElement("strong");
  summaryNode.textContent = summary;
  els.errorMessage.appendChild(summaryNode);

  if (detail) {
    const detailNode = document.createElement("span");
    detailNode.textContent = detail;
    els.errorMessage.appendChild(detailNode);
  }

  if (action?.url) {
    els.errorActionLink.hidden = false;
    els.errorActionLink.href = action.url;
    els.errorActionLink.textContent = action.label || "在新标签打开原链接";
  } else {
    els.errorActionLink.hidden = true;
    els.errorActionLink.removeAttribute("href");
  }

  els.errorBanner.hidden = false;
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorMessage.textContent = "";
  els.errorActionLink.hidden = true;
  els.errorActionLink.removeAttribute("href");
}

function handlePdfOpenError(error, context = { source: "local" }) {
  closePasswordDialog();

  const errorName = error?.name || "UnknownError";
  const errorMessage = error?.message || "No details";
  const details = `${errorName}: ${errorMessage}`;
  const action =
    context?.source === "remote" && context?.url
      ? {
          label: "在新标签打开原链接",
          url: context.url
        }
      : null;

  switch (errorName) {
    case "InvalidPDFException":
      showError("PDF 文件损坏或格式无效。", details, action);
      break;
    case "MissingPDFException":
      showError("无法读取该 PDF 文件。", details, action);
      break;
    case "PasswordException":
      showError("该 PDF 需要密码，且本次加载未完成。", details, action);
      break;
    case "UnexpectedResponseException":
      showError("读取 PDF 时出现异常响应（可能是 403 或防盗链）。", details, action);
      break;
    default:
      showError("打开 PDF 失败。", details, action);
      break;
  }
}

function isLikelyPdf(file) {
  if (!file) {
    return false;
  }
  if (file.type === "application/pdf") {
    return true;
  }
  return file.name.toLowerCase().endsWith(".pdf");
}

function normalizeHttpUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(String(rawUrl));
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null;
    }
    return parsed.href;
  } catch (error) {
    return null;
  }
}

function getDisplayNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const last = pathParts[pathParts.length - 1] || parsed.hostname;
    return decodeURIComponent(last);
  } catch (error) {
    return url;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function loadViewerSettings() {
  const stored = await storageGet(SETTINGS_STORAGE_KEY);
  const normalized = normalizeViewerSettings(stored || DEFAULT_VIEWER_SETTINGS);
  applyViewerSettings(normalized);
}

function normalizeViewerSettings(raw) {
  return {
    autoOutlineAutoFitEnabled: raw?.autoOutlineAutoFitEnabled !== false,
    themeMode: normalizeThemeMode(raw?.themeMode),
    themePresetId: normalizeThemePresetId(raw?.themePresetId),
    customThemeColor: normalizeHexColor(raw?.customThemeColor) || DEFAULT_VIEWER_SETTINGS.customThemeColor
  };
}

function applyViewerSettings(settings) {
  autoOutlineAutoFitEnabled = settings.autoOutlineAutoFitEnabled;
  currentThemeMode = settings.themeMode;
  currentThemePresetId = settings.themePresetId;
  currentCustomThemeColor = settings.customThemeColor;
  applyThemeTint(resolveThemeTint(settings));
}

function resolveThemeTint(settings) {
  if (settings.themeMode === "custom") {
    return settings.customThemeColor;
  }
  return THEME_PRESETS[settings.themePresetId] || DEFAULT_VIEWER_SETTINGS.customThemeColor;
}

function applyThemeTint(color) {
  document.documentElement.style.setProperty("--page-tint", color || DEFAULT_VIEWER_SETTINGS.customThemeColor);
}

function applyColorEnhancementState() {
  const isEnabled = colorEnhancementEnabled !== false;
  els.viewer.classList.toggle("dark-invert", isEnabled);
  document.documentElement.classList.toggle("color-enhancement-off", !isEnabled);
  els.colorToggleBtn.classList.toggle("is-off", !isEnabled);
  els.colorToggleBtn.textContent = isEnabled ? "临时关闭改色" : "恢复改色";
  els.colorToggleBtn.title = isEnabled ? "临时查看原始配色" : "恢复 Dark Mode 改色";
  els.colorToggleBtn.setAttribute("aria-pressed", !isEnabled ? "true" : "false");
}

function normalizeThemeMode(value) {
  return value === "custom" ? "custom" : "preset";
}

function normalizeThemePresetId(value) {
  const id = String(value || "").trim().toLowerCase();
  return THEME_PRESETS[id] ? id : DEFAULT_VIEWER_SETTINGS.themePresetId;
}

function normalizeHexColor(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1]}` : null;
}

function storageGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get([key], result => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to read storage.", chrome.runtime.lastError);
        resolve(null);
        return;
      }
      resolve(result[key] || null);
    });
  });
}

function storageSet(key, value) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to write storage.", chrome.runtime.lastError);
      }
      resolve();
    });
  });
}
