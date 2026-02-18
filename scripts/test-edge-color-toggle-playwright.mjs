import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const EXTENSION_PATH = path.resolve(".");
const USER_DATA_DIR = path.resolve(".tmp-playwright-edge-color-toggle-profile");
const LOCAL_PDF_PATH = path.resolve(".tmp-playwright-color-toggle-local.pdf");
const EDGE_EXECUTABLE_PATH =
  process.env.PDF_EDGE_EXECUTABLE || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const TEST_PDF_URL = "https://www.rfc-editor.org/rfc/rfc9110.pdf";

async function main() {
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  await ensureLocalPdfFixture();

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

    const cases = [
      { name: "remote_pdf", type: "remote", url: TEST_PDF_URL },
      { name: "local_pdf", type: "local", url: "" }
    ];

    const results = [];
    for (const item of cases) {
      const result = await runSingleCase(context, extensionId, item);
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
    await fs.rm(LOCAL_PDF_PATH, { force: true });
  }
}

async function ensureLocalPdfFixture() {
  const response = await fetch(TEST_PDF_URL);
  if (!response.ok) {
    throw new Error(`Failed to download local PDF fixture: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(LOCAL_PDF_PATH, Buffer.from(arrayBuffer));
}

async function runSingleCase(context, extensionId, item) {
  const page = await context.newPage();
  let result = null;

  try {
    if (item.type === "remote") {
      const viewerUrl =
        `chrome-extension://${extensionId}/src/viewer/viewer.html` +
        `?url=${encodeURIComponent(item.url)}` +
        `&from=${encodeURIComponent("https://example.com")}`;
      await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      const viewerUrl = `chrome-extension://${extensionId}/src/viewer/viewer.html`;
      await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.setInputFiles("#fileInput", LOCAL_PDF_PATH);
    }

    await waitForDocumentReady(page, 60000);

    const before = await readSnapshot(page);
    await page.click("#colorToggleBtn");
    await waitForToggleState(page, false, 10000);
    const disabled = await readSnapshot(page);
    await page.click("#colorToggleBtn");
    await waitForToggleState(page, true, 10000);
    const restored = await readSnapshot(page);

    const status =
      before.pageCount > 0 &&
      before.hasInvert &&
      !before.offClass &&
      before.buttonText.includes("临时关闭改色") &&
      disabled.pageCount > 0 &&
      !disabled.hasInvert &&
      disabled.offClass &&
      disabled.buttonText.includes("恢复改色") &&
      restored.pageCount > 0 &&
      restored.hasInvert &&
      !restored.offClass &&
      restored.buttonText.includes("临时关闭改色")
        ? "ok"
        : "failed";

    result = {
      name: item.name,
      status,
      before,
      disabled,
      restored
    };
    return result;
  } catch (error) {
    result = {
      name: item.name,
      status: "failed",
      before: null,
      disabled: null,
      restored: null,
      error: `Exception: ${error.message}`
    };
    return result;
  } finally {
    if (!result || result.status !== "ok") {
      try {
        await page.screenshot({ path: `.tmp-color-toggle-${item.name}.png`, fullPage: true });
      } catch (error) {
        // Ignore screenshot failures.
      }
    }
    await page.close();
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
          !document.getElementById("errorBanner").hidden &&
          getComputedStyle(document.getElementById("errorBanner")).display !== "none"
      );
      const passwordVisible = Boolean(
        document.getElementById("passwordDialogBackdrop") &&
          !document.getElementById("passwordDialogBackdrop").hidden &&
          getComputedStyle(document.getElementById("passwordDialogBackdrop")).display !== "none"
      );
      return { pageCount, errorVisible, passwordVisible };
    });

    if (snapshot.pageCount > 0 || snapshot.errorVisible || snapshot.passwordVisible) {
      return snapshot;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Timeout: PDF viewer did not reach ready state");
}

async function waitForToggleState(page, enabled, timeoutMs) {
  await page.waitForFunction(
    expectedEnabled => {
      const viewer = document.getElementById("viewer");
      const root = document.documentElement;
      const hasInvert = Boolean(viewer?.classList.contains("dark-invert"));
      const offClass = root.classList.contains("color-enhancement-off");
      return expectedEnabled ? hasInvert && !offClass : !hasInvert && offClass;
    },
    enabled,
    { timeout: timeoutMs }
  );
}

async function readSnapshot(page) {
  return page.evaluate(() => {
    const label = document.getElementById("pageCountLabel")?.textContent || "";
    const match = label.match(/\/\s*(\d+)/);
    const pageCount = match ? Number.parseInt(match[1], 10) : 0;
    const viewer = document.getElementById("viewer");
    const root = document.documentElement;
    const button = document.getElementById("colorToggleBtn");
    return {
      pageCount,
      hasInvert: Boolean(viewer?.classList.contains("dark-invert")),
      offClass: root.classList.contains("color-enhancement-off"),
      buttonText: button?.textContent?.trim() || "",
      buttonPressed: button?.getAttribute("aria-pressed") || "",
      viewerBackground: getComputedStyle(document.getElementById("viewerContainer")).backgroundColor
    };
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
