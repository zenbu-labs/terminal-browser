import UIKit

final class InputField: UIView, UITextViewDelegate {
  let id: Int
  var blurred: (() -> Void)?
  let text = PixelTextView()
  private let glass: UIVisualEffectView
  private let emptyInput = UIView(frame: .zero)
  private var reportedHeight: CGFloat = 0
  private var source = "type"
  var multiline = true
  var insertingLineBreak = false
  private let leading = UIButton(type: .system)
  private let trailing = UIButton(type: .system)
  private var leadingKind: String?
  private var trailingKind: String?
  private var barMinHeight: CGFloat = 44
  private var barPadding: CGFloat = 12
  private var barButton: CGFloat = 36
  private var lineHeight: CGFloat {
    let textLine = ceil(text.font?.lineHeight ?? 20)
    guard leadingKind != nil || trailingKind != nil else { return textLine + 22 }
    return max(barMinHeight, textLine + 2 * barPadding)
  }
  private var buttonSize: CGFloat { min(barButton, lineHeight - 8) }
  private var buttonCentre: CGFloat { lineHeight / 2 }
  private var lastWidth: CGFloat = 0
  var emit: (([String: Any]) -> Void)?

  init(id: Int) {
    self.id = id
    glass = GlassView.make()
    super.init(frame: .zero)
    glass.clipsToBounds = true
    addSubview(glass)
    text.backgroundColor = .clear
    text.isScrollEnabled = false
    text.textContainerInset = UIEdgeInsets(top: 11, left: 16, bottom: 11, right: 16)
    text.textContainer.lineFragmentPadding = 0
    text.keyboardAppearance = .dark
    text.autocorrectionType = .default
    text.smartQuotesType = .no
    text.smartDashesType = .no
    text.delegate = self
    text.field = self
    text.inputView = emptyInput
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
    tap.cancelsTouchesInView = false
    text.addGestureRecognizer(tap)
    glass.contentView.addSubview(text)
    for (button, action) in [(leading, #selector(leadingTapped)), (trailing, #selector(trailingTapped))] {
      button.isHidden = true
      button.addTarget(self, action: action, for: .touchUpInside)
      glass.contentView.addSubview(button)
    }
  }

  private func setAccessory(_ button: UIButton, kind: String?) {
    button.isHidden = kind == nil
    guard let kind else { return }
    let symbol = ["plus": "plus", "send": "arrow.up", "stop": "stop.fill"][kind] ?? "circle"
    var config: UIButton.Configuration
    if kind == "plus" {
      config = .plain()
      config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .regular))
      config.baseForegroundColor = UIColor(white: 0.92, alpha: 1)
    } else {
      if #available(iOS 26.0, *) { config = .prominentGlass() } else { config = .filled() }
      config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .bold))
      config.cornerStyle = .capsule
      config.baseBackgroundColor = .white
      config.baseForegroundColor = .black
    }
    config.contentInsets = .zero
    button.configuration = config
  }

  @objc private func leadingTapped() {
    if let leadingKind { emit?(["id": id, "type": "accessory", "name": leadingKind]) }
  }

  @objc private func trailingTapped() {
    if let trailingKind { emit?(["id": id, "type": "accessory", "name": trailingKind]) }
  }

  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    glass.frame = bounds
    glass.layer.cornerRadius = min(lineHeight / 2, bounds.height / 2)
    let line = lineHeight
    let left: CGFloat = leadingKind == nil ? 0 : line - 8
    let right: CGFloat = trailingKind == nil ? 0 : buttonCentre + buttonSize / 2 + 4
    text.frame = CGRect(x: left, y: 0, width: max(0, bounds.width - left - right), height: bounds.height)
    let middle = bounds.height - line / 2
    let size = buttonSize
    leading.frame = CGRect(x: buttonCentre - size / 2, y: middle - size / 2, width: size, height: size)
    trailing.frame = CGRect(x: bounds.width - buttonCentre - size / 2, y: middle - size / 2, width: size, height: size)
    if abs(bounds.width - lastWidth) > 0.5 {
      lastWidth = bounds.width
      centreOneLine()
      reportHeight()
    }
  }

  private func centreOneLine() {
    let font = text.font ?? .monospacedSystemFont(ofSize: 15, weight: .regular)
    let pad = max(8, ((lineHeight - font.lineHeight) / 2).rounded(.down))
    if text.textContainerInset.top != pad {
      text.textContainerInset = UIEdgeInsets(top: pad, left: 16, bottom: pad, right: 16)
    }
  }


  func apply(_ config: [String: Any]) {
    if let size = config["fontSize"] as? Double {
      text.font = UIFont.monospacedSystemFont(ofSize: CGFloat(size), weight: .regular)
      text.typingAttributes[.font] = text.font
      centreOneLine()
    }
    if let rgba = config["color"] as? [Double], rgba.count >= 3 {
      let color = UIColor(red: rgba[0] / 255, green: rgba[1] / 255, blue: rgba[2] / 255, alpha: rgba.count > 3 ? rgba[3] / 255 : 1)
      text.textColor = color
      text.tintColor = color
      text.typingAttributes[.foregroundColor] = color
    }
    if let multiline = config["multiline"] as? Bool { self.multiline = multiline }
    if let bar = config["bar"] as? [String: Any] {
      if let value = bar["minHeight"] as? Double { barMinHeight = CGFloat(value) }
      if let value = bar["padding"] as? Double { barPadding = CGFloat(value) }
      if let value = bar["button"] as? Double { barButton = CGFloat(value) }
      lastWidth = 0
      setNeedsLayout()
    }
    if let entries = config["leadingMenu"] as? [[String: String]] {
      let actions = entries.map { entry in
        UIAction(title: entry["title"] ?? "", image: entry["symbol"].flatMap { UIImage(systemName: $0) }) { [weak self] _ in
          guard let self else { return }
          self.emit?(["id": self.id, "type": "accessory", "name": entry["id"] ?? ""])
        }
      }
      leading.menu = actions.isEmpty ? nil : UIMenu(children: actions)
      leading.showsMenuAsPrimaryAction = !actions.isEmpty
      leading.preferredMenuElementOrder = .fixed
    }
    if let accessories = config["accessories"] as? [String: Any] {
      leadingKind = accessories["leading"] as? String
      trailingKind = accessories["trailing"] as? String
      setAccessory(leading, kind: leadingKind)
      setAccessory(trailing, kind: trailingKind)
      setNeedsLayout()
      centreOneLine()
      reportHeight()
    }
    if let value = config["text"] as? String {
      replace(NSRange(location: 0, length: text.attributedText.length), with: value, marks: config["marks"] as? [[String: Any]] ?? [])
    }
    if let splice = config["splice"] as? [Any], splice.count == 3, let start = splice[0] as? Int, let end = splice[1] as? Int, let insert = splice[2] as? String {
      replace(NSRange(location: start, length: max(0, end - start)), with: insert, marks: [])
    }
    if let mark = config["addMark"] as? [String: Any], let markId = mark["id"] as? Int {
      let at = min(mark["at"] as? Int ?? text.selectedRange.location, text.attributedText.length)
      let chip = NSAttributedString(attachment: Chip(markId: markId, label: mark["label"] as? String ?? "", font: text.font))
      let updated = NSMutableAttributedString(attributedString: text.attributedText)
      updated.insert(chip, at: at)
      text.attributedText = updated
      text.selectedRange = NSRange(location: at + 1, length: 0)
      changed(source: "edit")
    }
    if let removed = config["removeMark"] as? Int, let range = range(ofMark: removed) {
      let updated = NSMutableAttributedString(attributedString: text.attributedText)
      updated.deleteCharacters(in: range)
      text.attributedText = updated
      changed(source: "edit")
    }
    if config["selectAll"] as? Bool == true { text.selectedRange = NSRange(location: 0, length: text.attributedText.length) }
    if let caret = config["caret"] as? String { moveCaret(caret) }
    if config["focus"] as? Bool == true, !text.isFirstResponder { _ = text.becomeFirstResponder() }
    if config["blur"] as? Bool == true, text.isFirstResponder { _ = text.resignFirstResponder() }
    reportHeight()
  }

  private func replace(_ range: NSRange, with value: String, marks: [[String: Any]]) {
    let safe = NSIntersectionRange(range, NSRange(location: 0, length: text.attributedText.length))
    let attributes = text.typingAttributes
    let inserted = NSMutableAttributedString(string: value, attributes: attributes)
    for mark in marks {
      guard let markId = mark["id"] as? Int, let at = mark["at"] as? Int, at < inserted.length else { continue }
      inserted.replaceCharacters(in: NSRange(location: at, length: 1), with: NSAttributedString(attachment: Chip(markId: markId, label: mark["label"] as? String ?? "", font: text.font)))
    }
    let updated = NSMutableAttributedString(attributedString: text.attributedText)
    updated.replaceCharacters(in: safe, with: inserted)
    text.attributedText = updated
    text.selectedRange = NSRange(location: safe.location + inserted.length, length: 0)
    text.typingAttributes = attributes
    changed(source: "edit")
  }

  func setSoftKeyboard(_ visible: Bool) -> Bool {
    guard text.isFirstResponder else { return false }
    let wanted: UIView? = visible ? nil : emptyInput
    if text.inputView !== wanted {
      text.inputView = wanted
      text.reloadInputViews()
    }
    return true
  }

  @objc private func tapped() {
    emit?(["id": id, "type": "tapped"])
    if text.inputView != nil {
      text.inputView = nil
      text.reloadInputViews()
    }
    if !text.isFirstResponder { _ = text.becomeFirstResponder() }
  }

  private func moveCaret(_ direction: String) {
    guard let current = text.selectedTextRange?.end else { return }
    let way: UITextLayoutDirection = direction == "up" ? .up : .down
    if let next = text.position(from: current, in: way, offset: 1) {
      text.selectedTextRange = text.textRange(from: next, to: next)
    }
  }


  private func marks() -> [[String: Int]] {
    var found: [[String: Int]] = []
    let all = NSRange(location: 0, length: text.attributedText.length)
    text.attributedText.enumerateAttribute(.attachment, in: all) { value, range, _ in
      if let chip = value as? Chip { found.append(["id": chip.markId, "at": range.location]) }
    }
    return found
  }

  private func range(ofMark markId: Int) -> NSRange? {
    var hit: NSRange?
    text.attributedText.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.attributedText.length)) { value, range, stop in
      if (value as? Chip)?.markId == markId {
        hit = range
        stop.pointee = true
      }
    }
    return hit
  }

  private func caretRect() -> CGRect {
    guard let end = text.selectedTextRange?.end else { return .zero }
    return text.caretRect(for: end)
  }

  func changed(source: String) {
    let caret = caretRect()
    emit?([
      "id": id, "type": "input", "text": text.attributedText.string, "source": source,
      "selection": [text.selectedRange.location, text.selectedRange.location + text.selectedRange.length],
      "marks": marks(), "caret": [caret.minX, caret.minY, caret.width, caret.height],
    ])
    reportHeight()
  }

  private func reportHeight() {
    let left: CGFloat = leadingKind == nil ? 0 : lineHeight - 8
    let right: CGFloat = trailingKind == nil ? 0 : buttonCentre + buttonSize / 2 + 4
    let width = max(40, (bounds.width > 0 ? bounds.width : 200) - left - right)
    let height = max(lineHeight, ceil(text.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height))
    guard abs(height - reportedHeight) > 0.5 else { return }
    reportedHeight = height
    emit?(["id": id, "type": "height", "height": height])
  }

  func key(_ name: String, mods: [String: Bool] = [:]) {
    emit?(["id": id, "type": "key", "key": name, "mods": mods])
  }

  func textViewDidChange(_ textView: UITextView) {
    changed(source: source)
    source = "type"
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    let caret = caretRect()
    emit?(["id": id, "type": "caret", "selection": [text.selectedRange.location, text.selectedRange.location + text.selectedRange.length], "caret": [caret.minX, caret.minY, caret.width, caret.height]])
  }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
    if replacement == "\n", !insertingLineBreak {
      key("enter")
      return false
    }
    if replacement.count > 1 { source = "paste" }
    return true
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    emit?(["id": id, "type": "focus", "focused": true])
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    text.inputView = emptyInput
    emit?(["id": id, "type": "focus", "focused": false])
    blurred?()
  }
}

final class PixelTextView: UITextView {
  weak var field: InputField?

  private static let forwarded: [UIKeyboardHIDUsage: String] = [
    .keyboardUpArrow: "up", .keyboardDownArrow: "down", .keyboardEscape: "escape", .keyboardTab: "tab",
  ]

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var rest = Set<UIPress>()
    for press in presses {
      guard let key = press.key else {
        rest.insert(press)
        continue
      }
      let flags = key.modifierFlags
      let mods = ["shift": flags.contains(.shift), "ctrl": flags.contains(.control), "alt": flags.contains(.alternate), "meta": flags.contains(.command)]
      if let name = Self.forwarded[key.keyCode], !flags.contains(.command) {
        field?.key(name, mods: mods)
      } else if key.keyCode == .keyboardReturnOrEnter, flags.contains(.shift), field?.multiline == true {
        field?.insertingLineBreak = true
        insertText("\n")
        field?.insertingLineBreak = false
      } else if flags.contains(.control), let ch = key.charactersIgnoringModifiers.lowercased().first {
        field?.key(String(ch), mods: mods)
      } else {
        rest.insert(press)
      }
    }
    if !rest.isEmpty { super.pressesBegan(rest, with: event) }
  }
}

final class Chip: NSTextAttachment {
  let markId: Int

  init(markId: Int, label: String, font: UIFont?) {
    self.markId = markId
    super.init(data: nil, ofType: nil)
    let font = font ?? .monospacedSystemFont(ofSize: 15, weight: .regular)
    let label = label.isEmpty ? "📎" : label
    let textSize = (label as NSString).size(withAttributes: [.font: font])
    let size = CGSize(width: ceil(textSize.width) + 14, height: ceil(font.lineHeight))
    image = UIGraphicsImageRenderer(size: size).image { _ in
      UIColor.white.withAlphaComponent(0.16).setFill()
      UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 6).fill()
      (label as NSString).draw(at: CGPoint(x: 7, y: (size.height - textSize.height) / 2), withAttributes: [.font: font, .foregroundColor: UIColor.white])
    }
    bounds = CGRect(x: 0, y: font.descender, width: size.width, height: size.height)
  }

  required init?(coder: NSCoder) { nil }
}

final class InputContent: NativeContent {
  private let field: InputField

  var view: UIView { field }
  var above: Bool { true }

  init(id: Int, emit: @escaping NativeViews.Emit) {
    field = InputField(id: id)
    field.emit = emit
    field.blurred = { _ = PixelRuntime.shared.view?.becomeFirstResponder() }
  }

  func configure(_ config: [String: Any]) {
    field.apply(config)
  }

  func setSoftKeyboard(_ visible: Bool) -> Bool {
    field.setSoftKeyboard(visible)
  }
}
