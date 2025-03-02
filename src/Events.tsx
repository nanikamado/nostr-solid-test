import "./Events.css";
import { onCleanup, onMount, For, Show } from "solid-js";
import { get_events_rev, NostrEvent } from "./nostr.ts";
// import { Channel } from "./channel.ts";
import {
  createRxNostr,
  createRxForwardReq,
  createRxBackwardReq,
  now,
  EventPacket,
} from "rx-nostr";
// import * as Rxn from "rx-nostr";
import { verifier } from "rx-nostr-crypto";
import * as Rx from "rxjs";
import { createStore } from "solid-js/store";

type EventSignal = {
  event: NostrEvent;
  transition: boolean;
  realTime?: boolean;
  relays: string[];
  possition?: "top" | "middle" | "bottom";
};

type RelayState = {
  startSubscribing: (since: number, sinceId: string) => void;
  stopSubscribing: () => void;
  init: () => void;
};

function NostrEvents() {
  const [events, setEvents] = createStore<EventSignal[]>([]);

  const webSeckets: WebSocket[] = [];
  // let afterFirstEose = false;
  // let eventLoading = false;
  // let eventSubscribing = true;
  // let newestEventTime = 0;
  // const pool = new RelayPool();
  const rxNostr = createRxNostr({
    verifier: verifier,
    disconnectTimeout: 10 * 60 * 1000,
  });
  rxNostr.setDefaultRelays([
    "wss://relay.damus.io",
    "wss://relay.momostr.pink",
    "wss://nos.lol",
    "wss://yabu.me",
  ]);
  // pool.addRelay("wss://relay.damus.io");
  // pool.addRelay("wss://relay.momostr.pink");
  // pool.addRelay("wss://nos.lol");
  // let connection: undefined | Rx.Subscription;
  const addEvent = (
    event: NostrEvent,
    relay: string,
    transition: boolean,
    realTime: boolean
  ) => {
    const e = events.findIndex((e) => e.event.id == event.id);
    if (e !== -1) {
      if (events[e].relays.indexOf(relay) === -1) {
        setEvents(e, "relays", events[e].relays.length, relay);
      }
    } else {
      const es = [
        ...events,
        { event: event, transition, relays: [relay], realTime },
      ].sort((a, b) => {
        const c =
          [a.event.created_at, b.event.id] > [b.event.created_at, a.event.id];
        return c ? -1 : 1;
      });
      setEvents(es);
    }
  };
  const removeEvent = (i: number, relay: string) => {
    const last = events[i];
    const relayI = last.relays.indexOf(relay);
    if (relayI !== -1) {
      if (last.relays.length === 1) {
        console.log("remove", events[i].event.created_at, events[i].event.id);
        setEvents(events.filter((_, j) => j !== i));
      } else {
        setEvents(i, "relays", (relays) => relays.filter((r) => r !== relay));
      }
      return true;
    }
    return false;
  };
  const removeEventsFromBottom = (n: number, relay: string) => {
    for (let i = events.length - 1; n > 0 && i >= 0; i--) {
      if (removeEvent(i, relay)) {
        n--;
      }
    }
  };
  const removeEventsFromTop = (n: number, relay: string) => {
    for (let i = 0; n > 0 && i < events.length; i++) {
      if (removeEvent(i, relay)) {
        n--;
      }
    }
  };
  const get_rev = (
    since: number,
    until: number,
    limit: number,
    relay: string
  ) => {
    const event_getter = (
      since: number,
      until: number,
      limit: number
    ): Promise<EventPacket[]> => {
      if (since === 0) {
        console.error("since is 0");
        return Promise.resolve([]);
      }
      console.log(`get ${since}..=${until}[${limit}] : ${relay}`);
      return new Promise((resolve, reject) => {
        const rxReq = createRxBackwardReq();
        const events: EventPacket[] = [];
        rxNostr.use(rxReq, { relays: [relay] }).subscribe({
          next: (e) => {
            events.push(e);
          },
          complete: () => {
            console.log(`==`, events);
            resolve(events);
          },
          error: (e) => {
            reject(e);
          },
        });
        rxReq.emit({ kinds: [7, 1], since: until, until, limit: 10_000 });
        rxReq.emit({ kinds: [7, 1], since, until: until - 1, limit });
        rxReq.over();
      });
    };
    return get_events_rev(
      since,
      until,
      limit,
      event_getter,
      (e) => e.event.created_at
    );
  };
  const relays = new Map<string, RelayState>();
  const relayState = (relay: string) => {
    let connection: undefined | Rx.Subscription;
    let isSubscribing = false;
    return {
      init: () => {
        console.log("init", relay);
        const rxReq = createRxBackwardReq();
        rxNostr.use(rxReq, { relays: [relay] }).subscribe(({ event, from }) => {
          addEvent(event, from, false, true);
        });
        rxReq.emit({ kinds: [7, 1], limit: 10 });
        rxReq.over();
      },
      startSubscribing: (since: number, sinceId: string) => {
        if (isSubscribing) {
          return;
        }
        console.log("start sub", relay);
        isSubscribing = true;
        (async () => {
          const limit = 3;
          let until = now();
          while (isSubscribing) {
            console.log("req es", relay);
            until = now();
            const es = (await get_rev(since, until, limit, relay)).filter(
              (e) =>
                e.event.created_at > since ||
                (e.event.created_at == since && e.event.id < sinceId)
            );
            if (es.length > 0) {
              since = es[0].event.created_at;
              sinceId = es[0].event.id;
            }
            console.log(
              relay,
              "es =",
              es.map((e) => e.event.id)
            );
            for (const e of es) {
              addEvent(e.event, e.from, true, false);
            }
            if (es.length < limit) {
              break;
            }
          }
          if (isSubscribing) {
            const rxReq = createRxForwardReq();
            connection = rxNostr
              .use(rxReq, { relays: [relay] })
              .subscribe((a) => {
                addEvent(a.event, relay, true, true);
              });
            rxReq.emit({ kinds: [7, 1], limit: 1_000, since: until });
          }
        })();
      },
      stopSubscribing: () => {
        if (!isSubscribing) {
          return;
        }
        console.log("stop sub", relay);
        isSubscribing = false;
        connection?.unsubscribe();
      },
    };
  };

  onMount(() => {
    for (const relay in rxNostr.getDefaultRelays()) {
      const s = relayState(relay);
      s.init();
      relays.set(relay, s);
    }
  });

  onCleanup(() => {
    webSeckets.forEach((ws) => ws.close());
  });

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const ev = events.findIndex(
        (ev) => ev.event.id == (e.target as HTMLElement).dataset.eventId
      );
      if (ev === -1) {
        continue;
      }
      if (!e.isIntersecting) {
        const isDown =
          ((e.rootBounds?.bottom || 0) + (e.rootBounds?.top || 0)) / 2 <
          e.boundingClientRect.top;
        setEvents(ev, "possition", isDown ? "bottom" : "top");
      } else {
        setEvents(ev, "possition", "middle");
      }
    }
    for (const [relay, state] of relays) {
      let top = 0;
      let middle = 0;
      let bottom = 0;
      const [newestDate, newestId] = events[0]
        ? [events[0].event.created_at, events[0].event.id]
        : [now(), ""];
      for (const e of events) {
        if (e.relays.indexOf(relay) === -1) {
          continue;
        }
        switch (e.possition) {
          case "top":
            top++;
            break;
          case "middle":
            middle++;
            break;
          case "bottom":
            bottom++;
            break;
        }
      }
      console.log(relay, top, middle, bottom);
      if (top < 3) {
        state.startSubscribing(newestDate, newestId);
      } else {
        state.stopSubscribing();
        if (top > 10) {
          removeEventsFromTop(top - 10, relay);
        }
      }
      if (bottom > 10) {
        removeEventsFromBottom(bottom - 10, relay);
      }
    }
  });

  let ulElement: HTMLElement | null = null;

  return (
    <ul class="mt-4 overflow-scroll" ref={(el) => (ulElement = el)}>
      <Show when={events.length === 0}>
        <div>loading ...</div>
      </Show>
      <For each={events}>
        {(event) => {
          console.log("add", event.event.created_at, event.event.id);
          if (!event.realTime && ulElement && ulElement.scrollTop === 0) {
            ulElement.scroll({ top: 1 });
          }
          return (
            <div
              ref={(el) => observer.observe(el as HTMLElement)}
              class="grid grid-animated-ul"
              classList={{ transition: event.transition }}
              style="overflow-wrap: anywhere;"
              data-event-id={event.event.id}
              data-real-time={event.realTime}
            >
              <div style="overflow: hidden;">
                <div class="border-t py-2 text-sm font-mono whitespace-pre-wrap">
                  <div>{[...event.relays].join(", ")}</div>
                  <div>{JSON.stringify(event.event)}</div>
                </div>
              </div>
            </div>
          );
        }}
      </For>
    </ul>
  );
}

export default NostrEvents;
