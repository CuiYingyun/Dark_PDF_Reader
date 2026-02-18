import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const EXTENSION_PATH = path.resolve(".");
const USER_DATA_DIR = path.resolve(".tmp-playwright-profile");
const TEST_BROWSER = String(process.env.PDF_TEST_BROWSER || "chromium").toLowerCase();
const EDGE_EXECUTABLE_PATH =
  process.env.PDF_EDGE_EXECUTABLE || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const TEST_URLS = [
  "https://arxiv.org/pdf/1706.03762.pdf",
  "https://arxiv.org/pdf/2106.14834.pdf",
  "https://arxiv.org/pdf/2303.08774.pdf",
  "https://arxiv.org/pdf/2407.21783.pdf",
  "https://arxiv.org/pdf/2501.12345.pdf"
];

async function main() {
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });

  const launchOptions = {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  };
  if (TEST_BROWSER === "edge") {
    launchOptions.executablePath = EDGE_EXECUTABLE_PATH;
  }
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);

  try {
    const serviceWorker =
      context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    const extensionId = new URL(serviceWorker.url()).host;

    const results = [];
    for (const url of TEST_URLS) {
      const result = await runSingleCase(context, extensionId, url);
      results.push(result);
      console.log(JSON.stringify(result));
    }

    const failed = results.filter(item => item.status !== "ok");
    console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  }
}

async function runSingleCase(context, extensionId, pdfUrl) {
  const page = await context.newPage();
  const viewerUrl =
    `chrome-extension://${extensionId}/src/viewer/viewer.html` +
    `?url=${encodeURIComponent(pdfUrl)}` +
    `&from=${encodeURIComponent("https://arxiv.org")}`;

  const errors = [];
  page.on("console", msg => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  let result = null;

  try {
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const snapshot = await waitForViewerState(page, 45000);
    const passwordVisible = snapshot.passwordVisible;
    const errorVisible = snapshot.errorVisible;
    const pages = snapshot.pageCount;
    const status = !passwordVisible && !errorVisible && pages > 0 ? "ok" : "failed";

    result = {
      pdfUrl,
      status,
      pages,
      passwordVisible,
      errorVisible,
      errorText: snapshot.errorText,
      fileLabel: snapshot.fileLabel,
      pageUrl: snapshot.pageUrl,
      pageTitle: snapshot.pageTitle,
      hasOpenFileBtn: snapshot.hasOpenFileBtn,
      consoleErrors: errors.slice(0, 5)
    };
    return result;
  } catch (error) {
    result = {
      pdfUrl,
      status: "failed",
      pages: 0,
      passwordVisible: false,
      errorVisible: false,
      errorText: `Exception: ${error.message}`,
      fileLabel: "",
      pageUrl: page.url(),
      pageTitle: "",
      hasOpenFileBtn: false,
      consoleErrors: errors.slice(0, 5)
    };
    return result;
  } finally {
    if (!result || result.status !== "ok") {
      const screenshotName = `.tmp-test-${safeName(pdfUrl)}.png`;
      try {
        await page.screenshot({ path: screenshotName, fullPage: true });
      } catch (error) {
        // ignore screenshot failure
      }
    }
    await page.close();
  }
}

async function waitForViewerState(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await page.evaluate(() => {
      const passwordEl = document.getElementById("passwordDialogBackdrop");
      const errorEl = document.getElementById("errorBanner");
      const passwordVisible = Boolean(
        passwordEl &&
          !passwordEl.hidden &&
          getComputedStyle(passwordEl).display !== "none" &&
          getComputedStyle(passwordEl).visibility !== "hidden"
      );
      const errorVisible = Boolean(
        errorEl &&
          !errorEl.hidden &&
          getComputedStyle(errorEl).display !== "none" &&
          getComputedStyle(errorEl).visibility !== "hidden"
      );
      const errorText = document.getElementById("errorMessage")?.textContent?.trim() || "";
      const fileLabel = document.getElementById("fileName")?.textContent?.trim() || "";
      const hasOpenFileBtn = !!document.getElementById("openFileBtn");
      const label = document.getElementById("pageCountLabel")?.textContent || "";
      const match = label.match(/\/\s*(\d+)/);
      const pageCount = match ? Number.parseInt(match[1], 10) : 0;
      return {
        passwordVisible,
        errorVisible,
        errorText,
        fileLabel,
        pageCount,
        pageUrl: location.href,
        pageTitle: document.title,
        hasOpenFileBtn
      };
    });

    if (snapshot.passwordVisible || snapshot.errorVisible || snapshot.pageCount > 0) {
      return snapshot;
    }
    await page.waitForTimeout(250);
  }

  return {
    passwordVisible: false,
    errorVisible: false,
    errorText: "Timeout: viewer did not reach ready state",
    fileLabel: "",
    pageCount: 0,
    pageUrl: page.url(),
    pageTitle: "",
    hasOpenFileBtn: false
  };
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
