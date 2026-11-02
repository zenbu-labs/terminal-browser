import Foundation
import MetricKit
import PixelEngineC

final class CrashReporter: NSObject, MXMetricManagerSubscriber {
  static let shared = CrashReporter()

  static let directory: URL = {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let dir = caches.appendingPathComponent("pixel-crashes", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  private static var signalPath: [CChar] = []
  private var installed = false

  func install() {
    guard !installed else { return }
    installed = true
    MXMetricManager.shared.add(self)
    Self.directory.path.withCString { pixel_set_crash_dir($0) }
    NSSetUncaughtExceptionHandler { exception in
      CrashReporter.write(kind: "objc-exception", fields: ["name": exception.name.rawValue, "reason": exception.reason ?? "", "stack": exception.callStackSymbols])
    }
    Self.signalPath = Array((Self.directory.path + "/signal-\(getpid()).json").utf8CString)
    for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE] {
      signal(sig) { number in
        CrashReporter.writeSignal(number)
        signal(number, SIG_DFL)
        raise(number)
      }
    }
  }

  static func write(kind: String, fields: [String: Any]) {
    var report = fields
    report["kind"] = kind
    report["at"] = Date().timeIntervalSince1970 * 1000
    guard let data = try? JSONSerialization.data(withJSONObject: report) else { return }
    try? data.write(to: directory.appendingPathComponent("\(kind)-\(Int(Date().timeIntervalSince1970 * 1000)).json"))
  }

  private static func writeSignal(_ number: Int32) {
    let body = "{\"kind\":\"signal\",\"signal\":\(number),\"stack\":\(jsonString(Thread.callStackSymbols.joined(separator: "\n")))}"
    signalPath.withUnsafeBufferPointer { path in
      let fd = open(path.baseAddress!, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
      guard fd >= 0 else { return }
      body.withCString { _ = Darwin.write(fd, $0, strlen($0)) }
      close(fd)
    }
  }

  private static func jsonString(_ text: String) -> String {
    let wrapped = (try? JSONSerialization.data(withJSONObject: [text])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(wrapped.dropFirst().dropLast())
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    for payload in payloads {
      try? payload.jsonRepresentation().write(to: Self.directory.appendingPathComponent("metrickit-\(Int(Date().timeIntervalSince1970 * 1000)).json"))
    }
  }

  private func reports() -> [URL] {
    let files = (try? FileManager.default.contentsOfDirectory(at: Self.directory, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "json" }
  }

  func pending() -> [[String: String]] {
    reports().compactMap { url in
      (try? String(contentsOf: url, encoding: .utf8)).map { ["name": url.lastPathComponent, "body": $0] }
    }
  }

  func remove(_ name: String) {
    guard let report = reports().first(where: { $0.lastPathComponent == name }),
          report.deletingLastPathComponent().standardizedFileURL == Self.directory.standardizedFileURL
    else { return }
    try? FileManager.default.removeItem(at: report)
  }
}
