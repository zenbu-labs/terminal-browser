import ExpoModulesCore

public class PixelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Pixel")

    Events("onEngineEvents")

    OnCreate {
      PixelRuntime.shared.emit = { [weak self] batch in
        self?.sendEvent("onEngineEvents", ["events": batch])
      }
    }

    Function("configure") { (json: String) in
      guard let config = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
      if let colors = config["colors"] as? [String: [Int]] { PixelRuntime.shared.colors = colors }
    }

    Function("info") { () -> String in
      PixelRuntime.shared.info()
    }

    Function("applyOps") { (ops: String) in
      PixelRuntime.shared.applyOps(ops)
    }

    Function("start") {
      PixelRuntime.shared.start()
    }

    Function("stop") {
      PixelRuntime.shared.stop()
    }

    Function("call") { (name: String, args: String) -> String in
      PixelRuntime.shared.call(name, args)
    }

    Function("displayScale") { () -> Double in
      Double(PixelRuntime.shared.view?.window?.screen.scale ?? UIScreen.main.scale)
    }

    Function("textSize") { () -> Double in
      Double(PixelRuntime.shared.cellHeightPoints)
    }

    Function("setTextSize") { (points: Double) in
      DispatchQueue.main.async { PixelRuntime.shared.setCellHeight(points: CGFloat(points)) }
    }

    Function("frameStats") { () -> [String: Any] in
      PixelRuntime.shared.currentPresenter()?.stats.take() ?? [:]
    }

    View(PixelView.self) {}
  }
}
