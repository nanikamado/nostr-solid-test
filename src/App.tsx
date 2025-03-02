import "./App.css";
import NostrEvents from "./Events.tsx";

function App() {
  return (
    <div class="h-dvh px-10 mx-auto grid grid-cols-1 grid-rows-[3rem_1fr] p-10">
      <h2>Nost Events</h2>
      <NostrEvents />
    </div>
  );
}

export default App;
