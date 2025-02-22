import "./Events.css";
import { createSignal, onCleanup, onMount, For } from "solid-js";
import { TransitionGroup } from "solid-transition-group";
import { z } from "zod";

const nostrEventSchema = z.object({
  id: z.string(),
  kind: z.number(),
  pubkey: z.string(),
  created_at: z.number(),
  content: z.string(),
  sig: z.string(),
});
const relayMessageOkSchema = z.tuple([
  z.literal("EVENT"),
  z.string(),
  nostrEventSchema,
]);
const relayMessageEoseSchema = z.tuple([z.literal("EOSE"), z.string()]);
const relayMessageSchema = z.union([
  relayMessageEoseSchema,
  relayMessageOkSchema,
]);
type NostrEvent = z.infer<typeof nostrEventSchema>;

function NostrEvents() {
  const [events, setEvents] = createSignal<NostrEvent[]>([]);

  const webSeckets: WebSocket[] = [];

  onMount(() => {
    for (const url of [
      "wss://relay.damus.io",
      // "wss://relay.nostr.band",
      "wss://nos.lol",
      "wss://yabu.me",
    ]) {
      const socket = new WebSocket(url);
      webSeckets.push(socket);

      socket.onopen = () => {
        console.log("Connected to relay", url);
        socket!.send(JSON.stringify(["REQ", "test", { limit: 3, kinds: [7] }]));
      };

      socket.onmessage = (event: MessageEvent) => {
        try {
          const data = relayMessageSchema.safeParse(JSON.parse(event.data));
          if (data.success && data.data[0] === "EVENT") {
            const event = data.data[2];
            setEvents((prev) => {
              if (prev.find((e) => e.id == event.id)) {
                return prev;
              } else {
                return [...prev, event]
                  .sort((a, b) =>
                    [a.created_at, a.id] > [b.created_at, b.id] ? -1 : 1
                  )
                  .slice(0, 10);
              }
            }); // Keep only last 50 events
          }
        } catch (error) {
          console.error("Error parsing message", error);
        }
      };

      socket.onerror = (error) => {
        console.error("WebSocket error:", error);
      };

      socket.onclose = () => {
        console.log("WebSocket closed");
      };
    }
  });

  onCleanup(() => {
    webSeckets.forEach((ws) => ws.close());
  });

  return (
    <div>
      <h2 class="text-xl font-bold">Nostr Events</h2>
      <ul class="mt-4">
        <TransitionGroup>
          <For each={events()} fallback={<div>loading ...</div>}>
            {(event, _) => (
              <div
                class="border-b py-2 text-sm font-mono whitespace-pre-wrap grid"
                style="overflow-wrap: anywhere;"
              >
                <div style="overflow: hidden;">{JSON.stringify(event)}</div>
              </div>
            )}
          </For>
        </TransitionGroup>
      </ul>
    </div>
  );
}

export default NostrEvents;
