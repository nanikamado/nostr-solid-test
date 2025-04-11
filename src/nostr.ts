import * as NostrType from "nostr-typedef";

export type ParsedNip05 = {
  name: string;
  domain: string;
  text: string;
};

export const parseNip05 = (nip05: string): ParsedNip05 | null => {
  const s = nip05.split("@");
  if (s.length < 2) {
    return null;
  }
  const name = s.slice(0, s.length - 1).join("@");
  const domain = s[s.length - 1];
  return { name: name, domain, text: name === "_" ? "@" + domain : nip05 };
};

export type BridgedAccountProfile = {
  id?: string;
  bridgeSerever?: string;
  bridgedFrom: string;
};

export const getBridgeInfo = (
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

export type UserProfile = {
  pubkey: string;
  name: string;
  picture?: string;
  created_at: number;
  emojiMap: Map<string, string>;
  nip05?: ParsedNip05;
  bridged?: BridgedAccountProfile;
};

export const makeProfileFromEvent = (event: NostrType.Event): UserProfile => {
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

const eqSet = <T>(xs: Set<T>, ys: Set<T>) =>
  xs.size === ys.size && [...xs].every((x) => ys.has(x));

export const mergeFilters = (
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
