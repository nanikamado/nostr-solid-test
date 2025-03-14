import * as RxNostr from "rx-nostr";
import "./App.css";
import NostrEvents from "./Events.tsx";
import { Route, useParams, HashRouter } from "@solidjs/router";

function Home() {
  const params = useParams();
  try {
    const id = RxNostr.toHex(params.npub);
    return (
      <div class="h-dvh px-10 mx-auto grid grid-cols-1 grid-rows-[3rem_1fr] p-10">
        <h2>Nost Events</h2>
        <NostrEvents npub={id} />
      </div>
    );
  } catch (_e) {
    return (
      <div class="h-dvh px-10 mx-auto grid grid-cols-1 grid-rows-[3rem_1fr] p-10">
        <h2>Invalid npub: {params.npub}</h2>
      </div>
    );
  }
}

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
      <Route path="/home/:npub" component={Home} />
      <Route path="*" component={Usage} />
    </HashRouter>
  );
}

export default App;
