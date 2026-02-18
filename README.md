# Dark PDF Reader (Chrome/Edge Extension)

一个可本地加载（开发者模式）的 Chrome 扩展，用于打开本地或网页 PDF 并进行整页反色，获得暗色阅读效果。

## 已实现功能

- 打开本地 PDF（按钮选择 + 拖拽）
- 自动接管“网页直达 PDF”并进入插件阅读器（默认开启）
- 网页点击 PDF 链接时：插件在新标签页打开，原网页保留
- 右键 PDF 链接：强制使用插件打开
- 在已打开的 PDF 页面右键：手动切换到插件打开
- 在网页中点击扩展图标识别 PDF 并打开（支持直链、链接、嵌入式来源）
- 多个 PDF 候选时弹出选择列表
- 整页反色暗色模式（白底变黑底，文本/图表同步反色）
- 搜索文本（高亮、上一个/下一个、结果计数）
- 文档目录（Outline）侧栏跳转
- 页码跳转、上一页/下一页
- 缩放（适应宽度/适应页面/固定比例/连续放大缩小）
- 网页来源支持“返回原网页”按钮
- 提供设置页：自动接管开关、白名单、黑名单（黑名单优先）
- 提供设置页开关：有目录时自动展开并适应宽度（默认开启）
- 记住阅读位置（按 PDF 指纹保存：页码 + 缩放 + 滚动位置）
- 支持加密 PDF 密码输入
- 对损坏/异常 PDF 提供更详细错误提示
- 提供统一扩展图标（工具栏、扩展列表、页面 favicon）

## 性能目标（对应需求）

- 目标支持约 `200MB` 级别 PDF 文件可用
- 使用 `pdf.js` worker + 懒渲染，避免一次性全量渲染页面
- 使用 `Blob URL` 打开本地文件，避免额外数组缓冲拷贝
- 网页 PDF 模式不记录阅读位置（仅本地文件记忆）

## 本地加载方式（Chrome / Edge）

1. 打开 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目目录（`Dark_PDF_Reader`）
5. 点击扩展图标，会自动打开阅读器页面

Edge 可在 `edge://extensions/` 里用同样方式加载。

## 目录结构

- `manifest.json`: 扩展配置（MV3）
- `src/background.js`: 自动接管、右键菜单、网页识别、跳转阅读器
- `src/options/options.html`: 设置页
- `src/options/options.css`: 设置页样式
- `src/options/options.js`: 设置页逻辑
- `src/viewer/viewer.html`: 阅读器页面
- `src/viewer/viewer.css`: 阅读器样式
- `src/viewer/viewer.js`: 阅读器逻辑
- `vendor/pdfjs/`: 打包进项目的 pdf.js 运行资源

## 依赖与同步

项目使用 `pdfjs-dist@3.11.174` 并已将运行资源复制进 `vendor/pdfjs/`，可离线运行。

如需更新 `vendor` 资源：

```bash
npm install
npm run sync:pdfjs
```

自动化回归（arXiv 批量 PDF）：

```bash
npm run test:arxiv
```

自动接管回归（访问 arXiv 直达 PDF，验证自动跳转插件）：

```bash
npm run test:auto
```

Edge 回归（你当前使用的浏览器）：

```bash
npm run test:edge:list
npm run test:edge:auto
npm run test:edge:arxiv
npm run test:edge:outline
```

## 已知限制

- 当前为“全局反色”策略，图片与图表也会反色（符合本轮确认需求 `2A`）
- 不改造 Chrome 内置 `chrome://` PDF 阅读器，而是使用扩展内 viewer 页面
- 仅支持公开可访问 PDF；登录态、鉴权链接、强防盗链场景可能无法打开
