import type { Membership } from "../packages/contracts/src/foundation.js";

export const requiredRoleForCapability = (capability: string): Membership["role"] => capability.endsWith(".write") ? "editor" : "viewer";
