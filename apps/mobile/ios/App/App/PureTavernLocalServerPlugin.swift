import Capacitor
import Foundation

@objc(PureTavernLocalServerPlugin)
final class PureTavernLocalServerPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    let identifier = "PureTavernLocalServerPlugin"
    let jsName = "PureTavernLocalServer"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelRequest", returnType: CAPPluginReturnPromise),
    ]

    private static let responseEvent = "pureTavernLocalServerResponse"
    private static let chunkSize = 32 * 1024
    private static let maximumActiveRequests = 4
    private static let maximumRedirects = 10
    private static let maximumBodyBytes = 64 * 1024 * 1024
    private static let blockedRequestHeaders: Set<String> = [
        "accept-encoding",
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]
    private static let blockedResponseHeaders: Set<String> = [
        "connection",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "set-cookie",
        "set-cookie2",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]
    private static let sensitiveRedirectHeaders: Set<String> = [
        "authorization",
        "cookie",
        "proxy-authorization",
    ]
    private static let entityHeaders: Set<String> = [
        "content-encoding",
        "content-language",
        "content-length",
        "content-location",
        "content-type",
        "transfer-encoding",
    ]

    private final class RequestState {
        let requestId: String
        var currentURL: URL
        var redirectCount = 0
        var nextSequence = 0
        var headersSent = false

        init(requestId: String, currentURL: URL) {
            self.requestId = requestId
            self.currentURL = currentURL
        }
    }

    private let stateLock = NSLock()
    private var statesByTask: [Int: RequestState] = [:]
    private var tasksByRequestId: [String: URLSessionDataTask] = [:]
    private var session: URLSession?
    private var shuttingDown = false

    override func load() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        configuration.urlCache = nil

        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.name = "PureTavernLocalServer"
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }

    @objc func startRequest(_ call: CAPPluginCall) {
        let parsed: (requestId: String, request: URLRequest)
        do {
            parsed = try Self.parseRequest(call)
        } catch let error as LocalRequestError {
            call.reject(error.message, "INVALID_REQUEST")
            return
        } catch {
            call.reject("The local backend request is invalid.", "INVALID_REQUEST")
            return
        }

        stateLock.lock()
        guard !shuttingDown, let session else {
            stateLock.unlock()
            call.reject("The iOS local backend is unavailable.", "UNAVAILABLE")
            return
        }
        guard tasksByRequestId.count < Self.maximumActiveRequests else {
            stateLock.unlock()
            call.reject("Too many local backend requests are active.", "TOO_MANY_REQUESTS")
            return
        }
        guard tasksByRequestId[parsed.requestId] == nil else {
            stateLock.unlock()
            call.reject("The local backend request ID is already active.", "DUPLICATE_REQUEST")
            return
        }

        let task = session.dataTask(with: parsed.request)
        let state = RequestState(requestId: parsed.requestId, currentURL: parsed.request.url!)
        statesByTask[task.taskIdentifier] = state
        tasksByRequestId[parsed.requestId] = task
        stateLock.unlock()

        task.resume()
        call.resolve(["requestId": parsed.requestId])
    }

    @objc func cancelRequest(_ call: CAPPluginCall) {
        let requestId = call.getString("requestId")
        stateLock.lock()
        let task = requestId.flatMap { tasksByRequestId[$0] }
        stateLock.unlock()
        task?.cancel()
        call.resolve()
    }

    func shutdown() {
        stateLock.lock()
        if shuttingDown {
            stateLock.unlock()
            return
        }
        shuttingDown = true
        let tasks = Array(tasksByRequestId.values)
        tasksByRequestId.removeAll()
        statesByTask.removeAll()
        let activeSession = session
        session = nil
        stateLock.unlock()

        for task in tasks {
            task.cancel()
        }
        activeSession?.invalidateAndCancel()
    }

    deinit {
        shutdown()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let target = request.url, Self.isAllowedURL(target) else {
            failTask(task.taskIdentifier, code: "protocol", message: "The provider returned an invalid redirect.")
            completionHandler(nil)
            task.cancel()
            return
        }

        stateLock.lock()
        guard let state = statesByTask[task.taskIdentifier] else {
            stateLock.unlock()
            completionHandler(nil)
            return
        }
        state.redirectCount += 1
        guard state.redirectCount <= Self.maximumRedirects else {
            stateLock.unlock()
            failTask(task.taskIdentifier, code: "protocol", message: "The provider returned too many redirects.")
            completionHandler(nil)
            task.cancel()
            return
        }
        let source = state.currentURL
        state.currentURL = target
        stateLock.unlock()

        var sanitized = request
        var headers = sanitized.allHTTPHeaderFields ?? [:]
        if !Self.sameOrigin(source, target) {
            headers = Self.removingHeaders(headers, named: Self.sensitiveRedirectHeaders)
        }
        if task.currentRequest?.httpMethod == "POST", sanitized.httpMethod == "GET" {
            headers = Self.removingHeaders(headers, named: Self.entityHeaders)
            sanitized.httpBody = nil
        }
        headers = Self.filteredRequestHeaders(headers)
        headers["Accept-Encoding"] = "identity"
        sanitized.allHTTPHeaderFields = headers
        completionHandler(sanitized)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let response = response as? HTTPURLResponse else {
            failTask(dataTask.taskIdentifier, code: "protocol", message: "The provider returned an invalid response.")
            completionHandler(.cancel)
            return
        }

        stateLock.lock()
        guard let state = statesByTask[dataTask.taskIdentifier], !state.headersSent else {
            stateLock.unlock()
            completionHandler(.cancel)
            return
        }
        state.headersSent = true
        let requestId = state.requestId
        stateLock.unlock()

        emit([
            "requestId": requestId,
            "type": "headers",
            "status": response.statusCode,
            "statusText": "",
            "headers": Self.filteredResponseHeaders(response.allHeaderFields),
        ])
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var offset = 0
        while offset < data.count {
            let end = min(offset + Self.chunkSize, data.count)
            let chunk = data.subdata(in: offset ..< end)

            stateLock.lock()
            guard let state = statesByTask[dataTask.taskIdentifier], state.headersSent else {
                stateLock.unlock()
                return
            }
            let requestId = state.requestId
            let sequence = state.nextSequence
            state.nextSequence += 1
            stateLock.unlock()

            emit([
                "requestId": requestId,
                "type": "chunk",
                "sequence": sequence,
                "data": chunk.base64EncodedString(),
            ])
            offset = end
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard let state = removeState(task.taskIdentifier) else { return }
        if let urlError = error as? URLError, urlError.code == .cancelled {
            emitError(requestId: state.requestId, code: "aborted", message: "The local backend request was aborted.")
        } else if error != nil {
            emitError(requestId: state.requestId, code: "network", message: "The iOS local backend could not reach the provider.")
        } else if !state.headersSent {
            emitError(requestId: state.requestId, code: "protocol", message: "The provider returned no response headers.")
        } else {
            emit(["requestId": state.requestId, "type": "complete"])
        }
    }

    private func failTask(_ taskIdentifier: Int, code: String, message: String) {
        guard let state = removeState(taskIdentifier) else { return }
        emitError(requestId: state.requestId, code: code, message: message)
    }

    private func removeState(_ taskIdentifier: Int) -> RequestState? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let state = statesByTask.removeValue(forKey: taskIdentifier) else { return nil }
        tasksByRequestId.removeValue(forKey: state.requestId)
        return state
    }

    private func emitError(requestId: String, code: String, message: String) {
        emit([
            "requestId": requestId,
            "type": "error",
            "code": code,
            "message": message,
        ])
    }

    private func emit(_ event: PluginCallResultData) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(Self.responseEvent, data: event)
        }
    }

    private static func parseRequest(
        _ call: CAPPluginCall
    ) throws -> (requestId: String, request: URLRequest) {
        guard let requestId = call.getString("requestId"), isValidRequestId(requestId) else {
            throw LocalRequestError("A valid local backend request ID is required.")
        }
        guard let urlString = call.getString("url"), urlString.utf8.count <= 16 * 1024,
              let url = URL(string: urlString), isAllowedURL(url) else {
            throw LocalRequestError("The provider URL must be an HTTP or HTTPS URL.")
        }
        let method = call.getString("method", "GET").uppercased()
        guard method == "GET" || method == "POST" else {
            throw LocalRequestError("The local backend supports only GET and POST requests.")
        }

        let body = call.getString("body")
        let bodyData = body.map { Data($0.utf8) }
        guard bodyData?.count ?? 0 <= maximumBodyBytes else {
            throw LocalRequestError("The provider request body is too large.")
        }

        let rawHeaders = (call.getObject("headers") ?? [:]) as [String: Any]
        guard rawHeaders.count <= 256 else {
            throw LocalRequestError("The provider request contains too many headers.")
        }
        var headers: [String: String] = [:]
        for (name, value) in rawHeaders {
            guard let value = value as? String, isValidHeaderName(name), isSafeHeaderValue(value) else {
                throw LocalRequestError("The provider request contains an invalid header.")
            }
            headers[name] = value
        }
        headers = filteredRequestHeaders(headers)
        headers["Accept-Encoding"] = "identity"

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = bodyData
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 60
        request.allHTTPHeaderFields = headers
        return (requestId: requestId, request: request)
    }

    private static func isValidRequestId(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9._-]{1,128}$"#, options: .regularExpression) != nil
    }

    private static func isAllowedURL(_ value: URL) -> Bool {
        guard let scheme = value.scheme?.lowercased(), scheme == "http" || scheme == "https",
              value.host?.isEmpty == false, value.user == nil, value.password == nil else {
            return false
        }
        return true
    }

    private static func isValidHeaderName(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 256 else { return false }
        return value.range(of: #"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"#, options: .regularExpression) != nil
    }

    private static func isSafeHeaderValue(_ value: String) -> Bool {
        value.utf8.count <= 64 * 1024 && !value.contains("\r") && !value.contains("\n") && !value.contains("\0")
    }

    private static func filteredRequestHeaders(_ headers: [String: String]) -> [String: String] {
        var blocked = blockedRequestHeaders
        blocked.formUnion(connectionHeaderTokens(headers))
        return removingHeaders(headers, named: blocked)
    }

    private static func filteredResponseHeaders(_ rawHeaders: [AnyHashable: Any]) -> [String: String] {
        var normalized: [String: String] = [:]
        for (rawName, rawValue) in rawHeaders {
            guard let name = rawName as? String, isValidHeaderName(name),
                  let value = normalizedHeaderValue(rawValue), isSafeHeaderValue(value) else {
                continue
            }
            normalized[name] = value
        }

        var blocked = blockedResponseHeaders
        blocked.formUnion(connectionHeaderTokens(normalized))
        return normalized.filter { name, _ in
            let lowerName = name.lowercased()
            return !blocked.contains(lowerName) && !lowerName.hasPrefix("access-control-")
        }
    }

    private static func normalizedHeaderValue(_ value: Any) -> String? {
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
        if let values = value as? [String] { return values.joined(separator: ", ") }
        return nil
    }

    private static func connectionHeaderTokens(_ headers: [String: String]) -> Set<String> {
        var result: Set<String> = []
        for (name, value) in headers where name.caseInsensitiveCompare("Connection") == .orderedSame {
            for token in value.split(separator: ",") {
                let normalized = token.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if !normalized.isEmpty { result.insert(normalized) }
            }
        }
        return result
    }

    private static func removingHeaders(_ headers: [String: String], named removed: Set<String>) -> [String: String] {
        headers.filter { name, _ in !removed.contains(name.lowercased()) }
    }

    private static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        left.scheme?.caseInsensitiveCompare(right.scheme ?? "") == .orderedSame &&
            left.host?.caseInsensitiveCompare(right.host ?? "") == .orderedSame &&
            effectivePort(left) == effectivePort(right)
    }

    private static func effectivePort(_ value: URL) -> Int {
        if let port = value.port { return port }
        return value.scheme?.lowercased() == "https" ? 443 : 80
    }

    private struct LocalRequestError: Error {
        let message: String

        init(_ message: String) {
            self.message = message
        }
    }
}
