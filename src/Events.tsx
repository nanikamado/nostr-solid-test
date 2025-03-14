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
  LazyFilter,
} from "rx-nostr";
// import * as Rxn from "rx-nostr";
import { verifier } from "rx-nostr-crypto";
import * as Rx from "rxjs";
import { createStore, SetStoreFunction } from "solid-js/store";

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
  loadOldevents: (until: number | undefined) => Promise<{ success: boolean }>;
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

const subscribeReplacable = (
  rxNostr: RxNostr,
  filter: LazyFilter,
  callback: (e: EventPacket) => void
) => {
  const rxReq = createRxForwardReq();
  let latestCreatedAt = 0;
  let latestId = "x";
  rxNostr.use(rxReq).subscribe((a) => {
    if (
      a.event.created_at < latestCreatedAt ||
      (a.event.created_at === latestCreatedAt && a.event.id >= latestId)
    ) {
      return;
    }
    latestCreatedAt = a.event.created_at;
    latestId = a.event.id;
    callback(a);
  });
  rxReq.emit(filter);
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
};

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
  const relays = new Map<string, RelayState>();
  const relayState = (relay: string) => {
    let connection: false | Rx.Subscription = false;
    type LoadingOldEventsStatus = {
      until: number | undefined;
      resolves: ((a: { success: boolean }) => void)[];
      rejects: (() => void)[];
    };
    let loadingOldEvents: false | LoadingOldEventsStatus = false;
    return {
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
          rxReq.emit({ kinds: [7, 1], limit: 11, authors });
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
          rxNostr.use(rxReq, { relays: [relay] }).subscribe({
            next: (a) => {
              addEvent(a.event, relay, false, false);
            },
            complete: () => {
              const loadingOldEventsOld = loadingOldEvents;
              loadingOldEvents = false;
              if (loadingOldEventsOld) {
                loadingOldEventsOld.resolves.forEach((r) =>
                  r({ success: true })
                );
              }
              resolve({ success: true });
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
                kinds: [7, 1],
                limit: 10_000,
                until: until,
                since: onScreenEventLowerbound,
                authors,
              });
            }
            if (until) {
              rxReq.emit({
                kinds: [7, 1],
                limit: 1_000,
                until: until,
                since: until,
                authors,
              });
              rxReq.emit({
                kinds: [7, 1],
                limit: 8,
                until: until - 1,
                authors,
              });
            } else {
              rxReq.emit({ kinds: [7, 1], limit: 8, authors });
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
    subscribeReplacable(
      rxNostr,
      { kinds: [3], limit: 1, authors: [npub] },
      (a) => {
        const followees = a.event.tags.flatMap((t) =>
          t.length >= 2 && t[0] === "p" ? [t[1]] : []
        );
        if (followees.length !== 0) {
          setFollowees(followees);
        }
      }
    );
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
  // let onScreenEventUpperbound = 0;

  const load = () => {
    for (const [relay, state] of relays) {
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
          removeEventsFromBottom(bottom - 10, relay);
        } else if (bottom <= 3) {
          state.loadOldevents(oldest).then(({ success }) => {
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

  const state = {
    rxNostr,
    profileMap: new Map<string, ProfileMapValue>(),
  };

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

const imageUrl = (original: string | undefined) =>
  original ? "https://corsproxy.io/?url=" + encodeURIComponent(original) : "";
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
      state.rxNostr,
      { kinds: [0], limit: 1, authors: [event.event.pubkey] },
      (a: EventPacket) => {
        const emojiMap = new Map<string, string>();
        a.event.tags.forEach((t) => {
          if (t.length >= 3 && t[0] === "emoji") {
            emojiMap.set(t[1], t[2]);
          }
        });
        const p: UserProfile = {
          pubkey: a.event.pubkey,
          name: "",
          created_at: a.event.created_at,
          emojiMap,
        };
        try {
          const profileObj = JSON.parse(a.event.content);
          p.name = profileObj.display_name || profileObj.name || "";
          p.picture = profileObj.picture;
        } catch (_e) {
          p.name = a.event.pubkey;
        }
        set(["profile", p]);
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
                <div class="font-bold">
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
