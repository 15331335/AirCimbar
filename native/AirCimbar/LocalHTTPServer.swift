//
//  LocalHTTPServer.swift
//  AirCimbar
//
//  A minimal loopback HTTP server that serves the bundled web app.
//
//  Why this exists: the whole point of the phone app is the camera, and
//  WebKit only exposes getUserMedia to a *secure context*. Content loaded
//  straight out of the bundle over file:// is not one, so the web app would
//  come up with a dead viewfinder. `http://127.0.0.1:<port>` IS a trustworthy
//  origin (the loopback range is explicitly listed as such in the secure
//  contexts spec), which is the same reason Capacitor and Cordova serve their
//  bundles from localhost rather than from the filesystem.
//
//  This is deliberately tiny: GET only, no keep-alive, no ranges. It serves a
//  handful of static files to a single local client and never leaves the
//  device.
//

import Foundation
import Network

final class LocalHTTPServer {

    /// Directory whose contents are exposed. Reads are confined to it.
    private let root: URL
    private let queue = DispatchQueue(label: "org.aircimbar.httpserver")

    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    /// Port actually bound (0 in, ephemeral port out).
    private(set) var port: UInt16 = 0

    /// Extra headers added to every response.
    private let extraHeaders: [String: String]

    init(root: URL, extraHeaders: [String: String] = [:]) {
        self.root = root.standardizedFileURL
        self.extraHeaders = extraHeaders
    }

    // MARK: - Lifecycle

    /// Binds to 127.0.0.1 on an ephemeral port and starts accepting.
    @discardableResult
    func start(preferredPort: UInt16 = 0) throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // Loopback only: this must never be reachable from the network.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(rawValue: preferredPort) ?? .any
        )

        let listener = try NWListener(using: params)
        self.listener = listener

        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }

        let ready = DispatchSemaphore(value: 0)
        var startError: Error?

        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case .failed(let error):
                startError = error
                ready.signal()
            default:
                break
            }
        }

        listener.start(queue: queue)

        // The listener reports .ready or .failed within moments; a short
        // bounded wait keeps startup deterministic without blocking forever.
        _ = ready.wait(timeout: .now() + 5)
        if let startError { throw startError }
        guard let bound = listener.port?.rawValue else {
            throw NSError(domain: "AirCimbar", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "服务器未能绑定端口"])
        }
        port = bound
        return bound
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for (_, connection) in connections { connection.cancel() }
        connections.removeAll()
    }

    // MARK: - Connections

    private func accept(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        connections[key] = connection

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.queue.async { self?.connections.removeValue(forKey: key) }
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] chunk, _, isComplete, error in
            guard let self else { return }

            var accumulated = buffer
            if let chunk { accumulated.append(chunk) }

            if error != nil {
                connection.cancel()
                return
            }

            // A GET request header block ends at the first blank line.
            if let headerEnd = accumulated.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = accumulated.subdata(in: accumulated.startIndex..<headerEnd.lowerBound)
                self.respond(to: headerData, on: connection)
                return
            }

            // Guard against an unbounded header from a hostile local client.
            if accumulated.count > 32 * 1024 || isComplete {
                self.send(status: 431, reason: "Request Header Fields Too Large",
                          contentType: "text/plain; charset=utf-8",
                          body: Data("header too large\n".utf8), on: connection)
                return
            }

            self.receive(on: connection, buffer: accumulated)
        }
    }

    private func respond(to headerData: Data, on connection: NWConnection) {
        guard let headerText = String(data: headerData, encoding: .utf8),
              let requestLine = headerText.split(separator: "\r\n", maxSplits: 1).first
        else {
            send(status: 400, reason: "Bad Request", contentType: "text/plain; charset=utf-8",
                 body: Data("bad request\n".utf8), on: connection)
            return
        }

        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            send(status: 400, reason: "Bad Request", contentType: "text/plain; charset=utf-8",
                 body: Data("bad request\n".utf8), on: connection)
            return
        }

        let method = String(parts[0])
        guard method == "GET" || method == "HEAD" else {
            send(status: 405, reason: "Method Not Allowed", contentType: "text/plain; charset=utf-8",
                 body: Data("only GET is supported\n".utf8), on: connection)
            return
        }

        let rawPath = String(parts[1])
        let pathOnly = rawPath.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"

        let fileURL: URL
        switch resolve(pathOnly) {
        case .file(let url):
            fileURL = url
        case .forbidden:
            send(status: 403, reason: "Forbidden", contentType: "text/plain; charset=utf-8",
                 body: Data("forbidden\n".utf8), on: connection)
            return
        case .notFound:
            send(status: 404, reason: "Not Found", contentType: "text/plain; charset=utf-8",
                 body: Data("404 \(pathOnly)\n".utf8), on: connection)
            return
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            send(status: 404, reason: "Not Found", contentType: "text/plain; charset=utf-8",
                 body: Data("404 \(pathOnly)\n".utf8), on: connection)
            return
        }

        let body = method == "HEAD" ? Data() : data
        send(status: 200, reason: "OK",
             contentType: MimeType.forExtension(fileURL.pathExtension),
             body: body,
             contentLengthOverride: data.count,
             on: connection)
    }

    enum Resolution {
        case file(URL)
        case forbidden
        case notFound
    }

    /// Maps a URL path onto a file inside `root`, refusing anything that
    /// escapes it (`../`, encoded traversal, absolute paths). Keeps "refused"
    /// and "absent" distinct so the client gets 403 vs 404.
    private func resolve(_ path: String, depth: Int = 0) -> Resolution {
        guard depth < 4 else { return .notFound }

        var decoded = path
        if let unescaped = path.removingPercentEncoding { decoded = unescaped }

        if decoded.isEmpty { decoded = "/" }
        if decoded == "/" { decoded = "/index.html" }

        // Reject NUL and traversal outright rather than relying on
        // standardization alone.
        if decoded.contains("\0") { return .forbidden }
        let components = decoded.split(separator: "/", omittingEmptySubsequences: true)
        if components.contains("..") { return .forbidden }

        let candidate = root.appendingPathComponent(components.joined(separator: "/")).standardizedFileURL
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPath) else { return .forbidden }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else {
            return .notFound
        }
        if isDirectory.boolValue {
            guard components.last?.lowercased() != "index.html" else { return .notFound }
            return resolve("/" + components.joined(separator: "/") + "/index.html", depth: depth + 1)
        }
        return .file(candidate)
    }

    private func send(status: Int,
                      reason: String,
                      contentType: String,
                      body: Data,
                      contentLengthOverride: Int? = nil,
                      on connection: NWConnection) {
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(contentLengthOverride ?? body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n"
        for (key, value) in extraHeaders {
            head += "\(key): \(value)\r\n"
        }
        head += "\r\n"

        var response = Data(head.utf8)
        response.append(body)

        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

// MARK: - MIME types

enum MimeType {
    static func forExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        // must be exact or WebAssembly.instantiateStreaming refuses the bytes
        case "wasm": return "application/wasm"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
