import * as RxNostr from "rx-nostr";
import "./App.css";
import { NostrEvents, TlType } from "./Events.tsx";
import { Route, useParams, HashRouter } from "@solidjs/router";
import { createMemo, Show } from "solid-js";

const Home = (tlType: TlType) => () => {
  const params = useParams();
  const npub = createMemo(() => {
    try {
      return RxNostr.toHex(params.npub);
    } catch (_e) {
      return null;
    }
  });
  return (
    <div class="h-dvh mx-auto px-3 grid grid-cols-1 grid-rows-[3rem_1fr] max-w-xl">
      <Show when={npub()} fallback={<h2>Invalid npub: {params.npub}</h2>}>
        <h2 class="mt-3">Nost Events</h2>
        <NostrEvents npub={() => npub()!} tlType={tlType} />
      </Show>
    </div>
  );
};

function Usage() {
  return (
    <div class="h-dvh px-10 mx-auto grid grid-cols-1 grid-rows-[3rem_1fr] p-10">
      <h2>Usage</h2>
      <p>/#/home/:npub</p>
    </div>
  );
}

function App() {
  return (
    <HashRouter>
      <Route path="/home/:npub" component={Home("home")} />
      <Route
        path="/:npub"
        component={Home("user")}
        matchFilters={{
          npub: /^npub1/,
        }}
      />
      <Route path="*" component={Usage} />
    </HashRouter>
  );
}

export default App;
