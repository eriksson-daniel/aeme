import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ActivitySlot } from "../../worker/db/schema.ts";
import { ActivityLocations } from "../components/ActivityLocations.tsx";
import { AvailabilityGrid } from "../components/AvailabilityGrid.tsx";
import { BookingDetailsDialog } from "../components/BookingDetailsDialog.tsx";
import { BookingHistory } from "../components/BookingHistory.tsx";
import { DeleteActivityDialog } from "../components/DeleteActivityDialog.tsx";
import { EditActivityDialog } from "../components/EditActivityDialog.tsx";
import { PageContainer } from "../components/PageContainer.tsx";
import { ResponderBreakdown } from "../components/ResponderBreakdown.tsx";
import { Section } from "../components/Section.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Label } from "../components/ui/label.tsx";
import { isRespondByPassed } from "../lib/activity-state.ts";
import { guestWouldExceedMax, isSlotFull, respondersBySlot, slotKey } from "../lib/responders.ts";
import { useActivitiesQuery } from "../queries/activities.ts";
import { useUpsertAvailabilityMutation } from "../queries/availability.ts";
import { useSessionQuery, useViewer } from "../queries/session.ts";

// Matches the ongoing board's autosave, so a toggle on either surface
// behaves the same.
const SAVE_DEBOUNCE_MS = 600;

const formatBookingDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

const formatDeadline = (endTime: string) =>
  new Date(endTime).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const ActivityDetail = () => {
  const { activityId } = Route.useParams();
  const activities = useActivitiesQuery();
  const session = useSessionQuery();
  const viewer = useViewer();
  const upsertAvailability = useUpsertAvailabilityMutation();
  const navigate = useNavigate();

  const activity = activities.data?.find((candidate) => candidate.id === activityId);

  const [slots, setSlots] = useState<ActivitySlot[]>([]);
  const [declined, setDeclined] = useState(false);
  const [plusOne, setPlusOne] = useState(false);
  // The dates the grid currently shows, reported up so "all days" can mean
  // what's on screen. Stable identity + a content check, or the grid's effect
  // and this state would bounce off each other forever.
  const [visibleDates, setVisibleDates] = useState<string[]>([]);
  const handleVisibleDates = useCallback((dates: string[]) => {
    setVisibleDates((prev) => (prev.join("|") === dates.join("|") ? prev : dates));
  }, []);
  // Guards the 10s dashboard poll from overwriting an answer mid-edit.
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!activity || dirtyRef.current) return;
    setSlots(activity.slots);
    setDeclined(activity.declined);
    setPlusOne(activity.plusOne);
  }, [activity]);

  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  if (activities.isPending) return null;

  if (!activity) {
    return (
      <PageContainer className="p-2 md:px-6">
        <div className="flex w-full max-w-prose flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">That activity doesn't exist here.</p>
          <Button render={<Link to="/" />} nativeButton={false} variant="outline" size="sm">
            Back to dashboard
          </Button>
        </div>
      </PageContainer>
    );
  }

  const isOwner = session.data?.session?.userId === activity.createdBy;
  const closed = isRespondByPassed(activity);
  const responders = respondersBySlot(activity.responses);
  const viewerId = session.data?.session?.userId;
  // A guest needs a seat everywhere you've already got one.
  const noRoomForGuest =
    !plusOne && guestWouldExceedMax(slots, responders, viewerId, activity.maxMemberCount);

  // Toggling is the save — no separate confirm step. Debounced so a run of
  // taps (or a drag across hours) sends one request rather than one each.
  const save = (next: { slots: ActivitySlot[]; plusOne: boolean }) => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      upsertAvailability.mutate(
        { activityId: activity.id, slots: next.slots, declined: false, plusOne: next.plusOne },
        { onSettled: () => (dirtyRef.current = false) },
      );
    }, SAVE_DEBOUNCE_MS);
  };

  const handleChange = (next: ActivitySlot[]) => {
    dirtyRef.current = true;
    setSlots(next);
    setDeclined(false);
    save({ slots: next, plusOne });
  };

  const handlePlusOne = (next: boolean) => {
    dirtyRef.current = true;
    setPlusOne(next);
    setDeclined(false);
    save({ slots, plusOne: next });
  };

  const handleDecline = () => {
    // Drop any save still waiting out its debounce, or it would land after
    // this one and put the cleared days straight back.
    clearTimeout(saveTimerRef.current);

    dirtyRef.current = true;
    setSlots([]);
    setDeclined(true);
    // A decline can't carry a guest — the DB has a check constraint saying so.
    setPlusOne(false);
    upsertAvailability.mutate(
      { activityId: activity.id, slots: [], declined: true, plusOne: false },
      { onSettled: () => (dirtyRef.current = false) },
    );
  };

  // A full day can't be picked, so "all days" means all the ones with room
  // — or the button would never flip to "Clear all days".
  const pickableDates = visibleDates.filter(
    (date) =>
      slots.some((s) => s.date === date) ||
      !isSlotFull(responders[slotKey(date)] ?? [], viewerId, plusOne, activity.maxMemberCount),
  );
  const allDaysPicked =
    pickableDates.length > 0 && pickableDates.every((date) => slots.some((s) => s.date === date));

  const handleToggleAllDays = () => {
    if (allDaysPicked) {
      const visible = new Set(visibleDates);
      handleChange(slots.filter((slot) => !visible.has(slot.date)));
      return;
    }

    const already = new Set(slots.map((slot) => slot.date));
    const added = pickableDates
      .filter((date) => !already.has(date))
      .map((date) => ({ date }) satisfies ActivitySlot);
    handleChange([...slots, ...added]);
  };

  // What a persistent activity carries is only what's still to come — its
  // finished bookings are counted in `pastBookingCount` and fetched on demand
  // by `BookingHistory`. A one-off's `bookings` are all of them, and its
  // count is always 0.
  const bookings = [...activity.bookings].sort((a, b) =>
    (a.date + a.from).localeCompare(b.date + b.from),
  );
  const totalBookings = bookings.length + activity.pastBookingCount;

  return (
    <PageContainer className="p-2 pb-10 md:px-6">
      <div className="flex w-full max-w-prose flex-col items-start gap-4">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back to dashboard
        </Link>

        <header className="flex w-full flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold">{activity.title}</h1>
                {isOwner && (
                  <EditActivityDialog
                    activity={activity}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit activity"
                        className="text-muted-foreground"
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                    }
                  />
                )}
              </div>
              {activity.description && (
                <p className="text-sm text-muted-foreground">{activity.description}</p>
              )}
            </div>
            <Button
              render={
                <Link
                  to="/activities/$activityId/book"
                  params={{ activityId: activity.id }}
                  search={{ from: "activity" }}
                />
              }
              nativeButton={false}
              size="sm"
            >
              <PlusIcon className="size-4" />
              Book
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Badge>{activity.persistent ? "Ongoing" : "One-off"}</Badge>
            <Badge>
              {activity.slotGranularity === "day" ? "Any time that day" : "Specific hours"}
            </Badge>
            {activity.endTime && (
              <Badge variant={closed ? "outline" : "secondary"}>
                {closed ? "Closed" : "Respond by"} {formatDeadline(activity.endTime)}
              </Badge>
            )}
            {activity.idealMemberCount && <Badge>Aiming for {activity.idealMemberCount}</Badge>}
            {activity.maxMemberCount && <Badge>Max {activity.maxMemberCount}</Badge>}
            {totalBookings > 0 && <Badge variant="success">{totalBookings} booked</Badge>}
          </div>
        </header>

        <Section
          title={closed ? "Your response" : "When can you make it?"}
          description={
            closed
              ? "Responses are closed."
              : activity.slotGranularity === "day"
                ? "Tap the days that work for you — saved as you go."
                : "Drag across the hours you're free — saved as you go."
          }
        >
          {declined && !closed && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              You've said you can't make it. Pick a day or hour below to change your mind.
            </p>
          )}

          <AvailabilityGrid
            activityId={activity.id}
            granularity={activity.slotGranularity}
            suggestedDates={activity.suggestedDates}
            value={slots}
            onChange={handleChange}
            readOnly={closed}
            responders={responders}
            viewer={viewer}
            bookedSlots={activity.bookedSlots}
            bookings={activity.bookings}
            idealMemberCount={activity.idealMemberCount}
            maxMemberCount={activity.maxMemberCount}
            viewerPlusOne={plusOne}
            onVisibleDatesChange={handleVisibleDates}
          />

          {!closed && (
            <>
              {/* One-off only: a +1 is a guest for a specific occasion, which
                  a standing activity doesn't have. */}
              {!activity.persistent && (
                <div className="flex items-center gap-2 border-t border-border pt-4">
                  <Checkbox
                    id="plus-one"
                    checked={plusOne}
                    disabled={noRoomForGuest}
                    onCheckedChange={(checked) => handlePlusOne(checked === true)}
                  />
                  <Label htmlFor="plus-one">I'm bringing someone (+1)</Label>
                  {noRoomForGuest && (
                    <span className="text-xs text-muted-foreground">
                      — no room for a guest in a slot you've picked
                    </span>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                {/* Day granularity only: "all days" on an hourly activity would
                  mean every hour of every day, which is never what anyone
                  means. */}
                {activity.slotGranularity === "day" && visibleDates.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    // Nothing on screen has room (and you hold none of it),
                    // so there's nothing for the button to pick.
                    disabled={pickableDates.length === 0}
                    onClick={handleToggleAllDays}
                  >
                    {pickableDates.length === 0
                      ? "All days are full"
                      : allDaysPicked
                        ? "Clear all days"
                        : "I can do all days"}
                  </Button>
                )}
                {/* Persistent activities have nothing to decline — they just run. */}
                {!activity.persistent && (
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive"
                    disabled={upsertAvailability.isPending}
                    onClick={handleDecline}
                  >
                    Can't make it
                  </Button>
                )}
                {upsertAvailability.isPending && (
                  <span className="text-xs text-muted-foreground" aria-live="polite">
                    Saving…
                  </span>
                )}
              </div>
            </>
          )}

          {upsertAvailability.isError && (
            <p className="text-sm text-destructive" aria-live="polite">
              Failed to save availability.
            </p>
          )}
        </Section>

        <Section title="Who can make it" description="Everyone's answers, day by day.">
          <ResponderBreakdown activity={activity} />
        </Section>

        {activity.persistent && (
          <Section title="Locations" description="Places this happens, ready to pick when booking.">
            <ActivityLocations activity={activity} canEdit={isOwner} />
          </Section>
        )}

        <Section
          title="Bookings"
          description={
            totalBookings === 0
              ? "Nothing booked yet."
              : activity.pastBookingCount > 0
                ? `${
                    bookings.length > 0 ? `${bookings.length} coming up` : "Nothing coming up"
                  } · ${totalBookings} in total`
                : undefined
          }
        >
          {bookings.length > 0 && (
            <ul className="flex flex-col gap-2">
              {bookings.map((booking) => (
                <li
                  key={booking.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-green-600/30 bg-green-600/10 p-3"
                >
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {formatBookingDate(booking.date)} · {booking.from}–{booking.to}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {booking.attendeeNames.length > 0
                        ? `Joining: ${booking.attendeeNames.join(", ")}`
                        : "No one else joining yet."}
                    </p>
                  </div>
                  <BookingDetailsDialog
                    activityId={activity.id}
                    booking={booking}
                    idealMemberCount={activity.idealMemberCount}
                    from="activity"
                    trigger={
                      <Button type="button" variant="outline" size="sm">
                        Details
                      </Button>
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          <BookingHistory
            activityId={activity.id}
            count={activity.pastBookingCount}
            idealMemberCount={activity.idealMemberCount}
          />
        </Section>
        {isOwner && (
          <Section
            title="Delete activity"
            description="Made this by mistake, or in the wrong channel? There's no other way to remove it."
            className="border-destructive/30 bg-destructive/5"
          >
            <div>
              <DeleteActivityDialog
                activityId={activity.id}
                title={activity.title}
                bookingCount={totalBookings}
                onDeleted={() => navigate({ to: "/" })}
              />
            </div>
          </Section>
        )}
      </div>
    </PageContainer>
  );
};

export const Route = createFileRoute("/activities/$activityId")({
  component: ActivityDetail,
});
