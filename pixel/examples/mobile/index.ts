import { PixelView } from "@zenbu-labs/pixel-ios";
import { registerRootComponent } from "expo";
import { createElement } from "react";

import { start } from "./src/main";

start();
registerRootComponent(() => createElement(PixelView, { style: { flex: 1, backgroundColor: "#121216" } }));
