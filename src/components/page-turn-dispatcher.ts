export type PageTurnDirection = "previous" | "next";

export interface PageTurnDispatcher {
  dispatch(direction: PageTurnDirection): void;
  cancelPending(): void;
}

/**
 * Keeps page-turn input responsive without leaving a long animation queue
 * running after a wheel or key stream has stopped. The active turn and the
 * latest requested direction are retained; superseded intermediate input is
 * represented by that latest intent instead of becoming stale navigation.
 */
export function createPageTurnDispatcher({
  turn,
}: {
  turn(direction: PageTurnDirection): void | Promise<void>;
}): PageTurnDispatcher {
  let active = false;
  let pending: PageTurnDirection | null = null;

  const run = (direction: PageTurnDirection) => {
    active = true;
    let result: void | Promise<void>;
    try {
      result = turn(direction);
    } catch {
      result = Promise.reject();
    }
    void Promise.resolve(result)
      .catch(() => {})
      .then(() => {
        const next = pending;
        pending = null;
        if (next) run(next);
        else active = false;
      });
  };

  const dispatch = (direction: PageTurnDirection) => {
    if (active) {
      pending = direction;
      return;
    }
    run(direction);
  };

  const cancelPending = () => {
    pending = null;
  };

  return { dispatch, cancelPending };
}
