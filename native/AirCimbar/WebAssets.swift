//
//  WebAssets.swift
//  AirCimbar
//
//  Locates the web app that ships inside the bundle.
//

import Foundation

enum WebAssets {

    /// The `web` folder copied into the app bundle's resources.
    ///
    /// `tools/sync-web.mjs` mirrors `app/` into `native/AirCimbar/web/` so the
    /// exact same bytes that were verified as a PWA are what runs inside the
    /// app — there is no second copy of the app to keep in sync.
    static func rootURL() -> URL? {
        if let bundled = Bundle.main.url(forResource: "web", withExtension: nil),
           FileManager.default.fileExists(atPath: bundled.appendingPathComponent("index.html").path) {
            return bundled
        }

        // Development escape hatch: point at a checkout instead of the bundle.
        if let override = ProcessInfo.processInfo.environment["AIRCIMBAR_WEB_ROOT"] {
            let url = URL(fileURLWithPath: override)
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("index.html").path) {
                return url
            }
        }
        return nil
    }

    /// Sanity check that the assets needed to boot are actually present —
    /// a missing wasm shows up as a blank screen otherwise.
    static func validate(_ root: URL) -> String? {
        let required = ["index.html", "js/cimbar.js", "js/cimbar-worker.js", "vendor/cimbar_js.wasm"]
        for relative in required {
            let path = root.appendingPathComponent(relative).path
            if !FileManager.default.fileExists(atPath: path) {
                return "缺少内置资源：\(relative)"
            }
        }
        return nil
    }
}
