import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const EXTENSION_PATH = path.resolve(".");
const USER_DATA_DIR = path.resolve(".tmp-playwright-edge-outline-profile");
const EDGE_EXECUTABLE_PATH =
  process.env.PDF_EDGE_EXECUTABLE || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

const PDF_WITH_OUTLINE = "https://www.rfc-editor.org/rfc/rfc9110.pdf";
const PDF_WITHOUT_OUTLINE = "https://www.irs.gov/pub/irs-pdf/f1040.pdf";

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

    const results = [];

    await setAutoOutlineSetting(context, extensionId, true);
    results.push(await runSingleCase(context, extensionId, "enabled_with_outline", PDF_WITH_OUTLINE));
    results.push(await runSingleCase(context, extensionId, "enabled_without_outline", PDF_WITHOUT_OUTLINE));

    await setAutoOutlineSetting(context, extensionId, false);
    results.push(await runSingleCase(context, extensionId, "disabled_with_outline", PDF_WITH_OUTLINE));

    for (const item of results) {
      console.log(JSON.stringify(item));
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

async function setAutoOutlineSetting(context, extensionId, enabled) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/src/viewer/viewer.html`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.evaluate(value => {
      return new Promise(resolve => {
        const key = "autoTakeoverSettings";
        chrome.storage.local.get([key], result => {
          const current = result[key] || {};
          const next = {
            autoTakeoverEnabled: current.autoTakeoverEnabled !== false,
            whitelist: Array.isArray(current.whitelist) ? current.whitelist : [],
            blacklist: Array.isArray(current.blacklist) ? current.blacklist : [],
            autoOutlineAutoFitEnabled: Boolean(value)
          };
          chrome.storage.local.set({ [key]: next }, () => resolve());
        });
      });
    }, enabled);
    await page.waitForTimeout(300);
  } finally {
    await page.close();
  }
}

async function runSingleCase(context, extensionId, name, pdfUrl) {
  const page = await context.newPage();
  let result = null;

  try {
    const viewerUrl =
      `chrome-extension://${extensionId}/src/viewer/viewer.html` +
      `?url=${encodeURIComponent(pdfUrl)}` +
      `&from=${encodeURIComponent("https://example.com")}`;

    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const snapshot = await waitForSnapshot(page, 60000);

    let status = "ok";
    let expectation = "";
    if (name === "enabled_with_outline") {
      expectation = "hasOutline=true, panelExpanded=true, zoom=page-width, widthRatio<=1.03";
      if (
        !snapshot.hasOutline ||
        snapshot.outlineCollapsed ||
        snapshot.zoomValue !== "page-width" ||
        snapshot.widthRatio <= 0 ||
        snapshot.widthRatio > 1.03
      ) {
        status = "failed";
      }
    } else if (name === "enabled_without_outline") {
      expectation = "hasOutline=false, panelCollapsed=true";
      if (snapshot.hasOutline || !snapshot.outlineCollapsed) {
        status = "failed";
      }
    } else if (name === "disabled_with_outline") {
      expectation = "hasOutline=true, panelCollapsed=true";
      if (!snapshot.hasOutline || !snapshot.outlineCollapsed) {
        status = "failed";
      }
    }

    result = {
      name,
      status,
      pdfUrl,
      expectation,
      pageUrl: snapshot.pageUrl,
      pageCount: snapshot.pageCount,
      hasOutline: snapshot.hasOutline,
      outlineCollapsed: snapshot.outlineCollapsed,
      zoomValue: snapshot.zoomValue,
      widthRatio: snapshot.widthRatio,
      passwordVisible: snapshot.passwordVisible,
      errorVisible: snapshot.errorVisible,
      errorText: snapshot.errorText
    };
    return result;
  } catch (error) {
    result = {
      name,
      status: "failed",
      pdfUrl,
      expectation: "execution success",
      pageUrl: page.url(),
      pageCount: 0,
      hasOutline: false,
      outlineCollapsed: true,
      zoomValue: "",
      widthRatio: 0,
      passwordVisible: false,
      errorVisible: false,
      errorText: `Exception: ${error.message}`
    };
    return result;
  } finally {
    if (!result || result.status !== "ok") {
      const screenshotName = `.tmp-outline-${name}.png`;
      try {
        await page.screenshot({ path: screenshotName, fullPage: true });
      } catch (error) {
        // Ignore screenshot failures.
      }
    }
    await page.close();
  }
}

async function waitForSnapshot(page, timeoutMs) {
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
      const pageCountLabel = document.getElementById("pageCountLabel")?.textContent || "";
      const pageMatch = pageCountLabel.match(/\/\s*(\d+)/);
      const pageCount = pageMatch ? Number.parseInt(pageMatch[1], 10) : 0;

      const outlinePanel = document.getElementById("outlinePanel");
      const outlineCollapsed = outlinePanel ? outlinePanel.classList.contains("collapsed") : true;
      const outlineItems = document.querySelectorAll("#outlineContainer .outline-item").length;
      const hasOutline = outlineItems > 0;
      const noOutlineText = (document.getElementById("outlineContainer")?.textContent || "").includes("没有目录");

      const zoomValue = document.getElementById("zoomSelect")?.value || "";
      const viewerContainer = document.getElementById("viewerContainer");
      const firstPage = document.querySelector("#viewer .page");
      const containerWidth = viewerContainer?.clientWidth || 0;
      const pageWidth = firstPage ? firstPage.getBoundingClientRect().width : 0;
      const widthRatio = containerWidth > 0 ? Number((pageWidth / containerWidth).toFixed(3)) : 0;

      return {
        pageUrl,
        pageCount,
        hasOutline,
        noOutlineText,
        outlineCollapsed,
        zoomValue,
        widthRatio,
        passwordVisible,
        errorVisible,
        errorText
      };
    });

    if (snapshot.pageCount > 0 && (snapshot.hasOutline || snapshot.noOutlineText || snapshot.errorVisible)) {
      return snapshot;
    }

    if (snapshot.passwordVisible || snapshot.errorVisible) {
      return snapshot;
    }

    await page.waitForTimeout(250);
  }

  return {
    pageUrl: page.url(),
    pageCount: 0,
    hasOutline: false,
    noOutlineText: false,
    outlineCollapsed: true,
    zoomValue: "",
    widthRatio: 0,
    passwordVisible: false,
    errorVisible: false,
    errorText: "Timeout: outline behavior did not stabilize"
  };
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
