const fs = require("node:fs");
const path = require("node:path");

const PIXEL_REACT = ["react", "react/jsx-runtime", "react/jsx-dev-runtime"];

function packageDir(name, from) {
  return fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`, { paths: [from] })));
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function withPixel(config, { pixelRoots = [] } = {}) {
  const projectRoot = config.projectRoot;
  const pixelIos = realpath(__dirname);
  const pixel = packageDir("@zenbu-labs/pixel", pixelIos);
  const reconciler = packageDir("react-reconciler", pixel);
  const scheduler = packageDir("scheduler", reconciler);
  const react18 = packageDir("react-18", pixelIos);
  const roots = [pixel, reconciler, path.join(pixelIos, "src"), ...pixelRoots.map((root) => realpath(path.resolve(projectRoot, root)))];
  const onPixelSide = (origin) => {
    const real = realpath(origin);
    return roots.some((root) => real.startsWith(root + path.sep));
  };
  const resolveNext = config.resolver.resolveRequest;
  return {
    ...config,
    watchFolders: [...new Set([...(config.watchFolders ?? []), pixel, pixelIos, reconciler, scheduler, react18])],
    resolver: {
      ...config.resolver,
      resolveRequest(context, name, platform) {
        if (PIXEL_REACT.includes(name) && onPixelSide(context.originModulePath)) {
          return { type: "sourceFile", filePath: require.resolve(name.replace(/^react/, "react-18"), { paths: [pixelIos] }) };
        }
        if (name === "react-reconciler" || name.startsWith("react-reconciler/")) {
          return { type: "sourceFile", filePath: require.resolve(name, { paths: [pixel] }) };
        }
        return (resolveNext ?? context.resolveRequest)(context, name, platform);
      },
    },
  };
}

module.exports = { withPixel };
