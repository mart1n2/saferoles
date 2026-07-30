/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { setDatabaseBinding, type D1Database } from "../app/lib/db-binding";
import { setRuntimeVars } from "../app/lib/runtime-env";

/**
 * Bindings supplied by the Cloudflare runtime.
 *
 * Every field is optional and `env` itself may be absent: `vinext start` runs
 * this entry point under a plain Node server that provides no bindings, so
 * reaching into `env` unguarded fails every request rather than just the feature
 * that needed the binding.
 */
interface Env {
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  /** D1 binding, present only when configured in `.openai/hosting.json`. */
  DB?: D1Database;
  /** Optional Etherscan V2 multichain key. Sourcify needs no key. */
  ETHERSCAN_API_KEY?: string;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env | undefined, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const bindings = env ?? {};

    // Route handlers cannot reach `env` directly, so publish it here.
    setDatabaseBinding(bindings.DB ?? null);
    setRuntimeVars({ ETHERSCAN_API_KEY: bindings.ETHERSCAN_API_KEY });

    const assets = bindings.ASSETS;
    const images = bindings.IMAGES;

    // The Safe App manifest needs CORS headers, which a static asset cannot
    // carry — assets are served ahead of this code. It is a route handler
    // instead: see app/manifest.json/route.ts.

    if (url.pathname === "/_vinext/image" && assets && images) {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => assets.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await images.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
