// Injected before the page loads (Playwright addInitScript). A minimal React DevTools hook: React calls
// onCommitFiberRoot on every commit; with __perf.walk on, each commit's components are counted by name, split
// mount (no alternate) and render (props or state changed; bailed-out subtrees skipped). Also Event Timing entries (tap to next paint) and long tasks.
(() => {
  const perf = (window.__perf = { walk: false, commits: 0, rendered: {}, mounts: {}, events: [], longTasks: [], commitMs: 0, sends: [] });
  // PERF_SEND_STACKS=<substring>: the JS stack of every WebSocket frame sent that contains it (who sent that RPC).
  const sendMatch = null;
  if (sendMatch) { Error.stackTraceLimit = 80; const send = WebSocket.prototype.send; WebSocket.prototype.send = function (data) { if (typeof data === "string" && data.includes(sendMatch)) perf.sends.push({ t: performance.now(), stack: String(new Error().stack).split("\n").slice(2, 80).map(l => l.trim()).join(" | ") }); return send.call(this, data); }; }
  const nameOf = f => {
    const t = f.type; if (!t || typeof t === "string") return null;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || "Anonymous";
  };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  // Counts only fibers this commit touched: a subtree whose child list is the alternate's was skipped (bailout), a
  // fiber without an alternate inside a touched subtree mounted now, and one whose props or state object changed rendered.
  const walk = root => {
    const stack = [root.current];
    while (stack.length) {
      const f = stack.pop(); const a = f.alternate;
      if (COMPONENT.has(f.tag)) {
        const n = nameOf(f);
        if (n) { if (!a) perf.mounts[n] = (perf.mounts[n] || 0) + 1; else if (f.memoizedProps !== a.memoizedProps || f.memoizedState !== a.memoizedState) perf.rendered[n] = (perf.rendered[n] || 0) + 1; }
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child && !(a && f.child === a.child)) stack.push(f.child);
    }
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { id += 1; this.renderers.set(id, r); return id; },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, setStrictMode() {},
    onCommitFiberRoot(_id, root) { perf.commits += 1; if (perf.walk) { const s = performance.now(); walk(root); perf.commitMs += performance.now() - s; } },
  };
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) perf.events.push({ name: e.name, start: e.startTime, duration: e.duration, processing: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime }); })
      .observe({ type: "event", durationThreshold: 16, buffered: true });
    new PerformanceObserver(list => { for (const e of list.getEntries()) perf.longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: "longtask", buffered: true });
  } catch {}
})();
