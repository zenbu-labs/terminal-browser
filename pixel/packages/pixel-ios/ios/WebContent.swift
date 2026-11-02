import UIKit
import WebKit

final class WebContent: NSObject, NativeContent, WKScriptMessageHandler, WKNavigationDelegate {
  private static let heightScript = """
  (() => {
    const send = () => window.webkit.messageHandlers.pixelHeight.postMessage(
      Math.ceil(document.documentElement.getBoundingClientRect().height));
    new ResizeObserver(send).observe(document.documentElement);
    send();
  })();
  """

  let id: Int
  let web: WKWebView
  private let emit: NativeViews.Emit
  private var source = ""
  private var inline = false

  var view: UIView { web }
  var focusable: Bool { !inline }

  init(id: Int, emit: @escaping NativeViews.Emit) {
    self.id = id
    self.emit = emit
    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    web = WKWebView(frame: .zero, configuration: config)
    super.init()
    config.userContentController.add(self, name: "pixelHeight")
    config.userContentController.addUserScript(WKUserScript(source: Self.heightScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    web.navigationDelegate = self
    web.isOpaque = false
    web.backgroundColor = .clear
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.scrollView.bounces = false
  }

  func configure(_ config: [String: Any]) {
    if let inline = config["inline"] as? Bool {
      self.inline = inline
      web.scrollView.isScrollEnabled = !inline
    }
    if let source = config["source"] as? String, source != self.source {
      self.source = source
      load(source)
    }
  }

  private func load(_ source: String) {
    if source.hasPrefix("data:text/html"), let comma = source.firstIndex(of: ",") {
      let payload = String(source[source.index(after: comma)...])
      let html = source[..<comma].contains(";base64")
        ? String(data: Data(base64Encoded: payload) ?? Data(), encoding: .utf8) ?? ""
        : payload.removingPercentEncoding ?? payload
      web.loadHTMLString(html, baseURL: nil)
    } else if let url = URL(string: source), Self.allowed(url, mainFrame: true) {
      if url.isFileURL {
        web.loadFileURL(url, allowingReadAccessTo: Bundle.main.bundleURL)
      } else {
        web.load(URLRequest(url: url))
      }
    }
  }

  static func allowed(_ url: URL, mainFrame: Bool) -> Bool {
    switch url.scheme?.lowercased() {
    case "https", "http", "about", "blob": return true
    case "data": return !mainFrame
    case "file":
      let bundle = Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath().path + "/"
      return url.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(bundle)
    default: return false
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let allowed = action.request.url.map { Self.allowed($0, mainFrame: action.targetFrame?.isMainFrame ?? true) } ?? false
    decisionHandler(allowed ? .allow : .cancel)
  }

  func tap(at point: CGPoint) -> Bool {
    guard inline else { return false }
    web.evaluateJavaScript("document.elementFromPoint(\(point.x), \(point.y))?.click()")
    return true
  }

  func setShown(_ shown: Bool) {
    web.setAllMediaPlaybackSuspended(!shown, completionHandler: nil)
  }

  func close() {
    web.stopLoading()
    web.configuration.userContentController.removeScriptMessageHandler(forName: "pixelHeight")
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let height = message.body as? Double else { return }
    emit(["id": id, "type": "contentHeight", "height": height])
  }
}
