interface DisposableFoliateView {
  close(): void;
  remove(): void;
}

export function disposeFoliateViewAfterInitialization(
  view: DisposableFoliateView,
  initialization: Promise<unknown>,
  onCloseError: (error: unknown) => void,
) {
  // Detach immediately, but do not destroy Foliate while open/init is still
  // mutating its paginator. Destroying mid-render leaves its iframe document
  // null and can take down the replacement reader mounted by StrictMode.
  view.remove();
  const close = () => {
    try {
      view.close();
    } catch (error) {
      onCloseError(error);
    }
  };
  void initialization.then(close, close);
}
