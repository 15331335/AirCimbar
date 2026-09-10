//
//  main.swift — "will the camera work behind a certificate warning?" probe
//
//  The whole PWA plan depends on one question: after the user taps through
//  Safari's untrusted-certificate warning, is the page still a *secure
//  context*? getUserMedia and service workers are refused outside one.
//
//  This loads the app in real WebKit (the same engine iOS Safari uses) over
//  HTTPS with a self-signed certificate, accepting the challenge exactly the
//  way "proceed anyway" does, and reports what the page can actually do.
//
//  A plain-HTTP non-loopback origin is probed too, as a negative control:
//  it must report an insecure context, otherwise the probe proves nothing.
//
//  usage: securectx <https-url> <http-url>
//

import Foundation
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count > 2 else {
    FileHandle.standardError.write(Data("usage: securectx <https-url> <http-url>\n".utf8))
    exit(2)
}
let httpsURL = URL(string: args[1])!
let httpURL = URL(string: args[2])!

// MARK: - app plumbing

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class Probe: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    var loaded = false
    var loadError: String?
    /// Accepting the challenge is the programmatic equivalent of a user
    /// tapping through Safari's warning.
    var acceptedUntrustedCert = false

    override init() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 430, height: 932), configuration: config)
        super.init()
        webView.navigationDelegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadError = error.localizedDescription
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) { loadError = error.localizedDescription }

    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        acceptedUntrustedCert = true
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

let probe = Probe()
let window = NSWindow(contentRect: NSRect(x: -2000, y: -2000, width: 430, height: 932),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = probe.webView
window.orderBack(nil)

/// WebKit delivers results on the main queue, so pump the run loop rather
/// than blocking it.
func evaluate(_ js: String, timeout: TimeInterval = 30) -> Any? {
    var output: Any?
    var finished = false
    probe.webView.evaluateJavaScript(js) { value, error in
        output = error.map { ["__error": $0.localizedDescription] } ?? value
        finished = true
    }
    let limit = Date().addingTimeInterval(timeout)
    while !finished && Date() < limit {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    return output
}

func load(_ url: URL) -> Bool {
    probe.loaded = false
    probe.loadError = nil
    probe.webView.load(URLRequest(url: url, timeoutInterval: 25))
    let limit = Date().addingTimeInterval(35)
    while !probe.loaded && probe.loadError == nil && Date() < limit {
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    }
    return probe.loaded && probe.loadError == nil
}

// MARK: - the probe itself

/// Starts the probe. The result lands in window.__probe because
/// evaluateJavaScript does not await promises — the caller polls instead.
let startProbeJS = """
window.__probe = { done: false };
(async () => {
  const out = {
    isSecureContext: window.isSecureContext,
    hasMediaDevices: !!(navigator.mediaDevices),
    hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasSubtleCrypto: !!(window.crypto && window.crypto.subtle),
    hasServiceWorker: ('serviceWorker' in navigator),
    origin: location.origin,
    appLoaded: !!(window.AirCimbar && window.AirCimbarSender)
  };
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    out.gumResult = 'RESOLVED (camera opened)';
    s.getTracks().forEach(t => t.stop());
  } catch (e) {
    out.gumResult = e.name + ': ' + e.message;
  }
  out.done = true;
  window.__probe = out;
})();
'probe started'
"""

func report(_ label: String, _ url: URL) {
    print("\n───────── \(label) ─────────")
    print("  url: \(url.absoluteString)")
    guard load(url) else {
        print("  ❌ load failed: \(probe.loadError ?? "unknown")")
        return
    }
    _ = evaluate(startProbeJS, timeout: 10)

    // poll until the async probe finishes
    var obj: [String: Any]?
    let probeDeadline = Date().addingTimeInterval(35)
    while Date() < probeDeadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        if let raw = evaluate("JSON.stringify(window.__probe || {})", timeout: 10) as? String,
           let data = raw.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           parsed["done"] as? Bool == true {
            obj = parsed
            break
        }
    }
    guard let obj else {
        print("  ❌ probe returned nothing")
        return
    }
    let secure = (obj["isSecureContext"] as? Bool) ?? false
    print("  isSecureContext : \(secure ? "✅ true" : "❌ false")")
    print("  mediaDevices    : \(obj["hasMediaDevices"] as? Bool == true ? "present" : "ABSENT")")
    print("  getUserMedia    : \(obj["hasGetUserMedia"] as? Bool == true ? "present" : "ABSENT")")
    print("  crypto.subtle   : \(obj["hasSubtleCrypto"] as? Bool == true ? "present" : "ABSENT")")
    print("  serviceWorker   : \(obj["hasServiceWorker"] as? Bool == true ? "available" : "UNAVAILABLE")")
    print("  app JS loaded   : \(obj["appLoaded"] as? Bool == true ? "yes" : "no")")
    print("  getUserMedia()  : \(obj["gumResult"] ?? "?")")
    if probe.acceptedUntrustedCert {
        print("  (accepted an untrusted certificate to load this page)")
    }
}

report("HTTPS + untrusted cert (Safari: 点了「继续访问」)", httpsURL)
report("plain HTTP on a LAN IP (negative control — must be insecure)", httpURL)

print("")
probe.webView.stopLoading()
exit(0)
