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
node serve.mjs                 # 默认 https://<本机>:8443，自动使用 ../certs 的 linyango.cn 证书
```

终端会打印出可用的地址，例如：

```
https://localhost:8443/                     在本机浏览器测试
https://192.168.1.102:8443/                 同一 Wi-Fi 下的 iPhone
https://linyango.cn:8443/                   有域名证书，最省事（需把 8443 转发到本机）
```

在 iPhone 上用 **Safari** 打开上面的地址，然后：

1. 点底部分享按钮 → **添加到主屏幕**
2. 从主屏幕启动 AirCimbar，它会全屏运行，和原生 App 一样
3. 首次点「开始扫描」时允许摄像头权限

> 用 IP 访问时 Safari 会提示证书不受信任（证书签发给 `linyango.cn`）。
> 点「显示详细信息 → 访问此网站」即可，之后摄像头和离线缓存都正常工作。
> 想彻底避免这个提示，就把 8443 端口转发到本机并用 `https://linyango.cn:8443/` 访问。

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
| `B` (68) | 112×112 | 6 | **7500 B** | 1024×1024 | 默认，密度与稳健性最均衡 |
| `Bm` (67) | 112×78 | 6 | **5148 B** | 1024×720 | 16:9 长条，适合横屏显示器 |
| `Bu` (66) | 80×69 | 6 | **3240 B** | 736×637 | 码更小，远距离 / 低分辨率更稳 |
| `4C` (4) | 112×112 | 6 | **7500 B** | 1024×1024 | 0.5.x 旧调色板，兼容旧客户端 |
| `8C` (8) | 112×112 | 7 | **8750 B** | 1024×1024 | 0.5.x 八色旧调色板（仅解码） |

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

---

## 授权与致谢

* 编解码器：[sz3/libcimbar](https://github.com/sz3/libcimbar)（MPL-2.0），`app/vendor/` 下的
  wasm 产物为上游未修改的构建结果，同样适用 MPL-2.0。
* 界面参考：[topcss/AirScan-QR](https://github.com/topcss/AirScan-QR)（MIT）。
* libcimbar 内部依赖：wirehair、zstd、libcorrect、OpenCV 等，详见上游文档。
