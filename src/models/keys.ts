import type { ModelRequest } from "../ports/index.ts";
import { hashOf, sha256Hex } from "../util/canonical.ts";

/**
 * The identity of a request for recording and for logs: what the model is asked, not how it is routed. The role is
 * part of it (the same words put to a critic and to a planner are different requests); the memory scope, timeout and
 * data class are not, because they do not change what a correct reply is. The model id is not either, so a cassette
 * survives a change of role map, and the response says which model actually answered.
 */
export function promptKey(request: Pick<ModelRequest, "role" | "system" | "user" | "jsonSchema" | "maxTokens">): string {
  return hashOf({
    role: request.role,
    system: request.system,
    user: request.user,
    jsonSchema: request.jsonSchema ?? null,
    maxTokens: request.maxTokens ?? null,
  });
}

export function textHash(text: string): string {
  return sha256Hex(text);
}
