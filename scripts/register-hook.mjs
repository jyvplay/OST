// Bootstrap: Node 20.6+/22 requires module.register() to activate a custom
// resolve hook; merely preloading the hook file via --import is not enough.
import { register } from "node:module";

register("./ts-loader-hook.mjs", import.meta.url);
