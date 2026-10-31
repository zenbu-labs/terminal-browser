import ExpoModulesCore
import QuartzCore
import UIKit

final class PixelView: ExpoView, UIKeyInput, UITextInputTraits, UIGestureRecognizerDelegate {
  private let frames = MetalView()
  private let under = PassThroughView()
  private let above = PassThroughView()
  private let scrollProxy = ScrollProxy()
  private let emptyInput = UIView(frame: .zero)
  private var presenter: MetalPresenter?
  private var keyboardOverlap: CGFloat = 0
  private var repeatTimer: Timer?
  private var repeatingKey: UIKeyboardHIDUsage?
  private var pinchStart: CGFloat = 0
  private(set) var softKeyboardVisible = false

  var autocorrectionType: UITextAutocorrectionType = .no
  var autocapitalizationType: UITextAutocapitalizationType = .sentences
  var spellCheckingType: UITextSpellCheckingType = .no
  var smartQuotesType: UITextSmartQuotesType = .no
  var smartDashesType: UITextSmartDashesType = .no
  var keyboardAppearance: UIKeyboardAppearance = .dark

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isMultipleTouchEnabled = true
    frames.isUserInteractionEnabled = false
    presenter = MetalPresenter(layer: frames.metal)
    if let presenter { PixelRuntime.shared.attach(presenter) }
    PixelRuntime.shared.view = self
    PixelRuntime.shared.nativeViews.under = under
    PixelRuntime.shared.nativeViews.above = above

    let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
    let twoFingerTap = UITapGestureRecognizer(target: self, action: #selector(onTwoFingerTap(_:)))
    twoFingerTap.numberOfTouchesRequired = 2
    let press = UILongPressGestureRecognizer(target: self, action: #selector(onLongPress(_:)))
    press.minimumPressDuration = 0.35
    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
    scrollProxy.onScroll = { [weak self] delta, point in self?.scroll(by: delta, at: point) }
    scrollProxy.onPullDown = { [weak self] in self?.dismissKeyboard() }
    addSubview(scrollProxy)
    addSubview(under)
    addSubview(frames)
    addSubview(above)
    for recognizer in [tap, twoFingerTap, press, pinch] as [UIGestureRecognizer] {
      recognizer.delegate = self
      addGestureRecognizer(recognizer)
    }
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(keyboardFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    center.addObserver(self, selector: #selector(keyboardFrame(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    center.addObserver(self, selector: #selector(appActive(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(appActive(_:)), name: UIApplication.willResignActiveNotification, object: nil)
  }

  var engineSizePx: (UInt32, UInt32) {
    let scale = contentScaleFactor
    let height = max(bounds.height - keyboardOverlap, 1)
    return (UInt32(bounds.width * scale), UInt32(height * scale))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let scale = contentScaleFactor
    frames.frame = bounds
    under.frame = bounds
    above.frame = bounds
    frames.metal.contentsScale = scale
    frames.metal.drawableSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    scrollProxy.frame = bounds
    pushSize()
    presenter?.redraw()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard let window else { return }
    contentScaleFactor = window.screen.scale
    PixelRuntime.shared.scale = window.screen.scale
    setNeedsLayout()
    _ = becomeFirstResponder()
  }

  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    let scale = traitCollection.displayScale
    if scale > 0, scale != contentScaleFactor {
      contentScaleFactor = scale
      PixelRuntime.shared.scale = scale
      setNeedsLayout()
    }
  }

  func pushSize() {
    guard bounds.width > 0, bounds.height > 0 else { return }
    let size = engineSizePx
    PixelRuntime.shared.resize(widthPx: size.0, heightPx: size.1)
  }

  func px(_ point: CGPoint) -> [String: Any] {
    ["x": point.x * contentScaleFactor, "y": point.y * contentScaleFactor]
  }

  func pointer(_ kind: String, _ button: String, at point: CGPoint) {
    PixelRuntime.shared.input(["type": "pointer", "kind": kind, "button": button].merging(px(point)) { a, _ in a })
  }

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    other === scrollProxy.panGestureRecognizer
  }

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    !PixelRuntime.shared.nativeViews.owns(touch.view)
  }

  @objc private func onTap(_ g: UITapGestureRecognizer) {
    let point = g.location(in: self)
    window?.endEditing(true)
    if PixelRuntime.shared.nativeViews.tap(at: point) { return }
    pointer("down", "left", at: point)
    pointer("up", "left", at: point)
  }

  @objc private func onTwoFingerTap(_ g: UITapGestureRecognizer) {
    let point = g.location(in: self)
    pointer("down", "right", at: point)
    pointer("up", "right", at: point)
  }

  @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
    switch g.state {
    case .began:
      pinchStart = PixelRuntime.shared.cellHeightPoints
    case .changed, .ended:
      let next = (pinchStart * g.scale).rounded()
      if next != PixelRuntime.shared.cellHeightPoints { PixelRuntime.shared.setCellHeight(points: next) }
    default:
      break
    }
  }

  @objc private func onLongPress(_ g: UILongPressGestureRecognizer) {
    let point = g.location(in: self)
    switch g.state {
    case .began:
      Haptics.play("selection")
      pointer("down", "left", at: point)
    case .changed:
      pointer("move", "left", at: point)
    case .ended, .cancelled, .failed:
      pointer("up", "left", at: point)
    default:
      break
    }
  }

  private func scroll(by delta: CGFloat, at point: CGPoint) {
    PixelRuntime.shared.input(["type": "scroll", "dx": 0, "dy": delta * contentScaleFactor].merging(px(point)) { a, _ in a })
  }

  override var canBecomeFirstResponder: Bool { true }
  override var inputView: UIView? { softKeyboardVisible ? nil : emptyInput }

  func setSoftKeyboard(visible: Bool) {
    if PixelRuntime.shared.nativeViews.setSoftKeyboard(visible) { return }
    guard visible != softKeyboardVisible || !isFirstResponder else { return }
    softKeyboardVisible = visible
    if isFirstResponder {
      reloadInputViews()
    } else {
      _ = becomeFirstResponder()
    }
  }

  func dismissKeyboard() {
    window?.endEditing(true)
    guard softKeyboardVisible else { return }
    setSoftKeyboard(visible: false)
  }

  @objc private func keyboardFrame(_ note: Notification) {
    guard let window, let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let mine = convert(bounds, to: window)
    let overlap = note.name == UIResponder.keyboardWillHideNotification ? 0 : max(0, mine.maxY - end.minY)
    guard overlap != keyboardOverlap else { return }
    keyboardOverlap = overlap
    pushSize()
  }

  @objc private func appActive(_ note: Notification) {
    PixelRuntime.shared.input(["type": "focus", "focused": note.name == UIApplication.didBecomeActiveNotification])
  }

  var hasText: Bool { true }

  func insertText(_ text: String) {
    if text == "\n" || text == "\r" {
      key("enter")
    } else if text.count > 1 {
      PixelRuntime.shared.input(["type": "paste", "text": text])
    } else if let first = text.unicodeScalars.first {
      key(String(first), text: text)
    }
  }

  func deleteBackward() {
    key("backspace")
  }

  private func key(_ name: String, text: String? = nil, mods: [String: Bool] = [:]) {
    var event: [String: Any] = ["type": "key", "key": name, "mods": mods]
    if let text { event["text"] = text }
    PixelRuntime.shared.input(event)
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let unhandled = presses.filter { press in press.key.map { !handleHardware($0) } ?? true }
    if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if presses.contains(where: { $0.key?.keyCode == repeatingKey }) { stopRepeat() }
    super.pressesEnded(presses, with: event)
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    if presses.contains(where: { $0.key?.keyCode == repeatingKey }) { stopRepeat() }
    super.pressesCancelled(presses, with: event)
  }

  private static let special: [UIKeyboardHIDUsage: String] = [
    .keyboardUpArrow: "up", .keyboardDownArrow: "down", .keyboardLeftArrow: "left", .keyboardRightArrow: "right",
    .keyboardEscape: "escape", .keyboardTab: "tab", .keyboardHome: "home", .keyboardEnd: "end",
    .keyboardPageUp: "pageup", .keyboardPageDown: "pagedown", .keyboardDeleteForward: "delete",
    .keyboardReturnOrEnter: "enter", .keyboardDeleteOrBackspace: "backspace",
  ]

  private func handleHardware(_ key: UIKey) -> Bool {
    let flags = key.modifierFlags
    let mods = ["shift": flags.contains(.shift), "ctrl": flags.contains(.control), "alt": flags.contains(.alternate), "meta": flags.contains(.command)]
    let chord = flags.contains(.control) || flags.contains(.alternate) || flags.contains(.command)
    let name: String
    if let special = Self.special[key.keyCode] {
      let typed = special == "enter" || special == "backspace"
      if typed && !chord && !flags.contains(.shift) { return false }
      name = special
    } else if chord, let ch = key.charactersIgnoringModifiers.lowercased().unicodeScalars.first {
      name = String(ch)
    } else {
      return false
    }
    let fire: () -> Void = { [weak self] in self?.key(name, mods: mods) }
    fire()
    if !flags.contains(.command) { startRepeat(key.keyCode, fire) }
    return true
  }

  private func startRepeat(_ keyCode: UIKeyboardHIDUsage, _ fire: @escaping () -> Void) {
    repeatTimer?.invalidate()
    repeatingKey = keyCode
    repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
      self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.035, repeats: true) { _ in fire() }
    }
  }

  private func stopRepeat() {
    repeatTimer?.invalidate()
    repeatTimer = nil
    repeatingKey = nil
  }
}

final class MetalView: UIView {
  override class var layerClass: AnyClass { CAMetalLayer.self }
  var metal: CAMetalLayer { layer as! CAMetalLayer }
}
