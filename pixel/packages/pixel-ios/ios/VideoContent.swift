import AVFoundation
import UIKit

final class VideoContent: NativeContent {
  let id: Int
  private let playerView = PlayerView()
  var view: UIView { playerView }
  private let emit: NativeViews.Emit
  private let player = AVPlayer()
  private var source = ""
  private var headers: [String: String] = [:]
  private var timeObserver: Any?
  private var endObserver: NSObjectProtocol?
  private var paused = true
  private var loops = false
  private var shown = false

  init(id: Int, emit: @escaping NativeViews.Emit) {
    self.id = id
    self.emit = emit
    playerView.playerLayer.player = player
    playerView.playerLayer.videoGravity = .resizeAspect
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main) { [weak self] time in
      guard let self, let item = self.player.currentItem else { return }
      let duration = item.duration.isNumeric ? item.duration.seconds * 1000 : 0
      self.emit(["id": id, "type": "time", "timeMs": time.seconds * 1000, "durationMs": duration])
    }
    endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
      guard let self, (note.object as? AVPlayerItem) === self.player.currentItem else { return }
      if self.loops {
        self.player.seek(to: .zero)
        self.applyPlayback()
      } else {
        self.emit(["id": id, "type": "end"])
      }
    }
  }

  func configure(_ config: [String: Any]) {
    let headers = config["headers"] as? [String: String] ?? [:]
    if let source = config["source"] as? String, source != self.source || headers != self.headers, let url = URL(string: source) {
      self.source = source
      self.headers = headers
      let asset = AVURLAsset(url: url, options: headers.isEmpty ? nil : ["AVURLAssetHTTPHeaderFieldsKey": headers])
      player.replaceCurrentItem(with: AVPlayerItem(asset: asset))
    }
    if let muted = config["muted"] as? Bool { player.isMuted = muted }
    if let loops = config["loop"] as? Bool { self.loops = loops }
    if let timeMs = config["timeMs"] as? Double {
      player.seek(to: CMTime(seconds: timeMs / 1000, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: CMTime(seconds: 0.04, preferredTimescale: 600))
    }
    if let paused = config["paused"] as? Bool { self.paused = paused }
    applyPlayback()
  }

  func setShown(_ shown: Bool) {
    self.shown = shown
    applyPlayback()
  }

  private func applyPlayback() {
    if paused || !shown { player.pause() } else { player.play() }
  }

  func close() {
    player.pause()
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
  }
}

final class PlayerView: UIView {
  override class var layerClass: AnyClass { AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
