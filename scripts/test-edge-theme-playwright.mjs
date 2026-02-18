import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const EXTENSION_PATH = path.resolve(".");
const USER_DATA_DIR = path.resolve(".tmp-playwright-edge-theme-profile");
const EDGE_EXECUTABLE_PATH =
  process.env.PDF_EDGE_EXECUTABLE || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const TEST_PDF_URL = "https://www.rfc-editor.org/rfc/rfc9110.pdf";

const DEFAULT_COLOR = "#121212";
const PRESET_COLOR = "#0f172a";
const CUSTOM_COLOR = "#2a1537";

async function main() {
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: EDGE_EXECUTABLE_PATH,
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 20000 }));
    const extensionId = new URL(serviceWorker.url()).host;

    const page = await context.newPage();
    const viewerUrl =
      `chrome-extension://${extensionId}/src/viewer/viewer.html` +
      `?url=${encodeURIComponent(TEST_PDF_URL)}` +
      `&from=${encodeURIComponent("https://example.com")}`;
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForDocumentReady(page, 60000);

    const steps = [];

    const initial = await readTint(page);
    steps.push({ step: "initial", tint: initial });

    await setThemeSettings(page, {
      themeMode: "preset",
      themePresetId: "deep-sea-blue",
      customThemeColor: DEFAULT_COLOR
    });
    await waitForTint(page, PRESET_COLOR, 10000);
    steps.push({ step: "preset_deep_sea_blue", tint: await readTint(page) });

    await setThemeSettings(page, {
      themeMode: "custom",
      themePresetId: "deep-sea-blue",
      customThemeColor: CUSTOM_COLOR
    });
    await waitForTint(page, CUSTOM_COLOR, 10000);
    steps.push({ step: "custom_color", tint: await readTint(page) });

    const allGood =
      steps[0].tint === DEFAULT_COLOR &&
      steps[1].tint === PRESET_COLOR &&
      steps[2].tint === CUSTOM_COLOR;
    const result = {
      status: allGood ? "ok" : "failed",
      steps
    };
    console.log(JSON.stringify(result));

    if (!allGood) {
      process.exitCode = 1;
    }

    await page.close();
  } finally {
    await context.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  }
}

async function waitForDocumentReady(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await page.evaluate(() => {
      const label = document.getElementById("pageCountLabel")?.textContent || "";
      const match = label.match(/\/\s*(\d+)/);
      const pageCount = match ? Number.parseInt(match[1], 10) : 0;
      const errorVisible = Boolean(
        document.getElementById("errorBanner") &&
          !document.getElementById("errorBanner").hidden
      );
      return { pageCount, errorVisible };
    });
    if (snapshot.pageCount > 0 || snapshot.errorVisible) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Timeout: viewer did not reach ready state");
}

async function setThemeSettings(page, patch) {
  await page.evaluate(input => {
    return new Promise(resolve => {
      const key = "autoTakeoverSettings";
      chrome.storage.local.get([key], result => {
        const current = result[key] || {};
        const next = {
          autoTakeoverEnabled: current.autoTakeoverEnabled !== false,
          autoOutlineAutoFitEnabled: current.autoOutlineAutoFitEnabled !== false,
          whitelist: Array.isArray(current.whitelist) ? current.whitelist : [],
          blacklist: Array.isArray(current.blacklist) ? current.blacklist : [],
          themeMode: input.themeMode,
          themePresetId: input.themePresetId,
          customThemeColor: input.customThemeColor
        };
        chrome.storage.local.set({ [key]: next }, () => resolve());
      });
    });
  }, patch);
}

async function waitForTint(page, expectedHex, timeoutMs) {
  const target = expectedHex.toLowerCase();
  await page.waitForFunction(
    expected => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--page-tint").trim().toLowerCase();
      return value === expected;
    },
    target,
    { timeout: timeoutMs }
  );
}

async function readTint(page) {
  return page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--page-tint").trim().toLowerCase();
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
