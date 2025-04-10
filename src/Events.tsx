import "./Events.css";
import { onCleanup, onMount, For, Show, createRoot } from "solid-js";
import { NostrEvent } from "./nostr.ts";
// import { Channel } from "./channel.ts";
import {
  createRxNostr,
  createRxForwardReq,
  createRxBackwardReq,
  RxNostr,
  EventPacket,
  isFiltered,
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
import EventMenuButton from "./EventMenuButton.tsx";

type EventSignal = {
  event: NostrEvent;
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

class RelayState {
  concurrentReqs: number = 0;
  backwardReqBatch: WaitingBackwardReq[] = [];
  #connection: false | Rx.Subscription = false;
  #loadingOldEvents: false | LoadingOldEventsStatus = false;
  #baseFilter: Promise<NostrType.Filter>;
  #rxNostr: RxNostr;
  #addEvent: (
    event: NostrEvent,
    relay: string,
    transition: boolean,
    realTime: boolean
  ) => void;
  #onScreenEventLowerbound: { value: number };

  constructor(
    public relay: string,
    baseFilter: Promise<NostrType.Filter>,
    rxNostr: RxNostr,
    addEvent: (
      event: NostrEvent,
      relay: string,
      transition: boolean,
      realTime: boolean
    ) => void,
    onScreenEventLowerbound: { value: number }
  ) {
    this.#baseFilter = baseFilter;
    this.#rxNostr = rxNostr;
    this.#addEvent = addEvent;
    this.#onScreenEventLowerbound = onScreenEventLowerbound;
  }

  startSubscribing() {
    if (this.#connection) {
      return;
    }
    this.#baseFilter.then((baseFilter) => {
      const rxReq = createRxForwardReq();
      this.#connection = this.#rxNostr
        .use(rxReq, { relays: [this.relay] })
        .subscribe((a) => {
          this.#addEvent(a.event, this.relay, true, true);
        });
      rxReq.emit({ kinds: [1], limit: 11, ...baseFilter });
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
      this.#baseFilter.then((baseFilter) => {
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

const binarySearch = <T,>(arr: T[], f: (item: T) => boolean): number => {
  let left = -1;
  let right = arr.length;

  while (right - left > 1) {
    const mid = Math.floor((left + right) / 2);
    if (f(arr[mid])) {
      right = mid;
    } else {
      left = mid;
    }
  }

  return right;
};

const eqSet = <T,>(xs: Set<T>, ys: Set<T>) =>
  xs.size === ys.size && [...xs].every((x) => ys.has(x));

const mergeFilters = (
  a: NostrType.Filter,
  b: NostrType.Filter
): NostrType.Filter | null => {
  let differentKey;
  if (
    Object.entries(a).length !== Object.entries(b).length ||
    a.since !== b.since ||
    a.until !== b.until ||
    a.search ||
    b.search ||
    a.limit ||
    b.limit
  ) {
    return null;
  }
  for (const key in a) {
    if (key === "since" || key === "until") {
      continue;
    }
    const getAsSet = (f: NostrType.Filter, key: string) =>
      new Set((f as Record<string, unknown>)[key] as unknown[]);
    if (!eqSet(getAsSet(a, key), getAsSet(b, key))) {
      if (differentKey) {
        return null;
      }
      differentKey = key;
    }
  }
  if (differentKey) {
    return {
      ...a,
      [differentKey]: [
        ...new Set([
          ...((a as Record<string, unknown>)[differentKey] as unknown[]),
          ...((b as Record<string, unknown>)[differentKey] as unknown[]),
        ]),
      ],
    };
  } else {
    return null;
  }
};

const MAX_CUNCURRENT_REQS = 10;

const getEvents = (
  state: AppState,
  filter: NostrType.Filter,
  callback: (e: EventPacket) => void,
  complete: () => void = () => {}
) => {
  let count = state.relays.size();
  const countComplete = () => {
    if (--count === 0) {
      complete();
    }
  };
  for (const [relay, relayState] of state.relays) {
    const cb = (a: EventPacket) => {
      if (!isFiltered(a.event, filter)) {
        return;
      }
      callback(a);
    };
    if (relayState.concurrentReqs >= MAX_CUNCURRENT_REQS) {
      let merged = false;
      for (const batch of relayState.backwardReqBatch) {
        const m = mergeFilters(batch.filter, filter);
        if (m) {
          merged = true;
          batch.filter = m;
          const originalCb = batch.callback;
          batch.callback = (e) => {
            cb(e);
            originalCb(e);
          };
          break;
        }
      }
      if (!merged) {
        relayState.backwardReqBatch.push({ filter, callback: cb, complete });
      }
      continue;
    }
    relayState.concurrentReqs++;
    const comp = (complete: () => void) => {
      relayState.concurrentReqs--;
      complete();
      if (relayState.concurrentReqs < MAX_CUNCURRENT_REQS) {
        const batch = relayState.backwardReqBatch.shift();
        if (batch) {
          relayState.concurrentReqs++;
          subscribe(batch.filter, batch.callback, batch.complete);
        }
      }
    };
    const subscribe = (
      filter: NostrType.Filter,
      cb: (e: EventPacket) => void,
      complete: () => void
    ) => {
      const rxReq = createRxBackwardReq();
      state.rxNostr.use(rxReq, { relays: [relay] }).subscribe({
        next: cb,
        complete: () => {
          comp(complete);
        },
        error: (e) => {
          comp(complete);
          console.error(e);
        },
      });
      rxReq.emit(filter);
      rxReq.over();
    };
    subscribe(filter, cb, countComplete);
  }
};

const subscribeReplacable = (
  state: AppState,
  filter: NostrType.Filter,
  callback: (e: EventPacket) => void,
  complete: () => void = () => {}
) => {
  const latestCursors = new Map<string, { createdAt: number; id: string }>();
  return getEvents(
    state,
    filter,
    (a) => {
      const cursor = a.event.pubkey + ":" + a.event.kind;
      let latest = latestCursors.get(cursor);
      if (!latest) {
        latest = { createdAt: 0, id: "x" };
        latestCursors.set(cursor, latest);
      }
      if (
        a.event.created_at < latest.createdAt ||
        (a.event.created_at === latest.createdAt && a.event.id >= latest.id)
      ) {
        return;
      }
      latest.createdAt = a.event.created_at;
      latest.id = a.event.id;
      latestCursors.set(cursor, latest);
      return callback(a);
    },
    complete
  );
};

const isHex64 = (a: string) => /^[0-9a-f]{64}$/.test(a);

const addEvent = (
  events: EventSignal[],
  setEvents: SetStoreFunction<EventSignal[]>,
  event: NostrEvent,
  relay: string,
  transition: boolean,
  realTime: boolean
) => {
  if (normalizeUrl(relay) !== relay) {
    throw new Error(`invalid relay "${relay}"`);
  }
  const right = binarySearch(
    events,
    (e) =>
      e.event.created_at < event.created_at ||
      (e.event.created_at === event.created_at && e.event.id > event.id)
  );
  if (events[right - 1]?.event.id === event.id) {
    const e = right - 1;
    if (events[e].relays.indexOf(relay) === -1) {
      setEvents(e, "relays", events[e].relays.length, relay);
    }
  } else {
    verifier(event).then((valid) => {
      if (valid) {
        const newE = { event: event, transition, relays: [relay], realTime };
        const es = [...events.slice(0, right), newE, ...events.slice(right)];
        setEvents(es);
      }
    });
  }
};

const removeEvent = (
  events: EventSignal[],
  setEvents: SetStoreFunction<EventSignal[]>,
  i: number,
  relay: string
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
  relay: string
) => {
  for (let i = events.length - 1; n > 0 && i >= 0; i--) {
    if (removeEvent(events, setEvents, i, relay)) {
      n--;
    }
  }
};

const addMoreRelays = (
  baseFilter: Promise<NostrType.Filter>,
  state: AppState,
  relayState: (relay: string) => RelayState
) =>
  baseFilter.then((filter) => {
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
                )
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
                (a, b) => (relayCount.get(a) || 0) - (relayCount.get(b) || 0)
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
                          e
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
        }
      );
    }
  });

const getFollowees = (
  npub: string,
  state: AppState,
  rxNostr: RxNostr,
  mkRelayState: (relay: string) => RelayState,
  setBaseFilter: (f: NostrType.Filter) => void
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

type BridgedAccountProfile = {
  id?: string;
  bridgeSerever?: string;
  bridgedFrom: string;
};

type UserProfile = {
  pubkey: string;
  name: string;
  picture?: string;
  created_at: number;
  emojiMap: Map<string, string>;
  nip05?: ParsedNip05;
  bridged?: BridgedAccountProfile;
};

export type TlType =
  | { type: "home"; npub: () => string }
  | { type: "user"; npub: () => string }
  | { type: "tag"; tag: () => string };

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
    rxNostr.setDefaultRelays([
      "wss://relay.damus.io",
      "wss://relay.momostr.pink",
      "wss://nos.lol",
      "wss://yabu.me",
    ]);
    state.relays = new UrlMap<RelayState>();
    onScreenEventLowerbound.value = Number.MAX_SAFE_INTEGER;
    let setBaseFilter: (a: NostrType.Filter) => void;
    const baseFilter: Promise<NostrType.Filter> = new Promise((resolve) => {
      setBaseFilter = (fs) => resolve(fs);
    });
    const relayState = (relay: string) =>
      new RelayState(
        relay,
        baseFilter,
        rxNostr,
        (e, r, transition, realTime) =>
          addEvent(events, setEvents, e, r, transition, realTime),
        onScreenEventLowerbound
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
    } else if (tlType.type === "tag") {
      setBaseFilter!({ "#t": [tlType.tag()] });
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
    let isSubscribing = false;

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
        (ev) => ev.event.id == (e.target as HTMLElement).dataset.eventId
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

const imageUrl = (original: string | undefined) =>
  original ? httpsProxy(original) : "";

type ParsedNip05 = {
  name: string;
  domain: string;
  text: string;
};

const parseNip05 = (nip05: string): ParsedNip05 | null => {
  const s = nip05.split("@");
  if (s.length < 2) {
    return null;
  }
  const name = s.slice(0, s.length - 1).join("@");
  const domain = s[s.length - 1];
  return { name: name, domain, text: name === "_" ? "@" + domain : nip05 };
};

const verifyNip05Inner = async (
  name: string,
  domain: string,
  pubkey: string
) => {
  const res = await (
    await fetch(
      httpsProxy(`https://${domain}/.well-known/nostr.json?name=${name}`)
    )
  ).json();
  const nip05Pubkey = res.names?.[name];
  return nip05Pubkey === pubkey;
};

const verifyNip05 = (
  nip05: ParsedNip05,
  pubkey: string,
  state: AppState
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

const makeProfileFromEvent = (event: NostrType.Event): UserProfile => {
  const emojiMap = new Map<string, string>();
  event.tags.forEach((t) => {
    if (t.length >= 3 && t[0] === "emoji") {
      emojiMap.set(t[1], t[2]);
    }
  });
  const p: UserProfile = {
    pubkey: event.pubkey,
    name: "",
    created_at: event.created_at,
    emojiMap,
  };
  try {
    const profileObj = JSON.parse(event.content);
    p.name = profileObj.display_name || profileObj.name || "";
    p.picture = profileObj.picture;
    p.nip05 = profileObj.nip05 && parseNip05(profileObj.nip05);
  } catch (_e) {
    p.name = event.pubkey;
  }
  return p;
};

const getBridgeInfo = (
  event: NostrType.Event,
  nip05?: ParsedNip05
): BridgedAccountProfile | undefined => {
  let bridgeSerever;
  let id;
  if (nip05 && nip05.domain === "momostr.pink") {
    bridgeSerever = nip05.domain;
    const sections = nip05.name.split("_at_");
    id =
      "@" +
      sections.slice(0, sections.length - 1).join("_at_") +
      "@" +
      sections[sections.length - 1];
  } else if (nip05 && nip05.domain.endsWith(".mostr.pub")) {
    bridgeSerever = "mostr.pub";
    id =
      "@" +
      nip05.name +
      "@" +
      nip05.domain.replace(/\.mostr\.pub$/, "").replace("-", ".");
  }
  const activitypub = event.tags.find(
    (t) => t[0] === "proxy" && t[2] === "activitypub"
  );
  const atproto = event.tags.find(
    (t) => t[0] === "proxy" && t[2] === "atproto"
  );
  const web = event.tags.find((t) => t[0] === "proxy" && t[2] === "web");
  const bridgedFrom =
    (atproto?.[2] && "Bluesky") ||
    (activitypub?.[2] && "Fediverse") ||
    (web?.[2] && "Web");
  if (!bridgedFrom) {
    return undefined;
  }
  return { id, bridgeSerever, bridgedFrom };
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
            <img class="inline-block h-[1.3lh]" src={imageUrl(section[2])} />
          );
        } else if (section[0] === "image") {
          return <img src={imageUrl(section[1])} />;
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
  resultSetter: SetStoreFunction<ThreadParentStore>
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
    return Promise.resolve(undefined);
  }
  getEvents(
    state,
    { ids: [parent] },
    (e) => {
      resultSetter("value", (prev) => {
        if (prev) {
          return {
            event: e.event,
            relays: [...prev.relays, e.from],
            transition: false,
            realTime: false,
          };
        } else {
          return {
            event: e.event,
            relays: [e.from],
            transition: false,
            realTime: false,
          };
        }
      });
    },
    () => {}
  );
};

type ThreadParentStore = { value: null | EventSignal };

function Note(
  event: EventSignal,
  observer: IntersectionObserver,
  state: AppState
) {
  const [threadParent, setThreadParent] = createStore<ThreadParentStore>({
    value: null,
  });
  getParent(state, event.event, setThreadParent);

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
        ></NoteSingle>
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
      }
    );
    prof = () => get[1];
  } else {
    prof = () => p.get[1];
  }

  const [jsonOn, setJsonOn] = createSignal(false);

  return (
    <div class="py-2 whitespace-pre-wrap">
      <div class="flex w-full gap-1">
        <div class="size-10 shrink-0 overflow-hidden rounded">
          <Show when={prof()}>
            <img src={imageUrl(prof()!.picture)} />
          </Show>
        </div>
        <div class="w-full">
          <Show when={prof()} fallback={<div>loading ...</div>}>
            <div class="flow-root text-sm">
              <span class="font-bold">
                <NostrText
                  text={prof()!.name}
                  emojiMap={prof()!.emojiMap}
                ></NostrText>
              </span>
              <span class="ml-3">
                <UserId
                  event={event.event}
                  nip05={prof()?.nip05}
                  state={state}
                ></UserId>
              </span>
              <span class="float-end">
                <DateText date={event.event.created_at}></DateText>
              </span>
            </div>
          </Show>
          <Show when={threadParent && threadParent.value}>
            <NoteSingle event={threadParent!.value!} state={state}></NoteSingle>
          </Show>
          <div>
            <NostrText
              text={event.event.content}
              emojiMap={emojiMap}
              images={images}
            ></NostrText>
          </div>
          <EventMenuButton jsonOn={jsonOn} setJsonOn={setJsonOn} />
          <Show when={jsonOn()}>
            <div class="font-mono text-sm mt-1 opacity-80">
              {JSON.stringify(event.event)}
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
