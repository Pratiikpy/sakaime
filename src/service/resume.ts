/**
 * Resumable recording.
 *
 * Recording the sample run calls a rate-limited model route about once every half minute, and a run that stops part way (a 429
 * that outlasts the retries, a closed laptop) would otherwise spend every call it already made again. With resume on, a request
 * the cassette directory already answers is answered from the recording and only the missing ones go to the live route. The
 * recordings are still the real replies of the real route: nothing here writes or edits one.
 */
import { MemoryTraceSink, RecordedModelPort } from "../models/index.ts";
import type { ModelPort, ModelRequest, ModelResponse } from "../ports/index.ts";

export class ResumingModelPort implements ModelPort {
  private readonly recorded: RecordedModelPort;
  /** How many requests were answered from an earlier recording and how many went to the live route. */
  readonly counts = { replayed: 0, live: 0 };

  constructor(
    private readonly live: ModelPort,
    cassetteDir: string,
  ) {
    this.recorded = new RecordedModelPort({ dir: cassetteDir, trace: new MemoryTraceSink() });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (this.recorded.has(request)) {
      this.counts.replayed += 1;
      return this.recorded.complete(request);
    }
    this.counts.live += 1;
    return this.live.complete(request);
  }
}
