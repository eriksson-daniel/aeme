import { HistoryIcon } from "lucide-react";
import { useState } from "react";

import { useBookingHistoryQuery } from "../queries/bookings.ts";
import { BookingDetailsDialog } from "./BookingDetailsDialog.tsx";
import { Button } from "./ui/button.tsx";

const formatBookingDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

type Props = {
  activityId: string;
  /** How many bookings are in the past — known from the activity payload, so
   * the button can name the number before anything is fetched. */
  count: number;
  idealMemberCount?: number | null;
};

/** The bookings that have already happened, fetched only when asked for, and
 * then a page at a time.
 *
 * A standing activity's history grows without end, so it's left out of the
 * dashboard payload entirely (see `listPastBookingsForActivity`) and loaded
 * here, on the click — which is also why these details are read-only: the
 * edit screen works off the polled payload, and a past booking isn't in it.
 *
 * `count` arrives with that payload, so the button names the total before any
 * of this is fetched, and the heading can say how far down the list you are. */
export const BookingHistory = ({ activityId, count, idealMemberCount }: Props) => {
  const [open, setOpen] = useState(false);
  const history = useBookingHistoryQuery(activityId, open);
  const bookings = history.data?.pages.flatMap((page) => page.bookings);

  if (count === 0) return null;

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <HistoryIcon data-icon="inline-start" />
          Show {count} past booking{count === 1 ? "" : "s"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {bookings
            ? `Showing ${bookings.length} of ${count}, most recent first.`
            : "Past bookings, most recent first."}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Hide
        </Button>
      </div>

      {history.isError ? (
        <p className="text-sm text-destructive">Failed to load past bookings.</p>
      ) : bookings ? (
        <ul className="flex flex-col gap-2">
          {bookings.map((booking) => (
            <li
              key={booking.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3"
            >
              <div className="min-w-0 text-sm">
                <p className="font-medium text-muted-foreground">
                  {formatBookingDate(booking.date)} · {booking.from}–{booking.to}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {booking.attendeeNames.length > 0
                    ? `Joined: ${booking.attendeeNames.join(", ")}`
                    : "No one joined."}
                </p>
              </div>
              <BookingDetailsDialog
                activityId={activityId}
                booking={booking}
                idealMemberCount={idealMemberCount}
                from="activity"
                editable={false}
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    Details
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Loading…
        </p>
      )}

      {history.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={history.isFetchingNextPage}
            onClick={() => history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
