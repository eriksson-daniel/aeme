import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ActivitySlot } from "../../worker/db/schema.ts";
import { bookingOverlayPercent, bookingsForDay } from "../lib/booking-slots.ts";
import type { RespondingUser, Viewer } from "../lib/responders.ts";
import { cellPeople, guestCount, isSlotFull, responderLabel, slotKey } from "../lib/responders.ts";
import { bookedSlotOverlayClass, bookingOverlayClass, fullSlotClass } from "../lib/slot-color.ts";
import { useTapOrDrag } from "../lib/tap-or-drag.ts";
import type { ActivityWithAvailability } from "../queries/activities.ts";
import { BookingInfoPopover } from "./BookingInfoPopover.tsx";
import { HourAxis } from "./HourAxis.tsx";
import { MaxMemberCountNote } from "./MaxMemberCountNote.tsx";
import { PersonSegments } from "./PersonSegments.tsx";
import { Button } from "./ui/button.tsx";

const HOURS = Array.from({ length: 16 }, (_, i) => i + 8); // 08:00–23:00, each cell covers one hour
const WINDOW_DAYS = 7;
const DAY_COLUMN_MIN_PX = 72; // 4.5rem — must fit a nowrap date label without overlapping neighbors
const HOUR_CELL_PX = 24; // h-6

const toDateStr = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const addDays = (d: Date, n: number) => {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
};

const startOfDay = (d: Date) => {
  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  return next;
};

const formatHour = (h: number) => `${String(h).padStart(2, "0")}:00`;

const formatDayLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** Native tooltip naming who picked a cell — the full picture lives in the
 * breakdown below the grid, this is just the hover answer. */
const namesTitle = (responders: RespondingUser[]) =>
  responders.length > 0 ? responders.map(responderLabel).join(", ") : undefined;

type Props = {
  activityId: string;
  granularity: "day" | "hourly";
  /** Fixed set of candidate dates proposed by the creator; when set, the grid
   * only shows these dates instead of a scrollable rolling window. */
  suggestedDates: string[] | null;
  value: ActivitySlot[];
  onChange: (slots: ActivitySlot[]) => void;
  readOnly?: boolean;
  /** Everyone who picked each slot, keyed by `slotKey`, the viewer included. */
  responders?: Record<string, RespondingUser[]>;
  /** Whoever is looking: their own part of a cell is drawn from `value`
   * rather than `responders`, and they don't count against a full slot. */
  viewer?: Viewer;
  /** Whether each slot has an actual booking, keyed the same way. */
  bookedSlots?: Record<string, boolean>;
  bookings?: ActivityWithAvailability["bookings"];
  /** Advisory headcount, shown alongside a booking's attendee count. */
  idealMemberCount?: number | null;
  /** Cells that would go past this with the viewer added can't be picked. */
  maxMemberCount?: number | null;
  /** Whether the viewer is bringing a +1, who needs a seat too. */
  viewerPlusOne?: boolean;
  /** Called with the dates currently on screen, so the host can act on them
   * (e.g. select them all). Must be referentially stable. */
  onVisibleDatesChange?: (dates: string[]) => void;
};

export const AvailabilityGrid = ({
  activityId,
  granularity,
  suggestedDates,
  value,
  onChange,
  readOnly = false,
  responders = {},
  viewer,
  bookedSlots = {},
  bookings = [],
  idealMemberCount,
  maxMemberCount,
  viewerPlusOne = false,
  onVisibleDatesChange,
}: Props) => {
  const today = startOfDay(new Date());
  const viewerId = viewer?.userId;
  // The viewer's own stripe, labelled "+1" like everyone else's when they're
  // bringing someone.
  const viewerInCell = viewer && { ...viewer, plusOne: viewerPlusOne };

  const fixedDays =
    suggestedDates && suggestedDates.length > 0
      ? [...suggestedDates].sort().map((d) => new Date(`${d}T00:00:00`))
      : null;

  const [windowStart, setWindowStart] = useState(today);

  const days = fixedDays ?? Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(windowStart, i));

  const canGoPrev = !fixedDays && windowStart > today;
  const canGoNext = !fixedDays;

  const isDaySelected = (dateStr: string) => value.some((s) => s.date === dateStr);

  const toggleDay = (dateStr: string) => {
    if (isDaySelected(dateStr)) {
      onChange(value.filter((s) => s.date !== dateStr));
    } else {
      onChange([...value, { date: dateStr }]);
    }
  };

  const hourSetForDate = (dateStr: string) => {
    const set = new Set<number>();
    for (const slot of value) {
      if (slot.date !== dateStr || !slot.from || !slot.to) continue;
      const fromHour = Number(slot.from.slice(0, 2));
      const toHour = Number(slot.to.slice(0, 2));
      for (let h = fromHour; h < toHour; h++) set.add(h);
    }
    return set;
  };

  const setHour = (dateStr: string, hour: number, selected: boolean) => {
    const set = hourSetForDate(dateStr);
    if (selected) set.add(hour);
    else set.delete(hour);

    const sorted = [...set].sort((a, b) => a - b);
    const ranges: ActivitySlot[] = [];
    let rangeStart: number | null = null;
    let prev: number | null = null;

    for (const h of sorted) {
      if (rangeStart === null) rangeStart = h;
      else if (prev !== null && h !== prev + 1) {
        ranges.push({ date: dateStr, from: formatHour(rangeStart), to: formatHour(prev + 1) });
        rangeStart = h;
      }
      prev = h;
    }
    if (rangeStart !== null && prev !== null) {
      ranges.push({ date: dateStr, from: formatHour(rangeStart), to: formatHour(prev + 1) });
    }

    onChange([...value.filter((s) => s.date !== dateStr), ...ranges]);
  };

  // Which dates are on screen: every suggested date when the creator fixed a
  // set, otherwise the week currently in the window. Reported upward so the
  // page can offer an "all days" shortcut next to its other controls.
  const visibleKey = days.map(toDateStr).join("|");

  useEffect(() => {
    onVisibleDatesChange?.(visibleKey === "" ? [] : visibleKey.split("|"));
  }, [visibleKey, onVisibleDatesChange]);

  const dragValueRef = useRef<boolean | null>(null);
  const { beginsDrag, handlesClick } = useTapOrDrag();

  useEffect(() => {
    const clearDrag = () => (dragValueRef.current = null);
    window.addEventListener("pointerup", clearDrag);
    window.addEventListener("pointercancel", clearDrag);
    return () => {
      window.removeEventListener("pointerup", clearDrag);
      window.removeEventListener("pointercancel", clearDrag);
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {!fixedDays && (
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canGoPrev}
            onClick={() => setWindowStart((w) => addDays(w, -WINDOW_DAYS))}
          >
            Previous week
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canGoNext}
            onClick={() => setWindowStart((w) => addDays(w, WINDOW_DAYS))}
          >
            Next week
          </Button>
        </div>
      )}

      {maxMemberCount != null && (
        <MaxMemberCountNote maxMemberCount={maxMemberCount} granularity={granularity} />
      )}

      {granularity === "day" ? (
        <div className="flex flex-wrap gap-2">
          {days.map((d) => {
            const dateStr = toDateStr(d);
            const selected = isDaySelected(dateStr);
            const dayResponders = responders[slotKey(dateStr)] ?? [];
            const count = dayResponders.length;
            const guests = guestCount(dayResponders);
            const people = cellPeople(dayResponders, viewerInCell, selected);
            const booked = bookedSlots[dateStr] ?? false;
            const full =
              !selected && isSlotFull(dayResponders, viewerId, viewerPlusOne, maxMemberCount);
            return (
              <div key={dateStr} className="group relative hover:z-10">
                <button
                  type="button"
                  disabled={readOnly || full}
                  onClick={() => toggleDay(dateStr)}
                  title={namesTitle(dayResponders)}
                  className={cn(
                    "relative flex flex-col items-center rounded-md border border-input px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed",
                    full
                      ? fullSlotClass
                      : selected
                        ? "border-primary ring-1 ring-primary"
                        : "hover:bg-muted",
                    // Room under the label for the people strip.
                    people.length > 0 && !full && "pb-5",
                    readOnly && "disabled:opacity-60",
                  )}
                >
                  {formatDayLabel(d)}
                  {!full && (
                    <PersonSegments
                      people={people}
                      className="top-auto h-4 overflow-hidden rounded-b-[inherit]"
                    />
                  )}
                  {full && (
                    <span className="text-[10px] leading-none font-semibold tracking-wide uppercase">
                      Full
                    </span>
                  )}
                  {selected && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -right-1 bottom-6 origin-bottom-right -rotate-45 text-[10px] leading-none font-semibold text-primary"
                    >
                      æme!
                    </span>
                  )}
                  {booked && <div className={bookedSlotOverlayClass} />}
                </button>
                {(count >= 2 || guests > 0) && (
                  <span
                    title={namesTitle(dayResponders)}
                    className="absolute -top-1.5 -left-1.5 flex items-center gap-0.5"
                  >
                    <span className="flex size-4 items-center justify-center rounded-full bg-emerald-900 text-[9px] font-medium text-primary-foreground">
                      {count}
                    </span>
                    {guests > 0 && (
                      <span className="flex h-4 items-center justify-center rounded-full bg-emerald-700 px-1 text-[9px] font-medium text-primary-foreground">
                        +{guests}
                      </span>
                    )}
                  </span>
                )}
                {booked && (
                  <BookingInfoPopover
                    activityId={activityId}
                    bookings={bookingsForDay(bookings, dateStr)}
                    idealMemberCount={idealMemberCount}
                    from="activity"
                    className="absolute -bottom-2 -left-2"
                  />
                )}
                <Link
                  to="/activities/$activityId/book"
                  params={{ activityId }}
                  search={{ date: dateStr, from: "activity" }}
                  aria-label={`Add booking for ${formatDayLabel(d)}`}
                  className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-background text-muted-foreground opacity-0 shadow transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <PlusIcon className="size-4" />
                </Link>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          className="-m-3 grid select-none overflow-x-auto p-3"
          style={{
            gridTemplateColumns: `auto repeat(${days.length}, minmax(${DAY_COLUMN_MIN_PX}px, 1fr))`,
          }}
        >
          <div />
          {days.map((d) => {
            const dateStr = toDateStr(d);
            return (
              <Link
                key={dateStr}
                to="/activities/$activityId/book"
                params={{ activityId }}
                search={{ date: dateStr, from: "activity" }}
                aria-label={`Add booking for ${formatDayLabel(d)}`}
                className="group relative grid w-full place-items-center px-1 pb-1 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="col-start-1 row-start-1 whitespace-nowrap transition-opacity group-hover:opacity-0">
                  {formatDayLabel(d)}
                </span>
                <span className="col-start-1 row-start-1 flex items-center gap-1 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100">
                  <PlusIcon className="size-4" />
                  Book
                </span>
              </Link>
            );
          })}

          <HourAxis hours={HOURS} cellPx={HOUR_CELL_PX} />

          {days.map((d) => {
            const dateStr = toDateStr(d);
            return (
              <div
                key={dateStr}
                className="relative flex flex-col"
                style={{ height: HOURS.length * HOUR_CELL_PX }}
              >
                {HOURS.map((hour) => {
                  const selected = hourSetForDate(dateStr).has(hour);
                  const hourResponders = responders[slotKey(dateStr, hour)] ?? [];
                  const people = cellPeople(hourResponders, viewerInCell, selected);
                  const full =
                    !selected &&
                    isSlotFull(hourResponders, viewerId, viewerPlusOne, maxMemberCount);
                  return (
                    <div
                      key={hour}
                      title={namesTitle(hourResponders)}
                      onPointerDown={(e) => {
                        if (readOnly || full || !beginsDrag(e)) return;
                        const next = !selected;
                        dragValueRef.current = next;
                        setHour(dateStr, hour, next);
                      }}
                      onPointerEnter={() => {
                        if (readOnly || dragValueRef.current === null) return;
                        // A drag that's adding hours skips the full ones
                        // rather than stopping at them.
                        if (full && dragValueRef.current) return;
                        setHour(dateStr, hour, dragValueRef.current);
                      }}
                      onClick={(e) => {
                        if (readOnly || full || !handlesClick(e)) return;
                        setHour(dateStr, hour, !selected);
                      }}
                      className={cn(
                        "relative flex h-6 items-center justify-center border border-border/50",
                        full
                          ? fullSlotClass
                          : cn(
                              readOnly ? "cursor-not-allowed" : "cursor-pointer",
                              !readOnly &&
                                (people.length > 0 ? "hover:brightness-110" : "hover:bg-muted"),
                            ),
                      )}
                    >
                      {full ? (
                        <span className="text-[9px] font-semibold tracking-wide uppercase">
                          Full
                        </span>
                      ) : (
                        <PersonSegments people={people} />
                      )}
                    </div>
                  );
                })}

                {bookingsForDay(bookings, dateStr).map((booking) => (
                  <div
                    key={booking.id}
                    className={bookingOverlayClass}
                    style={bookingOverlayPercent(booking, HOURS)}
                  >
                    <BookingInfoPopover
                      activityId={activityId}
                      bookings={[booking]}
                      idealMemberCount={idealMemberCount}
                      from="activity"
                      className="absolute -top-2 -left-2"
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
