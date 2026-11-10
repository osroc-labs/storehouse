// The package's entry point: what a repo's guard or tooling imports from @osroc-labs/storehouse.
export { agentMarkers, getAgentMarker } from './protect/agents.ts';
export { manifestService } from './manifest/manifest.ts';
export { manifestSchema } from './manifest/schema.ts';
export type { Manifest } from './manifest/schema.ts';
export { protectedInvocation } from './protect/protect.ts';
export type { ProtectedEnvs, ProtectedInvocation } from './protect/protect.ts';
