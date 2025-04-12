import { JSX } from "solid-js";

export function ToggleButton(props: {
  isOn: () => boolean;
  setIsOn: (v: boolean) => void;
  children: JSX.Element;
  offTextColor?: string;
}) {
  return (
    <button type="button" onClick={() => props.setIsOn(!props.isOn())}>
      <div
        class={`${
          props.isOn() ? "text-pink-500" : props.offTextColor || "text-gray-100"
        } hover:text-pink-300`}
      >
        {props.children}
      </div>
    </button>
  );
}

export default ToggleButton;
