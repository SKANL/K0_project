import { httpRouter } from "convex/server";

export function denyUntrustedWebhook(signature: string | undefined) { return signature ? { status: 202 } : { status: 401 }; }

export default httpRouter();
