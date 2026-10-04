// Keeping the promise that nothing leaves the machine.
//
// MediaPipe Tasks 1.0 added a usage logger to every task it creates: it counts
// which task ran and how fast, and POSTs that as protobuf to Google's on-device
// ML logging endpoint every 60 seconds. It sends no image data, but it is a
// request the app did not make and a user was never told about, and the
// library offers no switch to turn it off (checked through 1.1.0-rc).
//
// So the endpoint is refused here, before it reaches the network. The logger
// treats a failed send as fatal — it stops its timer and never retries — so
// one refusal per page load is the whole cost. `npm run test:network` waits out
// the logging interval and fails if any such request gets through.

const BLOCKED = [/^https:\/\/odml\.pa\.googleapis\.com\//];

let installed = false;

export function blockTelemetry() {
  if (installed || typeof globalThis.fetch !== 'function') return;
  installed = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (url && BLOCKED.some((re) => re.test(url))) {
      return Promise.resolve(new Response(null, { status: 204, statusText: 'blocked by motion-studio' }));
    }
    return realFetch(input, init);
  };
}
