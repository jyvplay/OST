/**
 * Minimal Node ESM resolver hook so test scripts (run via plain
 * `node --experimental-strip-types`) can import the project's TypeScript
 * source files using the SAME extensionless relative specifiers the Next.js
 * bundler already accepts (import ... from "./parser"), instead of forcing
 * every src/lib/**.ts file to add a ".ts" suffix that tsc's default
 * configuration (no `allowImportingTsExtensions`) would reject.
 *
 * Use: node --experimental-strip-types --import ./scripts/ts-loader-hook.mjs <script>
 */
import { resolve as resolvePath, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    const retriable = e.code === "ERR_MODULE_NOT_FOUND" || e.code === "ERR_UNSUPPORTED_DIR_IMPORT";
    if (!retriable || !specifier.startsWith(".")) throw e;
    const baseDir = dirname(new URL(context.parentURL).pathname);
    const candidate = resolvePath(baseDir, specifier);
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      if (existsSync(candidate + ext)) return nextResolve(pathToFileURL(candidate + ext).href, context);
    }
    throw e;
  }
}
