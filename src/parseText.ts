export type TextSegment =
  | ["text", string]
  | ["emoji", string, string]
  | ["image", string];

export type ParseTextResult = TextSegment[];

export const parseText = (
  text: string,
  emojiMap: Map<string, string>,
  images: Set<string>
): ParseTextResult => {
  const result: ParseTextResult = [];
  let simpleTextStart = 0;
  let specialTextStart = 0;
  const pushSpecialText = (segment: TextSegment, length: number) => {
    if (simpleTextStart < specialTextStart) {
      result.push(["text", text.slice(simpleTextStart, specialTextStart)]);
    }
    result.push(segment);
    specialTextStart += length;
    simpleTextStart = specialTextStart;
  };

  while (specialTextStart < text.length) {
    let matched = false;

    if (text.startsWith(":", specialTextStart)) {
      for (const [key, value] of emojiMap) {
        if (text.startsWith(key + ":", specialTextStart + 1)) {
          pushSpecialText(["emoji", key, value], key.length + 2); // +2 for the colons
          matched = true;
          break;
        }
      }
    } else {
      for (const image of images) {
        if (text.startsWith(image, specialTextStart)) {
          pushSpecialText(["image", image], image.length);
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      specialTextStart++;
    }
  }

  if (simpleTextStart < specialTextStart) {
    result.push(["text", text.slice(simpleTextStart, specialTextStart)]);
  }

  return result;
};
