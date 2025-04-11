import { JSX } from "solid-js";

type Props = {
  isOn: () => boolean;
  setIsOn: (v: boolean) => void;
  children: JSX.Element;
};

export function ToggleButton({
  isOn: isOn,
  setIsOn: setIsOn,
  children,
}: Props) {
  return (
    <button type="button" onClick={() => setIsOn(!isOn())}>
      <div
        class={`${
          isOn() ? "text-pink-500" : "text-gray-100"
        } hover:text-pink-300`}
      >
        {children}
      </div>
    </button>
  );
}

export default ToggleButton;
