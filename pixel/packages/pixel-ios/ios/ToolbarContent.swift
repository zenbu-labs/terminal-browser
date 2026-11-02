import UIKit

final class ToolbarContent: NativeContent {
  private let id: Int
  private let emit: NativeViews.Emit
  private let capsule = ToolbarCapsule()
  private var items: [String] = []

  var view: UIView { capsule }
  var above: Bool { true }

  init(id: Int, emit: @escaping NativeViews.Emit) {
    self.id = id
    self.emit = emit
  }

  func configure(_ config: [String: Any]) {
    guard let list = config["items"] as? [[String: Any]] else { return }
    items = list.compactMap { $0["id"] as? String }
    capsule.setButtons(list.enumerated().map { index, item in
      var style = UIButton.Configuration.plain()
      style.image = UIImage(systemName: item["symbol"] as? String ?? "circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
      style.baseForegroundColor = UIColor(white: 0.94, alpha: 1)
      style.contentInsets = .zero
      let button = UIButton(configuration: style, primaryAction: UIAction { [weak self] _ in self?.pressed(index) })
      button.accessibilityLabel = item["label"] as? String
      return button
    })
  }

  private func pressed(_ index: Int) {
    guard index < items.count else { return }
    emit(["id": id, "type": "press", "item": items[index]])
  }
}

final class ToolbarCapsule: UIView {
  private let glass = GlassView.make()
  private let stack = UIStackView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    glass.clipsToBounds = true
    addSubview(glass)
    stack.axis = .horizontal
    stack.distribution = .fillEqually
    glass.contentView.addSubview(stack)
  }

  required init?(coder: NSCoder) { nil }

  func setButtons(_ buttons: [UIButton]) {
    for view in stack.arrangedSubviews {
      stack.removeArrangedSubview(view)
      view.removeFromSuperview()
    }
    buttons.forEach(stack.addArrangedSubview)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    glass.frame = bounds
    glass.layer.cornerRadius = bounds.height / 2
    stack.frame = bounds.insetBy(dx: bounds.height * 0.2, dy: bounds.height * 0.1)
  }
}
