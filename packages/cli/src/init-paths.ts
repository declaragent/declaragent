import { join } from 'node:path';
import { configDir } from './paths.js';

/** Marker file written after a successful first `declaragent init` run. */
export function initializedMarkerPath(dir = configDir()): string {
  return join(dir, '.initialized');
}

/** Sentinel file that records a telemetry opt-out. Presence ⇒ opt-out. */
export function telemetryOptOutPath(dir = configDir()): string {
  return join(dir, '.telemetry-opt-out');
}
