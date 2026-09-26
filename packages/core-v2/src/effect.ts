// Request --Effect program--> Result event

import type { Effect as Fx } from "effect";

// Effect describes deferred execution with typed failures and required services.
export interface Effect<Request, Result, Error = never, Services = never> {
  readonly request: Request;
  readonly run: Fx.Effect<Result, Error, Services>;
}
