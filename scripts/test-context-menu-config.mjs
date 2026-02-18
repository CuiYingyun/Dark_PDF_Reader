import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync("./src/background.js", "utf8");

const createdMenus = [];
const removedCalls = [];

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
    removeAll: callback => {
      removedCalls.push("removeAll");
      callback && callback();
    },
    create: (options, callback) => {
      createdMenus.push(options);
      callback && callback();
    }
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

if (typeof context.recreateContextMenus !== "function") {
  throw new Error("recreateContextMenus not found");
}

await context.recreateContextMenus();

if (!removedCalls.length) {
  throw new Error("Expected contextMenus.removeAll to be called");
}

const linkMenu = createdMenus.find(item => item.id === "open-link-pdf");
const pageMenu = createdMenus.find(item => item.id === "open-current-pdf");
if (!linkMenu || !pageMenu) {
  throw new Error(`Expected both menus, got: ${JSON.stringify(createdMenus)}`);
}

if (linkMenu.visible !== true || pageMenu.visible !== true) {
  throw new Error(`Expected both menus visible=true, got: ${JSON.stringify(createdMenus)}`);
}

if (String(linkMenu.contexts) !== "link" || String(pageMenu.contexts) !== "page") {
  throw new Error(`Unexpected menu contexts: ${JSON.stringify(createdMenus)}`);
}

console.log("context menu config passed");
