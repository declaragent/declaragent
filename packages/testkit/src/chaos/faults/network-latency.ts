import type { ChaosTargetRuntime } from '../types.js';

/**
 * Phase 6 slice-7 `network-latency` fault.
 *
 * Wraps a caller-supplied fetch implementation so every request to a
 * target URL is delayed by `extraMs` for `durationMs`. Channel
 * adapters + secret providers both surface a `fetch` override hook
 * (see `channel-<*>/src/instance.ts`, `secrets/providers/<*>`) so
 * plugging the wrapper in for the chaos window is a one-line change.
 *
 * Returns a `ChaosTargetRuntime.networkLatency` fragment that toggles
 * the injection on/off. During the fault window `wrappedFetch` adds
 * the delay; outside the window it's a pass-through.
 */

export interface NetworkLatencyFaultOptions {
  /** Original fetch the adapter should call through. */
  fetch: typeof fetch;
  /**
   * Predicate over the request URL — return true to delay this
   * request. The default is a substring match against `fault.target`.
   */
  matches?: (url: string, target: string) => boolean;
}

export interface NetworkLatencyFaultHandle {
  /** Fetch wrapper to hand to adapters / providers. */
  wrappedFetch: typeof fetch;
  /** Runtime fragment the driver dispatches to. */
  runtime: Required<Pick<ChaosTargetRuntime, 'networkLatency'>>;
}

export function createNetworkLatencyFault(
  opts: NetworkLatencyFaultOptions,
): NetworkLatencyFaultHandle {
  const matches = opts.matches ?? ((url, target) => url.includes(target));
  let active: { target: string; extraMs: number; deadline: number } | null = null;

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (active) {
      const now = Date.now();
      if (now < active.deadline) {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (matches(url, active.target)) {
          await new Promise((r) => setTimeout(r, active?.extraMs ?? 0));
        }
      } else {
        active = null;
      }
    }
    return opts.fetch(input as Request, init);
  };

  const wrappedFetch = impl as unknown as typeof fetch;

  async function networkLatency(
    target: string,
    extraMs: number,
    durationMs: number,
  ): Promise<void> {
    active = { target, extraMs, deadline: Date.now() + durationMs };
    await new Promise<void>((r) => setTimeout(r, durationMs));
    active = null;
  }

  return { wrappedFetch, runtime: { networkLatency } };
}
