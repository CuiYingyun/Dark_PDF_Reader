import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync("./src/background.js", "utf8");

const noop = () => {};
const makeEvent = () => ({ addListener: noop });

const chrome = {
  runtime: {
    onInstalled: makeEvent(),
    onStartup: makeEvent(),
    onMessage: makeEvent(),
    getURL: path => `chrome-extension://extid/${path}`
  },
  storage: {
    onChanged: makeEvent(),
    local: {
      get: (_keys, callback) => callback({}),
      set: (_obj, callback) => callback && callback()
    }
  },
  action: {
    onClicked: makeEvent(),
    setBadgeBackgroundColor: async () => {},
    setBadgeText: async () => {},
    setTitle: async () => {}
  },
  contextMenus: {
    onClicked: makeEvent(),
    onShown: makeEvent(),
    removeAll: callback => callback && callback(),
    create: (_options, callback) => callback && callback(),
    update: (_menuId, _props, callback) => callback && callback(),
    refresh: noop
  },
  tabs: {
    onRemoved: makeEvent(),
    onUpdated: makeEvent(),
    create: async () => {},
    update: async () => {},
    get: async () => ({ url: "chrome-extension://extid/src/viewer/viewer.html" })
  },
  webNavigation: {
    onCommitted: makeEvent()
  },
  webRequest: {
    onHeadersReceived: makeEvent()
  },
  declarativeNetRequest: {
    updateDynamicRules: async () => {}
  },
  scripting: {
    executeScript: async () => [{ result: [] }]
  }
};

const context = {
  chrome,
  URL,
  Map,
  Set,
  Promise,
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({ headers: { get: () => "text/html" }, status: 200 })
};

vm.createContext(context);
vm.runInContext(code, context, { filename: "background.js" });

const { resolvePdfUrlHint } = context;
if (typeof resolvePdfUrlHint !== "function") {
  throw new Error("resolvePdfUrlHint not found");
}

const cases = [
  {
    input:
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Farxiv.org%2Fpdf%2F1706.03762.pdf",
    expected: "https://arxiv.org/pdf/1706.03762.pdf"
  },
  {
    input:
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=https%3A%2F%2Farxiv.org%2Fpdf%2F2106.14834.pdf",
    expected: "https://arxiv.org/pdf/2106.14834.pdf"
  },
  {
    input: "chrome-extension://foo/viewer.html#https://arxiv.org/pdf/2303.08774.pdf",
    expected: "https://arxiv.org/pdf/2303.08774.pdf"
  },
  {
    input: "edge://pdfjs/web/viewer.html?file=https%3A%2F%2Farxiv.org%2Fpdf%2F2407.21783.pdf",
    expected: "https://arxiv.org/pdf/2407.21783.pdf"
  },
  {
    input: "https://arxiv.org/pdf/2407.21783.pdf",
    expected: "https://arxiv.org/pdf/2407.21783.pdf"
  }
];

for (const item of cases) {
  const got = resolvePdfUrlHint(item.input);
  if (got !== item.expected) {
    throw new Error(`Mismatch for ${item.input}\nexpected: ${item.expected}\ngot: ${got}`);
  }
}

console.log(`resolver test passed: ${cases.length}/${cases.length}`);
