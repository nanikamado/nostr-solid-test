import "./Events.css";
import { onCleanup, onMount, For, Show } from "solid-js";
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

type RelayState = {
  startSubscribing: () => void;
  stopSubscribing: () => void;
  loadOldevents: (until: number | undefined) => Promise<{ success: boolean }>;
  concurrentReqs: number;
  backwardReqBatch: WaitingBackwardReq[];
};

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

const subscribeReplacable = (
  state: AppState,
  filter: NostrType.Filter,
  callback: (e: EventPacket) => void,
  complete: () => void = () => {}
) => {
  const latestCursors = new Map<string, { createdAt: number; id: string }>();
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

type NostrEventsProps = {
  npub: string;
};

type UserProfile = {
  pubkey: string;
  name: string;
  picture?: string;
  created_at: number;
  emojiMap: Map<string, string>;
  nip05?: string;
};

const normalizeUrl = (url: string) => {
  const u = new URL(url);
  const s = u.toString();
  if (u.pathname === "/" && s[s.length - 1] === "/") {
    return s.slice(0, -1);
  } else {
    return s;
  }
};

class UrlMap<T> {
  urls: Map<string, T>;

  constructor() {
    this.urls = new Map();
  }
  get(url: string): T | undefined {
    return this.urls.get(normalizeUrl(url));
  }
  set(url: string, value: T) {
    this.urls.set(normalizeUrl(url), value);
  }
  [Symbol.iterator]() {
    return this.urls[Symbol.iterator]();
  }
  has(url: string) {
    return this.urls.has(normalizeUrl(url));
  }
  size() {
    return this.urls.size;
  }
}

function NostrEvents({ npub }: NostrEventsProps) {
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
  rxNostr.createAllMessageObservable().subscribe((a) => {
    if (a.type === "NOTICE") {
      console.error(a.from, ":", a.message);
    }
  });
  rxNostr.setDefaultRelays([
    "wss://relay.damus.io",
    "wss://relay.momostr.pink",
    "wss://nos.lol",
    "wss://yabu.me",
  ]);
  const state = {
    rxNostr,
    profileMap: new Map<string, ProfileMapValue>(),
    Nip05Verified: new Map<string, Accessor<boolean>>(),
    relays: new UrlMap<RelayState>(),
  };
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
    if (normalizeUrl(relay) !== relay) {
      throw new Error(`invalid relay "${relay}"`);
    }
    const e = events.findIndex((e) => e.event.id == event.id);
    const right = binarySearch(
      events,
      (e) =>
        e.event.created_at < event.created_at ||
        (e.event.created_at === event.created_at && e.event.id > event.id)
    );
    if (events[right - 1]?.event.id === event.id) {
      if (events[e].relays.indexOf(relay) === -1) {
        setEvents(e, "relays", events[e].relays.length, relay);
      }
    } else {
      const newE = { event: event, transition, relays: [relay], realTime };
      const es = [...events.slice(0, right), newE, ...events.slice(right)];
      setEvents(es);
    }
  };
  const removeEvent = (i: number, relay: string) => {
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
  const removeEventsFromBottom = (n: number, relay: string) => {
    for (let i = events.length - 1; n > 0 && i >= 0; i--) {
      if (removeEvent(i, relay)) {
        n--;
      }
    }
  };
  let onScreenEventLowerbound = Number.MAX_SAFE_INTEGER;
  let setFollowees: (a: string[]) => void;
  const followees: Promise<string[]> = new Promise((resolve) => {
    setFollowees = resolve;
  });
  followees.then((authors) => {
    for (const a of authors) {
      const [profile, setProfile] = createStore<ProfileMapValueInner>([
        "loading",
      ]);
      state.profileMap.set(a, { get: profile, set: setProfile });
    }
    const relayCount = new Map<string, number>();
    const preferedRelays: string[][] = [];
    console.log("add more relays");
    let done = 0;
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
        console.log("complete!!!!", done++);
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
              console.log("test relay", r, relayCount.get(r));
              const req = createRxBackwardReq();
              const added = await new Promise((resolve) => {
                rxNostr
                  .use(req, { relays: [rs[0]] })
                  .pipe(Rx.timeout(10_000))
                  .subscribe({
                    next: () => {
                      console.log("add max relay", r, relayCount.get(r));
                      state.relays.set(r, relayState(r));
                      rxNostr.addDefaultRelays([r]);
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
  });
  const relayState = (relay: string) => {
    let connection: false | Rx.Subscription = false;
    type LoadingOldEventsStatus = {
      until: number | undefined;
      resolves: ((a: { success: boolean }) => void)[];
      rejects: (() => void)[];
    };
    let loadingOldEvents: false | LoadingOldEventsStatus = false;
    return {
      concurrentReqs: 0,
      backwardReqBatch: [],
      startSubscribing: () => {
        if (connection) {
          return;
        }
        followees.then((authors) => {
          const rxReq = createRxForwardReq();
          connection = rxNostr
            .use(rxReq, { relays: [relay] })
            .subscribe((a) => {
              addEvent(a.event, relay, true, true);
            });
          rxReq.emit({ kinds: [1], limit: 11, authors });
        });
      },
      stopSubscribing: () => {
        if (!connection) {
          return;
        }
        console.log("stop sub", relay);
        connection?.unsubscribe();
        connection = false;
      },
      loadOldevents: (until: number | undefined) => {
        return new Promise<{ success: boolean }>((resolve, reject) => {
          if (loadingOldEvents) {
            console.log("skip load old", relay, until);
            loadingOldEvents.resolves.push(resolve);
            loadingOldEvents.rejects.push(reject);
            return;
          }
          loadingOldEvents = { until, resolves: [], rejects: [] };
          const rxReq = createRxBackwardReq();
          console.log("load old", relay, until);
          let count = 0;
          rxNostr.use(rxReq, { relays: [relay] }).subscribe({
            next: (a) => {
              addEvent(a.event, relay, false, false);
              count++;
            },
            complete: () => {
              const loadingOldEventsOld = loadingOldEvents;
              loadingOldEvents = false;
              const success = count > 0;
              if (loadingOldEventsOld) {
                loadingOldEventsOld.resolves.forEach((r) => r({ success }));
              }
              resolve({ success });
              return;
            },
            error: (e) => {
              const loadingOldEventsOld = loadingOldEvents;
              loadingOldEvents = false;
              if (loadingOldEventsOld) {
                loadingOldEventsOld.rejects.forEach((r) => r());
              }
              reject(e);
              return;
            },
          });
          followees.then((authors) => {
            if (onScreenEventLowerbound !== Number.MAX_SAFE_INTEGER) {
              rxReq.emit({
                kinds: [1],
                limit: 10_000,
                until: until,
                since: onScreenEventLowerbound,
                authors,
              });
            }
            if (until) {
              rxReq.emit({
                kinds: [1],
                limit: 1_000,
                until: until,
                since: until,
                authors,
              });
              rxReq.emit({
                kinds: [1],
                limit: 8,
                until: until - 1,
                authors,
              });
            } else {
              rxReq.emit({ kinds: [1], limit: 8, authors });
            }
            rxReq.over();
          });
        });
      },
    };
  };

  let ulElement: HTMLElement | null = null;
  let scrolling: undefined | number;

  onMount(() => {
    for (const relay in rxNostr.getDefaultRelays()) {
      const r = normalizeUrl(relay);
      state.relays.set(r, relayState(r));
    }
    subscribeReplacable(state, { kinds: [3, 10_002], authors: [npub] }, (a) => {
      if (a.event.kind === 3) {
        const followees = a.event.tags.flatMap((t) =>
          t.length >= 2 && t[0] === "p" ? [t[1]] : []
        );
        if (followees.length !== 0) {
          setFollowees(followees);
        }
      } else if (a.event.kind === 10002) {
        const rs = a.event.tags.flatMap((t) =>
          t.length >= 2 && t[0] === "r" && t[2] !== "write"
            ? [normalizeUrl(t[1])]
            : []
        );
        rs.forEach((relay) => {
          if (!state.relays.has(relay)) {
            state.relays.set(relay, relayState(relay));
            rxNostr.addDefaultRelays([relay]);
          }
        });
      }
    });
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
  // let onScreenEventUpperbound = 0;

  const load = () => {
    for (const [relay, relayState] of state.relays) {
      const loadRelay = () => {
        let bottom = 0;
        let oldest = undefined;
        for (const e of events) {
          if (e.relays.indexOf(relay) === -1) {
            continue;
          }
          if (e.event.created_at < onScreenEventLowerbound) {
            bottom++;
          }
          oldest = e.event.created_at;
        }
        if (bottom > 10) {
          console.log("remove event of", relay);
          removeEventsFromBottom(bottom - 10, relay);
        } else if (bottom <= 3) {
          relayState.loadOldevents(oldest).then(({ success }) => {
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
          onScreenEventLowerbound = events[ev].event.created_at;
        } else {
          // onScreenEventUpperbound = events[ev].event.created_at;
        }
      }
    }
    load();
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
          // if (!event.realTime && ulElement && ulElement.scrollTop === 0) {
          //   ulElement.scroll({ top: 1 });
          // }
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

type ParseTextResult = (["text", string] | ["emoji", string, string])[];

const parseText = (
  text: string,
  emojiMap: Map<string, string>
): ParseTextResult => {
  const sections = text.split(":");
  const result: ParseTextResult = [];
  let canBeEmoji = false;
  for (const section of sections) {
    if (canBeEmoji) {
      const url = emojiMap.get(section);
      if (url) {
        result.push(["emoji", section, url]);
        canBeEmoji = false;
      } else {
        result.push(["text", ":" + section]);
        canBeEmoji = true;
      }
    } else {
      result.push(["text", section]);
      canBeEmoji = true;
    }
  }
  return result;
};

const httpsProxy = (url: string) => {
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return "https://corsproxy.io/?url=" + encodeURIComponent(url);
  } else {
    return url;
  }
};

const imageUrl = (original: string | undefined) =>
  original ? httpsProxy(original) : "";

const parseNip05 = (nip05: string) => {
  const s = nip05.split("@");
  if (s.length < 2) {
    return null;
  }
  const name = s.slice(0, s.length - 1).join("@");
  const domain = s[s.length - 1];
  return { name, domain, text: name === "_" ? "@" + domain : nip05 };
};

const verifyNip05 = async (name: string, domain: string, pubkey: string) => {
  const res = await (
    await fetch(
      httpsProxy(`https://${domain}/.well-known/nostr.json?name=${name}`)
    )
  ).json();
  const nip05Pubkey = res.names?.[name];
  return nip05Pubkey === pubkey;
};

const Nip05 = (nip05: string | undefined, pubkey: string, state: AppState) => {
  if (!nip05) {
    return <span></span>;
  }
  const parsed = parseNip05(nip05);
  if (!parsed) {
    return <span></span>;
  }
  const { name, domain, text } = parsed;
  if (state.Nip05Verified.get(pubkey) === undefined) {
    const [verified, setVerified] = createSignal(false);
    state.Nip05Verified.set(pubkey, verified);
    verifyNip05(name, domain, pubkey)
      .then((res) => {
        setVerified(res);
      })
      .catch(() => {
        setVerified(false);
      });
  }
  return (
    <Show when={state.Nip05Verified.get(pubkey)} fallback={<span></span>}>
      <span>{text}</span>
    </Show>
  );
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
    p.nip05 = profileObj.nip05;
  } catch (_e) {
    p.name = event.pubkey;
  }
  return p;
};

function Note(
  event: EventSignal,
  observer: IntersectionObserver,
  state: AppState
) {
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
      <div style="overflow: hidden;">
        <div class="border-t py-2 text-sm font-mono whitespace-pre-wrap">
          <div>{[...event.relays].join(", ")}</div>
          <div class="flex w-full gap-1">
            <Show when={prof()} fallback={<div>loading ...</div>}>
              <img
                src={imageUrl(prof()!.picture)}
                class="size-10 shrink-0 overflow-hidden rounded"
              />
            </Show>
            <div>
              <Show when={prof()} fallback={<div>loading ...</div>}>
                <div>
                  <span class="font-bold">
                    <For each={parseText(prof()!.name, prof()!.emojiMap)}>
                      {(section) => {
                        if (section[0] === "text") {
                          return <span>{section[1]}</span>;
                        } else {
                          return (
                            <img
                              class="inline-block h-5"
                              src={imageUrl(section[2])}
                            />
                          );
                        }
                      }}
                    </For>
                  </span>
                  <span class="ml-3">
                    {Nip05(prof()?.nip05, event.event.pubkey, state)}
                  </span>
                </div>
              </Show>
              <div>{JSON.stringify(event.event)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default NostrEvents;
