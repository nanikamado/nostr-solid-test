import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { type Component } from "solid-js";
import EllipsisHorizontal from "heroicons/24/outline/ellipsis-horizontal.svg";

const EventMenuButton: Component<{
  jsonOn: () => boolean;
  setJsonOn: (show: boolean) => void;
}> = (props) => {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger>
        <div class="size-4 shrink-0 text-gray-100 hover:text-pink-500">
          <EllipsisHorizontal />
        </div>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="bg-gray-700 m-1 px-2 rounded-md shadow-lg">
          <DropdownMenu.CheckboxItem
            checked={props.jsonOn()}
            onChange={props.setJsonOn}
          >
            Show JSON
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
};

export default EventMenuButton;
