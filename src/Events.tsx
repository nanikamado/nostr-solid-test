import "./Events.css";
import { onCleanup, onMount, For, Show } from "solid-js";
import { NostrEvent } from "./nostr.ts";
// import { Channel } from "./channel.ts";
import {
  createRxNostr,
  createRxForwardReq,
  createRxBackwardReq,
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
  startSubscribing: () => void;
  stopSubscribing: () => void;
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
  const relays = new Map<string, RelayState>();
  const relayState = (relay: string) => {
    let connection: false | Rx.Subscription = false;
    return {
      startSubscribing: () => {
        if (connection) {
          return;
        }
        const rxReq = createRxForwardReq();
        connection = rxNostr.use(rxReq, { relays: [relay] }).subscribe((a) => {
          addEvent(a.event, relay, true, true);
        });
        rxReq.emit({ kinds: [7, 1], limit: 10 });
      },
      stopSubscribing: () => {
        if (!connection) {
          return;
        }
        console.log("stop sub", relay);
        connection?.unsubscribe();
        connection = false;
      },
    };
  };

  let ulElement: HTMLElement | null = null;
  let scrolling: undefined | number;

  onMount(() => {
    for (const relay in rxNostr.getDefaultRelays()) {
      const s = relayState(relay);
      relays.set(relay, s);
    }
    if (!ulElement) {
      return;
    }
    const ulElm = ulElement;
    let isSubscribing = false;

    const onscroll = () => {
      const isSubscribingOld = isSubscribing;
      isSubscribing = ulElm.scrollTop <= 10;
      const start = !isSubscribingOld && isSubscribing;
      const stop = isSubscribingOld && !isSubscribing;
      if (!start && !stop) {
        return;
      }
      for (const [_relay, state] of relays) {
        if (start) {
          state.startSubscribing();
        } else if (stop) {
          state.stopSubscribing();
        }
      }
      if (scrolling) {
        clearTimeout(scrolling);
      }
    };
    ulElement.onscroll = onscroll;
    onscroll();
  });

  onCleanup(() => {
    webSeckets.forEach((ws) => ws.close());
  });

  // const cutEvents = () => {
  //   const i = events.findIndex((e) => e.possition === "middle");
  //   if (i <= 2) {
  //     return events;
  //   }
  //   return events.slice(i - 2);
  // };
  // let scrollHeightOld = 0;

  // watch events and update noteList
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
    for (const [relay, _state] of relays) {
      let bottom = 0;
      let oldest = undefined;
      for (const e of events) {
        if (e.relays.indexOf(relay) === -1) {
          continue;
        }
        if (e.possition === "bottom") {
          bottom++;
        }
        oldest = e.event.created_at;
      }
      if (bottom > 10) {
        removeEventsFromBottom(bottom - 10, relay);
      } else if (bottom <= 3) {
        const rxReq = createRxBackwardReq();
        rxNostr.use(rxReq, { relays: [relay] }).subscribe((a) => {
          addEvent(a.event, relay, false, false);
        });
        if (oldest) {
          rxReq.emit({
            kinds: [7, 1],
            limit: 1_000,
            until: oldest,
            since: oldest,
          });
          rxReq.emit({ kinds: [7, 1], limit: 10, until: oldest - 1 });
        } else {
          rxReq.emit({ kinds: [7, 1], limit: 10 });
        }
        rxReq.over();
      }
    }
  });

  return (
    <ul
      class="mt-4 overflow-scroll"
      ref={(el) => {
        ulElement = el;
        // el.onscroll = () => {
        //   if (el.scrollHeight !== scrollHeightOld) {
        //     console.log("scrollHeight", el.scrollHeight);
        //     el.scrollBy({ top: el.scrollHeight - scrollHeightOld });
        //     scrollHeightOld = el.scrollHeight;
        //   }
        // };
      }}
    >
      <Show when={events.length === 0}>
        <div>loading ...</div>
      </Show>
      <For each={events}>
        {(event) => {
          console.log("add", event.event.created_at, event.event.id);
          // if (!event.realTime && ulElement && ulElement.scrollTop === 0) {
          //   ulElement.scroll({ top: 1 });
          // }
          return Note(event, observer);
        }}
      </For>
    </ul>
  );
}

function Note(event: EventSignal, observer: IntersectionObserver) {
  // onCleanup(() => {
  //   console.log("remove", event.event.created_at, event.event.id);
  // });
  // let element: HTMLElement | null = null;
  // const originalScrollTop = parent.scrollTop;
  onMount(() => {
    console.log("add", event.event.created_at, event.event.id);
  });
  onCleanup(() => {
    console.log("remove", event.event.created_at, event.event.id);
  });
  return (
    <div
      ref={(el) => {
        observer.observe(el);
      }}
      class="grid grid-animated-ul"
      // classList={{ transition: event.transition }}
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
}

export default NostrEvents;
