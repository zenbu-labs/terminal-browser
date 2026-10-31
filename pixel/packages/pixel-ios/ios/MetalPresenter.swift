import Metal
import PixelEngineC
import QuartzCore
import UIKit

final class MetalPresenter {
  private static let inFlight = 3
  private static let shader = """
  #include <metal_stdlib>
  using namespace metal;
  struct Out { float4 position [[position]]; float2 uv; };
  vertex Out frameQuad(uint id [[vertex_id]], constant float2 &scale [[buffer(0)]]) {
    float2 corner = float2(id & 1, id >> 1);
    Out out;
    out.position = float4(corner.x * 2 * scale.x - 1, 1 - corner.y * 2 * scale.y, 0, 1);
    out.uv = corner;
    return out;
  }
  fragment float4 show(Out in [[stage_in]], texture2d<float> frame [[texture(0)]], constant float &premultiplied [[buffer(0)]]) {
    constexpr sampler nearest(filter::nearest);
    float4 px = frame.sample(nearest, in.uv);
    return float4(premultiplied > 0.5 ? px.rgb : px.rgb * px.a, px.a);
  }
  """

  let layer: CAMetalLayer
  let stats = FrameStats()
  private let device: MTLDevice
  private let queue: MTLCommandQueue
  private let pipeline: MTLRenderPipelineState
  private var texture: MTLTexture?
  private var staging: [MTLBuffer?] = Array(repeating: nil, count: MetalPresenter.inFlight)
  private var next = 0
  private var premultiplied = false
  private let slots = DispatchSemaphore(value: MetalPresenter.inFlight)

  init?(layer: CAMetalLayer) {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
          let library = try? device.makeLibrary(source: Self.shader, options: nil)
    else { return nil }
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: "frameQuad")
    descriptor.fragmentFunction = library.makeFunction(name: "show")
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    guard let pipeline = try? device.makeRenderPipelineState(descriptor: descriptor) else { return nil }
    self.device = device
    self.queue = queue
    self.pipeline = pipeline
    self.layer = layer
    layer.device = device
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = true
    layer.maximumDrawableCount = 3
    layer.isOpaque = false
  }

  func present(_ frame: PixelFrame) {
    let width = Int(frame.width), height = Int(frame.height)
    guard let rgba = frame.rgba, width > 0, height > 0, width <= 16384, height <= 16384 else { return }
    let started = CACurrentMediaTime()
    slots.wait()
    var fresh = false
    if texture?.width != width || texture?.height != height {
      let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: false)
      descriptor.usage = .shaderRead
      descriptor.storageMode = .private
      texture = device.makeTexture(descriptor: descriptor)
      fresh = true
    }
    guard let texture, let commands = queue.makeCommandBuffer() else {
      slots.signal()
      return
    }
    let damage = fresh ? [MTLRegionMake2D(0, 0, width, height)] : Self.regions(frame.rects, Int(frame.rect_count), width: width, height: height)
    let uploaded = upload(damage, from: rgba, width: width, to: texture, commands: commands)
    premultiplied = frame.premultiplied
    let cpuMs = (CACurrentMediaTime() - started) * 1000
    let slots = self.slots
    commands.addCompletedHandler { _ in slots.signal() }
    draw(texture, premultiplied: frame.premultiplied, commands: commands, started: started, cpuMs: cpuMs, uploadedPixels: uploaded)
    commands.commit()
  }

  func redraw() {
    guard let texture, let commands = queue.makeCommandBuffer() else { return }
    slots.wait()
    let slots = self.slots
    commands.addCompletedHandler { _ in slots.signal() }
    draw(texture, premultiplied: premultiplied, commands: commands, started: CACurrentMediaTime(), cpuMs: 0, uploadedPixels: 0)
    commands.commit()
  }

  private func upload(_ damage: [MTLRegion], from rgba: UnsafePointer<UInt8>, width: Int, to texture: MTLTexture, commands: MTLCommandBuffer) -> Int {
    guard !damage.isEmpty else { return 0 }
    let bytes = damage.reduce(0) { $0 + $1.size.width * $1.size.height * 4 }
    let slot = next
    next = (next + 1) % Self.inFlight
    if (staging[slot]?.length ?? 0) < bytes {
      staging[slot] = device.makeBuffer(length: max(bytes, texture.width * texture.height * 4), options: .storageModeShared)
    }
    guard let buffer = staging[slot], let blit = commands.makeBlitCommandEncoder() else { return 0 }
    let base = buffer.contents()
    var offset = 0
    var pixels = 0
    for region in damage {
      let rowBytes = region.size.width * 4
      for row in 0..<region.size.height {
        let source = rgba + ((region.origin.y + row) * width + region.origin.x) * 4
        (base + offset + row * rowBytes).copyMemory(from: source, byteCount: rowBytes)
      }
      blit.copy(from: buffer, sourceOffset: offset, sourceBytesPerRow: rowBytes, sourceBytesPerImage: rowBytes * region.size.height,
                sourceSize: region.size, to: texture, destinationSlice: 0, destinationLevel: 0, destinationOrigin: region.origin)
      offset += rowBytes * region.size.height
      pixels += region.size.width * region.size.height
    }
    blit.endEncoding()
    return pixels
  }

  private func draw(_ texture: MTLTexture, premultiplied: Bool, commands: MTLCommandBuffer, started: CFTimeInterval, cpuMs: Double, uploadedPixels: Int) {
    guard let drawable = layer.nextDrawable() else { return }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = drawable.texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    if let encoder = commands.makeRenderCommandEncoder(descriptor: pass) {
      var scale = SIMD2<Float>(Float(texture.width) / Float(drawable.texture.width), Float(texture.height) / Float(drawable.texture.height))
      var alreadyPremultiplied: Float = premultiplied ? 1 : 0
      encoder.setRenderPipelineState(pipeline)
      encoder.setVertexBytes(&scale, length: MemoryLayout<SIMD2<Float>>.size, index: 0)
      encoder.setFragmentTexture(texture, index: 0)
      encoder.setFragmentBytes(&alreadyPremultiplied, length: MemoryLayout<Float>.size, index: 0)
      encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
      encoder.endEncoding()
    }
    let stats = self.stats
    #if targetEnvironment(simulator)
    commands.addCompletedHandler { _ in
      stats.presented(at: CACurrentMediaTime(), wallMs: (CACurrentMediaTime() - started) * 1000, cpuMs: cpuMs, pixels: uploadedPixels)
    }
    #else
    drawable.addPresentedHandler { presented in
      stats.presented(at: presented.presentedTime, wallMs: (CACurrentMediaTime() - started) * 1000, cpuMs: cpuMs, pixels: uploadedPixels)
    }
    #endif
    commands.present(drawable)
  }

  static func regions(_ rects: UnsafePointer<UInt32>?, _ count: Int, width: Int, height: Int) -> [MTLRegion] {
    guard let rects else { return [] }
    return (0..<count).compactMap { i in
      clamped(MTLRegionMake2D(Int(rects[i * 4]), Int(rects[i * 4 + 1]), Int(rects[i * 4 + 2]), Int(rects[i * 4 + 3])), width: width, height: height)
    }
  }

  static func clamped(_ region: MTLRegion, width: Int, height: Int) -> MTLRegion? {
    let x = max(0, region.origin.x), y = max(0, region.origin.y)
    let w = min(region.origin.x + region.size.width, width) - x
    let h = min(region.origin.y + region.size.height, height) - y
    return w > 0 && h > 0 ? MTLRegionMake2D(x, y, w, h) : nil
  }

  func snapshot() -> UIImage? {
    guard let texture, let commands = queue.makeCommandBuffer(), let blit = commands.makeBlitCommandEncoder() else { return nil }
    let width = texture.width, height = texture.height
    guard let buffer = device.makeBuffer(length: width * height * 4, options: .storageModeShared) else { return nil }
    blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: width, height: height, depth: 1),
              to: buffer, destinationOffset: 0, destinationBytesPerRow: width * 4, destinationBytesPerImage: width * height * 4)
    blit.endEncoding()
    commands.commit()
    commands.waitUntilCompleted()
    var bytes = [UInt8](UnsafeBufferPointer(start: buffer.contents().assumingMemoryBound(to: UInt8.self), count: width * height * 4))
    for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
    guard let provider = CGDataProvider(data: Data(bytes) as CFData),
          let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                              provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return nil }
    return UIImage(cgImage: image, scale: UIScreen.main.scale, orientation: .up)
  }
}

final class FrameStats {
  private static let kept = 2000
  private let lock = NSLock()
  private var last: CFTimeInterval = 0
  private var intervals: [Double] = []
  private var wall: [Double] = []
  private var cpu: [Double] = []
  private var pixels: [Int] = []

  func presented(at time: CFTimeInterval, wallMs: Double, cpuMs: Double, pixels uploaded: Int) {
    guard time > 0 else { return }
    lock.lock()
    defer { lock.unlock() }
    if last > 0 {
      let gap = (time - last) * 1000
      if gap < 250 { intervals.append(gap) }
    }
    last = time
    wall.append(wallMs)
    cpu.append(cpuMs)
    pixels.append(uploaded)
    if pixels.count > Self.kept {
      intervals = intervals.suffix(Self.kept / 2)
      wall = wall.suffix(Self.kept / 2)
      cpu = cpu.suffix(Self.kept / 2)
      pixels = pixels.suffix(Self.kept / 2)
    }
  }

  func take() -> [String: Any] {
    lock.lock()
    defer {
      intervals = []
      wall = []
      cpu = []
      pixels = []
      lock.unlock()
    }
    func percentile(_ values: [Double], _ p: Double) -> Double {
      guard !values.isEmpty else { return 0 }
      let sorted = values.sorted()
      return sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))]
    }
    func spread(_ values: [Double]) -> [String: Double] { ["p50": percentile(values, 0.5), "p95": percentile(values, 0.95)] }
    return [
      "frames": intervals.count,
      "intervalMs": ["p50": percentile(intervals, 0.5), "p95": percentile(intervals, 0.95), "max": intervals.max() ?? 0],
      "presentCpuMs": spread(cpu),
      "presentWallMs": spread(wall),
      "uploadedMpx": pixels.isEmpty ? 0 : Double(pixels.reduce(0, +)) / Double(pixels.count) / 1e6,
      "maximumFramesPerSecond": UIScreen.main.maximumFramesPerSecond,
    ]
  }
}
