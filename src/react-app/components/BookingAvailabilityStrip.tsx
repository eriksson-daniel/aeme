import { cn } from "cn";
import { useEffect, useRef } from "react";

import { type ActivityResponse, respondersBySlot, slotKey } from "../lib/responders.ts";
import { useTapOrDrag } from "../lib/tap-or-drag.ts";
import type { ActivityWithAvailability } from "../queries/activities.ts";
import { PersonSegments } from "./PersonSegments.tsx";

// Same window the availability grids offer, so the strip can't show hours
// nobody was ever able to pick.
const HOURS = Array.from({ length: 16 }, (_, i) => i + 8); // 08:00–23:00

const formatHour = (h: number) => `${String(h).padStart(2, "0")}:00`;

const timeToMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Hours a `from`–`to` window touches at all, so a 16:00–18:02 booking marks
 * three cells rather than silently dropping the last two minutes. */
const hoursInWindow = (from: string, to: string) => {
  if (from === "" || to === "" || from >= to) return new Set<number>();

  const startHour = Math.floor(timeToMinutes(from) / 60);
  const endHour = Math.ceil(timeToMinutes(to) / 60);
  return new Set(Array.from({ length: endHour - startHour }, (_, i) => startHour + i));
};

/** Sits on the line where its hour starts (the cell's left edge), not centered
 * under the cell — hence the extra tick after the last cell. */
const HourTick = ({ hour }: { hour: number }) => (
  <span className="self-start -translate-x-1/2 text-[9px] text-muted-foreground">
    {String(hour).padStart(2, "0")}
  </span>
);

type Props = {
  responses: ActivityResponse[];
  bookings: ActivityWithAvailability["bookings"];
  /** YYYY-MM-DD the strip describes. */
  date: string;
  from: string;
  to: string;
  onSelectRange: (from: string, to: string) => void;
};

/** Hour-by-hour availability for one date: how many people offered each hour,
 * who they are, and which hours are already booked — the view you need to
 * *choose* a time, as opposed to checking one you've already chosen. Drag
 * across it to set the booking's start and end.
 *
 * Only worth showing for an hourly activity; a whole-day one has nothing to
 * say per hour. */
export const BookingAvailabilityStrip = ({
  responses,
  bookings,
  date,
  from,
  to,
  onSelectRange,
}: Props) => {
  // A ref, not state: the anchor never affects rendering, and a pointerenter
  // firing before the next render would read a stale value from state.
  const anchorHourRef = useRef<number | null>(null);
  const { beginsDrag, handlesClick } = useTapOrDrag();

  useEffect(() => {
    const clearDrag = () => (anchorHourRef.current = null);
    window.addEventListener("pointerup", clearDrag);
    window.addEventListener("pointercancel", clearDrag);
    return () => {
      window.removeEventListener("pointerup", clearDrag);
      window.removeEventListener("pointercancel", clearDrag);
    };
  }, []);

  // Everyone, including the viewer: when picking a time you care about the
  // whole group, not just the other people.
  const responders = respondersBySlot(responses);
  const selectedHours = hoursInWindow(from, to);

  const bookedHours = new Set<number>();
  const bookingsByHour = new Map<number, string[]>();
  for (const booking of bookings) {
    if (booking.date !== date) continue;
    for (const hour of hoursInWindow(booking.from, booking.to)) {
      bookedHours.add(hour);
      const labels = bookingsByHour.get(hour) ?? [];
      labels.push(`${booking.from}–${booking.to}`);
      bookingsByHour.set(hour, labels);
    }
  }

  const selectTo = (hour: number) => {
    const anchor = anchorHourRef.current ?? hour;
    onSelectRange(formatHour(Math.min(anchor, hour)), formatHour(Math.max(anchor, hour) + 1));
  };

  const peak = Math.max(0, ...HOURS.map((hour) => (responders[slotKey(date, hour)] ?? []).length));

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        {peak === 0
          ? "No one has picked an hour on this day."
          : `Drag to pick a time — the best hours have ${peak} available.`}
      </p>

      <div className="-mx-2 overflow-x-auto px-2 pb-1">
        <div className="flex min-w-max select-none">
          {HOURS.map((hour) => {
            const hourResponders = responders[slotKey(date, hour)] ?? [];
            const count = hourResponders.length;
            const booked = bookedHours.has(hour);
            const names = hourResponders.map((responder) => responder.name).join(", ");
            const bookedLabel = bookingsByHour.get(hour)?.join(", ");

            return (
              <div key={hour} className="flex w-9 shrink-0 flex-col items-center gap-0.5">
                <div className="relative w-full">
                  <button
                    type="button"
                    title={
                      [
                        count > 0 ? `Free ${formatHour(hour)}: ${names}` : undefined,
                        bookedLabel && `Already booked: ${bookedLabel}`,
                      ]
                        .filter(Boolean)
                        .join("\n") || undefined
                    }
                    onPointerDown={(e) => {
                      if (!beginsDrag(e)) return;
                      anchorHourRef.current = hour;
                      onSelectRange(formatHour(hour), formatHour(hour + 1));
                    }}
                    onPointerEnter={() => {
                      if (anchorHourRef.current === null) return;
                      selectTo(hour);
                    }}
                    onClick={(e) => {
                      if (!handlesClick(e)) return;
                      onSelectRange(formatHour(hour), formatHour(hour + 1));
                    }}
                    className={cn(
                      "relative flex h-10 w-full cursor-pointer items-center justify-center border transition-colors",
                      count > 0
                        ? "border-transparent hover:brightness-110"
                        : "border-dashed border-muted-foreground/30 hover:bg-muted",
                    )}
                  >
                    <PersonSegments people={hourResponders} />
                    {/* Drawn over the stripes: an inset ring on the button
                        itself would sit underneath them. */}
                    {selectedHours.has(hour) && (
                      <span className="pointer-events-none absolute inset-0 ring-2 ring-primary ring-inset" />
                    )}
                  </button>
                  {booked && (
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-green-500" />
                  )}
                </div>
                <HourTick hour={hour} />
              </div>
            );
          })}
          {/* Zero-width: just carries the label for where the last hour ends. */}
          <div className="flex w-0 shrink-0 flex-col items-center gap-0.5">
            <div className="h-10" />
            <HourTick hour={HOURS[HOURS.length - 1] + 1} />
          </div>
        </div>
      </div>
    </div>
  );
};
