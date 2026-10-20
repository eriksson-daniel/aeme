import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRightIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ActivitySlot } from "../../worker/db/schema.ts";
import { bookingOverlayPercent, bookingsForDay } from "../lib/booking-slots.ts";
import {
  cellPeople,
  guestCount,
  isSlotFull,
  type RespondingUser,
  responderLabel,
  respondersBySlot,
  slotKey,
} from "../lib/responders.ts";
import { bookedSlotOverlayClass, bookingOverlayClass, fullSlotClass } from "../lib/slot-color.ts";
import { useTapOrDrag } from "../lib/tap-or-drag.ts";
import type { ActivityWithAvailability } from "../queries/activities.ts";
import { useUpsertAvailabilityMutation } from "../queries/availability.ts";
import { useViewer } from "../queries/session.ts";
import { BookingInfoPopover } from "./BookingInfoPopover.tsx";
import { EditActivityDialog } from "./EditActivityDialog.tsx";
import { HourAxis } from "./HourAxis.tsx";
import { MaxMemberCountNote } from "./MaxMemberCountNote.tsx";
import { PersonSegments } from "./PersonSegments.tsx";
import { Button } from "./ui/button.tsx";
import { UpcomingBookings } from "./UpcomingBookings.tsx";

const HOURS = Array.from({ length: 16 }, (_, i) => i + 8); // 08:00–23:00, each cell covers one hour
const MIN_VISIBLE_DAYS = 7;
const LABEL_COLUMN_PX = 64; // 4rem
const DAY_COLUMN_MIN_PX = 72; // 4.5rem — must fit a nowrap date label without overlapping neighbors
const DAY_COLUMN_MAX_PX = 80; // 5rem
const CARD_INSET_PX = 34; // card padding + border, subtracted when fitting day columns
const HOUR_CELL_PX = 24; // h-6
const SAVE_DEBOUNCE_MS = 600;

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

/** Native tooltip naming who picked a cell — the full breakdown lives on the
 * activity's own page, this is just the hover answer. */
const namesTitle = (responders: RespondingUser[]) =>
  responders.length > 0 ? responders.map(responderLabel).join(", ") : undefined;

const hourSetForDate = (slots: ActivitySlot[], dateStr: string) => {
  const set = new Set<number>();
  for (const slot of slots) {
    if (slot.date !== dateStr || !slot.from || !slot.to) continue;
    const fromHour = Number(slot.from.slice(0, 2));
    const toHour = Number(slot.to.slice(0, 2));
    for (let h = fromHour; h < toHour; h++) set.add(h);
  }
  return set;
};

const collapseHours = (dateStr: string, hours: Set<number>): ActivitySlot[] => {
  const sorted = [...hours].sort((a, b) => a - b);
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
  return ranges;
};

type CardProps = {
  activity: ActivityWithAvailability;
  days: Date[];
};

const ActivityPickerCard = ({ activity, days }: CardProps) => {
  const [slots, setSlots] = useState<ActivitySlot[]>(activity.slots);
  const upsertAvailability = useUpsertAvailabilityMutation();
  const viewer = useViewer();
  const viewerId = viewer?.userId;
  const isOwner = viewerId === activity.createdBy;
  const responders = respondersBySlot(activity.responses);

  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!dirtyRef.current) setSlots(activity.slots);
  }, [activity.slots]);

  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const scheduleSave = (next: ActivitySlot[]) => {
    setSlots(next);
    dirtyRef.current = true;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      upsertAvailability.mutate(
        // Persistent activities support neither declining nor a +1 — those
        // are one-off concepts.
        { activityId: activity.id, slots: next, declined: false, plusOne: false },
        { onSettled: () => (dirtyRef.current = false) },
      );
    }, SAVE_DEBOUNCE_MS);
  };

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

  const isDaySelected = (dateStr: string) => slots.some((s) => s.date === dateStr);

  const toggleDay = (dateStr: string) => {
    if (isDaySelected(dateStr)) scheduleSave(slots.filter((s) => s.date !== dateStr));
    else scheduleSave([...slots, { date: dateStr }]);
  };

  const setHour = (dateStr: string, hour: number, selected: boolean) => {
    const set = hourSetForDate(slots, dateStr);
    if (selected) set.add(hour);
    else set.delete(hour);
    scheduleSave([...slots.filter((s) => s.date !== dateStr), ...collapseHours(dateStr, set)]);
  };

  const status = upsertAvailability.isPending
    ? "Saving…"
    : upsertAvailability.isError
      ? "Failed to save"
      : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Link
              to="/activities/$activityId"
              params={{ activityId: activity.id }}
              aria-label={`Open ${activity.title}`}
              className="group/title flex min-w-0 items-center gap-0.5 font-semibold underline-offset-4 hover:underline"
            >
              <span className="truncate">{activity.title}</span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/title:translate-x-0.5 group-hover/title:text-foreground" />
            </Link>
            {isOwner && (
              <EditActivityDialog
                activity={activity}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Edit activity"
                    className="size-5 text-muted-foreground"
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                }
              />
            )}
            {status && <span className="text-xs text-muted-foreground">{status}</span>}
          </div>
          {activity.description && (
            <p className="text-sm text-muted-foreground">{activity.description}</p>
          )}
          {activity.maxMemberCount !== null && (
            <MaxMemberCountNote
              maxMemberCount={activity.maxMemberCount}
              granularity={activity.slotGranularity}
            />
          )}
        </div>
        <UpcomingBookings
          activityId={activity.id}
          bookings={activity.bookings}
          idealMemberCount={activity.idealMemberCount}
        />
      </div>

      <div
        className="-m-3 grid w-full select-none overflow-x-auto p-3"
        style={{
          gridTemplateColumns: `${LABEL_COLUMN_PX}px repeat(${days.length}, minmax(${DAY_COLUMN_MIN_PX}px, ${DAY_COLUMN_MAX_PX}px))`,
        }}
      >
        <div />
        {days.map((d) => {
          const dateStr = toDateStr(d);
          return (
            <Link
              key={dateStr}
              to="/activities/$activityId/book"
              params={{ activityId: activity.id }}
              search={{ date: dateStr, from: "home" }}
              aria-label={`Add booking for ${formatDayLabel(d)}`}
              className="group relative grid w-full place-items-center px-1 pb-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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

        {activity.slotGranularity === "day" ? (
          <>
            <div />
            {days.map((d) => {
              const dateStr = toDateStr(d);
              const selected = isDaySelected(dateStr);
              const dayResponders = responders[slotKey(dateStr)] ?? [];
              const count = dayResponders.length;
              const guests = guestCount(dayResponders);
              const people = cellPeople(dayResponders, viewer, selected);
              const booked = activity.bookedSlots[dateStr] ?? false;
              // Ongoing activities have no +1s, so the viewer is one seat.
              const full =
                !selected && isSlotFull(dayResponders, viewerId, false, activity.maxMemberCount);
              return (
                <div key={dateStr} className="group relative rounded-sm">
                  <button
                    type="button"
                    disabled={full}
                    onClick={() => toggleDay(dateStr)}
                    title={namesTitle(dayResponders)}
                    className={cn(
                      "relative flex h-8 w-full items-center justify-center overflow-hidden rounded-sm border transition-colors",
                      full
                        ? fullSlotClass
                        : people.length > 0
                          ? "border-transparent hover:brightness-110"
                          : "border-dashed border-muted-foreground/30 hover:border-primary/60 hover:bg-muted",
                    )}
                  >
                    {full ? (
                      <span className="text-[10px] font-semibold tracking-wide uppercase">
                        Full
                      </span>
                    ) : people.length > 0 ? (
                      <PersonSegments people={people} />
                    ) : (
                      <span className="text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        æme!
                      </span>
                    )}
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
                  {booked && <div className={bookedSlotOverlayClass} />}
                  {booked && (
                    <BookingInfoPopover
                      activityId={activity.id}
                      bookings={bookingsForDay(activity.bookings, dateStr)}
                      idealMemberCount={activity.idealMemberCount}
                      from="home"
                      className="absolute -bottom-2 -left-2"
                    />
                  )}
                </div>
              );
            })}
          </>
        ) : (
          <div
            className="col-span-full grid"
            style={{
              gridTemplateColumns: `${LABEL_COLUMN_PX}px repeat(${days.length}, minmax(${DAY_COLUMN_MIN_PX}px, ${DAY_COLUMN_MAX_PX}px))`,
            }}
          >
            <HourAxis hours={HOURS} cellPx={HOUR_CELL_PX} />

            {days.map((d) => {
              const dateStr = toDateStr(d);
              const selectedHours = hourSetForDate(slots, dateStr);
              return (
                <div
                  key={dateStr}
                  className="relative flex flex-col"
                  style={{ height: HOURS.length * HOUR_CELL_PX }}
                >
                  {HOURS.map((hour) => {
                    const selected = selectedHours.has(hour);
                    const hourResponders = responders[slotKey(dateStr, hour)] ?? [];
                    const people = cellPeople(hourResponders, viewer, selected);
                    const full =
                      !selected &&
                      isSlotFull(hourResponders, viewerId, false, activity.maxMemberCount);
                    return (
                      <div
                        key={hour}
                        title={namesTitle(hourResponders)}
                        onPointerDown={(e) => {
                          if (full || !beginsDrag(e)) return;
                          const next = !selected;
                          dragValueRef.current = next;
                          setHour(dateStr, hour, next);
                        }}
                        onPointerEnter={() => {
                          if (dragValueRef.current === null) return;
                          // A drag that's adding hours skips the full ones
                          // rather than stopping at them.
                          if (full && dragValueRef.current) return;
                          setHour(dateStr, hour, dragValueRef.current);
                        }}
                        onClick={(e) => {
                          if (full || !handlesClick(e)) return;
                          setHour(dateStr, hour, !selected);
                        }}
                        className={cn(
                          "group relative flex h-6 items-center justify-center border transition-colors",
                          full
                            ? fullSlotClass
                            : cn(
                                "cursor-pointer",
                                // A transparent border rather than none, so a
                                // run of filled hours keeps a gap between
                                // them and you can still count the hours.
                                people.length > 0
                                  ? "border-transparent hover:brightness-110"
                                  : "border-dashed border-muted-foreground/30 hover:border-primary/60 hover:bg-muted",
                              ),
                        )}
                      >
                        {full ? (
                          <span className="text-[9px] font-semibold tracking-wide uppercase">
                            Full
                          </span>
                        ) : people.length > 0 ? (
                          <PersonSegments people={people} />
                        ) : (
                          <span className="text-[9px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                            æme!
                          </span>
                        )}
                      </div>
                    );
                  })}

                  {bookingsForDay(activity.bookings, dateStr).map((booking) => (
                    <div
                      key={booking.id}
                      className={bookingOverlayClass}
                      style={bookingOverlayPercent(booking, HOURS)}
                    >
                      <BookingInfoPopover
                        activityId={activity.id}
                        bookings={[booking]}
                        idealMemberCount={activity.idealMemberCount}
                        from="home"
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
    </div>
  );
};

type Props = {
  activities: ActivityWithAvailability[];
};

export const OngoingBoard = ({ activities }: Props) => {
  const today = startOfDay(new Date());
  const [windowStart, setWindowStart] = useState(today);
  const [visibleDays, setVisibleDays] = useState(MIN_VISIBLE_DAYS);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const recompute = () => {
      const fit = Math.floor(
        (el.clientWidth - CARD_INSET_PX - LABEL_COLUMN_PX) / DAY_COLUMN_MAX_PX,
      );
      setVisibleDays(Math.max(MIN_VISIBLE_DAYS, fit));
    };

    // Don't call recompute() synchronously here: right after mount (especially
    // in production, where CSS loads via a separate <link> rather than being
    // injected synchronously like Vite's dev server does) `el.clientWidth` can
    // still reflect a pre-layout/pre-stylesheet size. ResizeObserver's first
    // callback after `observe()` is guaranteed to report the settled
    // post-layout size, so rely on that alone for the initial measurement too.
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const days = Array.from({ length: visibleDays }, (_, i) => addDays(windowStart, i));

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-4">
      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recurring activities yet.</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={windowStart <= today}
              onClick={() => setWindowStart((w) => addDays(w, -visibleDays))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setWindowStart((w) => addDays(w, visibleDays))}
            >
              Next
            </Button>
          </div>

          {activities.map((activity) => (
            <ActivityPickerCard key={activity.id} activity={activity} days={days} />
          ))}
        </>
      )}
    </div>
  );
};
