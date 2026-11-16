import type { PaseoApi } from "@getpaseo/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";

/**
 * Paseo hands a plugin its host's Paseo API only inside handler calls. This returns the server context with every
 * handler call remembering it, and the latest one, for work that runs outside handlers, such as the status label
 * sync. Every Paseo version (0.9.1 through 0.16) builds the context as a plain object, so a copy keeps its other members.
 * RPC and subscription handlers (0.16) both receive a context with `paseo`, so one wrapper serves both overloads.
 */
export function rememberHostPaseo(context: PluginServerContext): { server: PluginServerContext; current(): PaseoApi | null } {
  let paseo: PaseoApi | null = null;
  const handle = (contract: unknown, handler: (input: unknown, handlerContext: PluginHandlerContext) => unknown) =>
    context.handle(contract as never, ((input: unknown, handlerContext: PluginHandlerContext) => {
      paseo = handlerContext.paseo;
      return handler(input, handlerContext);
    }) as never);
  const server: PluginServerContext = { ...context, handle: handle as PluginServerContext["handle"] };
  return { server, current: () => paseo };
}
