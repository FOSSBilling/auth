import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The runner cannot import auth.ts's extensionless Worker imports, so tests
// extract option literals from its source text and evaluate them against the
// installed Better Auth implementation instead. Returns the `account:` option
// object literal for use with runInNewContext.
export function extractAccountLiteral(text: string): string {
  const linking = text.indexOf("accountLinking:");
  assert.ok(linking !== -1, "production account linking policy exists");
  const key = text.lastIndexOf("account:", linking);
  assert.ok(key !== -1, "production account policy exists");
  const start = text.indexOf("{", key);
  assert.ok(start !== -1, "production account policy is a literal object");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("production account policy is a literal object");
}

// Exercise the real router without D1 or GitHub; only ./auth is substituted.
// Resolves the Worker's extensionless imports for Node's TypeScript runner.
export function registerRouterTestHooks(authSource: string) {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL?.endsWith("/src/index.ts") &&
        specifier === "./auth"
      ) {
        return {
          url: `data:text/javascript,${encodeURIComponent(authSource)}`,
          shortCircuit: true
        };
      }
      if (
        context.parentURL?.includes("/src/") &&
        specifier.startsWith("./") &&
        !specifier.endsWith(".ts")
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    }
  });
}
