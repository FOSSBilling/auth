import { registerHooks } from "node:module";

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
