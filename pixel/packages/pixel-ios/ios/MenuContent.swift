import UIKit

final class MenuContent: NativeContent {
  private let id: Int
  private let emit: NativeViews.Emit
  private let button = UIButton(type: .custom)

  var view: UIView { button }
  var above: Bool { true }

  init(id: Int, emit: @escaping NativeViews.Emit) {
    self.id = id
    self.emit = emit
    button.showsMenuAsPrimaryAction = true
    button.preferredMenuElementOrder = .fixed
    button.backgroundColor = .clear
  }

  func configure(_ config: [String: Any]) {
    guard let items = config["items"] as? [[String: Any]] else { return }
    button.menu = UIMenu(children: elements(items))
  }

  private func elements(_ items: [[String: Any]]) -> [UIMenuElement] {
    items.map { item in
      let title = item["title"] as? String ?? ""
      let image = (item["symbol"] as? String).flatMap { UIImage(systemName: $0) }
      if let children = item["children"] as? [[String: Any]] {
        return UIMenu(title: title, image: image, options: item["inline"] as? Bool == true ? .displayInline : [], children: elements(children))
      }
      let choice = item["id"] as? String ?? ""
      return UIAction(title: title, subtitle: item["subtitle"] as? String, image: image, state: item["checked"] as? Bool == true ? .on : .off) { [weak self] _ in
        guard let self else { return }
        self.emit(["id": self.id, "type": "select", "item": choice])
      }
    }
  }
}
