import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const EXTENSION_PATH = path.resolve(".");
const USER_DATA_DIR = path.resolve(".tmp-playwright-edge-list-profile");
const LIST_URL = "https://arxiv.org/list/cs.SE/2026?skip=0&show=2000";
const SAMPLE_COUNT = 5;
const TEST_BROWSER = String(process.env.PDF_TEST_BROWSER || "edge").toLowerCase();
const EDGE_EXECUTABLE_PATH =
  process.env.PDF_EDGE_EXECUTABLE || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

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
    const expectedPrefix = `chrome-extension://${extensionId}/src/viewer/viewer.html`;

    const seedPage = await context.newPage();
    await seedPage.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await seedPage.waitForSelector('a[href*="/pdf/"]', { timeout: 30000 });

    const targets = await seedPage.evaluate(maxCount => {
      const links = Array.from(document.querySelectorAll('a[href*="/pdf/"]'));
      const seen = new Set();
      const selected = [];
      for (const link of links) {
        const raw = link.getAttribute("href") || "";
        if (!raw || seen.has(raw)) {
          continue;
        }
        seen.add(raw);
        selected.push(raw);
        if (selected.length >= maxCount) {
          break;
        }
      }
      return selected;
    }, SAMPLE_COUNT);
    await seedPage.close();

    const results = [];
    for (const href of targets) {
      const result = await runSingleCase(context, expectedPrefix, href);
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

async function runSingleCase(context, expectedPrefix, href) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", msg => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  let result = null;

  try {
    await safeGoto(page, LIST_URL);
    await page.waitForSelector('a[href*="/pdf/"]', { timeout: 30000 });
    const target = page.locator(`a[href="${href}"]`).first();
    await target.waitFor({ state: "visible", timeout: 15000 });
    const popupPromise = context.waitForEvent("page", { timeout: 2500 }).catch(() => null);
    try {
      await target.click({ timeout: 15000 });
    } catch (error) {
      const message = String(error?.message || "");
      if (!message.includes("Execution context was destroyed") && !message.includes("frame was detached")) {
        throw error;
      }
    }
    const popup = await popupPromise;
    const activePage = popup || page;
    const snapshot = await waitForReadyState(activePage, expectedPrefix, 60000);
    const openedInNewTab = context
      .pages()
      .some(candidate => candidate !== page && candidate.url().startsWith(expectedPrefix));
    const sourceTabUrl = page.url();
    const sourceTabKept = sourceTabUrl.includes("/list/cs.SE/2026");
    const status =
      snapshot.pageCount > 0 &&
      !snapshot.passwordVisible &&
      !snapshot.errorVisible &&
      snapshot.pageUrl.startsWith(expectedPrefix) &&
      openedInNewTab &&
      sourceTabKept
        ? "ok"
        : "failed";

    result = {
      href,
      status,
      redirectedUrl: snapshot.pageUrl,
      pageCount: snapshot.pageCount,
      passwordVisible: snapshot.passwordVisible,
      errorVisible: snapshot.errorVisible,
      errorText: snapshot.errorText,
      fileLabel: snapshot.fileLabel,
      hasOpenFileBtn: snapshot.hasOpenFileBtn,
      openedInNewTab,
      sourceTabUrl,
      sourceTabKept,
      consoleErrors: consoleErrors.slice(0, 5)
    };
    if (popup) {
      await popup.close();
    }
    return result;
  } catch (error) {
    result = {
      href,
      status: "failed",
      redirectedUrl: page.url(),
      pageCount: 0,
      passwordVisible: false,
      errorVisible: false,
      errorText: `Exception: ${error.message}`,
      fileLabel: "",
      hasOpenFileBtn: false,
      consoleErrors: consoleErrors.slice(0, 5)
    };
    return result;
  } finally {
    if (!result || result.status !== "ok") {
      const screenshotName = `.tmp-edge-list-${safeName(href)}.png`;
      try {
        await page.screenshot({ path: screenshotName, fullPage: true });
      } catch (error) {
        // Ignore screenshot failures.
      }
    }
    await page.close();
  }
}

async function safeGoto(page, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (error) {
      const message = String(error?.message || "");
      const isRetriable = message.includes("ERR_ABORTED") || message.includes("frame was detached");
      if (!isRetriable || attempt === 1) {
        throw error;
      }
    }
  }
}

async function waitForReadyState(page, expectedPrefix, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await page.evaluate(() => {
      const pageUrl = location.href;
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
      const hasOpenFileBtn = Boolean(document.getElementById("openFileBtn"));
      const pageCountLabel = document.getElementById("pageCountLabel")?.textContent || "";
      const match = pageCountLabel.match(/\/\s*(\d+)/);
      const pageCount = match ? Number.parseInt(match[1], 10) : 0;
      return {
        pageUrl,
        passwordVisible,
        errorVisible,
        errorText,
        fileLabel,
        hasOpenFileBtn,
        pageCount
      };
    });

    if (snapshot.pageCount > 0 || snapshot.errorVisible || snapshot.passwordVisible) {
      return snapshot;
    }

    if (snapshot.pageUrl.startsWith("chrome-error://")) {
      return snapshot;
    }

    if (snapshot.pageUrl.startsWith(expectedPrefix) && /打开|loading/i.test(snapshot.fileLabel)) {
      await page.waitForTimeout(300);
      continue;
    }

    if (snapshot.pageUrl.startsWith(expectedPrefix) && !snapshot.fileLabel) {
      return snapshot;
    }
    await page.waitForTimeout(250);
  }

  return {
    pageUrl: page.url(),
    passwordVisible: false,
    errorVisible: false,
    errorText: "Timeout: list-click flow did not reach ready state",
    fileLabel: "",
    hasOpenFileBtn: false,
    pageCount: 0
  };
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
