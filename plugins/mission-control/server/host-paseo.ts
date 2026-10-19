import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";

/**
 * Paseo hands a plugin its host's Paseo API only inside handler calls. This returns the server context with every
 * handler call remembering it, and the latest one, for work that runs outside handlers, such as the status label
 * sync. Every Paseo version (0.9.1 through 0.12) builds the context as a plain object, so a copy keeps its other members.
 */
export function rememberHostPaseo(context: PluginServerContext): { server: PluginServerContext; current(): PaseoApi | null } {
  let paseo: PaseoApi | null = null;
  const server: PluginServerContext = {
    ...context,
    handle: (contract, handler) => context.handle(contract, (input, handlerContext) => {
      paseo = handlerContext.paseo;
      return handler(input, handlerContext);
    }),
  };
  return { server, current: () => paseo };
}
