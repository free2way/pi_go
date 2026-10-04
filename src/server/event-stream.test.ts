import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../shared/types.js";
import { RunEventStream } from "./event-stream.js";

function event(seq: number): RunEvent {
  return { seq, runId: "run_1", round: 1, source: "system", type: `e${seq}`, message: `event ${seq}`, at: new Date(0).toISOString() };
}

/** Minimal in-memory store with a listener set, mirroring PostgresRunStore. */
function makeStore(initial: RunEvent[] = []) {
  const events = [...initial];
  const listeners = new Set<(event: RunEvent) => void>();
  return {
    events,
    listen: (listener: (event: RunEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    append: (value: RunEvent) => {
      events.push(value);
      for (const listener of listeners) listener(value);
    },
    fetchPage: async (after: number, limit: number) => events.filter((item) => item.seq > after).slice(0, limit),
  };
}

describe("RunEventStream (AUD-17)", () => {
  it("subscribes before replay so an event appended mid-replay is never lost", async () => {
    const store = makeStore([event(1), event(2), event(3)]);
    const sent: number[] = [];
    const stream = new RunEventStream({
      runId: "run_1",
      subscribe: store.listen,
      fetchPage: async (after, limit) => {
        // Simulate an event appended between the snapshot and the subscription:
        // it is appended while the FIRST page is being read.
        const page = await store.fetchPage(after, limit);
        if (after === 0) store.append(event(4));
        return page;
      },
      send: (value) => { sent.push(value.seq); return true; },
      close: () => undefined,
      heartbeatMs: 0,
    });
    await stream.start();
    expect(sent).toEqual([1, 2, 3, 4]);
    expect(stream.watermark).toBe(4);
  });

  it("replays from the Last-Event-ID cursor instead of from zero", async () => {
    const store = makeStore([event(1), event(2), event(3), event(4), event(5)]);
    const sent: number[] = [];
    const stream = new RunEventStream({
      runId: "run_1",
      cursor: 3,
      subscribe: store.listen,
      fetchPage: store.fetchPage,
      send: (value) => { sent.push(value.seq); return true; },
      close: () => undefined,
      heartbeatMs: 0,
    });
    await stream.start();
    expect(sent).toEqual([4, 5]);
  });

  it("pages a long replay in bounded chunks (AT-REL-008)", async () => {
    const store = makeStore(Array.from({ length: 25 }, (_, index) => event(index + 1)));
    const sent: number[] = [];
    const stream = new RunEventStream({
      runId: "run_1",
      subscribe: store.listen,
      fetchPage: store.fetchPage,
      send: (value) => { sent.push(value.seq); return true; },
      close: () => undefined,
      heartbeatMs: 0,
      pageSize: 10,
    });
    await stream.start();
    expect(sent).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it("dedupes an event delivered by both replay and the live subscription", async () => {
    const store = makeStore([event(1), event(2)]);
    const sent: number[] = [];
    const stream = new RunEventStream({
      runId: "run_1",
      subscribe: store.listen,
      fetchPage: async (after, limit) => {
        const page = await store.fetchPage(after, limit);
        // A live notification for an event that replay also returns.
        if (after === 0) store.append(event(2));
        return page;
      },
      send: (value) => { sent.push(value.seq); return true; },
      close: () => undefined,
      heartbeatMs: 0,
    });
    await stream.start();
    expect(sent).toEqual([1, 2]);
  });

  it("closes the connection as overflow when the buffer cap is exceeded", async () => {
    const store = makeStore([event(1), event(2), event(3), event(4), event(5)]);
    const closes: string[] = [];
    const stream = new RunEventStream({
      runId: "run_1",
      subscribe: store.listen,
      fetchPage: store.fetchPage,
      send: () => false, // socket backpressured immediately
      close: (reason) => { closes.push(reason); },
      heartbeatMs: 0,
      queueMax: 2,
    });
    await stream.start();
    expect(closes).toEqual(["overflow"]);

    // A bounded reconnect replays from the watermark that was actually delivered.
    expect(stream.watermark).toBeLessThanOrEqual(1);
  });

  it("keeps ordering and completes after a backpressure pause and resume", async () => {
    const store = makeStore(Array.from({ length: 6 }, (_, index) => event(index + 1)));
    const sent: number[] = [];
    let backpressured = true;
    const closes: string[] = [];
    const stream = new RunEventStream({
      runId: "run_1",
      subscribe: store.listen,
      fetchPage: store.fetchPage,
      send: (value) => { sent.push(value.seq); return !backpressured; },
      close: (reason) => { closes.push(reason); },
      heartbeatMs: 0,
      pageSize: 3,
      queueMax: 10,
    });
    await stream.start();
    expect(sent).toEqual([1]);
    backpressured = false;
    stream.resume();
    await vi.waitFor(() => expect(sent).toEqual([1, 2, 3, 4, 5, 6]));
    expect(closes).toEqual([]);
    expect(stream.watermark).toBe(6);
  });

  it("emits a heartbeat while live and stops when the connection closes", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([event(1)]);
      let beats = 0;
      const stream = new RunEventStream({
        runId: "run_1",
        subscribe: store.listen,
        fetchPage: store.fetchPage,
        send: () => true,
        close: () => undefined,
        heartbeat: () => { beats += 1; },
        heartbeatMs: 1_000,
      });
      await stream.start();
      await vi.advanceTimersByTimeAsync(3_500);
      expect(beats).toBe(3);
      stream.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(beats).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when the consumer callbacks fail", async () => {
    const store = makeStore([event(1)]);
    const stream = new RunEventStream({
      runId: "run_1",
      subscribe: store.listen,
      fetchPage: store.fetchPage,
      send: () => { throw new Error("socket gone"); },
      close: () => undefined,
      heartbeatMs: 0,
      queueMax: 1,
    });
    await expect(stream.start()).resolves.toBeUndefined();
  });
});
