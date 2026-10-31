require "json"

package = JSON.parse(File.read(File.join(__dir__, "..", "package.json")))

Pod::Spec.new do |s|
  s.name = "PixelIOS"
  s.version = package["version"]
  s.summary = package["description"]
  s.author = "zenbu-labs"
  s.homepage = "https://github.com/zenbu-labs/terminal-browser"
  s.license = package["license"]
  s.platforms = { :ios => "16.4" }
  s.source = { git: "" }
  s.static_framework = true
  s.dependency "ExpoModulesCore"
  s.vendored_frameworks = "Vendor/PixelEngine.xcframework"
  s.frameworks = "Metal", "QuartzCore", "UIKit", "WebKit", "AVFoundation"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }
  s.source_files = "*.swift"
end
