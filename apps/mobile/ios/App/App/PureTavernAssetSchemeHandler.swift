import Foundation
import UniformTypeIdentifiers
import WebKit

final class PureTavernAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private enum TaskMode {
        case bridged(token: String?)
        case delegated(task: WKURLSchemeTask)
    }

    private final class FallbackTaskProxy: NSObject, WKURLSchemeTask {
        let original: WKURLSchemeTask
        let onComplete: () -> Void

        init(original: WKURLSchemeTask, onComplete: @escaping () -> Void) {
            self.original = original
            self.onComplete = onComplete
        }

        var request: URLRequest { original.request }

        func didReceive(_ response: URLResponse) {
            original.didReceive(response)
        }

        func didReceive(_ data: Data) {
            original.didReceive(data)
        }

        func didFinish() {
            original.didFinish()
            onComplete()
        }

        func didFailWithError(_ error: Error) {
            original.didFailWithError(error)
            onComplete()
        }
    }

    private final class BridgeTaskContext {
        weak var webView: WKWebView?
        let task: WKURLSchemeTask

        init(webView: WKWebView, task: WKURLSchemeTask) {
            self.webView = webView
            self.task = task
        }
    }

    private struct ByteRange {
        let start: Int64
        let end: Int64

        var length: Int64 { end - start + 1 }
    }

    private static let chunkBytes: Int64 = 512 * 1024
    private static let bridgeTimeoutSeconds: TimeInterval = 15
    private static let bridgeHeader = "X-Pure-Tavern-iOS-Asset-Bridge"
    private static let extensionMimeTypes: [String: String] = {
        guard
            let url = Bundle.main.url(
                forResource: "PureTavernExtensionMimeTypes",
                withExtension: "json"
            ),
            let data = try? Data(contentsOf: url),
            let object = try? JSONSerialization.jsonObject(with: data),
            let value = object as? [String: String]
        else {
            return [:]
        }
        return value
    }()
    private static let openAssetScript = """
    const bridge = globalThis.__PURE_TAVERN_IOS_ASSET_BRIDGE__;
    if (!bridge) return { kind: 'unavailable' };
    return await bridge.openAsset(requestUrl);
    """
    private static let readChunkScript = """
    const bridge = globalThis.__PURE_TAVERN_IOS_ASSET_BRIDGE__;
    if (!bridge) throw new Error('PureTavern iOS asset bridge is unavailable.');
    return await bridge.readChunk(token, offset, length);
    """
    private static let releaseAssetScript = """
    const bridge = globalThis.__PURE_TAVERN_IOS_ASSET_BRIDGE__;
    return bridge ? bridge.releaseAsset(token) : false;
    """

    private let fallbackHandler: WKURLSchemeHandler
    private let appRoot: URL
    private let bridgeTimeoutTimer: DispatchSourceTimer
    private let stateLock = NSLock()
    private var taskModes: [ObjectIdentifier: TaskMode] = [:]
    private var bridgeDeadlines: [ObjectIdentifier: Date] = [:]
    private var bridgeTaskContexts: [ObjectIdentifier: BridgeTaskContext] = [:]

    init(fallbackHandler: WKURLSchemeHandler, appRoot: URL) {
        self.fallbackHandler = fallbackHandler
        self.appRoot = appRoot.standardizedFileURL
        self.bridgeTimeoutTimer = DispatchSource.makeTimerSource(queue: .main)
        super.init()
        bridgeTimeoutTimer.setEventHandler { [weak self] in
            self?.expireTimedOutBridgeTasks()
        }
        bridgeTimeoutTimer.schedule(deadline: .now() + 1, repeating: 1)
        bridgeTimeoutTimer.resume()
    }

    deinit {
        bridgeTimeoutTimer.setEventHandler {}
        bridgeTimeoutTimer.cancel()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard
            let url = urlSchemeTask.request.url,
            let method = urlSchemeTask.request.httpMethod,
            method == "GET" || method == "HEAD",
            isManaged(url)
        else {
            delegate(webView, task: urlSchemeTask, register: true)
            return
        }

        let identifier = taskIdentifier(urlSchemeTask)
        setMode(.bridged(token: nil), for: identifier)
        armBridgeTimeout(webView: webView, task: urlSchemeTask, identifier: identifier)
        webView.callAsyncJavaScript(
            Self.openAssetScript,
            arguments: ["requestUrl": url.absoluteString],
            in: nil,
            in: .page
        ) { [weak self, weak webView] result in
            guard let self, let webView else { return }
            guard self.isActive(identifier) else {
                if case .success(let value) = result,
                   let response = value as? [String: Any],
                   let token = response["token"] as? String {
                    self.releaseAsset(token, in: webView)
                }
                return
            }
            self.touchBridgeDeadline(identifier)
            switch result {
            case .success(let value):
                self.handleLookupResult(
                    value,
                    webView: webView,
                    task: urlSchemeTask,
                    identifier: identifier,
                    requestURL: url
                )
            case .failure:
                self.handleUnavailableBridge(
                    webView: webView,
                    task: urlSchemeTask,
                    identifier: identifier,
                    requestURL: url
                )
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let identifier = taskIdentifier(urlSchemeTask)
        guard let mode = removeMode(for: identifier) else { return }
        switch mode {
        case .delegated(let delegatedTask):
            fallbackHandler.webView(webView, stop: delegatedTask)
        case .bridged(let token):
            if let token { releaseAsset(token, in: webView) }
        }
    }

    private func handleLookupResult(
        _ value: Any?,
        webView: WKWebView,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier,
        requestURL: URL
    ) {
        guard let result = value as? [String: Any], let kind = result["kind"] as? String else {
            handleUnavailableBridge(
                webView: webView,
                task: task,
                identifier: identifier,
                requestURL: requestURL
            )
            return
        }

        switch kind {
        case "asset":
            streamAsset(
                result,
                webView: webView,
                task: task,
                identifier: identifier,
                requestURL: requestURL
            )
        case "fallback":
            guard let path = result["path"] as? String else {
                respondError(status: 404, message: "Asset not found", task: task, identifier: identifier)
                return
            }
            respondWithStaticAsset(path: path, task: task, identifier: identifier, requestURL: requestURL)
        case "invalid":
            respondError(status: 400, message: "Invalid asset path", task: task, identifier: identifier)
        case "unmanaged":
            delegate(webView, task: task, identifier: identifier)
        default:
            handleUnavailableBridge(
                webView: webView,
                task: task,
                identifier: identifier,
                requestURL: requestURL
            )
        }
    }

    private func streamAsset(
        _ result: [String: Any],
        webView: WKWebView,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier,
        requestURL: URL
    ) {
        guard
            let token = result["token"] as? String,
            let sizeNumber = result["size"] as? NSNumber,
            sizeNumber.int64Value >= 0
        else {
            respondError(status: 500, message: "Invalid asset bridge response", task: task, identifier: identifier)
            return
        }

        let size = sizeNumber.int64Value
        let marker = (result["marker"] as? String) ?? "assets/library"
        let responsePath = (result["responsePath"] as? String) ?? requestURL.path
        let preferredContentType = result["contentType"] as? String
        let contentType = contentType(for: responsePath, preferred: preferredContentType)
        let range = task.request.httpMethod == "HEAD"
            ? nil
            : parseRange(task.request.value(forHTTPHeaderField: "Range"), size: size)
        let responseRange = range ?? (size > 0 ? ByteRange(start: 0, end: size - 1) : nil)
        var headers = [
            "Content-Type": contentType,
            "Cache-Control": "no-store",
            "Accept-Ranges": "bytes",
            "X-Pure-Tavern-Asset": marker,
            Self.bridgeHeader: "1"
        ]
        let status = range == nil ? 200 : 206
        headers["Content-Length"] = String(responseRange?.length ?? 0)
        if let range {
            headers["Content-Range"] = "bytes \(range.start)-\(range.end)/\(size)"
        }

        guard let response = HTTPURLResponse(
            url: requestURL,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        ) else {
            releaseAsset(token, in: webView)
            respondError(status: 500, message: "Unable to create asset response", task: task, identifier: identifier)
            return
        }

        guard updateToken(token, for: identifier) else {
            releaseAsset(token, in: webView)
            return
        }
        task.didReceive(response)
        if task.request.httpMethod == "HEAD" || responseRange == nil {
            releaseAsset(token, in: webView)
            finish(task, identifier: identifier)
            return
        }

        streamNextChunk(
            webView: webView,
            task: task,
            identifier: identifier,
            token: token,
            offset: responseRange!.start,
            endExclusive: responseRange!.end + 1
        )
    }

    private func streamNextChunk(
        webView: WKWebView,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier,
        token: String,
        offset: Int64,
        endExclusive: Int64
    ) {
        guard isActive(identifier) else {
            releaseAsset(token, in: webView)
            return
        }
        if offset >= endExclusive {
            releaseAsset(token, in: webView)
            finish(task, identifier: identifier)
            return
        }

        let length = min(Self.chunkBytes, endExclusive - offset)
        webView.callAsyncJavaScript(
            Self.readChunkScript,
            arguments: [
                "token": token,
                "offset": NSNumber(value: offset),
                "length": NSNumber(value: length)
            ],
            in: nil,
            in: .page
        ) { [weak self, weak webView] result in
            guard let self, let webView else { return }
            guard self.isActive(identifier) else {
                self.releaseAsset(token, in: webView)
                return
            }
            switch result {
            case .success(let value):
                guard
                    let base64 = value as? String,
                    let data = Data(base64Encoded: base64),
                    data.count == Int(length)
                else {
                    self.releaseAsset(token, in: webView)
                    self.fail(
                        task,
                        identifier: identifier,
                        message: "Invalid asset bridge chunk"
                    )
                    return
                }
                self.touchBridgeDeadline(identifier)
                task.didReceive(data)
                self.streamNextChunk(
                    webView: webView,
                    task: task,
                    identifier: identifier,
                    token: token,
                    offset: offset + length,
                    endExclusive: endExclusive
                )
            case .failure(let error):
                self.releaseAsset(token, in: webView)
                self.fail(task, identifier: identifier, message: error.localizedDescription)
            }
        }
    }

    private func handleUnavailableBridge(
        webView: WKWebView,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier,
        requestURL: URL
    ) {
        if let fallback = thumbnailFallback(for: requestURL) {
            respondWithStaticAsset(
                path: fallback,
                task: task,
                identifier: identifier,
                requestURL: requestURL
            )
        } else {
            delegate(webView, task: task, identifier: identifier)
        }
    }

    private func respondWithStaticAsset(
        path: String,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier,
        requestURL: URL
    ) {
        guard isActive(identifier) else { return }
        guard let fileURL = safeStaticFileURL(for: path) else {
            respondError(status: 400, message: "Invalid static asset path", task: task, identifier: identifier)
            return
        }
        guard
            let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
            values.isRegularFile == true,
            let fileSize = values.fileSize
        else {
            respondError(status: 404, message: "Asset not found", task: task, identifier: identifier)
            return
        }

        let size = Int64(fileSize)
        let range = task.request.httpMethod == "HEAD"
            ? nil
            : parseRange(task.request.value(forHTTPHeaderField: "Range"), size: size)
        let status = range == nil ? 200 : 206
        let contentLength = range?.length ?? size
        let body: Data?
        if task.request.httpMethod == "HEAD" {
            body = nil
        } else {
            do {
                body = try readStaticData(fileURL, range: range)
            } catch {
                respondError(status: 500, message: "Unable to read static asset", task: task, identifier: identifier)
                return
            }
        }
        if let body, body.count != Int(contentLength) {
            respondError(status: 500, message: "Static asset read was incomplete", task: task, identifier: identifier)
            return
        }
        var headers = [
            "Content-Type": contentType(for: path, preferred: nil),
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes",
            Self.bridgeHeader: "static"
        ]
        if let range {
            headers["Content-Range"] = "bytes \(range.start)-\(range.end)/\(size)"
        }
        headers["Content-Length"] = String(contentLength)

        guard let response = HTTPURLResponse(
            url: requestURL,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        ) else {
            respondError(status: 500, message: "Unable to create static response", task: task, identifier: identifier)
            return
        }
        task.didReceive(response)
        if let body { task.didReceive(body) }
        finish(task, identifier: identifier)
    }

    private func readStaticData(_ fileURL: URL, range: ByteRange?) throws -> Data {
        guard let range else { return try Data(contentsOf: fileURL) }
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(range.start))
        return try handle.read(upToCount: Int(range.length)) ?? Data()
    }

    private func respondError(
        status: Int,
        message: String,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier
    ) {
        guard isActive(identifier), let url = task.request.url else { return }
        let body = Data(message.utf8)
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": String(body.count),
                "Cache-Control": "no-store",
                Self.bridgeHeader: "error"
            ]
        )!
        task.didReceive(response)
        if task.request.httpMethod != "HEAD" { task.didReceive(body) }
        finish(task, identifier: identifier)
    }

    private func fail(_ task: WKURLSchemeTask, identifier: ObjectIdentifier, message: String) {
        guard removeMode(for: identifier) != nil else { return }
        task.didFailWithError(
            NSError(
                domain: "com.puretavern.ios-assets",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        )
    }

    private func finish(_ task: WKURLSchemeTask, identifier: ObjectIdentifier) {
        guard removeMode(for: identifier) != nil else { return }
        task.didFinish()
    }

    private func delegate(_ webView: WKWebView, task: WKURLSchemeTask, register: Bool) {
        let identifier = taskIdentifier(task)
        let proxy = FallbackTaskProxy(original: task) { [weak self] in
            _ = self?.removeMode(for: identifier)
        }
        if register { setMode(.delegated(task: proxy), for: identifier) }
        fallbackHandler.webView(webView, start: proxy)
    }

    private func delegate(
        _ webView: WKWebView,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier
    ) {
        let proxy = FallbackTaskProxy(original: task) { [weak self] in
            _ = self?.removeMode(for: identifier)
        }
        guard replaceMode(.delegated(task: proxy), for: identifier) else { return }
        fallbackHandler.webView(webView, start: proxy)
    }

    private func releaseAsset(_ token: String, in webView: WKWebView) {
        webView.callAsyncJavaScript(
            Self.releaseAssetScript,
            arguments: ["token": token],
            in: nil,
            in: .page
        ) { _ in }
    }

    private func isManaged(_ url: URL) -> Bool {
        if url.path == "/thumbnail" { return true }
        let decoded = url.path.removingPercentEncoding ?? url.path
        return [
            "/backgrounds/",
            "/User Avatars/",
            "/user/files/",
            "/user/images/",
            "/characters/",
            "/assets/",
            "/scripts/extensions/third-party/"
        ].contains { decoded.hasPrefix($0) }
    }

    private func thumbnailFallback(for url: URL) -> String? {
        guard url.path == "/thumbnail",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let type = components.queryItems?.first(where: { $0.name == "type" })?.value,
              let file = components.queryItems?.first(where: { $0.name == "file" })?.value,
              isSafeRelativePath(file) else {
            return nil
        }
        switch type {
        case "avatar": return file.contains("/") ? nil : "/img/ai4.png"
        case "bg": return "/backgrounds/\(file)"
        case "persona": return file == "user-default.png"
            ? "/User Avatars/user-default.png"
            : "/img/user-default.png"
        default: return nil
        }
    }

    private func safeStaticFileURL(for path: String) -> URL? {
        let decoded = path.removingPercentEncoding ?? path
        guard decoded.hasPrefix("/"), isSafeRelativePath(String(decoded.dropFirst())) else { return nil }
        let fileURL = decoded
            .split(separator: "/")
            .reduce(appRoot) { result, segment in
                result.appendingPathComponent(String(segment), isDirectory: false)
            }
            .standardizedFileURL
        let rootPath = appRoot.path.hasSuffix("/") ? appRoot.path : appRoot.path + "/"
        guard fileURL.path.hasPrefix(rootPath) else { return nil }
        return fileURL
    }

    private func isSafeRelativePath(_ value: String) -> Bool {
        guard !value.isEmpty, !value.contains("\\") else { return false }
        return value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { segment in
            !segment.isEmpty &&
            segment != "." &&
            segment != ".." &&
            !segment.unicodeScalars.contains { $0.value <= 31 || $0.value == 127 }
        }
    }

    private func contentType(for path: String, preferred: String?) -> String {
        let isExtensionAsset = path.hasPrefix("/scripts/extensions/third-party/")
        if !isExtensionAsset,
           let preferred,
           !preferred.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return preferred
        }

        let pathExtension = URL(fileURLWithPath: path).pathExtension.lowercased()
        if isExtensionAsset, let mapped = Self.extensionMimeTypes[pathExtension] {
            return addingUtf8Charset(to: mapped)
        }

        let extensionOverrides = [
            "js": "application/javascript; charset=UTF-8",
            "mjs": "application/javascript; charset=UTF-8",
            "css": "text/css; charset=UTF-8",
            "json": "application/json; charset=UTF-8",
            "html": "text/html; charset=UTF-8",
            "htm": "text/html; charset=UTF-8",
            "wasm": "application/wasm",
            "svg": "image/svg+xml"
        ]
        if let type = extensionOverrides[pathExtension] { return type }

        let inferred = UTType(filenameExtension: pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        return addingUtf8Charset(to: inferred)
    }

    private func addingUtf8Charset(to contentType: String) -> String {
        if contentType.hasPrefix("text/") ||
            contentType == "application/javascript" ||
            contentType == "application/json" {
            return "\(contentType); charset=UTF-8"
        }
        return contentType
    }

    private func parseRange(_ value: String?, size: Int64) -> ByteRange? {
        guard let value, value.hasPrefix("bytes="), size > 0 else { return nil }
        let expression = try! NSRegularExpression(pattern: #"^bytes=(\d*)-(\d*)$"#)
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = expression.firstMatch(in: value, range: range), match.range == range else {
            return nil
        }
        let startText = substring(value, range: match.range(at: 1))
        let endText = substring(value, range: match.range(at: 2))
        var start = Int64(startText) ?? 0
        var end = Int64(endText) ?? (size - 1)
        if startText.isEmpty && !endText.isEmpty {
            guard let suffixLength = Int64(endText) else { return nil }
            start = max(0, size - suffixLength)
            end = size - 1
        }
        guard start >= 0, end >= start, start < size else { return nil }
        return ByteRange(start: start, end: min(end, size - 1))
    }

    private func substring(_ value: String, range: NSRange) -> String {
        guard range.location != NSNotFound, let swiftRange = Range(range, in: value) else { return "" }
        return String(value[swiftRange])
    }

    private func taskIdentifier(_ task: WKURLSchemeTask) -> ObjectIdentifier {
        ObjectIdentifier(task as AnyObject)
    }

    private func armBridgeTimeout(
        webView: WKWebView,
        task: WKURLSchemeTask,
        identifier: ObjectIdentifier
    ) {
        stateLock.lock()
        bridgeTaskContexts[identifier] = BridgeTaskContext(webView: webView, task: task)
        bridgeDeadlines[identifier] = Date().addingTimeInterval(Self.bridgeTimeoutSeconds)
        stateLock.unlock()
    }

    private func touchBridgeDeadline(_ identifier: ObjectIdentifier) {
        stateLock.lock()
        if let mode = taskModes[identifier], case .bridged = mode {
            bridgeDeadlines[identifier] = Date().addingTimeInterval(Self.bridgeTimeoutSeconds)
        }
        stateLock.unlock()
    }

    private func expireTimedOutBridgeTasks() {
        var expired: [(BridgeTaskContext, String?)] = []
        let now = Date()
        stateLock.lock()
        let expiredIdentifiers = bridgeDeadlines.compactMap { identifier, deadline in
            deadline <= now ? identifier : nil
        }
        for identifier in expiredIdentifiers {
            guard
                let mode = taskModes[identifier],
                case .bridged(let token) = mode,
                let context = bridgeTaskContexts[identifier]
            else {
                bridgeDeadlines.removeValue(forKey: identifier)
                bridgeTaskContexts.removeValue(forKey: identifier)
                continue
            }
            taskModes.removeValue(forKey: identifier)
            bridgeDeadlines.removeValue(forKey: identifier)
            bridgeTaskContexts.removeValue(forKey: identifier)
            expired.append((context, token))
        }
        stateLock.unlock()

        for (context, token) in expired {
            if let token, let webView = context.webView { releaseAsset(token, in: webView) }
            context.task.didFailWithError(
                NSError(
                    domain: "com.puretavern.ios-assets",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "iOS asset bridge request timed out."]
                )
            )
        }
    }

    private func setMode(_ mode: TaskMode, for identifier: ObjectIdentifier) {
        stateLock.lock()
        taskModes[identifier] = mode
        stateLock.unlock()
    }

    private func updateToken(_ token: String, for identifier: ObjectIdentifier) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard taskModes[identifier] != nil else { return false }
        taskModes[identifier] = .bridged(token: token)
        return true
    }

    private func replaceMode(_ mode: TaskMode, for identifier: ObjectIdentifier) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard taskModes[identifier] != nil else { return false }
        taskModes[identifier] = mode
        bridgeDeadlines.removeValue(forKey: identifier)
        bridgeTaskContexts.removeValue(forKey: identifier)
        return true
    }

    private func removeMode(for identifier: ObjectIdentifier) -> TaskMode? {
        stateLock.lock()
        defer { stateLock.unlock() }
        bridgeDeadlines.removeValue(forKey: identifier)
        bridgeTaskContexts.removeValue(forKey: identifier)
        return taskModes.removeValue(forKey: identifier)
    }

    private func isActive(_ identifier: ObjectIdentifier) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return taskModes[identifier] != nil
    }
}
