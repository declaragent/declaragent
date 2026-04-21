/**
 * Built-in tool list shared by every REPL + daemon + fleet-run entry
 * point. Previously duplicated inline in `app.tsx`; extracted in 0.3.6
 * so `fleet-run-llm-handler.ts` reuses the same list without forking.
 *
 * Plugin-contributed tools + builder tools layer ON TOP of this via
 * the per-entry-point composition logic (builder gets the builder
 * toolkit; fleet-run + `declaragent run` stay on the built-ins).
 */

import { Agent, Bash, Edit, GlobTool, Grep, Read, type Tool, Write } from '@declaragent/core';

export const BUILTIN_TOOLS: readonly Tool[] = [Read, Write, Edit, GlobTool, Grep, Bash, Agent];
