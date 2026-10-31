import ExpoModulesCore

public class NativeViewsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PixelNativeViews")

    Events("onNativeViewEvent")

    OnCreate {
      NativeViews.kinds["web"] = { id, emit in WebContent(id: id, emit: emit) }
      NativeViews.kinds["video"] = { id, emit in VideoContent(id: id, emit: emit) }
      NativeViews.kinds["input"] = { id, emit in InputContent(id: id, emit: emit) }
      PixelRuntime.shared.nativeViews.emit = { [weak self] event in
        self?.sendEvent("onNativeViewEvent", event)
      }
    }

    Function("open") { (id: Int, kind: String) in
      DispatchQueue.main.async { PixelRuntime.shared.nativeViews.open(id: id, kind: kind) }
    }

    Function("configure") { (id: Int, json: String) in
      guard let config = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
      DispatchQueue.main.async { PixelRuntime.shared.nativeViews.configure(id: id, config: config) }
    }

    Function("close") { (id: Int) in
      DispatchQueue.main.async { PixelRuntime.shared.nativeViews.close(id: id) }
    }
  }
}
