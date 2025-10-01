import "./Events.css";
import { createRoot, For, onCleanup, onMount, Show } from "solid-js";
import {
  createRxBackwardReq,
  createRxForwardReq,
  createRxNostr,
  EventPacket,
  RxNostr,
} from "rx-nostr";
import { verifier } from "rx-nostr-crypto";
import * as Rx from "rxjs";
import { createStore, SetStoreFunction } from "solid-js/store";
import * as NostrType from "nostr-typedef";
import { createSignal } from "solid-js";
import { Accessor } from "solid-js";
import { normalizeUrl, UrlMap } from "./util.ts";
import useDatePulser from "./utils/useDatePulser.ts";
import { formatRelative } from "./utils/formatDate.ts";
// @ts-types="solid-js"
import { createEffect } from "solid-js";
import { parseText } from "./parseText.ts";
import ChevronUp from "heroicons/24/outline/chevron-up.svg";
import ChevronDown from "heroicons/24/outline/chevron-down.svg";
import ToggleButton from "./ToggleButton.tsx";
import binarySearch from "./utils/binarySearch.ts";
import {
  BatchPool,
  EventStreamElement,
  getBridgeInfo,
  makeProfileFromEvent,
  ParsedNip05,
  UserProfile,
} from "./nostr.ts";
import { Channel } from "./channel.ts";
import { ReactiveMap } from "@solid-primitives/map";

type EventReferer = {
  reactions: ReactiveMap<string, number>;
  recievedEvents: Set<string>;
};

type EventSignal = {
  event: NostrType.Event;
  referer: EventReferer;
  transition: boolean;
  realTime?: boolean;
  relays: string[];
  possition?: "top" | "middle" | "bottom";
};

type WaitingBackwardReq = {
  filter: NostrType.Filter;
  callback: (e: EventPacket) => void;
  complete: () => void;
};

type LoadingOldEventsStatus = {
  until: number | undefined;
  resolves: ((a: { success: boolean }) => void)[];
  rejects: ((e: unknown) => void)[];
};

type MutablePromise<T> = {
  ready: Promise<boolean>;
  value: T | null;
};

class RelayState {
  concurrentReqs: number = 0;
  backwardReqBatch: WaitingBackwardReq[] = [];
  batchPool: BatchPool;
  #connection: false | Rx.Subscription = false;
  #loadingOldEvents: false | LoadingOldEventsStatus = false;
  #baseFilter: MutablePromise<NostrType.Filter>;
  #rxNostr: RxNostr;
  #addEvent: (
    event: NostrType.Event,
    relay: string,
    transition: boolean,
    realTime: boolean,
  ) => void;
  #onScreenEventLowerbound: { value: number };

  constructor(
    public relay: string,
    baseFilter: MutablePromise<NostrType.Filter>,
    rxNostr: RxNostr,
    addEvent: (
      event: NostrType.Event,
      relay: string,
      transition: boolean,
      realTime: boolean,
    ) => void,
    onScreenEventLowerbound: { value: number },
  ) {
    this.#baseFilter = baseFilter;
    this.#rxNostr = rxNostr;
    this.#addEvent = addEvent;
    this.#onScreenEventLowerbound = onScreenEventLowerbound;
    this.batchPool = new BatchPool(relay);
  }

  startSubscribing() {
    this.#baseFilter.ready.then(() => {
      if (this.#connection) {
        return;
      }
      const rxReq = createRxForwardReq();
      this.#connection = this.#rxNostr
        .use(rxReq, { relays: [this.relay] })
        .subscribe((a) => {
          this.#addEvent(a.event, this.relay, true, true);
        });
      rxReq.emit({ kinds: [1], limit: 11, ...this.#baseFilter.value });
    });
  }

  stopSubscribing() {
    if (!this.#connection) {
      return;
    }
    console.log("stop sub", this.relay);
    this.#connection?.unsubscribe();
    this.#connection = false;
  }

  loadOldevents(until: number | undefined): Promise<{ success: boolean }> {
    return new Promise<{ success: boolean }>((resolve, reject) => {
      if (this.#loadingOldEvents) {
        console.log("skip load old", this.relay, until);
        this.#loadingOldEvents.resolves.push(resolve);
        this.#loadingOldEvents.rejects.push(reject);
        return;
      }
      this.#loadingOldEvents = { until, resolves: [], rejects: [] };
      const rxReq = createRxBackwardReq();
      console.log("load old", this.relay, until, this.#loadingOldEvents, "...");
      let count = 0;
      this.#rxNostr.use(rxReq, { relays: [this.relay] }).subscribe({
        next: (a) => {
          this.#addEvent(a.event, this.relay, false, false);
          count++;
        },
        complete: () => {
          console.log("... load", this.relay, until, this.#loadingOldEvents);
          const loadingOldEventsOld = this.#loadingOldEvents;
          this.#loadingOldEvents = false;
          const success = count > 0;
          if (loadingOldEventsOld) {
            loadingOldEventsOld.resolves.forEach((r) => r({ success }));
          }
          resolve({ success });
          return;
        },
        error: (e) => {
          console.log("... failed to load", this.relay, until);
          const loadingOldEventsOld = this.#loadingOldEvents;
          this.#loadingOldEvents = false;
          if (loadingOldEventsOld) {
            loadingOldEventsOld.rejects.forEach((r) => r(e));
          }
          reject(e);
          return;
        },
      });
      this.#baseFilter.ready.then(() => {
        const baseFilter = this.#baseFilter.value!;
        if (this.#onScreenEventLowerbound.value !== Number.MAX_SAFE_INTEGER) {
          rxReq.emit({
            kinds: [1],
            until: until,
            since: this.#onScreenEventLowerbound.value,
            ...baseFilter,
          });
        }
        if (until) {
          rxReq.emit({
            kinds: [1],
            until: until,
            since: until,
            ...baseFilter,
          });
          rxReq.emit({
            kinds: [1],
            limit: 8,
            until: until - 1,
            ...baseFilter,
          });
        } else {
          rxReq.emit({ kinds: [1], limit: 8, ...baseFilter });
        }
        rxReq.over();
      });
    });
  }
}

const getEvents = (
  state: AppState,
  filter: NostrType.Filter,
  callback: (e: { event: EventStreamElement; relay: string }) => void,
) => {
  let count = state.relays.size();
  for (const [relay, relayState] of state.relays) {
    relayState.batchPool.getEvents(state.rxNostr, filter, (e) => {
      callback({ event: e, relay });
      if (e[0] === "eose") {
        if (--count === 0) {
          callback({ event: ["complete"], relay });
        }
      }
    });
  }
};

const subscribeReplacable = (
  state: AppState,
  filter: NostrType.Filter,
  callback: (e: EventPacket) => void,
  complete: () => void = () => {},
) => {
  const latestCursors = new Map<
    string,
    { event: NostrType.Event; relay: string }
  >();
  return getEvents(state, filter, (e) => {
    if (e.event[0] === "event") {
      const a = e.event[1];
      const cursor = a.event.pubkey + ":" + a.event.kind;
      const latest = latestCursors.get(cursor);
      if (
        latest &&
        (a.event.created_at < latest.event.created_at ||
          (a.event.created_at === latest.event.created_at &&
            a.event.id >= latest.event.id))
      ) {
        return;
      }
      if (latest && !a.event.tags.find((t) => t[0] === "-")) {
        console.log("update event in", latest.relay, "to", a.event);
        state.rxNostr.send(a.event, { relays: [latest.relay] });
      }
      latestCursors.set(cursor, { event: a.event, relay: e.relay });
      return callback(a);
    } else if (e.event[0] === "complete") {
      complete();
    }
  });
};

const isHex64 = (a: string) => /^[0-9a-f]{64}$/.test(a);

type NewEventCallback = (
  event: NostrType.Event,
  reactions: EventReferer,
) => void;

const checkNewEvent = async (
  event: NostrType.Event,
  onNewEventAdded?: NewEventCallback,
): Promise<null | { referer: EventReferer }> => {
  const valid = await verifier(event);
  if (!valid) {
    return null;
  }
  const referer = {
    reactions: new ReactiveMap<string, number>(),
    recievedEvents: new Set<string>(),
  };
  if (onNewEventAdded) {
    onNewEventAdded(event, referer);
  }
  return { referer };
};

const addEvent = (
  events: EventSignal[],
  setEvents: SetStoreFunction<EventSignal[]>,
  event: NostrType.Event,
  relay: string,
  transition: boolean,
  realTime: boolean,
  onNewEventAdded?: NewEventCallback,
) => {
  if (normalizeUrl(relay) !== relay) {
    throw new Error(`invalid relay "${relay}"`);
  }
  const right = binarySearch(
    events,
    (e) =>
      e.event.created_at < event.created_at ||
      (e.event.created_at === event.created_at && e.event.id > event.id),
  );
  if (events[right - 1]?.event.id === event.id) {
    const e = right - 1;
    if (events[e].relays.indexOf(relay) === -1) {
      setEvents(e, "relays", events[e].relays.length, relay);
    }
  } else {
    checkNewEvent(event, onNewEventAdded).then((valid) => {
      if (valid) {
        const newE = {
          event,
          transition,
          relays: [relay],
          realTime,
          referer: valid.referer,
        };
        const es = [...events.slice(0, right), newE, ...events.slice(right)];
        setEvents(es);
      }
    });
  }
};

const onNewEventAdded = (
  event: NostrType.Event,
  referer: EventReferer,
  state: AppState,
) => {
  const events = new Map<string, number>();
  getEvents(state, { "#e": [event.id], kinds: [7] }, (e) => {
    if (e.event[0] === "event") {
      const event = e.event[1].event;
      if (referer.recievedEvents.has(event.id)) {
        return;
      }
      referer.recievedEvents.add(event.id);
      const count = events.get(event.content) || 0;
      events.set(event.content, count + 1);
      return;
    } else if (e.event[0] == "eose") {
      for (const [k, v] of events) {
        referer.reactions.set(k, v);
      }
      return referer;
    }
  });
};

const removeEvent = (
  events: EventSignal[],
  setEvents: SetStoreFunction<EventSignal[]>,
  i: number,
  relay: string,
) => {
  const last = events[i];
  const relayI = last.relays.indexOf(relay);
  if (relayI !== -1) {
    if (last.relays.length === 1) {
      setEvents(events.filter((_, j) => j !== i));
    } else {
      setEvents(i, "relays", (relays) => relays.filter((r) => r !== relay));
    }
    return true;
  }
  return false;
};

const removeEventsFromBottom = (
  events: EventSignal[],
  setEvents: SetStoreFunction<EventSignal[]>,
  n: number,
  relay: string,
) => {
  for (let i = events.length - 1; n > 0 && i >= 0; i--) {
    if (removeEvent(events, setEvents, i, relay)) {
      n--;
    }
  }
};

const addMoreRelays = (
  baseFilter: MutablePromise<NostrType.Filter>,
  state: AppState,
  relayState: (relay: string) => RelayState,
) =>
  baseFilter.ready.then(() => {
    const filter = baseFilter.value!;
    if (filter.authors) {
      const authors = filter.authors;
      console.log("adding more relays", authors);
      for (const a of authors) {
        const [profile, setProfile] = createStore<ProfileMapValueInner>([
          "loading",
        ]);
        state.profileMap.set(a, { get: profile, set: setProfile });
      }
      const relayCount = new Map<string, number>();
      const preferedRelays: string[][] = [];
      console.log("add more relays");
      let done = false;
      subscribeReplacable(
        state,
        { kinds: [0, 10_002], authors },
        (a) => {
          if (a.event.kind === 0) {
            state.profileMap
              .get(a.event.pubkey)
              ?.set(["profile", makeProfileFromEvent(a.event)]);
          } else if (a.event.kind === 10_002) {
            const rs = [
              ...new Set(
                a.event.tags.flatMap((t) =>
                  t.length >= 2 && t[0] === "r" && t[2] !== "read"
                    ? [normalizeUrl(t[1])]
                    : []
                ),
              ),
            ];
            preferedRelays.push(rs);
            for (const r of rs) {
              const c = relayCount.get(r) || 0;
              relayCount.set(r, c + 1);
            }
          }
        },
        async () => {
          if (done) {
            throw new Error("should not be called");
          }
          done = true;
          for (const rs of preferedRelays) {
            if (rs.length && !rs.find((r) => state.relays.has(r))) {
              rs.sort(
                (a, b) => (relayCount.get(a) || 0) - (relayCount.get(b) || 0),
              );
              rs.reverse();
              for (const r of rs) {
                if (!relayCount.get(r)) {
                  break;
                }
                const req = createRxBackwardReq();
                const added = await new Promise((resolve) => {
                  state.rxNostr
                    .use(req, { relays: [rs[0]] })
                    .pipe(Rx.timeout(10_000))
                    .subscribe({
                      next: () => {
                        console.log("add max relay", r, relayCount.get(r));
                        state.relays.set(r, relayState(r));
                        state.rxNostr.addDefaultRelays([r]);
                        resolve(true);
                      },
                      error: (e) => {
                        console.log(
                          "could not use relay",
                          r,
                          relayCount.get(r),
                          e,
                        );
                        resolve(false);
                      },
                    });
                  req.emit({ kinds: [10_002], limit: 1 });
                  req.over();
                });
                if (added) {
                  break;
                } else {
                  relayCount.delete(r);
                }
              }
            }
          }
        },
      );
    }
  });

const getFollowees = (
  npub: string,
  state: AppState,
  rxNostr: RxNostr,
  mkRelayState: (relay: string) => RelayState,
  setBaseFilter: (f: NostrType.Filter) => void,
) =>
  subscribeReplacable(state, { kinds: [3, 10_002], authors: [npub] }, (a) => {
    if (a.event.kind === 3) {
      const followees = a.event.tags.flatMap((t) =>
        t.length >= 2 && t[0] === "p" ? [t[1]] : []
      );
      if (followees.length !== 0) {
        setBaseFilter({ authors: followees.filter(isHex64) });
      }
    } else if (a.event.kind === 10002) {
      const rs = a.event.tags.flatMap((t) =>
        t.length >= 2 && t[0] === "r" && t[2] !== "write"
          ? [normalizeUrl(t[1])]
          : []
      );
      rs.forEach((relay) => {
        if (!state.relays.has(relay)) {
          state.relays.set(relay, mkRelayState(relay));
          rxNostr.addDefaultRelays([relay]);
        }
      });
    }
  });

type NostrEventsProps = {
  tlType: TlType;
};

export type TlType =
  & (
    | { type: "home"; npub: () => string }
    | { type: "user"; npub: () => string }
    | { type: "customFilter"; baseFilter: () => NostrType.Filter }
  )
  & { baseRelays: () => string[] };

export function NostrEvents({ tlType }: NostrEventsProps) {
  const [events, setEvents] = createStore<EventSignal[]>([]);

  const rxNostr = createRxNostr({
    verifier: verifier,
    disconnectTimeout: 10 * 60 * 1000,
    skipVerify: true,
    skipValidateFilterMatching: true,
    skipExpirationCheck: true,
    skipFetchNip11: true,
  });
  rxNostr.createAllMessageObservable().subscribe((a) => {
    if (a.type === "NOTICE") {
      console.error(a.from, ":", a.message);
    }
  });
  const state = {
    rxNostr,
    profileMap: new Map<string, ProfileMapValue>(),
    Nip05Verified: new Map<string, Accessor<boolean>>(),
    relays: new UrlMap<RelayState>(),
  };
  const onScreenEventLowerbound = { value: Number.MAX_SAFE_INTEGER };

  createEffect(() => {
    setEvents([]);
    rxNostr.setDefaultRelays(tlType.baseRelays());
    state.relays = new UrlMap<RelayState>();
    onScreenEventLowerbound.value = Number.MAX_SAFE_INTEGER;
    let rsl: (a: boolean) => void;
    const baseFilter: MutablePromise<NostrType.Filter> = {
      ready: new Promise((resolve) => {
        rsl = resolve;
      }),
      value: null,
    };
    const setBaseFilter = (fs: NostrType.Filter) => {
      rsl(true);
      baseFilter.value = fs;
    };
    const relayState = (relay: string) =>
      new RelayState(
        relay,
        baseFilter,
        rxNostr,
        (e, r, transition, realTime) =>
          addEvent(events, setEvents, e, r, transition, realTime, (e, s) =>
            onNewEventAdded(e, s, state)),
        onScreenEventLowerbound,
      );
    for (const relay in rxNostr.getDefaultRelays()) {
      const r = normalizeUrl(relay);
      state.relays.set(r, relayState(r));
    }
    for (const [_relay, relayState] of state.relays) {
      relayState.startSubscribing();
    }
    if (tlType.type === "home") {
      getFollowees(tlType.npub(), state, rxNostr, relayState, setBaseFilter!);
    } else if (tlType.type === "user") {
      setBaseFilter!({ authors: [tlType.npub()] });
    } else if (tlType.type === "customFilter") {
      setBaseFilter!(tlType.baseFilter());
    } else {
      throw new Error("unknown tlType");
    }
    addMoreRelays(baseFilter, state, relayState);
  });

  let ulElement: HTMLElement | null = null;
  let scrolling: undefined | number;

  onMount(() => {
    if (!ulElement) {
      return;
    }
    const ulElm = ulElement;
    let isSubscribing = true;

    ulElement.onscroll = () => {
      const isSubscribingOld = isSubscribing;
      isSubscribing = ulElm.scrollTop <= 10;
      const start = !isSubscribingOld && isSubscribing;
      const stop = isSubscribingOld && !isSubscribing;
      if (!start && !stop) {
        return;
      }
      for (const [_relay, relayState] of state.relays) {
        if (start) {
          relayState.startSubscribing();
        } else if (stop) {
          relayState.stopSubscribing();
        }
      }
      if (scrolling) {
        clearTimeout(scrolling);
      }
    };
  });

  const load = () => {
    for (const [relay, relayState] of state.relays) {
      let lastOldest: undefined | null | number;
      let oldest: null | number = null;
      const loadRelay = () => {
        let bottom = 0;
        for (const e of events) {
          if (e.relays.indexOf(relay) === -1) {
            continue;
          }
          if (e.event.created_at < onScreenEventLowerbound.value) {
            bottom++;
          }
          oldest = e.event.created_at;
        }
        if (bottom > 10) {
          console.log("remove event of", relay);
          removeEventsFromBottom(events, setEvents, bottom - 10, relay);
        } else if (bottom <= 3 && lastOldest !== oldest) {
          lastOldest = oldest;
          relayState.loadOldevents(oldest || undefined).then(({ success }) => {
            if (success) {
              loadRelay();
            }
          });
        }
      };
      loadRelay();
    }
  };
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const ev = events.findIndex(
        (ev) => ev.event.id == (e.target as HTMLElement).dataset.eventId,
      );
      if (ev === -1) {
        continue;
      }
      if (e.isIntersecting) {
        const isDown =
          ((e.rootBounds?.bottom || 0) + (e.rootBounds?.top || 0)) / 2 <
            (e.boundingClientRect.bottom + e.boundingClientRect.top) / 2;
        if (isDown) {
          onScreenEventLowerbound.value = events[ev].event.created_at;
        }
      }
    }
    load();
  });

  return (
    <ul class="mt-4 overflow-scroll" ref={(el) => (ulElement = el)}>
      <Show when={events.length === 0}>
        <div>loading ...</div>
      </Show>
      <For each={events}>
        {(event) => {
          return Note(event, observer, state);
        }}
      </For>
    </ul>
  );
}

type ProfileMapValueInner = ["profile", UserProfile] | ["loading"];
type ProfileMapValue = {
  get: ProfileMapValueInner;
  set: SetStoreFunction<ProfileMapValueInner>;
};

type AppState = {
  rxNostr: RxNostr;
  profileMap: Map<string, ProfileMapValue>;
  Nip05Verified: Map<string, Accessor<boolean>>;
  relays: UrlMap<RelayState>;
};

const httpsProxy = (url: string) => {
  return url;
  // if (url.startsWith("https://") || url.startsWith("http://")) {
  //   return "https://corsproxy.io/?url=" + encodeURIComponent(url);
  // } else {
  //   return url;
  // }
};

const imageProxy = (url: string, option: string) =>
  encodeURI(option) +
  "/" + encodeURI(url);

function FallbackImage(props: { src: string; option: string; class: string }) {
  if (props.src.startsWith("https://") || props.src.startsWith("http://")) {
    const [src, setSrc] = createSignal({
      url: "https://api.yabu.me/v0/images/optimize/" +
        imageProxy(props.src, props.option),
      fallback: [
        "https://nostr-image-optimizer.ocknamo.com/image/" +
        imageProxy(props.src, props.option),
        "https://nostr-image-optimizer.ocknamo.com/image/" + imageProxy(
          "https://web.archive.org/web/30000000000000im_/" + props.src,
          props.option,
        ),
        props.src,
      ],
    });

    return (
      <img
        class={props.class}
        src={src().url}
        onError={() => {
          const fallback = src().fallback;
          if (fallback.length) {
            console.error("failed to load", props.src, "proxy: on");
            return setSrc({ url: fallback[0], fallback: fallback.slice(1) });
          } else {
            console.error("failed to load", props.src, "proxy: off");
          }
        }}
      />
    );
  } else {
    // for urls line `data:image/png;...`
    return (
      <img
        class={props.class}
        src={props.src}
      />
    );
  }
}

const verifyNip05Inner = async (
  name: string,
  domain: string,
  pubkey: string,
) => {
  const res = await (
    await fetch(
      httpsProxy(`https://${domain}/.well-known/nostr.json?name=${name}`),
    )
  ).json();
  const nip05Pubkey = res.names?.[name];
  return nip05Pubkey === pubkey;
};

const verifyNip05 = (
  nip05: ParsedNip05,
  pubkey: string,
  state: AppState,
): Accessor<boolean> => {
  const { name, domain } = nip05;
  if (state.Nip05Verified.get(pubkey) === undefined) {
    const [verified, setVerified] = createSignal(false);
    state.Nip05Verified.set(pubkey, verified);
    verifyNip05Inner(name, domain, pubkey)
      .then((res) => {
        setVerified(res);
      })
      .catch(() => {
        setVerified(false);
      });
  }
  return state.Nip05Verified.get(pubkey)!;
};

const UserId = (props: {
  event: NostrType.Event;
  nip05?: ParsedNip05;
  state: AppState;
}) => {
  const bridged = getBridgeInfo(props.event, props.nip05);
  const nip05IsVarid = props.nip05
    ? verifyNip05(props.nip05, props.event.pubkey, props.state)
    : () => false;
  return (
    <Show when={nip05IsVarid()}>
      <Show when={bridged} fallback={<span>{props.nip05!.text}</span>}>
        <span>{bridged!.id ? bridged!.id : props.nip05!.text}</span>
        <span class="opacity-50 ml-3">
          bridged from {bridged!.bridgedFrom}
          {bridged!.bridgeSerever ? " by " + bridged!.bridgeSerever : ""}
        </span>
      </Show>
    </Show>
  );
};

const NostrText = (props: {
  text: string;
  emojiMap: Map<string, string>;
  images?: Set<string>;
}) => {
  if (!props.images) {
    props.images = new Set<string>();
  }
  return (
    <For each={parseText(props.text, props.emojiMap, props.images)}>
      {(section) => {
        if (section[0] === "emoji") {
          return (
            <FallbackImage
              class="inline-block h-[1.7em]"
              src={section[2]}
              option="height=50"
            />
          );
        } else if (section[0] === "image") {
          return <FallbackImage src={section[1]} class="" option="width=800" />;
        } else if (section[0] === "video") {
          return <video src={section[1]} controls></video>;
        } else {
          return <span>{section[1]}</span>;
        }
      }}
    </For>
  );
};

const DateText = (props: { date: number }) => {
  const currentDateHigh = createRoot(() =>
    useDatePulser(() => ({ interval: 7000 }))
  );
  const s = formatRelative(new Date(props.date * 1000), currentDateHigh());
  return <span>{s}</span>;
};

const getParent = (
  state: AppState,
  event: NostrType.Event,
  resultSetter: SetStoreFunction<ThreadParentStore>,
  onNewEventAdded?: NewEventCallback,
) => {
  let root;
  let reply;
  for (const t of event.tags) {
    if (t[3] === "reply") {
      reply = t[1];
    } else if (t[3] === "root") {
      root = t[1];
    }
  }
  const parent = reply || root;
  if (!parent) {
    return;
  }
  resultSetter("value", ["loading"]);
  const ch = new Channel<{
    e: EventPacket;
    type: ["verified", EventReferer] | ["unverifed"];
  }>();
  getEvents(state, { ids: [parent] }, (e) => {
    if (e.event[0] !== "event") {
      return;
    }
    ch.send({ e: e.event[1], type: ["unverifed"] });
  });
  (async () => {
    for await (const { e, type } of ch) {
      await new Promise((resolve) => {
        resultSetter("value", (prev) => {
          if (prev && prev[0] === "event") {
            resolve(null);
            return [
              "event",
              {
                event: prev[1].event,
                referer: prev[1].referer,
                relays: [...prev[1].relays, e.from],
                transition: false,
                realTime: false,
              },
            ];
          } else if (type[0] === "verified") {
            resolve(null);
            return [
              "event",
              {
                event: e.event,
                referer: type[1],
                relays: [e.from],
                transition: false,
                realTime: false,
              },
            ];
          } else {
            checkNewEvent(e.event, onNewEventAdded).then((valid) => {
              if (valid) {
                ch.send({ e, type: ["verified", valid.referer] });
              }
              resolve(null);
            });
            return prev;
          }
        });
      });
    }
  })();
};

type ThreadParentStore = { value: null | ["loading"] | ["event", EventSignal] };

function Note(
  event: EventSignal,
  observer: IntersectionObserver,
  state: AppState,
) {
  const [threadParent, setThreadParent] = createStore<ThreadParentStore>({
    value: null,
  });
  getParent(
    state,
    event.event,
    setThreadParent,
    (e, s) => onNewEventAdded(e, s, state),
  );

  return (
    <div
      ref={(el) => {
        observer.observe(el);
      }}
      class="grid grid-animated-ul"
      classList={{ transition: event.transition }}
      style="overflow-wrap: anywhere;"
      data-event-id={event.event.id}
      data-real-time={event.realTime}
    >
      <div style="overflow: hidden;" class="border-t">
        <NoteSingle
          event={event}
          state={state}
          threadParent={threadParent}
        >
        </NoteSingle>
      </div>
    </div>
  );
}

function NoteSingle(props: {
  event: EventSignal;
  state: AppState;
  threadParent?: ThreadParentStore;
}) {
  const { event, state, threadParent } = props;
  const emojiMap = new Map<string, string>();
  const images = new Set<string>();
  event.event.tags.forEach((t) => {
    if (t.length >= 3 && t[0] === "emoji") {
      emojiMap.set(t[1], t[2]);
    } else if (t[0] === "imeta") {
      if (t.slice(1).find((t) => t.startsWith("m image/"))) {
        const image = t.slice(1).find((t) => t.startsWith("url "));
        if (image) {
          images.add(image.slice("url ".length));
        }
      }
    }
  });
  onMount(() => {
    console.log("add", event.event.created_at, event.event.id);
  });
  onCleanup(() => {
    console.log("remove", event.event.created_at, event.event.id);
  });

  let prof: () => UserProfile | undefined;
  const p = state.profileMap.get(event.event.pubkey);

  if (!p) {
    const [get, set] = createStore<ProfileMapValueInner>(["loading"]);
    state.profileMap.set(event.event.pubkey, { get, set });
    subscribeReplacable(
      state,
      { kinds: [0], authors: [event.event.pubkey] },
      (a: EventPacket) => {
        set(["profile", makeProfileFromEvent(a.event)]);
      },
    );
    prof = () => get[1];
  } else {
    prof = () => p.get[1];
  }

  const [eventMenuOn, setEventMenuOn] = createSignal(false);
  const [jsonOn, setJsonOn] = createSignal(false);

  return (
    <div class="py-2 whitespace-pre-wrap">
      <div class="flex w-full gap-1">
        <div class="size-10 shrink-0 overflow-hidden rounded">
          <Show when={prof() && prof()!.picture}>
            <FallbackImage
              src={prof()!.picture!}
              class=""
              option="width=100"
            />
          </Show>
        </div>
        <div class="w-full">
          <Show when={prof()} fallback={<div>loading ...</div>}>
            <div class="flow-root text-sm">
              <span class="font-bold">
                <NostrText
                  text={prof()!.name}
                  emojiMap={prof()!.emojiMap}
                >
                </NostrText>
              </span>
              <span class="ml-3">
                <UserId
                  event={event.event}
                  nip05={prof()?.nip05}
                  state={state}
                >
                </UserId>
              </span>
              <span class="float-end">
                <DateText date={event.event.created_at}></DateText>
              </span>
            </div>
          </Show>
          <Show when={threadParent && threadParent.value}>
            <Show
              when={threadParent!.value![0] === "event"}
              fallback={<NoteLoading />}
            >
              <NoteSingle
                event={threadParent!.value![1] as EventSignal}
                state={state}
              >
              </NoteSingle>
            </Show>
          </Show>
          <div>
            <NostrText
              text={event.event.content}
              emojiMap={emojiMap}
              images={images}
            >
            </NostrText>
          </div>
          <div>
            <For each={[...event.referer.reactions.entries()]}>
              {([emoji, count]) => (
                <span>
                  {emoji} {count}
                </span>
              )}
            </For>
          </div>
          <div class="flex justify-around mt-1">
            <ToggleButton
              isOn={eventMenuOn}
              setIsOn={setEventMenuOn}
              offTextColor="text-gray-100/50"
            >
              <div class="size-4 shrink-0">
                <Show when={eventMenuOn()} fallback={<ChevronDown />}>
                  <ChevronUp />
                </Show>
              </div>
            </ToggleButton>
          </div>
          <div>
            <Show when={eventMenuOn()}>
              <ToggleButton isOn={jsonOn} setIsOn={setJsonOn}>
                Show JSON
              </ToggleButton>
            </Show>
          </div>
          <Show when={jsonOn()}>
            <div class="font-mono text-sm mt-1 opacity-80 whitespace-break-spaces break-all">
              {formatEvent(event.event)}
            </div>
          </Show>
          <div class="opacity-50 mt-0.5 text-sm">
            {[...event.relays]
              .map((a) => a.replace(/^wss:\/\//, ""))
              .join(", ")}
          </div>
        </div>
      </div>
    </div>
  );
}

const NoteLoading = () => {
  return (
    <div class="w-full p-2">
      <div class="w-full rounded-sm border-dashed border-white border-1 p-2">
        loading ...
      </div>
    </div>
  );
};

const formatEvent = (event: NostrType.Event) => {
  let tags;
  if (event.tags.length === 0) {
    tags = "[]";
  } else {
    tags = "[\n" +
      event.tags
        .map((t) => {
          const tag = t.map((a) => JSON.stringify(a)).join(", ");
          return `        [${tag}]`;
        })
        .join(",\n") +
      "\n    ]";
  }
  return `{
    "kind" : ${event.kind},
    "pubkey" : "${event.pubkey}",
    "created_at" : ${event.created_at},
    "content" : ${JSON.stringify(event.content)},
    "tags" : ${tags},
    "id" : "${event.id}",
    "sig" : "${event.sig}"
}`;
};
