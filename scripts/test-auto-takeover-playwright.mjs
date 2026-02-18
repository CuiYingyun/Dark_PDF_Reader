import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const EXTENSION_PATH = path.resolve(".");
const USER_DATA_DIR = path.resolve(".tmp-playwright-auto-profile");
const TEST_BROWSER = String(process.env.PDF_TEST_BROWSER || "chromium").toLowerCase();
const EDGE_EXECUTABLE_PATH =
  process.env.PDF_EDGE_EXECUTABLE || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const TEST_URLS = [
  "https://arxiv.org/pdf/1706.03762.pdf",
  "https://arxiv.org/pdf/2106.14834.pdf",
  "https://arxiv.org/pdf/2303.08774.pdf"
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
    const expectedPrefix = `chrome-extension://${extensionId}/src/viewer/viewer.html`;

    // Warm up the background bootstrap via content script before direct PDF navigation tests.
    const warmupPage = await context.newPage();
    await warmupPage.goto("https://arxiv.org", { waitUntil: "domcontentloaded", timeout: 45000 });
    await warmupPage.waitForTimeout(1200);
    await warmupPage.close();

    const results = [];
    for (const url of TEST_URLS) {
      const result = await runSingleCase(context, expectedPrefix, url);
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

async function runSingleCase(context, expectedPrefix, targetUrl) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", msg => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  let result = null;
  let viewerPage = null;

  try {
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (error) {
      const message = String(error?.message || "");
      if (!message.includes("ERR_ABORTED") && !message.includes("frame was detached")) {
        throw error;
      }
    }
    viewerPage = await waitForViewerPage(context, expectedPrefix, targetUrl, 45000);
    const snapshot = await waitForViewerReady(viewerPage, 45000);
    const status = snapshot.pageCount > 0 && !snapshot.passwordVisible && !snapshot.errorVisible ? "ok" : "failed";

    result = {
      targetUrl,
      status,
      redirectedUrl: snapshot.pageUrl,
      pageCount: snapshot.pageCount,
      passwordVisible: snapshot.passwordVisible,
      errorVisible: snapshot.errorVisible,
      errorText: snapshot.errorText,
      fileLabel: snapshot.fileLabel,
      consoleErrors: consoleErrors.slice(0, 5)
    };
    return result;
  } catch (error) {
    result = {
      targetUrl,
      status: "failed",
      redirectedUrl: page.url(),
      pageCount: 0,
      passwordVisible: false,
      errorVisible: false,
      errorText: `Exception: ${error.message}`,
      fileLabel: "",
      consoleErrors: consoleErrors.slice(0, 5)
    };
    return result;
  } finally {
    if (!result || result.status !== "ok") {
      const screenshotName = `.tmp-auto-${safeName(targetUrl)}.png`;
      try {
        const shotPage = viewerPage || page;
        await shotPage.screenshot({ path: screenshotName, fullPage: true });
      } catch (error) {
        // ignore screenshot failure
      }
    }
    if (viewerPage && viewerPage !== page) {
      await viewerPage.close();
    }
    await page.close();
  }
}

async function waitForViewerPage(context, expectedPrefix, targetUrl, timeoutMs) {
  const start = Date.now();
  const candidateTargets = buildTargetVariants(targetUrl);

  while (Date.now() - start < timeoutMs) {
    for (const candidatePage of context.pages()) {
      const candidateUrl = candidatePage.url();
      if (!candidateUrl.startsWith(expectedPrefix)) {
        continue;
      }
      if (candidateTargets.some(target => candidateUrl.includes(target) || candidateUrl.includes(encodeURIComponent(target)))) {
        return candidatePage;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error("Timeout: did not find viewer tab in context");
}

function buildTargetVariants(targetUrl) {
  const variants = new Set();
  variants.add(targetUrl);

  try {
    const parsed = new URL(targetUrl);
    if (parsed.pathname.toLowerCase().endsWith(".pdf")) {
      parsed.pathname = parsed.pathname.slice(0, -4);
      variants.add(parsed.toString());
    }
  } catch (error) {
    // Ignore invalid URL variants.
  }

  return Array.from(variants);
}

async function waitForViewerReady(page, timeoutMs) {
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
      const label = document.getElementById("pageCountLabel")?.textContent || "";
      const match = label.match(/\/\s*(\d+)/);
      const pageCount = match ? Number.parseInt(match[1], 10) : 0;
      return {
        passwordVisible,
        errorVisible,
        errorText,
        fileLabel,
        pageCount,
        pageUrl: location.href
      };
    });

    if (snapshot.pageCount > 0 || snapshot.errorVisible || snapshot.passwordVisible) {
      return snapshot;
    }
    await page.waitForTimeout(250);
  }

  return {
    passwordVisible: false,
    errorVisible: false,
    errorText: "Timeout: auto takeover did not reach viewer ready state",
    fileLabel: "",
    pageCount: 0,
    pageUrl: page.url()
  };
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
