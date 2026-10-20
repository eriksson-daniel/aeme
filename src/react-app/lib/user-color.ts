/** Black or white, whichever reads better on `hex` — users can pick any
 * color, including ones too light for white text. Uses relative luminance
 * (WCAG), with the crossover where both have equal contrast. */
export const textColorOn = (hex: string) => {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.179 ? "#000000" : "#ffffff";
};

/** The letter shown in someone's part of a cell. */
export const initialOf = (name: string) => name.trim().charAt(0).toUpperCase();
