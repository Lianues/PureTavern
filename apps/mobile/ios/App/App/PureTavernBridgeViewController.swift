import Capacitor
import UIKit
import WebKit

@objc(PureTavernBridgeViewController)
final class PureTavernBridgeViewController: CAPBridgeViewController {
    private var localScheme = "capacitor"
    private var appRoot = Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true)
    private var pureTavernAssetHandler: PureTavernAssetSchemeHandler?

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        localScheme = descriptor.urlScheme ?? "capacitor"
        appRoot = descriptor.appLocation
        return descriptor
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        if let fallbackHandler = configuration.urlSchemeHandler(forURLScheme: localScheme),
           let appRoot {
            configuration.setURLSchemeHandler(nil, forURLScheme: localScheme)
            let handler = PureTavernAssetSchemeHandler(
                fallbackHandler: fallbackHandler,
                appRoot: appRoot
            )
            configuration.setURLSchemeHandler(handler, forURLScheme: localScheme)
            pureTavernAssetHandler = handler
        }

        return super.webView(with: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let scriptURL = Bundle.main.url(
            forResource: "PureTavernAssetBridge",
            withExtension: "js"
        ), let source = try? String(contentsOf: scriptURL, encoding: .utf8) else {
            CAPLog.print("⚡️  ERROR: PureTavern iOS asset bridge script is missing.")
            return
        }
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
    }
}
