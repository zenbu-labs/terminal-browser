import UIKit

@MainActor
final class SystemBar {
  static let shared = SystemBar()

  var emit: (([String: Any]) -> Void)?
  private var items: [[String: String]] = []
  private var shell: SystemBarShell?
  private(set) var active = false

  func setItems(_ items: [[String: String]]) {
    self.items = items
    if shell == nil, !items.isEmpty { shell = SystemBarShell.install() }
    refresh()
  }

  func refresh() {
    guard let shell else { return }
    let vertical = Self.hasVerticalBar(shell.view)
    shell.navigation.setNavigationBarHidden(!vertical, animated: false)
    shell.navigation.topViewController?.navigationItem.rightBarButtonItems = vertical ? items.map(button) : nil
    let now = vertical && !items.isEmpty
    guard now != active else { return }
    active = now
    emit?(["type": "active", "active": now])
  }

  private func button(_ item: [String: String]) -> UIBarButtonItem {
    let id = item["id"] ?? ""
    let action = UIAction(title: item["label"] ?? id, image: UIImage(systemName: item["symbol"] ?? "circle")) { [weak self] _ in
      self?.emit?(["type": "press", "item": id])
    }
    return UIBarButtonItem(primaryAction: action)
  }

  static func hasVerticalBar(_ view: UIView?) -> Bool {
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *), let view {
      switch view.traitCollection.verticalBarEdge {
      case .leading, .trailing: return true
      default: return false
      }
    }
    #endif
    return false
  }
}

final class SystemBarShell: UIViewController {
  let navigation: UINavigationController

  static func install() -> SystemBarShell? {
    guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first,
          let root = window.rootViewController
    else { return nil }
    if let shell = root as? SystemBarShell { return shell }
    window.rootViewController = UIViewController()
    let shell = SystemBarShell(content: root)
    window.rootViewController = shell
    return shell
  }

  private init(content: UIViewController) {
    navigation = UINavigationController(rootViewController: content)
    navigation.setNavigationBarHidden(true, animated: false)
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    addChild(navigation)
    view.addSubview(navigation.view)
    navigation.view.frame = view.bounds
    navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    navigation.didMove(toParent: self)
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      view.registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (_: UIView, _: UITraitCollection) in
        SystemBar.shared.refresh()
      }
    }
    #endif
  }
}
