import UIKit

final class DeviceRequests {
  private unowned let runtime: PixelRuntime

  init(runtime: PixelRuntime) {
    self.runtime = runtime
  }

  func handle(_ data: String) {
    for body in Self.oscBodies(data) where body.hasPrefix("7717;") {
      let request = String(body.dropFirst(5))
      DispatchQueue.main.async { [weak self] in self?.answer(request) }
    }
  }

  private func answer(_ request: String) {
    let view = runtime.view
    switch request {
    case "?":
      runtime.reply("7717;keyboard=\(view?.softKeyboardVisible == true ? "shown" : "hidden");screenshot=1;haptics=1;host=pixel-ios")
    case "keyboard=show":
      view?.setSoftKeyboard(visible: true)
    case "keyboard=hide":
      view?.setSoftKeyboard(visible: false)
    case "screenshot":
      if let image = runtime.currentPresenter()?.snapshot() {
        UIPasteboard.general.image = image
        runtime.reply("7717;screenshot=ok")
      } else {
        runtime.reply("7717;screenshot=error")
      }
    case let haptic where haptic.hasPrefix("haptic="):
      Haptics.play(String(haptic.dropFirst(7)))
    default:
      break
    }
  }

  static func oscBodies(_ data: String) -> [String] {
    var bodies: [String] = []
    var rest = Substring(data)
    while let start = rest.range(of: "\u{1b}]") {
      let after = rest[start.upperBound...]
      guard let end = after.firstIndex(where: { $0 == "\u{07}" || $0 == "\u{1b}" }) else { break }
      bodies.append(String(after[..<end]))
      rest = after[after.index(after: end)...]
    }
    return bodies
  }
}

enum Haptics {
  static func play(_ style: String) {
    switch style {
    case "selection": UISelectionFeedbackGenerator().selectionChanged()
    case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
    case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
    case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
  }
}
