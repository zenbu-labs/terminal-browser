import ExpoModulesCore

public class CrashModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PixelCrashes")

    OnCreate {
      CrashReporter.shared.install()
    }

    Function("pending") { () -> [[String: String]] in
      CrashReporter.shared.pending()
    }

    Function("remove") { (name: String) in
      CrashReporter.shared.remove(name)
    }

    Function("crash") {
      abort()
    }
  }
}
