//
//  main.swift — native shell smoke test (macOS harness)
//
//  Exercises the same two pieces the iOS app is built from, on macOS:
//
//    1. LocalHTTPServer serves the bundled web app over loopback
//    2. a WKWebView loads it and runs it
//
//  It asserts the app boots, that the JS bridge is detected and actually
//  reaches native code, and that the libcimbar wasm engine initialises inside
//  WebKit. Everything happens with no network access.
//
//  build+run:
//    swiftc -O -module-cache-path <cache> \
//      native/AirCimbar/LocalHTTPServer.swift test/WebViewSmoke.swift -o /tmp/airsmoke
//    /tmp/airsmoke native/AirCimbar/web
//

import Foundation
import AppKit
import WebKit

// MARK: - arguments

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: smoke <web-root>\n".utf8))
    exit(2)
}
let webRoot = URL(fileURLWithPath: CommandLine.arguments[1])

func fail(_ message: String) -> Never {
    print("❌ \(message)")
    exit(1)
}

// MARK: - server

let server = LocalHTTPServer(root: webRoot)
let port: UInt16
do {
    port = try server.start()
} catch {
    fail("LocalHTTPServer failed to start: \(error)")
}
print("▶ loopback server on 127.0.0.1:\(port)")

// MARK: - bridge recorder

final class BridgeRecorder: NSObject, WKScriptMessageHandler {
    private(set) var types: [String] = []
    private(set) var fileBytes = 0
    private(set) var fileNames: [String] = []
    private(set) var keepAwakeValues: [Bool] = []

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        types.append(type)
        switch type {
        case "keepAwake": keepAwakeValues.append(body["on"] as? Bool ?? false)
        case "fileBegin": fileNames.append(body["name"] as? String ?? "?")
        case "fileChunk":
            if let encoded = body["data"] as? String, let data = Data(base64Encoded: encoded) {
                fileBytes += data.count
            }
        default: break
        }
    }
}

// MARK: - web view host

final class Host: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let recorder = BridgeRecorder()
    var didFinish = false
    var loadError: String?

    override init() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(recorder, name: "aircimbar")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 430, height: 932),
                            configuration: config)
        super.init()
        webView.navigationDelegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { didFinish = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadError = error.localizedDescription
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        loadError = error.localizedDescription
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let host = Host()
// A window keeps WebKit's rendering path (and therefore WebGL) alive.
let window = NSWindow(contentRect: NSRect(x: -2000, y: -2000, width: 430, height: 932),
                      styleMask: [.borderless],
                      backing: .buffered,
                      defer: false)
window.contentView = host.webView
window.orderBack(nil)

let url = URL(string: "http://127.0.0.1:\(port)/index.html?native=1")!
host.webView.load(URLRequest(url: url, timeoutInterval: 30))

// MARK: - drive

/// WebKit delivers the completion on the main queue, so pumping the run loop
/// is the only safe way to wait — blocking the main thread here would
/// deadlock against the callback.
func evaluate(_ js: String, timeout: TimeInterval = 45) -> Any? {
    var output: Any?
    var finished = false
    host.webView.evaluateJavaScript(js) { value, error in
        if let error { output = ["__error": error.localizedDescription] }
        else { output = value }
        finished = true
    }
    let limit = Date().addingTimeInterval(timeout)
    while !finished && Date() < limit {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    return output
}

let deadline = Date().addingTimeInterval(60)
while !host.didFinish && host.loadError == nil && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
}

if let loadError = host.loadError { fail("page failed to load: \(loadError)") }
if !host.didFinish { fail("page never finished loading") }

print("▶ page loaded")

// let the app's scripts settle and post their bridge messages
RunLoop.main.run(until: Date().addingTimeInterval(2.5))

struct Report: Decodable {
    let readyState: String
    let missingModules: [String]
    let modes: [String]
    let wasmURL: String
    let bridgeDetected: Bool
    let title: String
    let panels: [String]
}

let probe = """
JSON.stringify({
  readyState: document.readyState,
  missingModules: ['AirCimbar','AirCimbarSender','AirCimbarReceiver','AirCimbarImport'].filter(k => !window[k]),
  modes: Object.keys(window.AirCimbar ? window.AirCimbar.MODES : {}),
  wasmURL: window.AirCimbar ? window.AirCimbar.vendorURL(window.AirCimbar.WASM) : '',
  bridgeDetected: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.aircimbar),
  title: document.title,
  panels: ['send','receive','import'].filter(p => !!document.getElementById('panel-' + p))
})
"""

guard let raw = evaluate(probe) as? String,
      let data = raw.data(using: .utf8),
      let report = try? JSONDecoder().decode(Report.self, from: data) else {
    fail("could not read the page state: \(String(describing: evaluate(probe)))")
}

print("▶ readyState=\(report.readyState)  title=\(report.title)")
print("▶ modes=\(report.modes.joined(separator: ","))  panels=\(report.panels.joined(separator: ","))")
print("▶ wasmURL=\(report.wasmURL)")
print("▶ bridge detected by web layer: \(report.bridgeDetected)")
print("▶ bridge messages received natively: \(host.recorder.types)")

// MARK: - wasm engine inside WebKit

let engineProbe = """
window.__smoke = { done: false, ok: false, err: '' };
(async () => {
  try {
    AirCimbarSender.init(document.getElementById('qrCanvas'));
    await AirCimbarSender.ensureWasm();
    AirCimbarSender.setFps(1000);
    await AirCimbarSender.setMode(68);
    const bytes = new TextEncoder().encode('aircimbar native smoke test');
    await AirCimbarSender.prepare(new Blob([bytes]), 'smoke.txt');
    window.__smoke.ok = AirCimbarSender.state.prepared;
  } catch (e) {
    window.__smoke.err = String(e && e.message || e);
  }
  window.__smoke.done = true;
})();
'the engine probe started'
"""

_ = evaluate(engineProbe, timeout: 15)

let engineDeadline = Date().addingTimeInterval(60)
var engineResult: [String: Any] = [:]
while Date() < engineDeadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.4))
    if let value = evaluate("JSON.stringify(window.__smoke || {})", timeout: 10) as? String,
       let d = value.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
       obj["done"] as? Bool == true {
        engineResult = obj
        break
    }
}

// MARK: - verdict

var problems: [String] = []
if report.readyState != "complete" { problems.append("document not complete") }
if !report.missingModules.isEmpty { problems.append("missing modules: \(report.missingModules)") }
if report.modes.count != 5 { problems.append("mode table incomplete: \(report.modes)") }
if report.panels.count != 3 { problems.append("missing panels: \(report.panels)") }
if !report.bridgeDetected { problems.append("web layer did not detect the native bridge") }
if !host.recorder.types.contains("ready") { problems.append("native never received the bridge 'ready' message") }
if host.recorder.types.isEmpty { problems.append("no bridge messages arrived at all") }
if engineResult["ok"] as? Bool != true {
    problems.append("wasm engine did not initialise in WebKit: \(engineResult["err"] ?? "unknown")")
}

// the keep-awake path
_ = evaluate("""
(function () {
  const b = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.aircimbar;
  if (b) b.postMessage({ type: 'keepAwake', on: true });
  return 'sent';
})()
""", timeout: 10)
RunLoop.main.run(until: Date().addingTimeInterval(0.8))
if host.recorder.keepAwakeValues != [true] {
    problems.append("keepAwake bridge message did not arrive (got \(host.recorder.keepAwakeValues))")
}

// the file-save path, exercising the chunked base64 protocol end to end
_ = evaluate("""
(function () {
  const b = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.aircimbar;
  if (!b) return 'no bridge';
  b.postMessage({ type: 'fileBegin', name: '../evil/name.bin', size: 5, mime: 'application/octet-stream' });
  b.postMessage({ type: 'fileChunk', data: btoa('hello') });
  b.postMessage({ type: 'fileEnd' });
  return 'sent';
})()
""", timeout: 10)
RunLoop.main.run(until: Date().addingTimeInterval(1.0))
if host.recorder.fileBytes != 5 {
    problems.append("fileChunk bridge did not deliver 5 bytes (got \(host.recorder.fileBytes))")
}
if host.recorder.fileNames.isEmpty {
    problems.append("fileBegin bridge did not arrive")
}

print("")
if problems.isEmpty {
    print("✅ NATIVE SMOKE OK — loopback server + WKWebView ran the bundled app offline,")
    print("   wasm engine initialised, and the bridge carried ready/keepAwake/file messages.")
    server.stop()
    exit(0)
} else {
    print("❌ NATIVE SMOKE FAILED")
    for p in problems { print("   • \(p)") }
    server.stop()
    exit(1)
}
