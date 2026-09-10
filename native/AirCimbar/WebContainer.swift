//
//  WebContainer.swift
//  AirCimbar
//
//  Hosts the bundled web app in a WKWebView and bridges the three things the
//  web layer cannot do on its own:
//
//    * camera permission  — WKWebView refuses getUserMedia unless the UI
//      delegate approves it for the requesting frame
//    * screen wake        — navigator.wakeLock is unreliable in WKWebView
//    * saving a file      — blob downloads do not work in WKWebView, so the
//      bytes are handed to the native share sheet instead
//
//  Written so the whole file type-checks on macOS as well as iOS, which is
//  what makes this project verifiable without an iOS SDK.
//

import Foundation
import SwiftUI
import WebKit

// MARK: - Bridge protocol

/// Messages the web layer sends up. Kept small and explicit on purpose.
enum BridgeMessage {
    static let channel = "aircimbar"

    case ready
    case keepAwake(Bool)
    case fileBegin(name: String, size: Int, mime: String)
    case fileChunk(Data)
    case fileEnd
    case log(String)
}

// MARK: - Engine

/// Owns the loopback server and the web view's lifetime.
@MainActor
final class WebEngine: NSObject, ObservableObject {

    enum Phase: Equatable {
        case starting
        case running(port: UInt16)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var lastBridgeError: String?
    @Published var reloadToken = 0

    private var server: LocalHTTPServer?
    private var pendingFile: (name: String, mime: String, handle: FileHandle, url: URL)?

    /// Boots the server. Safe to call more than once; the second call is a no-op.
    func start() {
        guard server == nil else { return }

        guard let root = WebAssets.rootURL() else {
            phase = .failed("找不到内置的网页资源。请先运行 tools/sync-web.mjs 把 app/ 同步到 native/AirCimbar/web/。")
            return
        }
        if let problem = WebAssets.validate(root) {
            phase = .failed(problem)
            return
        }

        let server = LocalHTTPServer(root: root)
        do {
            let port = try server.start()
            self.server = server
            phase = .running(port: port)
        } catch {
            phase = .failed("本地服务器启动失败：\(error.localizedDescription)")
        }
    }

    func stop() {
        server?.stop()
        server = nil
        IdleTimer.setDisabled(false)
        closePendingFile()
    }

    var startURL: URL? {
        guard case .running(let port) = phase else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/index.html?native=1")
    }

    // MARK: Camera

    func prepareCamera() {
        CameraPermission.request { _ in }
    }

    // MARK: Bridge handling

    func handle(_ message: BridgeMessage, from view: AnyObject?) {
        switch message {
        case .ready:
            lastBridgeError = nil

        case .keepAwake(let on):
            // Only ever hold the screen awake while a broadcast is running.
            IdleTimer.setDisabled(on)

        case .fileBegin(let name, _, let mime):
            closePendingFile()
            let safeName = FileExport.sanitize(name)
            let url = FileExport.stagingDirectory().appendingPathComponent(safeName)
            FileManager.default.createFile(atPath: url.path, contents: nil)
            guard let handle = try? FileHandle(forWritingTo: url) else {
                lastBridgeError = "无法创建临时文件 \(safeName)"
                return
            }
            pendingFile = (safeName, mime, handle, url)

        case .fileChunk(let data):
            guard let pending = pendingFile else { return }
            do {
                try pending.handle.write(contentsOf: data)
            } catch {
                lastBridgeError = "写入失败：\(error.localizedDescription)"
                closePendingFile()
            }

        case .fileEnd:
            guard let pending = pendingFile else { return }
            try? pending.handle.close()
            pendingFile = nil
            FileExport.share(fileURL: pending.url, from: view)

        case .log(let text):
            NSLog("[AirCimbar web] %@", text)
        }
    }

    private func closePendingFile() {
        guard let pending = pendingFile else { return }
        try? pending.handle.close()
        pendingFile = nil
    }
}

// MARK: - WKWebView

struct WebContainer {
    let engine: WebEngine
    let url: URL
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator(engine: engine) }
}

#if os(iOS)
extension WebContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeWebView() }
    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.loadIfNeeded(url: url, reloadToken: reloadToken)
    }
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.tearDown()
    }
}
#elseif os(macOS)
extension WebContainer: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { context.coordinator.makeWebView() }
    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.loadIfNeeded(url: url, reloadToken: reloadToken)
    }
    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.tearDown()
    }
}
#endif

// MARK: - Coordinator

/// Retain-cycle guard: `WKUserContentController` holds its handlers strongly,
/// and the handler is the coordinator, which in turn owns the web view.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

extension WebContainer {

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

        private let engine: WebEngine
        private weak var webView: WKWebView?
        private var loadedToken = -1

        init(engine: WebEngine) {
            self.engine = engine
            super.init()
        }

        func makeWebView() -> WKWebView {
            let config = WKWebViewConfiguration()

            // The decoder needs the camera to keep streaming, and the sender
            // needs the page to stay live while it animates frames.
            #if os(iOS)
            config.allowsInlineMediaPlayback = true
            #endif
            config.mediaTypesRequiringUserActionForPlayback = []

            let preferences = WKWebpagePreferences()
            preferences.allowsContentJavaScript = true
            config.defaultWebpagePreferences = preferences

            config.userContentController.add(WeakScriptHandler(target: self),
                                             name: BridgeMessage.channel)

            let webView = WKWebView(frame: .zero, configuration: config)
            webView.navigationDelegate = self
            webView.uiDelegate = self
            webView.allowsBackForwardNavigationGestures = false
            #if os(iOS)
            webView.scrollView.bounces = false
            webView.isOpaque = false
            webView.backgroundColor = .black
            webView.scrollView.backgroundColor = .black
            #endif
            self.webView = webView
            return webView
        }

        func loadIfNeeded(url: URL, reloadToken: Int) {
            guard reloadToken != loadedToken else { return }
            loadedToken = reloadToken
            webView?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        }

        func tearDown() {
            webView?.configuration.userContentController
                .removeScriptMessageHandler(forName: BridgeMessage.channel)
            webView?.navigationDelegate = nil
            webView?.uiDelegate = nil
            webView = nil
        }

        // MARK: Camera

        @available(iOS 15.0, macOS 12.0, *)
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            // Only ever grant this to our own loopback origin; anything else
            // has no business asking for the camera.
            guard origin.host == "127.0.0.1" || origin.host == "localhost" else {
                decisionHandler(.deny)
                return
            }
            switch type {
            case .camera, .cameraAndMicrophone:
                decisionHandler(.grant)
            default:
                decisionHandler(.deny)
            }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView,
                     didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            NSLog("[AirCimbar] provisional load failed: %@", error.localizedDescription)
        }

        /// The web content process can be killed under memory pressure — with
        /// several 128 MB wasm heaps alive that is a real possibility. Reload
        /// rather than leaving a dead white screen.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            NSLog("[AirCimbar] web content process terminated; reloading")
            webView.reload()
        }

        // MARK: Bridge

        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            var parsed: BridgeMessage?
            switch type {
            case "ready":
                parsed = .ready
            case "keepAwake":
                parsed = .keepAwake(body["on"] as? Bool ?? false)
            case "fileBegin":
                parsed = .fileBegin(name: body["name"] as? String ?? "aircimbar.bin",
                                    size: body["size"] as? Int ?? 0,
                                    mime: body["mime"] as? String ?? "application/octet-stream")
            case "fileChunk":
                if let encoded = body["data"] as? String, let data = Data(base64Encoded: encoded) {
                    parsed = .fileChunk(data)
                }
            case "fileEnd":
                parsed = .fileEnd
            case "log":
                parsed = .log(body["message"] as? String ?? "")
            default:
                break
            }

            guard let parsed else { return }
            let view = webView
            Task { @MainActor in engine.handle(parsed, from: view) }
        }
    }
}
