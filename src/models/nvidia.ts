import { PortError, type ComputeReceipt } from "../ports/index.ts";
import { ChatModelClient, type ChatClientOptions, type ReplyContext } from "./client.ts";
import type { LaneDescriptor } from "./types.ts";

export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export type NvidiaClientOptions = Omit<ChatClientOptions, "baseUrl"> & { baseUrl?: string };

/**
 * Nemotron through NVIDIA's own OpenAI-compatible API. Always a remote lane. The reply carries no receipt, so its
 * `ModelResponse` has none and is counted as unreceipted wherever receipt coverage is reported.
 */
export class NvidiaClient extends ChatModelClient {
  readonly provider = "nvidia" as const;
  protected readonly lanePreference = "remote" as const;
  private readonly lane: LaneDescriptor;

  constructor(options: NvidiaClientOptions) {
    if (!options.apiKey || options.apiKey.length < 8) {
      throw new PortError("FORBIDDEN", "NvidiaClient needs an API key (NVIDIA_API_KEY)");
    }
    super("nvidia", { ...options, baseUrl: options.baseUrl ?? NVIDIA_DEFAULT_BASE_URL });
    this.lane = {
      id: "nvidia:remote",
      location: "remote",
      destination: this.transport.hostname,
      verified: false,
      note: "NVIDIA's hosted API: prompts leave this machine",
    };
    this.opts.egress.registerLane(this.lane);
  }

  protected laneFor(): LaneDescriptor {
    return this.lane;
  }

  protected headersFor(): Record<string, string> {
    return {};
  }

  protected verifyReply(_ctx: ReplyContext): ComputeReceipt | undefined {
    return undefined;
  }
}
