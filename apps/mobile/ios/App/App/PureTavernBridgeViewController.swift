import Capacitor
import UIKit
import WebKit

private final class PureTavernWebViewConfiguration: WKWebViewConfiguration {
    var pureTavernScheme: String?
    var pureTavernAppRoot: URL?
    private(set) var pureTavernAssetHandler: PureTavernAssetSchemeHandler?

    func inheritCapacitorSettings(from source: WKWebViewConfiguration) {
        processPool = source.processPool
        preferences = source.preferences
        userContentController = source.userContentController
        websiteDataStore = source.websiteDataStore
        defaultWebpagePreferences = source.defaultWebpagePreferences
        applicationNameForUserAgent = source.applicationNameForUserAgent
        allowsInlineMediaPlayback = source.allowsInlineMediaPlayback
        suppressesIncrementalRendering = source.suppressesIncrementalRendering
        allowsAirPlayForMediaPlayback = source.allowsAirPlayForMediaPlayback
        mediaTypesRequiringUserActionForPlayback = source.mediaTypesRequiringUserActionForPlayback
        limitsNavigationsToAppBoundDomains = source.limitsNavigationsToAppBoundDomains
    }

    override func setURLSchemeHandler(
        _ urlSchemeHandler: WKURLSchemeHandler?,
        forURLScheme urlScheme: String
    ) {
        guard
            let fallbackHandler = urlSchemeHandler,
            let pureTavernScheme,
            let pureTavernAppRoot,
            urlScheme.caseInsensitiveCompare(pureTavernScheme) == .orderedSame
        else {
            super.setURLSchemeHandler(urlSchemeHandler, forURLScheme: urlScheme)
            return
        }

        // Capacitor registers its asset handler after creating the configuration. Wrap that first
        // registration instead of trying to unregister and replace it, which WebKit rejects.
        let handler = PureTavernAssetSchemeHandler(
            fallbackHandler: fallbackHandler,
            appRoot: pureTavernAppRoot
        )
        pureTavernAssetHandler = handler
        super.setURLSchemeHandler(handler, forURLScheme: urlScheme)
    }
}

@objc(PureTavernBridgeViewController)
final class PureTavernBridgeViewController: CAPBridgeViewController {
    private var localScheme = "capacitor"
    private var appRoot = Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true)
    private var pureTavernAssetHandler: PureTavernAssetSchemeHandler?
    private var localServerPlugin: PureTavernLocalServerPlugin?

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        localScheme = descriptor.urlScheme ?? "capacitor"
        appRoot = descriptor.appLocation
        return descriptor
    }

    override func webViewConfiguration(
        for instanceConfiguration: InstanceConfiguration
    ) -> WKWebViewConfiguration {
        let capacitorConfiguration = super.webViewConfiguration(for: instanceConfiguration)
        guard let appRoot else { return capacitorConfiguration }

        let configuration = PureTavernWebViewConfiguration()
        configuration.inheritCapacitorSettings(from: capacitorConfiguration)
        configuration.pureTavernScheme = localScheme
        configuration.pureTavernAppRoot = appRoot
        return configuration
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        pureTavernAssetHandler = configuration.urlSchemeHandler(
            forURLScheme: localScheme
        ) as? PureTavernAssetSchemeHandler
        return super.webView(with: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        let localServerPlugin = PureTavernLocalServerPlugin()
        bridge?.registerPluginInstance(localServerPlugin)
        self.localServerPlugin = localServerPlugin
        addUserScript(named: "PureTavernLocalBackendBridge", describedAs: "local backend bridge")
        addUserScript(named: "PureTavernAssetBridge", describedAs: "asset bridge")
        // Repairs jQuery UI's local-tab detection, which otherwise AJAX-loads the app root and
        // injects a second copy of the whole Legacy document. See PureTavernTabsFix.js.
        addUserScript(named: "PureTavernTabsFix", describedAs: "jQuery UI tabs fix")
    }

    deinit {
        localServerPlugin?.shutdown()
    }

    private func addUserScript(named name: String, describedAs description: String) {
        guard let scriptURL = Bundle.main.url(forResource: name, withExtension: "js"),
              let source = try? String(contentsOf: scriptURL, encoding: .utf8) else {
            CAPLog.print("⚡️  ERROR: PureTavern iOS \(description) script is missing.")
            return
        }
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
    }
}
