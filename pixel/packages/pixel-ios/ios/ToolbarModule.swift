import ExpoModulesCore

public class ToolbarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PixelToolbar")

    Events("onSystemBar")

    OnCreate {
      NativeViews.kinds["toolbar"] = { id, emit in ToolbarContent(id: id, emit: emit) }
      Task { @MainActor in
        SystemBar.shared.emit = { [weak self] event in self?.sendEvent("onSystemBar", event) }
      }
    }

    Function("setSystemBarItems") { (json: String) in
      let items = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: String]]) ?? []
      Task { @MainActor in SystemBar.shared.setItems(items) }
    }
  }
}
