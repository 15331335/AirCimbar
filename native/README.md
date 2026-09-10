# AirCimbar for iOS — 独立运行版

这是一个**完全离线、自带一切**的 iPhone 应用：不需要电脑在后台跑服务器，不需要 Wi-Fi，
不需要蓝牙，飞行模式下照常工作。装好就是独立 App。

它和你已经在用的 PWA 跑的是**同一份代码**（`app/` 目录），由 `tools/sync-web.mjs`
原样复制进 App 包里，所以两边永远不会走偏。

---

## 为什么需要这个版本

| | PWA（Safari 添加到主屏幕） | 原生 App（本目录） |
| --- | --- | --- |
| 需要电脑跑 `serve.mjs` | 首次安装需要 | **完全不需要** |
| 需要 Wi-Fi / 局域网 | 首次安装需要 | **不需要，飞行模式可用** |
| 摄像头 | 可用（需 HTTPS） | 可用 |
| 保持屏幕常亮 | 靠 `navigator.wakeLock`，WKWebView 下不可靠 | **原生 `isIdleTimerDisabled`，可靠** |
| 保存接收到的文件 | 系统分享面板 | **原生分享面板**（WKWebView 不支持 blob 下载） |
| 安装方式 | Safari 分享 → 添加到主屏幕 | 侧载 IPA（见下） |

---

## 它是怎么做到离线的

```
┌──────────────────────────────────────────────┐
│  AirCimbar.app                               │
│                                              │
│  SwiftUI 外壳（ContentView / WebEngine）      │
│      │                                       │
│      ├── LocalHTTPServer                     │
│      │     绑定 127.0.0.1:<随机端口>          │
│      │     只读地提供包内的 web/ 目录          │
│      │                                       │
│      └── WKWebView                           │
│            加载 http://127.0.0.1:PORT/        │
│            ├─ app/          （UI）            │
│            └─ cimbar_js.wasm（上游编解码器）   │
│                                              │
│  包内资源：web/  （2.0 MB，含 wasm）           │
└──────────────────────────────────────────────┘
```

**为什么要有那个本地服务器？** 摄像头。WebKit 只在**安全上下文**里才给 `getUserMedia`，
而从 App 包里直接 `file://` 打开的内容不算安全上下文，取景框会一直是黑的。
`http://127.0.0.1:<port>` 属于规范明文列出的可信来源，所以用它来喂页面——
Capacitor / Cordova 出于同样的原因也是这么做的。

这个 socket **只绑回环地址**，外部网络访问不到；App 不做任何其他网络请求，
全部资源都在包里（已核对：源码里除了页脚的署名超链接，没有任何外部 URL）。

---

## 安装到 iPhone

需要一个免费的 Apple ID。免费账号侧载的 App **有效期为 7 天**，过期后重新侧载一次即可
（App 数据不会丢）。

### 方案 A：云端构建（不需要 Mac 装 Xcode）

1. **建一个 GitHub 仓库**，把本目录（`AirCimbar/`）推上去：

   ```sh
   cd AirCimbar
   git init && git add -A && git commit -m "AirCimbar"
   gh repo create AirCimbar --private --source=. --push    # 或用网页端建库后 git push
   ```

2. 打开仓库的 **Actions → Build AirCimbar IPA → Run workflow**。
   如果签名时报 bundle id 冲突，把 `bundle_id` 改成 `com.<你的名字>.aircimbar` 再跑一次。

3. 等 5–10 分钟，从这次运行的 **Artifacts** 里下载 `AirCimbar-unsigned-ipa`，
   解压得到 `AirCimbar-unsigned.ipa`。

4. 用 [Sideloadly](https://sideloadly.io/) 侧载：
   - Mac/PC 装 Sideloadly，iPhone 用数据线连上
   - 把 `AirCimbar-unsigned.ipa` 拖进去
   - 填你的 Apple ID（免费账号即可），点 Start
   - iPhone 上：**设置 → 通用 → VPN与设备管理 → 信任你的开发者证书**

5. 回到主屏幕，打开 AirCimbar，第一次点「开始扫描」时允许摄像头。

### 方案 B：本机 Xcode 构建

需要 macOS + Xcode 15 或更高（iOS 16+ SDK；要装到 iOS 26 设备上请用 Xcode 16.4+）。

```sh
brew install xcodegen
cd native
node ../tools/sync-web.mjs     # 把 app/ 同步进 App 包
xcodegen generate
open AirCimbar.xcodeproj
```

在 Xcode 里选中 `AirCimbar` target → **Signing & Capabilities** → 勾上
*Automatically manage signing* 并选你的 Team，然后连上 iPhone 直接 Run。

> 注意：部署到 iOS 26 设备需要 Xcode 16.4+，而它要求 macOS 15.6+。
> 如果你的 Mac 系统较旧，请走方案 A（云端构建不受本机系统版本限制）。

---

## 验证

原生外壳的核心机制在本机就能验证，不需要 Xcode，也不需要 iOS SDK：

```sh
node test/swift-typecheck.mjs   # 6 个 Swift 文件全量类型检查（macOS SDK）
node test/native-smoke.mjs      # 编译并运行 LocalHTTPServer + WKWebView 真实跑一遍
```

`native-smoke` 会真的启动回环服务器、用 WKWebView 加载包内页面，并断言：

* 页面加载完成，三个标签页、五种模式都在
* **libcimbar 的 wasm 引擎在 WebKit 里初始化成功**（含 `prepare()` 建流）
* Web 层检测到原生桥，且 `ready` 消息真的到达了原生代码
* `keepAwake` 与分块 base64 的文件传输协议都能跑通

它还顺带验证了 `LocalHTTPServer` 的安全行为：只绑 `127.0.0.1`、
`../` 与百分号编码的目录穿越一律 403、缺失文件 404、非 GET 405。

---

## 代码结构

| 文件 | 作用 |
| --- | --- |
| `AirCimbarApp.swift` | `@main` 入口 |
| `ContentView.swift` | SwiftUI 外壳；启动失败与摄像头被拒时的原生提示 |
| `WebContainer.swift` | WKWebView 容器 + 摄像头授权代理 + JS 桥 |
| `LocalHTTPServer.swift` | 回环静态服务器（含目录穿越防护） |
| `WebAssets.swift` | 定位并校验包内 `web/` |
| `PlatformSupport.swift` | 屏幕常亮、摄像头权限、原生分享面板 |
| `Info.plist` | 摄像头用途说明、仅本地网络的 ATS 例外 |
| `project.yml` | XcodeGen 工程描述（工程文件由它生成，不入库） |
| `web/` | 由 `tools/sync-web.mjs` 从 `app/` 同步，**不要手改** |

### JS ↔ 原生 协议

Web 层检测到 `window.webkit.messageHandlers.aircimbar` 就会启用桥；PWA 环境下
这段代码不生效，自动退回系统分享 / 下载。

| 消息 | 方向 | 作用 |
| --- | --- | --- |
| `{type:'ready'}` | JS → 原生 | 页面就绪 |
| `{type:'keepAwake', on:bool}` | JS → 原生 | 广播期间保持屏幕常亮 |
| `{type:'fileBegin', name, size, mime}` | JS → 原生 | 开始接收一个待保存文件 |
| `{type:'fileChunk', data:base64}` | JS → 原生 | 512 KB 分块（33 MB 文件约 44 MB 文本，必须分块） |
| `{type:'fileEnd'}` | JS → 原生 | 收齐 → 弹原生分享面板 |
| `{type:'log', message}` | JS → 原生 | 转发到系统日志 |

文件名在原生侧会做净化（去掉 `/`、`\`、`:`、`..`），避免从数据里带出路径。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动就停在「无法启动」 | 包内 `web/` 缺失。跑 `node tools/sync-web.mjs` 后重新构建 |
| 取景框全黑、没有画面 | 摄像头权限被拒。App 内会弹出提示，点「去设置」开启 |
| 侧载时报 bundle id 冲突 | 云端构建时把 `bundle_id` 换成你自己的唯一值 |
| 装完 7 天后打不开 | 免费 Apple ID 的签名到期，重新用 Sideloadly 侧载一次 |
| 想让 App 常驻不失效 | 加入 Apple Developer Program（$99/年）后用正式证书签名，有效期 1 年 |
