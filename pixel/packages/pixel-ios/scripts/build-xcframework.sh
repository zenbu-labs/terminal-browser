#!/bin/zsh
set -euo pipefail
here=${0:A:h}
engine=$here/../../../engine
vendor=$here/../ios/Vendor
profile=${PIXEL_IOS_PROFILE:-release-ios}
out=$(mktemp -d)
cd $engine
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  IPHONEOS_DEPLOYMENT_TARGET=16.4 cargo build -p pixel-ios --profile $profile --target $target
  mkdir -p $out/$target
  cp target/$target/$profile/libpixel_ios.a $out/$target/
done
mkdir -p $out/include
cp crates/pixel-ios/include/pixel_ios.h $out/include/
cat > $out/include/module.modulemap <<'MAP'
module PixelEngineC {
  header "pixel_ios.h"
  export *
}
MAP
rm -rf $vendor/PixelEngine.xcframework
mkdir -p $vendor
xcodebuild -create-xcframework \
  -library $out/aarch64-apple-ios/libpixel_ios.a -headers $out/include \
  -library $out/aarch64-apple-ios-sim/libpixel_ios.a -headers $out/include \
  -output $vendor/PixelEngine.xcframework >/dev/null
rm -rf $out
du -sh $vendor/PixelEngine.xcframework/*/libpixel_ios.a
