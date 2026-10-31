import Foundation
import PixelEngineC
import UIKit

final class PixelRuntime {
  static let shared = PixelRuntime()
  static let defaultCellHeight: CGFloat = 17
  static let expectedAbiVersion: UInt32 = 1

  var cellHeightPoints: CGFloat = {
    let saved = UserDefaults.standard.double(forKey: "pixel.cellHeight")
    return saved > 0 ? CGFloat(saved) : PixelRuntime.defaultCellHeight
  }()
  var scale: CGFloat = UIScreen.main.scale
  var colors: [String: [Int]] = ["foreground": [232, 232, 232, 255], "background": [25, 25, 27, 255]]
  var emit: (([String]) -> Void)?
  let nativeViews = NativeViews()
  weak var view: PixelView?

  private var engine: OpaquePointer?
  private let engineLock = NSRecursiveLock()
  private var started = false
  private var wantsStart = false
  private let lock = NSLock()
  private var pendingEvents: [String] = []
  private var flushScheduled = false
  private var presenter: MetalPresenter?
  private var lastMetrics: (UInt32, UInt32, UInt32, UInt32)?
  private lazy var requests = DeviceRequests(runtime: self)

  private init() {
    precondition(pixel_abi_version() == Self.expectedAbiVersion, "PixelEngine.xcframework does not match this version of pixel-ios")
  }

  private func cell() -> (UInt32, UInt32) {
    let height = cellHeightPoints * scale
    return (UInt32((height * 0.447).rounded()), UInt32(height.rounded()))
  }

  private func ensureEngine() -> OpaquePointer? {
    engineLock.lock()
    defer { engineLock.unlock() }
    if let engine { return engine }
    let size = view.map { $0.engineSizePx } ?? Self.screenSizePx()
    let (cw, ch) = cell()
    let config: [String: Any] = ["width": size.0, "height": size.1, "cellWidth": cw, "cellHeight": ch, "colors": colors]
    guard let json = Self.json(config) else { return nil }
    engine = json.withCString { pixel_engine_new($0) }
    lastMetrics = (size.0, size.1, cw, ch)
    return engine
  }

  static func screenSizePx() -> (UInt32, UInt32) {
    let bounds = UIScreen.main.bounds
    let scale = UIScreen.main.scale
    return (UInt32(bounds.width * scale), UInt32(bounds.height * scale))
  }

  static func json(_ object: Any) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func info() -> String {
    guard let engine = ensureEngine(), let raw = pixel_engine_info(engine) else { return "{}" }
    defer { pixel_string_free(raw) }
    return String(cString: raw)
  }

  func applyOps(_ json: String) {
    guard let engine = ensureEngine() else { return }
    json.withCString { pixel_engine_apply_ops(engine, $0) }
  }

  func start() {
    engineLock.lock()
    defer { engineLock.unlock() }
    wantsStart = true
    guard currentPresenter() != nil, let engine = ensureEngine(), !started else { return }
    started = true
    var callbacks = PixelCallbacks()
    callbacks.context = Unmanaged.passUnretained(self).toOpaque()
    callbacks.event = { context, json in
      guard let context, let json else { return }
      PixelRuntime.from(context).queueEvent(String(cString: json))
    }
    callbacks.present = { context, frame in
      guard let context, let frame else { return }
      PixelRuntime.from(context).currentPresenter()?.present(frame.pointee)
    }
    callbacks.write = { context, data in
      guard let context, let data else { return }
      PixelRuntime.from(context).requests.handle(String(cString: data))
    }
    callbacks.place = { context, placements, count, covers, coverCount in
      guard let context else { return }
      PixelRuntime.from(context).place(placements, Int(count), covers, Int(coverCount))
    }
    pixel_engine_start(engine, callbacks)
  }

  private static func from(_ context: UnsafeMutableRawPointer) -> PixelRuntime {
    Unmanaged<PixelRuntime>.fromOpaque(context).takeUnretainedValue()
  }

  func stop() {
    engineLock.lock()
    defer { engineLock.unlock() }
    guard let engine else { return }
    pixel_engine_free(engine)
    self.engine = nil
    started = false
    wantsStart = false
  }

  func input(_ object: [String: Any]) {
    guard let engine = ensureEngine(), let json = Self.json(object) else { return }
    json.withCString { pixel_engine_input(engine, $0) }
  }

  func resize(widthPx: UInt32, heightPx: UInt32) {
    engineLock.lock()
    defer { engineLock.unlock() }
    guard let engine = ensureEngine() else { return }
    let (cw, ch) = cell()
    let metrics = (widthPx, heightPx, cw, ch)
    if let last = lastMetrics, last == metrics { return }
    lastMetrics = metrics
    pixel_engine_resize(engine, widthPx, heightPx, cw, ch)
  }

  func setCellHeight(points: CGFloat) {
    cellHeightPoints = min(max(points, 11), 30)
    UserDefaults.standard.set(Double(cellHeightPoints), forKey: "pixel.cellHeight")
    if let view {
      let size = view.engineSizePx
      resize(widthPx: size.0, heightPx: size.1)
    }
  }

  func attach(_ presenter: MetalPresenter) {
    lock.lock()
    self.presenter = presenter
    lock.unlock()
    if wantsStart { start() }
  }

  func currentPresenter() -> MetalPresenter? {
    lock.lock()
    defer { lock.unlock() }
    return presenter
  }

  func call(_ name: String, _ args: String) -> String {
    let raw = name.withCString { n in args.withCString { a in pixel_call(n, a) } }
    guard let raw else { return #"{"error":"no result"}"# }
    defer { pixel_string_free(raw) }
    return String(cString: raw)
  }

  private func place(_ placements: UnsafePointer<PixelPlacement>?, _ count: Int, _ covers: UnsafePointer<PixelCover>?, _ coverCount: Int) {
    let s = scale
    let points = { (x: Float, y: Float, w: Float, h: Float) in CGRect(x: CGFloat(x) / s, y: CGFloat(y) / s, width: CGFloat(w) / s, height: CGFloat(h) / s) }
    var placed: [Int: NativeViews.Placement] = [:]
    for p in UnsafeBufferPointer(start: placements, count: placements == nil ? 0 : count) {
      placed[Int(p.surface)] = .init(rect: points(p.x, p.y, p.width, p.height), visible: points(p.visible_x, p.visible_y, p.visible_width, p.visible_height))
    }
    var covered: [Int: [NativeViews.Cover]] = [:]
    for c in UnsafeBufferPointer(start: covers, count: covers == nil ? 0 : coverCount) {
      covered[Int(c.surface), default: []].append(.init(rect: points(c.x, c.y, c.width, c.height), opaque: c.opaque))
    }
    DispatchQueue.main.async { [weak self] in self?.nativeViews.place(placed, covers: covered) }
  }

  func reply(_ osc: String) {
    input(["type": "osc", "data": osc])
  }

  private func queueEvent(_ json: String) {
    lock.lock()
    pendingEvents.append(json)
    let schedule = !flushScheduled
    flushScheduled = true
    lock.unlock()
    guard schedule else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let batch = self.pendingEvents
      self.pendingEvents = []
      self.flushScheduled = false
      self.lock.unlock()
      self.emit?(batch)
    }
  }
}
