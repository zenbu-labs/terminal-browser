import UIKit

protocol NativeContent: AnyObject {
  var view: UIView { get }
  var above: Bool { get }
  var focusable: Bool { get }
  func configure(_ config: [String: Any])
  func setShown(_ shown: Bool)
  func tap(at point: CGPoint) -> Bool
  func setSoftKeyboard(_ visible: Bool) -> Bool
  func close()
}

extension NativeContent {
  var above: Bool { false }
  var focusable: Bool { false }
  func setShown(_ shown: Bool) {}
  func tap(at point: CGPoint) -> Bool { false }
  func setSoftKeyboard(_ visible: Bool) -> Bool { false }
  func close() {}
}

final class NativeViews {
  typealias Emit = ([String: Any]) -> Void
  typealias Make = (_ id: Int, _ emit: @escaping Emit) -> NativeContent

  struct Placement {
    var rect: CGRect
    var visible: CGRect
  }

  struct Cover {
    var rect: CGRect
    var opaque: Bool
  }

  private final class Slot {
    let content: NativeContent
    let container = UIView()
    var shown = false

    init(content: NativeContent) {
      self.content = content
      container.clipsToBounds = true
      container.isUserInteractionEnabled = false
      container.isHidden = true
      container.addSubview(content.view)
    }
  }

  static var kinds: [String: Make] = [:]

  weak var under: UIView?
  weak var above: UIView?
  var emit: Emit?
  private var slots: [Int: Slot] = [:]
  private var placements: [Int: Placement] = [:]
  private var covers: [Int: [Cover]] = [:]
  private var focused: Int?

  func open(id: Int, kind: String) {
    guard slots[id] == nil, let make = Self.kinds[kind] else { return }
    let slot = Slot(content: make(id) { [weak self] event in self?.emit?(event) })
    slots[id] = slot
    (slot.content.above ? above : under)?.addSubview(slot.container)
    layout(id)
  }

  func configure(id: Int, config: [String: Any]) {
    slots[id]?.content.configure(config)
    if config["blur"] as? Bool == true { blur(id) }
    layout(id)
  }

  func close(id: Int) {
    guard let slot = slots.removeValue(forKey: id) else { return }
    slot.content.close()
    slot.container.removeFromSuperview()
    if focused == id { focused = nil }
  }

  func place(_ placements: [Int: Placement], covers: [Int: [Cover]]) {
    self.placements = placements
    self.covers = covers
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in slots.keys { layout(id) }
    CATransaction.commit()
  }

  func setSoftKeyboard(_ visible: Bool) -> Bool {
    slots.values.contains { $0.content.setSoftKeyboard(visible) }
  }

  func tap(at point: CGPoint) -> Bool {
    let hit = slots.first { id, slot in
      !slot.content.above && slot.shown && slot.container.frame.contains(point) && !(covers[id] ?? []).contains { $0.rect.contains(point) }
    }
    if let (_, slot) = hit, slot.content.tap(at: slot.content.view.convert(point, from: slot.container.superview)) {
      return true
    }
    let next = hit.flatMap { $0.value.content.focusable ? $0.key : nil }
    guard next != focused else { return next != nil }
    if let previous = focused { emit?(["id": previous, "type": "focus", "focused": false]) }
    if let next { emit?(["id": next, "type": "focus", "focused": true]) }
    focused = next
    for id in slots.keys { layout(id) }
    return next != nil
  }

  func owns(_ view: UIView?) -> Bool {
    guard let view else { return false }
    return slots.contains { id, slot in (slot.content.above || id == focused) && view.isDescendant(of: slot.container) }
  }

  private func blur(_ id: Int) {
    guard focused == id else { return }
    focused = nil
    emit?(["id": id, "type": "focus", "focused": false])
  }

  private func layout(_ id: Int) {
    guard let slot = slots[id] else { return }
    guard let placement = placements[id], placement.visible.width > 1, placement.visible.height > 1 else {
      setShown(slot, false)
      return
    }
    slot.container.frame = placement.visible
    slot.content.view.frame = placement.rect.offsetBy(dx: -placement.visible.minX, dy: -placement.visible.minY)
    let local = { (cover: Cover) in cover.rect.intersection(placement.visible).offsetBy(dx: -placement.visible.minX, dy: -placement.visible.minY) }
    let all = covers[id] ?? []
    let uncovered = { (counted: [Cover]) in counted.reduce([slot.container.bounds]) { pieces, cover in pieces.flatMap { Self.subtract(local(cover), from: $0) } } }
    let pieces = slot.content.above ? uncovered(all) : uncovered(all.filter(\.opaque))
    if slot.content.above, !all.isEmpty {
      let mask = (slot.container.layer.mask as? CAShapeLayer) ?? CAShapeLayer()
      let path = UIBezierPath()
      for piece in pieces { path.append(UIBezierPath(rect: piece)) }
      mask.frame = slot.container.bounds
      mask.path = path.cgPath
      slot.container.layer.mask = mask
    } else {
      slot.container.layer.mask = nil
    }
    slot.container.isUserInteractionEnabled = (slot.content.above || focused == id) && !pieces.isEmpty
    setShown(slot, !pieces.isEmpty)
  }

  private func setShown(_ slot: Slot, _ shown: Bool) {
    guard slot.shown != shown || slot.container.isHidden == shown else { return }
    slot.shown = shown
    slot.container.isHidden = !shown
    slot.content.setShown(shown)
  }

  static func subtract(_ cut: CGRect, from rect: CGRect) -> [CGRect] {
    let hole = cut.intersection(rect)
    guard !hole.isNull, hole.width > 0, hole.height > 0 else { return [rect] }
    return [
      CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: hole.minY - rect.minY),
      CGRect(x: rect.minX, y: hole.maxY, width: rect.width, height: rect.maxY - hole.maxY),
      CGRect(x: rect.minX, y: hole.minY, width: hole.minX - rect.minX, height: hole.height),
      CGRect(x: hole.maxX, y: hole.minY, width: rect.maxX - hole.maxX, height: hole.height),
    ].filter { $0.width > 0.5 && $0.height > 0.5 }
  }
}

final class PassThroughView: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    return hit === self ? nil : hit
  }
}
