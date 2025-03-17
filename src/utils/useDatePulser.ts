// this file is copied from https://github.com/syusui-s/rabbit/blob/fec8bf6025e1abc8ab0a7948fd375d47a6056c05/src/hooks/useDatePulser.ts#L7
// License: AGPL-3.0 https://github.com/syusui-s/rabbit/blob/fec8bf6025e1abc8ab0a7948fd375d47a6056c05/LICENSE

import { createSignal, createEffect, onCleanup, type Accessor } from "solid-js";

type DatePulserProps = {
  interval: number;
};

const useDatePulser = (
  propsProvider: () => DatePulserProps
): Accessor<Date> => {
  const [currentDate, setCurrentDate] = createSignal(new Date());

  createEffect(() => {
    const id = setInterval(() => {
      setCurrentDate(new Date());
    }, propsProvider().interval);

    onCleanup(() => clearInterval(id));
  });

  return currentDate;
};

export default useDatePulser;
