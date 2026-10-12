import { Link } from "@tanstack/react-router";
import { CalendarPlusIcon, DownloadIcon } from "lucide-react";
import type { ReactElement } from "react";

import { isUrl } from "../lib/is-url.ts";
import type { ActivityWithAvailability } from "../queries/activities.ts";
import { useSessionQuery } from "../queries/session.ts";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.tsx";

type BookingSummary = ActivityWithAvailability["bookings"][number];

const formatFullDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

type Props = {
  activityId: string;
  booking: BookingSummary;
  trigger: ReactElement;
  /** Advisory headcount, shown alongside the attendee count as "N/ideal". */
  idealMemberCount?: number | null;
  /** Where the edit link should return to once it's done. */
  from: "home" | "activity";
  /** Whether the booking's owner is offered the edit link. False for a past
   * booking shown from the history: the edit screen reads the booking out of
   * the dashboard payload, which only carries what's still to come. */
  editable?: boolean;
};

export const BookingDetailsDialog = ({
  activityId,
  booking,
  trigger,
  idealMemberCount,
  from,
  editable = true,
}: Props) => {
  const { data } = useSessionQuery();
  const isOwner = data?.session?.userId === booking.createdBy;

  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{formatFullDate(booking.date)}</DialogTitle>
          <DialogDescription>
            {booking.from}–{booking.to}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm">
          {booking.description && <p>{booking.description}</p>}
          {booking.fixedLocation ? (
            <p>
              <span className="text-muted-foreground">Location:</span>{" "}
              <a
                href={booking.fixedLocation.mapsUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {booking.fixedLocation.name}
              </a>
            </p>
          ) : (
            booking.location && (
              <p>
                <span className="text-muted-foreground">Location:</span>{" "}
                {isUrl(booking.location) ? (
                  <a href={booking.location} target="_blank" rel="noreferrer" className="underline">
                    {booking.location}
                  </a>
                ) : (
                  booking.location
                )}
              </p>
            )
          )}
          <p>
            <span className="text-muted-foreground">Booked by</span> {booking.createdByName}
          </p>
          <p>
            <span className="text-muted-foreground">
              Joining
              {idealMemberCount ? ` (${booking.attendeeNames.length}/${idealMemberCount})` : ""}:
            </span>{" "}
            {booking.attendeeNames.length > 0
              ? booking.attendeeNames.join(", ")
              : "No one else yet."}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            render={
              <a
                href={`/api/bookings/${booking.id}/google-calendar`}
                target="_blank"
                rel="noreferrer"
              />
            }
            nativeButton={false}
          >
            <CalendarPlusIcon data-icon="inline-start" />
            Google Calendar
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            render={<a href={`/api/bookings/${booking.id}/ics`} />}
            nativeButton={false}
          >
            <DownloadIcon data-icon="inline-start" />
            Download ICS
          </Button>
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Close</DialogClose>
          {isOwner && editable && (
            <Button
              render={
                <Link
                  to="/activities/$activityId/book"
                  params={{ activityId }}
                  search={{ bookingId: booking.id, from }}
                />
              }
              nativeButton={false}
            >
              Edit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
