// Pass-through AppSync JS resolver for real-time subscriptions.
// Returns an empty request and echoes ctx.result to all subscribers.
export function request() {
  return {};
}

export function response(ctx) {
  return ctx.result;
}
