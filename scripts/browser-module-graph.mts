/** Read real production modules and their static transitive import graph for
 * isolated native-browser kernel tests. Uses the installed TypeScript compiler;
 * only module-specifier ranges are rewritten later. No algorithms are replaced.
 * Static relative/@/ imports only; external packages/dynamic imports fail closed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

export interface BrowserModule {
  path: string; code: string; bytes: number; sha256: string;
  imports: { start: number; end: number; path: string }[];
}
export function browserModuleGraph(entries: readonly string[]): BrowserModule[] {
  const root = resolve("."), modules = new Map<string, BrowserModule>();
  const key = (path: string) => relative(root, path).split(sep).join("/");
  const load = (path: string): string => {
    const absolute = resolve(path), local = relative(root, absolute);
    if (local.startsWith(`..${sep}`) || local === ".." || isAbsolute(local)) throw new Error("Browser module escapes repository");
    const id = key(absolute); if (modules.has(id)) return id;
    const source = readFileSync(absolute), transformed = ts.transpileModule(source.toString("utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
    const errors = transformed.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
    const code = transformed.outputText, tree = ts.createSourceFile(id, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const record: BrowserModule = { path: id, code, bytes: source.length, sha256: createHash("sha256").update(source).digest("hex"), imports: [] }; modules.set(id, record);
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`Dynamic import is unsupported in isolated browser graph: ${id}`);
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const value = specifier.text;
          if (!value.startsWith(".") && !value.startsWith("@/")) throw new Error(`External import is unsupported in isolated browser graph: ${id}: ${value}`);
          const base = value.startsWith("@/") ? resolve(root, "src", value.slice(2)) : resolve(dirname(absolute), value);
          const dependency = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`].find(candidate => existsSync(candidate) && /\.(?:tsx?|m?js)$/.test(candidate));
          if (!dependency) throw new Error(`Missing isolated browser dependency: ${id}: ${value}`);
          record.imports.push({ start: specifier.getStart(tree), end: specifier.getEnd(), path: load(dependency) });
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(tree); return id;
  };
  for (const path of entries) load(path);
  return [...modules.values()];
}
