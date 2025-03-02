import { z } from "zod";

const EventSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  content: z.string(),
  sig: z.string(),
  kind: z.number(),
  created_at: z.number(),
  tags: z.string().array().array(),
});
type ExtendedFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: [number, string];
  until?: number;
  limit?: number;
};
export const RelayMessageEventSchema = z.tuple([
  z.literal("EVENT"),
  z.string(),
  EventSchema,
]);
export const RelayMessageOkSchema = z.tuple([
  z.literal("OK"),
  z.string(),
  z.boolean(),
  z.string(),
]);
export const RelayMessageEoseSchema = z.tuple([z.literal("EOSE"), z.string()]);
export const RelayMessageClosedSchema = z.tuple([
  z.literal("CLOSED"),
  z.string(),
  z.string(),
]);
export const RelayMessageNoticeSchema = z.tuple([
  z.literal("NOTICE"),
  z.string(),
]);
export const RelayMessageAuthSchema = z.tuple([z.literal("AUTH"), z.string()]);
export const RelayMessageSchema = z.union([
  RelayMessageEventSchema,
  RelayMessageOkSchema,
  RelayMessageEoseSchema,
  RelayMessageClosedSchema,
  RelayMessageNoticeSchema,
  RelayMessageAuthSchema,
]);
export type RelayMessage = z.infer<typeof RelayMessageSchema>;
export type RelayMessageEose = z.infer<typeof RelayMessageEoseSchema>;
export type RelayMessageEvent = z.infer<typeof RelayMessageEventSchema>;
export type NostrEvent = z.infer<typeof EventSchema>;
// export type NostrFilter = z.infer<typeof FilterSchema>;
/** NIP-01 Nostr filter. */
export interface NostrFilter {
  /** A list of event IDs. */
  ids?: string[];
  /** A list of lowercase pubkeys, the pubkey of an event must be one of these. */
  authors?: string[];
  /** A list of a kind numbers. */
  kinds?: number[];
  /** An integer unix timestamp in seconds, events must be newer than this to pass. */
  since?: number;
  /** An integer unix timestamp in seconds, events must be older than this to pass. */
  until?: number;
  /** Maximum number of events relays SHOULD return in the initial query. */
  limit?: number;
  /** NIP-50 search query. */
  search?: string;
  /** A list of tag values, for #e — a list of event ids, for #p — a list of pubkeys, etc. */
  [key: `#${string}`]: string[] | undefined;
}
export type SubPagenationFilter = NostrFilter & {
  since: number;
  limit: number;
};
export type RevFilter = SubPagenationFilter & { until: number };

const PING_EVENT = `["EVENT",{"kind":1,"id":"0000000000000000000000000000000000000000000000000000000000000000","pubkey":"0000000000000000000000000000000000000000000000000000000000000001","created_at":0,"tags":[],"content":"ping","sig":"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"}]`;

class RelayConnection {
  #url: string;
  #connection: ["connected", WebSocket] | ["idle"] | ["connecting"] = ["idle"];
  #subs: Map<
    string,
    { filter: string; ch: Channel<RelayMessageEvent | RelayMessageEose> }
  > = new Map();
  #sendingEvents: Map<
    string,
    { event: string; receiver: Channel<RelayMessage> }
  > = new Map();
  receiver: Channel<RelayMessage>;
  #waitingPongTimeout: undefined | number;
  #pingTimeout: undefined | number;
  #auth_signer: undefined | ((challenge: string) => string);
  #lastConnectionTime = 0;
  #connection_delay = 5_000;

  constructor(url: string, auth_signer?: (challenge: string) => string) {
    this.#url = url;
    this.receiver = new Channel();
    this.#auth_signer = auth_signer;
  }

  sub_extended(
    subId: string,
    filter: ExtendedFilter,
    ch: Channel<RelayMessageEvent | RelayMessageEose>
  ) {
    ch.onClose(() => {
      this.close_sub(subId);
    });
    const f = JSON.stringify({
      ids: filter.ids,
      authors: filter.authors,
      kinds: filter.kinds,
      since: filter.since && filter.since[0],
      until: filter.until,
      limit: filter.limit,
    });
    const ch2: Channel<RelayMessageEvent | RelayMessageEose> = new Channel();
    this.#subs.set(subId, {
      filter: f,
      ch: ch2,
    });
    this.send_sub_inner(subId, f);
  }

  send_sub(
    subId: string,
    filter: string,
    ch: Channel<RelayMessageEvent | RelayMessageEose>
  ) {
    ch.onClose(() => {
      this.close_sub(subId);
    });
    this.#subs.set(subId, { filter, ch });
    this.send_sub_inner(subId, filter);
  }

  send_sub_pagenation(
    subId: string,
    filter: SubPagenationFilter,
    ch: Channel<RelayMessageEvent | RelayMessageEose>
  ) {
    const ch1: Channel<RelayMessageEvent | RelayMessageEose> = new Channel();
    const ch2: Channel<RelayMessageEvent | RelayMessageEose> = new Channel();
    const f1 = JSON.stringify({
      ids: filter.ids,
      authors: filter.authors,
      kinds: filter.kinds,
      since: filter.since,
      until: filter.since,
      limit: 100000,
    });
    const f2 = JSON.stringify({
      ids: filter.ids,
      authors: filter.authors,
      kinds: filter.kinds,
      since: filter.since + 1,
      until: filter.until,
      limit: filter.limit,
    });
    ch.onClose(() => {
      ch1.close();
      ch2.close();
    });
    let count = 2;
    (async () => {
      for await (const a of ch1) {
        ch.send(a);
      }
      if (--count === 0) {
        ch.close();
      }
    })();
    (async () => {
      for await (const a of ch2) {
        ch.send(a);
      }
      if (--count === 0) {
        ch.close();
      }
    })();
    this.send_sub(subId, f1, ch1);
    this.send_sub(subId, f2, ch2);
  }

  async get_events(
    subId: string,
    filter: string,
    limit: number
  ): Promise<NostrEvent[]> {
    if (limit <= 0) {
      return [];
    }
    const ch: Channel<RelayMessageEvent | RelayMessageEose> = new Channel();
    ch.onClose(() => {
      this.close_sub(subId);
    });
    this.#subs.set(subId, { filter, ch });
    this.send_sub_inner(subId, filter);
    const result: NostrEvent[] = [];
    for await (const a of ch) {
      if (a[0] === "EOSE") {
        return result;
      }
      result.push(a[2]);
      if (--limit <= 0) {
        return result;
      }
    }
    return result;
  }

  get_events_rev(subId: string, filter: RevFilter): Promise<NostrEvent[]> {
    return get_events_rev(
      filter.since,
      filter.until,
      filter.limit,
      (since, until, limit) =>
        this.get_events(
          subId,
          JSON.stringify({
            ids: filter.ids,
            authors: filter.authors,
            kinds: filter.kinds,
            since: since,
            until: until,
            limit: filter.limit,
          }),
          limit
        ),
      (a) => a.created_at
    );
  }

  close_sub(id: string) {
    if (this.#subs.delete(id)) {
      console.log("close", id, this.#url);
      this.send(`["CLOSE","${id}"]`);
    }
  }

  private send_sub_inner(subId: string, filter: string) {
    this.send(`["REQ","${subId}",${filter}]`);
  }

  send_event(eventId: string, event: string): Channel<RelayMessage> {
    const s: Channel<RelayMessage> = new Channel();
    this.#sendingEvents.set(eventId, { event, receiver: s });
    this.send_event_inner(event);
    return s;
  }

  private send_event_inner(event: string) {
    this.send(`["EVENT",${event}]`);
  }

  private resetTimeout() {
    clearTimeout(this.#pingTimeout);
    clearTimeout(this.#waitingPongTimeout);
    const sendPing = () => {
      console.log("ping");
      if (this.#connection[0] === "idle") {
        console.log("connection is idle");
        this.connect();
      } else if (this.#connection[0] === "connecting") {
        console.log("connection is connecting");
      } else if (this.#connection[1].readyState === WebSocket.OPEN) {
        console.log("connection is not open:", this.#connection[1].readyState);
        this.connect();
      } else {
        this.#connection[1].send(PING_EVENT);
        this.#waitingPongTimeout = setTimeout(() => {
          console.log("connection lost");
          this.connect();
        }, 1000 * 10);
      }
    };
    this.#pingTimeout = setTimeout(sendPing, 1000 * 30);
  }

  private async connect() {
    if (this.#connection[0] === "connecting") {
      return;
    }
    console.log("connect", this.#url);
    if (this.#sendingEvents.size === 0 && this.#subs.size === 0) {
      this.#connection[0] = "idle";
      return;
    }
    if (Date.now() < this.#lastConnectionTime + 60_000) {
      console.error(this.#url, "is unstable. sleeping", this.#connection_delay);
      await new Promise((r) => setTimeout(r, this.#connection_delay));
      this.#connection_delay = Math.min(
        this.#connection_delay * 2,
        24 * 60 * 60 * 1000 * 4
      );
    } else {
      this.#connection_delay = 5_000;
    }
    const c = new WebSocket(this.#url);
    this.#connection = ["connected", c];
    this.#lastConnectionTime = Date.now();
    c.onopen = () => {
      for (const [subId, sub] of this.#subs) {
        console.log("sub", subId, sub.filter);
        this.send_sub_inner(subId, sub.filter);
      }
      for (const event of this.#sendingEvents.values()) {
        this.send_event_inner(event.event);
      }
    };
    c.onclose = () => {
      clearTimeout(this.#pingTimeout);
      clearTimeout(this.#waitingPongTimeout);
      this.connect();
    };
    c.onmessage = (m) => {
      this.resetTimeout();
      const e = RelayMessageSchema.safeParse(JSON.parse(m.data));
      if (e.success) {
        const message = e.data;
        switch (message[0]) {
          case "OK": {
            const e = this.#sendingEvents.get(message[1]);
            if (e) {
              if (!e.receiver.closed) {
                e.receiver.send(message);
                e.receiver.close();
              }
              this.#sendingEvents.delete(message[1]);
            } else {
              this.receiver.send(message);
            }
            break;
          }
          case "CLOSED": {
            const sub = this.#subs.get(message[1]);
            if (sub && !sub.ch.closed) {
              sub.ch.close();
            }
            this.#subs.delete(message[1]);
            break;
          }
          case "AUTH": {
            if (this.#auth_signer) {
              this.send(`["AUTH",${this.#auth_signer(message[1])}]`);
            }
            break;
          }
          case "EVENT":
          case "EOSE": {
            const sub = this.#subs.get(message[1]);
            if (sub) {
              if (!sub.ch.closed) {
                sub.ch.send(message);
              }
            }
            break;
          }
          default:
            this.receiver.send(message);
        }
      } else {
        console.error("not supported: ", m.data);
      }
    };
  }

  private send(message: string) {
    if (
      this.#connection[0] === "connected" &&
      this.#connection[1].readyState === WebSocket.OPEN
    ) {
      this.#connection[1].send(message);
    } else if (
      (this.#connection[0] === "connected" &&
        this.#connection[1].readyState === WebSocket.CONNECTING) ||
      this.#connection[0] === "connecting"
    ) {
      console.log(this.#url + ":", "now connecting");
    } else {
      console.log(this.#url + ":", "connection is not open", this.#connection);
      this.connect();
    }
  }

  async *receive(): AsyncGenerator<RelayMessage> {
    for await (const e of this.receiver) {
      yield e;
    }
  }
}

export const get_events_rev = async <T>(
  since: number,
  until: number,
  limit: number,
  get_events: (since: number, until: number, limit: number) => Promise<T[]>,
  get_timestamp: (event: T) => number
): Promise<T[]> => {
  if (since > until || limit <= 0) {
    return [];
  }
  const middle = ~~((since + until + 1) / 2) - 1;
  const es = await get_events(since, middle, limit + 1);
  es.reverse();
  if (since === until || es.length === limit) {
    return es;
  } else if (es.length > limit) {
    const es_older = await get_events_rev(
      since,
      Math.min(get_timestamp(es[0]), middle),
      limit,
      get_events,
      get_timestamp
    );
    if (es_older.length < limit) {
      return [
        ...new Set([...es_older, ...es.slice(0, limit - es_older.length)]),
      ];
    } else {
      return es_older;
    }
  } else {
    const es_newer = await get_events_rev(
      middle + 1,
      until,
      limit - es.length,
      get_events,
      get_timestamp
    );
    return [...es, ...es_newer];
  }
};

// import { assertEquals } from "jsr:@std/assert";

// Deno.test("get events rev test", async () => {
//   const a = await get_events_rev(
//     20,
//     30,
//     3,
//     (since, until, limit) => {
//       return Promise.resolve(
//         Array(until - since + 1)
//           .fill(since)
//           .map((x, y) => x + y)
//           .slice(0, limit)
//       );
//     },
//     (a) => a
//   );
//   assertEquals(a, [30, 29, 28]);
// });

import { Channel } from "./channel.ts";

export class RelayPool {
  #connections: RelayConnection[] = [];
  #receiver: Channel<RelayMessage> = new Channel();
  #subs: Map<
    string,
    { filter: string; ch: Channel<RelayMessageEvent | RelayMessageEose> }
  > = new Map();

  constructor() {}

  addRelay(url: string) {
    const c = new RelayConnection(url);
    this.#connections.push(c);
    for (const [id, { filter, ch }] of this.#subs) {
      c.send_sub(id, filter, ch);
    }
  }

  sub(
    id: string,
    filter: string,
    ch: Channel<RelayMessageEvent | RelayMessageEose>
  ) {
    const ch_inner: Channel<RelayMessageEvent | RelayMessageEose> =
      new Channel();
    this.#subs.set(id, { filter, ch: ch_inner });
    for (const c of this.#connections) {
      c.send_sub(id, filter, ch_inner);
    }
    ch.onClose(() => {
      console.log("final");
      ch_inner.close();
      this.#subs.delete(id);
    });
    const recieved = new Set();
    (async () => {
      for await (const e of ch_inner) {
        if (!recieved.has(e)) {
          recieved.add(e);
          ch.send(e);
        }
      }
    })();
  }

  async get_events_rev(
    subId: string,
    filter: RevFilter
  ): Promise<NostrEvent[]> {
    return (
      await Promise.all(
        this.#connections.map((c) => c.get_events_rev(subId, filter))
      )
    ).flat();
  }

  async *receive(): AsyncGenerator<RelayMessage> {
    for await (const e of this.#receiver) {
      yield e;
    }
  }
}
