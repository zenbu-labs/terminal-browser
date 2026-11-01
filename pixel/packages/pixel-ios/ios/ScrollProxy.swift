import UIKit

final class ScrollProxy: UIScrollView, UIScrollViewDelegate {
  private static let middle: CGFloat = 5_000_000
  private static let pullDownDistance: CGFloat = 60

  var onScroll: ((CGFloat, CGPoint) -> Void)?
  var onPullDown: (() -> Void)?
  private var pulled = false
  private var last: CGFloat = middle
  private var point = CGPoint.zero

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    showsVerticalScrollIndicator = false
    showsHorizontalScrollIndicator = false
    alwaysBounceVertical = true
    bounces = false
    keyboardDismissMode = .interactive
    contentInsetAdjustmentBehavior = .never
    delegate = self
    panGestureRecognizer.maximumNumberOfTouches = 1
    contentSize = CGSize(width: 1, height: Self.middle * 2)
    contentOffset = CGPoint(x: 0, y: Self.middle)
  }

  required init?(coder: NSCoder) { nil }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    point = panGestureRecognizer.location(in: superview)
    pulled = false
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let delta = contentOffset.y - last
    last = contentOffset.y
    if panGestureRecognizer.state == .began || panGestureRecognizer.state == .changed {
      point = panGestureRecognizer.location(in: superview)
      if !pulled, panGestureRecognizer.translation(in: superview).y > Self.pullDownDistance {
        pulled = true
        onPullDown?()
      }
    }
    if delta != 0 { onScroll?(delta, point) }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { recenter() }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { recenter() }
  }

  private func recenter() {
    last = Self.middle
    contentOffset = CGPoint(x: 0, y: Self.middle)
  }
}
