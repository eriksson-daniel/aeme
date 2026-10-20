/** A slot the viewer can't pick because it's at the activity's max. Replaces
 * the slot's usual fill rather than layering on it: "can't pick this" is the
 * one thing worth reading at a glance, and who's in it is on hover. */
export const fullSlotClass =
  "cursor-not-allowed border-solid border-muted-foreground/40 bg-muted bg-full-stripes text-muted-foreground";

/** Overlay marking a day-mode slot (a whole cell) that has an actual
 * booking — a thick dotted green outline, layered on top of (not replacing)
 * the cell's own fill/border. */
export const bookedSlotOverlayClass =
  "pointer-events-none absolute inset-0 rounded-[inherit] border-[3px] border-dotted border-green-500";

/** Overlay for a single booking on an hourly grid, sized/positioned via
 * inline `top`/`height` (see `bookingOverlayPercent`) so it's proportional
 * to the booking's actual start/end minutes rather than snapping to whole
 * hour-cell boundaries — a 30-minute booking reads as visibly smaller than a
 * 2-hour one instead of both filling a full cell. */
export const bookingOverlayClass =
  "pointer-events-none absolute inset-x-0 rounded-sm border-[3px] border-dotted border-green-500";
