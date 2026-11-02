import UIKit

enum GlassView {
  static func make() -> UIVisualEffectView {
    if #available(iOS 26.0, *) {
      let effect = UIGlassEffect()
      effect.isInteractive = true
      return UIVisualEffectView(effect: effect)
    }
    return UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
  }
}
