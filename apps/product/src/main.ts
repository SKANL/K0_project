import { mountProductShell } from "./dom.js";
import { productRuntime } from "./runtime.js";

export { productRuntime } from "./runtime.js";

if (typeof document !== "undefined") {
  mountProductShell(document, productRuntime);
}
