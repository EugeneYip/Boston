/**
 * Cooperative yielding that survives background-tab throttling.
 *
 * `await new Promise(r => setTimeout(r, 0))` is the obvious way to hand the event
 * loop back so the loading bar can repaint between chunks of boot work. It is also
 * a trap, and it cost this project most of its cold boot.
 *
 * Chrome clamps timers in a **hidden** tab to roughly one per second, and once a
 * tab has been hidden for five minutes it drops to one per *minute* ("intensive
 * throttling"). Every agent verification tab is hidden — the browser pane does not
 * composite while it is behind the editor — so each of those yields cost a second
 * or more instead of the microsecond it was written to cost. Measured in a hidden
 * tab on the live page:
 *
 *     9 x  await new Promise(r => setTimeout(r, 0))     2896 ms
 *     9 x  await yieldToPaint()                            9 ms
 *
 * That one line was the entire reported 49 s `vehicles` init: the geometry it was
 * interleaved with builds in 383 ms for all nine vehicle types.
 *
 * A MessageChannel task is not a timer, so none of that throttling applies. It
 * still returns to the event loop — a visible tab can style, lay out and paint
 * between chunks exactly as before — but it is dispatched promptly whether the tab
 * is visible or not.
 *
 * Use this anywhere boot work is chunked. Never use `setTimeout` for a yield.
 */

let _chan = null;
const _waiting = [];

/**
 * Yield to the event loop, letting the browser paint if it is in a position to.
 * Not subject to background-tab timer throttling.
 * @returns {Promise<void>}
 */
export function yieldToPaint() {
  // Node/SSR and very old engines: nothing to paint, so resolving is correct.
  if (typeof MessageChannel !== 'function') return Promise.resolve();
  if (!_chan) {
    _chan = new MessageChannel();
    // Assigning `onmessage` implicitly starts the port. Every postMessage below
    // delivers exactly one message, so FIFO-resolving the oldest waiter is right
    // no matter which caller queued it — all any of them want is "next task".
    _chan.port1.onmessage = () => { const r = _waiting.shift(); if (r) r(); };
  }
  return new Promise((resolve) => {
    _waiting.push(resolve);
    _chan.port2.postMessage(0);
  });
}

export default yieldToPaint;
