# AirCimbar

**屏幕 → 摄像头 的离线文件传输。** 一台设备把文件变成一串不断刷新的彩色图块矩阵码显示在屏幕上，
另一台设备用摄像头读回来，全程没有网络、没有蓝牙、没有数据线、不经过任何服务器。

* 传输核心：**[libcimbar](https://github.com/sz3/libcimbar) v0.6.8 官方 WASM 构建**（未修改的上游产物）
* 界面与交互：参考 **[AirScan-QR](https://github.com/topcss/AirScan-QR)**
* 与 **[cimbar.org](https://cimbar.org) 双向互通**：iPhone 发的码 PC 浏览器能收，反之亦然

因为用的是上游同一份编解码器，纠错（Reed–Solomon）、交织、喷泉码（wirehair）、
压缩（zstd）全部由上游实现，本项目只负责把它接到一个手机上真正好用的界面里。

## 两种用法

| | **PWA**（现在就能试） | **原生 App**（独立运行） |
| --- | --- | --- |
| 安装 | Safari 打开 → 分享 → 添加到主屏幕 | 侧载 IPA（见 [`native/README.md`](native/README.md)） |
| 需要电脑 | 首次安装需要跑 `serve.mjs` | **完全不需要** |
| 需要网络 | 首次安装需要 | **不需要，飞行模式可用** |
| 摄像头 | ✅（需 HTTPS） | ✅ |
| 屏幕常亮 | 靠 `wakeLock`，WKWebView 下不可靠 | ✅ 原生 `isIdleTimerDisabled` |
| 保存文件 | 系统分享面板 | ✅ 原生分享面板 |

传输行为两者完全一致——`app/` 是唯一源码，`tools/sync-web.mjs` 把它原样复制进 App 包。

---

## 快速开始（PWA）

iOS 只在**安全上下文（HTTPS）**下才允许网页调用摄像头，所以必须用 HTTPS 打开。

```sh
cd AirCimbar
python3 tools/make-local-ca.py     # 一次性：生成本机 CA + 服务器证书（SAN 含本机局域网 IP）
node serve.mjs                     # https://<本机局域网IP>:8443
```

终端会打印出手机关访问的地址和下面这套安装步骤。

### 让 iPhone 信任本机证书（只做一次，之后永不弹警告）

用 IP 访问时，如果证书不是签发给这个 IP 的，iOS 会弹「此连接非私人连接」。
这个警告**在从主屏幕图标冷启动 PWA 时可能每次都会出现**，会让「像 App 一样」的体验彻底破功。
所以用自建 CA 一次性解决：

1. 手机上用 Safari 打开 `https://192.168.1.102:8443/aircimbar-ca.mobileconfig`
   （这一步会先弹一次证书警告，点「显示详细信息 → 访问此网站」继续）
2. **设置 → 通用 → VPN与设备管理** → 安装该描述文件
3. **设置 → 通用 → 关于本机 → 证书信任设置** → 打开 **AirCimbar Local CA** 的开关
4. 再打开 `https://192.168.1.102:8443/` —— 不再有任何警告

`make-local-ca.py` 生成的东西（都在 `certs/`，已 gitignore）：

| 文件 | 用途 |
| --- | --- |
| `aircimbar-ca.pem` / `.key` | 本机根 CA（私钥不出本机） |
| `aircimbar-local.pem` / `.key` | 服务器证书，SAN 含 `192.168.1.102` + `127.0.0.1` + `localhost` |
| `aircimbar-ca.mobileconfig` | 给 iPhone 安装的描述文件，由 `serve.mjs` 在 `/aircimbar-ca.mobileconfig` 提供 |

CA 有效期 10 年，服务器证书默认 825 天（iOS 对 TLS 证书的上限）。
换 Wi-Fi 导致本机 IP 变了，重跑一次 `make-local-ca.py` 并在手机上重装描述文件即可。
如果想在手机上也用域名访问，可以加 `--name your-host.local` 把它写进 SAN。

> 没有自建 CA 也能跑：`serve.mjs` 会自动回退到 `certs/linyango.cn.*`（如果存在），
> 只是仍会有证书警告。

### 添加到主屏幕

1. Safari 打开 `https://<本机IP>:8443/`，点底部分享按钮 → **添加到主屏幕**
2. **先在有网状态下打开一两次**，让 Service Worker 把全部资源（含 1.9 MB 的 wasm）缓存下来
3. 之后即使关掉电脑、断网、开飞行模式，从主屏幕启动依然完全可用
4. 首次点「开始扫描」时允许摄像头权限

---

## 怎么用

### 发送（屏幕上显示码）

| 步骤 | 说明 |
| --- | --- |
| 选择文件 / 发送文字 | 单文件上限约 **33 MB**（喷泉码要求整个文件常驻内存） |
| 选模式 | `B` 默认、`Bm` 宽屏长条、`Bu` 小码远距、`4C` 旧版兼容 |
| 调帧率 | 1–30 fps，默认 15。对方识别得稳就调高，丢帧严重就调低 |
| 调压缩 | zstd 0–22，默认 16。文本/日志用 16–19；zip/jpg/mp4 之类已压缩的调低更省电 |
| 开始广播 | 之后双击画面可进入全屏，全屏时只剩码和两个按钮 |

**提高成功率：** 屏幕亮度调到最高并关掉自动亮度；让对方摄像头把整个码框满并保持稳定；
避免屏幕反光和摩尔纹；距离 10–30 cm 通常最好。帧循环播放，对方随时加入都来得及。

### 接收（摄像头读码）

对准发送方屏幕，框线变绿表示已锁定。进度条来自喷泉码解码进度，
**掉帧、乱序都不要紧**——只要累计收到足够的帧就会自动拼出完整文件。
完成后点「保存文件」，iOS 会弹出分享面板，可存到「文件」或转发出去。

模式默认「自动」，会在 `B / Bm / Bu / 4C` 之间轮询，识别到就锁定。
已知对方用什么模式时手动指定会更快。

### 导入解码（录屏 / 截图）

把发送方屏幕录下来，或者截一张码的图，在这个标签页里选文件即可解码。
适合远程桌面、录屏取证、以及摄像头对不准的场景。
录屏时尽量铺满画面、用高码率；解不出来时把播放速度降到 `0.5×` 或提高解码分辨率。

---

## 模式与实测速率

每个码帧携带的数据量（直接从运行中的 wasm 读出，见 `test/roundtrip.mjs`）：

| 模式 | 图块网格 | 位/格 | 每帧数据 | 图像尺寸 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `Bu` (66) | 80×69 | 6 | **3240 B** | 736×637 | **默认**。格数最少，摄像头最容易识别，手机对手机首选 |
| `B` (68) | 112×112 | 6 | **7500 B** | 1024×1024 | 密度最高，适合电脑显示器等大屏 |
| `Bm` (67) | 112×78 | 6 | **5148 B** | 1024×720 | 16:9 长条，适合横屏显示器和录屏 |
| `4C` (4) | 112×112 | 6 | **7500 B** | 1024×1024 | 0.5.x 旧调色板，兼容旧客户端 |
| `8C` (8) | 112×112 | 7 | **8750 B** | 1024×1024 | 0.5.x 八色旧调色板（仅解码） |

### 每种模式实际需要多少像素

码能不能被识别，取决于**码在摄像头画面里占多少像素**，而不是采集分辨率。
把真实渲染出来的码逐级降采样后测量解码命中率（`node test/resolution.mjs`）：

| 码宽（像素） | `B` | `Bm` | `Bu` |
| --- | --- | --- | --- |
| 720 | 86% | 86% | 100% |
| 600 | 100% | 90% | 100% |
| 512 | 79% | 86% | 98% |
| 432 | 67% | 43% | 90% |
| 360 | 26% | 38% | 79% |
| 300 | 5% | 0% | 45% |

（命中率 = 该尺寸下能成功解出喷泉码数据的帧占比，已在 3 个采样相位上平均，避免重采样走运/倒霉。）

**结论：`Bu` 比 `B` 宽容约 3 倍。** 这就是为什么默认模式是 `Bu` ——
手机拍手机时码通常只占画面 30–60%，`B` 很容易掉到 400px 以下而扫不动。

估算码宽：`采集分辨率 × 码在画面里的占比`。例如 1280 采集、码占 40% → 约 512px，
此时 `Bu` 有 98% 命中率，`B` 只有 79% 且经常凑不齐完整文件。
所以**先切 `Bu`，还不行再把接收端采集分辨率调到 1920**。

以 `B` 模式 15 fps 计算，理论吞吐是 **112 KB/s**（上游宣称 106 KB/s）。
实际上限取决于对方的识别成功率：发送端会生成 8 倍于所需的数据块，
重复的块会被接收端丢弃，所以**实际有效速率通常是 20–60 KB/s**。
识别率高的场合（大屏 + 稳的三脚架）可以接近上限。

---

## 架构

```
app/                     ← 唯一源码，PWA 与原生 App 共用
  index.html            单页：发送 / 接收 / 导入解码
  css/app.css
  js/
    cimbar.js           引擎核心：模式表、wasm 加载、工具函数
    send.js             发送端：驱动上游 wasm 编码器，向 canvas 渲染帧
    recv.js             接收端：摄像头 → 抓帧 → 扫描 worker → 喷泉 sink → 文件
    import.js           视频 / 图片离线解码
    cimbar-worker.js    wasm 宿主，两个角色（scan / sink）
    ui.js               界面接线（含原生桥，PWA 下自动降级）
  sw.js  manifest.webmanifest  icons/
  vendor/               上游未修改的 wasm 产物（见 vendor/UPSTREAM.md）

native/                  ← 独立运行的 iOS App
  AirCimbar/            SwiftUI 外壳 + 回环服务器 + WKWebView + JS 桥
  project.yml           XcodeGen 工程描述
  web/                  由 tools/sync-web.mjs 从 app/ 生成，不入库
  README.md             安装与构建说明

serve.mjs               HTTPS 静态服务器（PWA 用）
tools/make-icons.py     图标生成器（纯 Python，无第三方依赖）
tools/sync-web.mjs      把 app/ 同步进 iOS 包
test/                   验证套件
```

**主线程不跑任何 wasm。** 解码全部放在 worker 里：N 个 `scan` worker 负责
`cimbard_scan_extract_decode`（画面 → 喷泉码数据），1 个 `sink` worker 负责
`cimbard_fountain_decode` + zstd 还原。这样界面不会卡，也避免了同时开着发送端时
编码器和解码器争抢同一个 wasm 实例里 thread-local 的配置。

每个 wasm 实例会预留 128 MB 堆，所以 worker 数量是有意压低的（默认 3 个扫描 + 1 个 sink）。

### 已知限制：iOS 独立模式可能读不到缓存（Apple 侧问题）

有报告指出 iOS 18 起，**添加到主屏幕后的独立模式（standalone）完全不做 Service Worker
缓存**，而同一个站点在 Safari 里离线却正常：[SO #79375555](https://stackoverflow.com/questions/79375555)
（该问题至今无解）。[SO #60689146](https://stackoverflow.com/questions/60689146) 也是同样的症状。

这个项目自身的缓存逻辑是**对的**，已实测验证：加载一次后，Cache Storage 里有全部 14 个文件
（含 1.9 MB 的 wasm），关掉服务器再重载，页面、脚本和 wasm 都照常从缓存取出
（`node test/sw-update.mjs`）。所以如果手机上独立模式打不开，那是 WebKit 没有把
Service Worker 用在独立模式上，不是缓存没写进去。

**怎么判断属于哪种情况：**

1. 页脚会直接告诉你状态：
   * `离线就绪 · 已缓存 14 项 · aircimbar-v6` → 缓存完整，问题在独立模式
   * `缓存不完整（缺 N 项）` → 还没缓存全，联网重开一次
   * `未缓存（需联网加载）` → Service Worker 没有接管
2. 开飞行模式，用 **Safari 直接打开网址**（不要点主屏幕图标）。能打开就说明
   Service Worker 正常，问题只出在独立模式。

**绕不过去时用原生 App** —— 它把所有资源打包进 IPA，完全不依赖 Service Worker，
因此这个 iOS 缺陷影响不到它。见 [`native/README.md`](native/README.md)。

### 一个踩过的坑：缓存优先的 Service Worker 把更新锁死了

一开始 `sw.js` 对所有资源都是 cache-first，结果是**装上之后再改任何东西，手机都拿不到** ——
必须手动把缓存版本号加一才行。这对「边用边改」是致命的。

改成按需分流：`/vendor/`（1.9 MB wasm，内容稳定）继续 cache-first；
html/css/js 走 **network-first**，取不到才回落到缓存。这样一次重载就拿到新版本，
而服务器关掉时依然能离线打开。`test/sw-update.mjs` 同时验证这两条：
它改一次磁盘上的源码、重载一次看是否生效，然后**真的把服务器关掉**再重载，
确认页面、脚本和 wasm 都还能从缓存里取出来。

### 一个踩过的坑：广播中改设置会中断

`cimbare_configure()` 在新参数下 `restart_and_resize_buffer()` 失败时会把编码流
`_fes` 置空（`cimbar_js.cpp`），而 `_cimbare_next_frame()` 遇到空流返回 -1。
界面在改完参数后才异步重新喂数据，rAF 循环正好撞进这个空窗期，于是报
「next_frame 失败 (-1)」并停止广播。

修法是让帧循环在重配置期间主动停手（`send.js` 的 `S.reconfiguring`），
并把偶发的 -1 当作可恢复情况而不是致命错误。回归测试见 `test/reconfigure.mjs`，
它已验证过：把修复还原回去，这个测试会失败。

### 另一个踩过的坑：证书警告页仍然是安全上下文

这是自建 HTTPS 的 PWA 最关键的未知数：**点过「继续访问」之后，摄像头还能用吗？**
答案是能。我用真实 WebKit（iOS Safari 同一个引擎）加载了一个自签名证书的 HTTPS 页面、
按「继续访问」的方式接受了证书，然后在页面里读 `window.isSecureContext` —— 结果是 `true`，
`serviceWorker` 和 `crypto.subtle` 也都在。安全上下文的判定只看 scheme 和 host，不看证书是否受信任。

复现方式：`test/secure-context/main.swift`。

所以证书警告不会让摄像头失效，**但它会在每次冷启动时出现**，这才是要装 CA 的真正理由。

### 一个踩过的坑：不要用浏览器的原生 VideoFrame

`recv.js` 抓帧**故意**走 canvas 2D → RGBA，而不是把浏览器给的 `VideoFrame`（NV12/I420）
直接交给解码器。实测（libcimbar v0.6.8 + wasm）：同一帧画面，canvas RGBA 路径正常解出
7500 字节，原生 NV12 缓冲区在**每一帧**上都返回 `-3`（提取失败）。
canvas 还顺带解决了缩放和行序（GL 是自下而上）问题。复现脚本：`test/camera-probe.mjs`。

---

## 测试

全部测试都在本机跑，**不需要 Xcode、不需要 OpenCV、不需要 cmake**——
上游 wasm 产物直接加载即可。Chrome 用无头模式提供 WebGL，用 CDP 驱动真实界面。

```sh
node test/run-all.mjs            # 全部（约 3–4 分钟）
node test/run-all.mjs --quick    # 跳过较慢的摄像头 / 视频 / 原生路径
```

（或用 `npm test` / `npm run test:quick`。）

单独跑：

```sh
node test/probe.mjs                                  # wasm 能否在 Node 里实例化，及各模式缓冲大小
node test/roundtrip.mjs --mode 68 --size 8192        # 编码→解码闭环，Node 侧解码 + 哈希比对
node test/app-roundtrip.mjs --mode 68 --size 61440   # 驱动真实 app 模块（send.js + cimbar-worker.js）
node test/ui-smoke.mjs                               # 界面接线：元素、标签页、控件、控制台报错
node test/camera-roundtrip.mjs --mode 68 --size 4096 # 假摄像头 → 真实 recv.js → 比对哈希
node test/import-roundtrip.mjs --mode 68 --size 4096 # MediaRecorder 录屏 → 真实 import.js → 比对哈希
node test/camera-probe.mjs                           # 诊断：RGBA vs 原生 VideoFrame 两条抓帧路径
node test/swift-typecheck.mjs                        # 原生 Swift 全量类型检查（macOS SDK）
node test/native-smoke.mjs                           # 编译并运行 回环服务器 + WKWebView
node tools/sync-web.mjs --check                      # 包内 web/ 是否与 app/ 同步
```

（`test/secure-context/main.swift` 是上面那个证书/安全上下文探针，需手动编译：
`swiftc -O -module-cache-path /tmp/mc -o /tmp/secctx test/secure-context/main.swift`）

已验证的结论（全部**字节级一致**）：

| 覆盖范围 | 结果 |
| --- | --- |
| 4 种模式 `B` / `Bm` / `Bu` / `4C` 编码→解码闭环 | ✅ |
| 真实 app 模块（`send.js` + `cimbar-worker.js`），60 KB / 40 帧 | ✅ |
| 摄像头路径：假摄像头 → 真实界面点击「开始扫描」→ `recv.js` → 文件（60 KB / B 模式） | ✅ |
| 摄像头路径，`Bm` / `Bu` / `4C` 模式 | ✅ |
| 导入路径：录屏视频 → `import.js` → 文件 | ✅ |
| 界面接线：全部元素存在、三个标签页、滑杆与分段控件、无控制台报错 | ✅ |
| 原生外壳：回环服务器 + WKWebView 离线跑通包内 App，wasm 引擎在 WebKit 内初始化成功 | ✅ |
| 原生外壳：JS ↔ 原生桥（`ready` / `keepAwake` / 分块文件传输） | ✅ |
| 原生外壳：`LocalHTTPServer` 只绑回环、目录穿越 403、缺失 404、非 GET 405 | ✅ |
| 原生 Swift 源码类型检查（6 个文件，macOS SDK） | ✅ |

`test/camera-roundtrip.mjs` 用 Chrome 的 `--use-file-for-fake-video-capture` 把
渲染好的码帧做成 Y4M 假摄像头，再用 CDP 点击真实界面上的按钮，
所以它覆盖的是手机上的同一条代码路径，而不是一份平行的测试实现。

`test/import-roundtrip.mjs` 用 `MediaRecorder` 把码帧录成视频，再通过
`DOM.setFileInputFiles` 塞进真实的 `<input type=file>`，走完整的导入流程。

---

## 限制

* **单个文件约 33 MB** —— 上游 wirehair 喷泉码把整个文件放在内存里，这是硬限制。
  更大的文件请先用 `cimbar-bigfile` 之类的工具分卷。
* **必须 HTTPS** —— iOS 的安全上下文要求，`node serve.mjs --http` 仅供桌面调试。
* **33 MB 文件在这个速率下要很久** —— 10 MB 按 40 KB/s 大约 4 分钟，且发送端不能熄屏。
* **iOS 上无法用 Fullscreen API** —— 用界面里的「双击画面」进入的全屏模式代替。
* 发送端长时间广播会比较费电、发热。
* **原生 App 需要侧载** —— 免费 Apple ID 签名的有效期是 7 天，过期后重新侧载一次即可
  （App 数据不丢）。详见 [`native/README.md`](native/README.md)。
* **iOS 18+ 的「主屏幕独立模式」可能完全不走 Service Worker 缓存** —— 见下。

---

## 授权与致谢

* 编解码器：[sz3/libcimbar](https://github.com/sz3/libcimbar)（MPL-2.0），`app/vendor/` 下的
  wasm 产物为上游未修改的构建结果，同样适用 MPL-2.0。
* 界面参考：[topcss/AirScan-QR](https://github.com/topcss/AirScan-QR)（MIT）。
* libcimbar 内部依赖：wirehair、zstd、libcorrect、OpenCV 等，详见上游文档。
