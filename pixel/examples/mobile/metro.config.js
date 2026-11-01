const { getDefaultConfig } = require("expo/metro-config");
const { withPixel } = require("@zenbu-labs/pixel-ios/metro");

module.exports = withPixel(getDefaultConfig(__dirname), { pixelRoots: ["src"] });
