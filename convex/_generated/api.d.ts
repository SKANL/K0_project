/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as audit from "../audit.js";
import type * as authz from "../authz.js";
import type * as automation from "../automation.js";
import type * as commands from "../commands.js";
import type * as crons from "../crons.js";
import type * as graph from "../graph.js";
import type * as http from "../http.js";
import type * as inbox from "../inbox.js";
import type * as integrations from "../integrations.js";
import type * as liveness from "../liveness.js";
import type * as memory from "../memory.js";
import type * as migrations_automation from "../migrations/automation.js";
import type * as migrations_foundation from "../migrations/foundation.js";
import type * as migrations_integrations from "../migrations/integrations.js";
import type * as migrations_memory from "../migrations/memory.js";
import type * as migrations_runtime from "../migrations/runtime.js";
import type * as outbox from "../outbox.js";
import type * as policy from "../policy.js";
import type * as state from "../state.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  audit: typeof audit;
  authz: typeof authz;
  automation: typeof automation;
  commands: typeof commands;
  crons: typeof crons;
  graph: typeof graph;
  http: typeof http;
  inbox: typeof inbox;
  integrations: typeof integrations;
  liveness: typeof liveness;
  memory: typeof memory;
  "migrations/automation": typeof migrations_automation;
  "migrations/foundation": typeof migrations_foundation;
  "migrations/integrations": typeof migrations_integrations;
  "migrations/memory": typeof migrations_memory;
  "migrations/runtime": typeof migrations_runtime;
  outbox: typeof outbox;
  policy: typeof policy;
  state: typeof state;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
