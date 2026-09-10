//
//  PlatformSupport.swift
//  AirCimbar
//
//  The handful of things the web layer cannot do for itself on iOS:
//  holding the screen awake while broadcasting, saving a received file
//  through the system share sheet, and requesting camera access up front.
//
//  Everything here is written so the project still type-checks on macOS
//  (where it compiles to harmless no-ops), which keeps the whole app
//  verifiable on a machine without an iOS SDK.
//

import Foundation

#if os(iOS)
import UIKit
import AVFoundation
#elseif os(macOS)
import AppKit
#endif

// MARK: - Screen sleep

enum IdleTimer {

    /// `navigator.wakeLock` is unreliable inside WKWebView, so the web layer
    /// asks the native side to hold the screen awake while it is broadcasting.
    static func setDisabled(_ disabled: Bool) {
        #if os(iOS)
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = disabled
        }
        #endif
    }
}

// MARK: - Camera permission

enum CameraPermission {

    enum Status {
        case authorized, denied, undetermined
    }

    static var current: Status {
        #if os(iOS)
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .notDetermined: return .undetermined
        default: return .denied
        }
        #else
        return .authorized
        #endif
    }

    /// Asking before the web view tries `getUserMedia` means the system prompt
    /// appears in a context the user understands, instead of the web view
    /// silently failing.
    static func request(_ completion: @escaping (Status) -> Void) {
        #if os(iOS)
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            completion(.authorized)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { completion(granted ? .authorized : .denied) }
            }
        default:
            completion(.denied)
        }
        #else
        completion(.authorized)
        #endif
    }

    /// Deep link into Settings so a denied user has somewhere to go.
    static func openSettings() {
        #if os(iOS)
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
        #endif
    }
}

// MARK: - Saving a received file

enum FileExport {

    /// Writes bytes to a temporary file and hands it to the system.
    ///
    /// The web app cannot rely on `<a download>` inside WKWebView — blob
    /// downloads are not supported there — so the bridge sends the bytes
    /// across and the file is shared natively instead.
    static func share(fileURL: URL, from view: AnyObject?) {
        #if os(iOS)
        guard let controller = topViewController(from: view) else { return }
        let activity = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        // iPad and Mac Catalyst want an anchor or they trap.
        if let popover = activity.popoverPresentationController {
            popover.sourceView = controller.view
            popover.sourceRect = CGRect(x: controller.view.bounds.midX,
                                        y: controller.view.bounds.midY,
                                        width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        controller.present(activity, animated: true)
        #endif
    }

    #if os(iOS)
    private static func topViewController(from view: AnyObject?) -> UIViewController? {
        if let view = view as? UIView, let controller = view.window?.rootViewController {
            return topMost(controller)
        }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
            ?? scenes.flatMap { $0.windows }.first
        return window?.rootViewController.map(topMost)
    }

    private static func topMost(_ controller: UIViewController) -> UIViewController {
        if let presented = controller.presentedViewController { return topMost(presented) }
        if let nav = controller as? UINavigationController, let visible = nav.visibleViewController {
            return topMost(visible)
        }
        if let tab = controller as? UITabBarController, let selected = tab.selectedViewController {
            return topMost(selected)
        }
        return controller
    }
    #endif

    /// Where received files are staged before being handed to the share sheet.
    static func stagingDirectory() -> URL {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("AirCimbarReceived", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    /// Strips path separators so a filename from the wire can never escape the
    /// staging directory.
    static func sanitize(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "aircimbar.bin" }
        let cleaned = trimmed
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        let collapsed = cleaned.replacingOccurrences(of: "..", with: "_")
        return collapsed.isEmpty ? "aircimbar.bin" : String(collapsed.prefix(180))
    }
}
