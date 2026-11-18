import { useEffect, useState } from "react";
import type { Emitter } from "../core/util";

type EventsOf<T extends Emitter<any>> = NonNullable<T["__events"]>;

/** Subscribe to an emitter event and keep the latest value in state. */
export function useEvent<T extends Emitter<any>, K extends keyof EventsOf<T> & string, I extends EventsOf<T>[K] | null>(
  em: T,
  key: K,
  initial: I,
): EventsOf<T>[K] | I {
  const [v, setV] = useState<EventsOf<T>[K] | I>(initial);
  useEffect(() => em.on(key, (x: EventsOf<T>[K]) => setV(() => x)), [em, key]);
  return v;
}
