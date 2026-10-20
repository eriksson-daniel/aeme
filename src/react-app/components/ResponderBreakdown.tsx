import {
  headcount,
  rangesForDate,
  respondedDates,
  responderLabel,
  splitByResponse,
} from "../lib/responders.ts";
import type { ActivityWithAvailability } from "../queries/activities.ts";
import { useChannelMembersQuery } from "../queries/channelMembers.ts";

const toDateStr = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const formatDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

const NameList = ({ names }: { names: string[] }) => (
  <div className="flex flex-wrap gap-1.5">
    {names.map((name) => (
      <span key={name} className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
        {name}
      </span>
    ))}
  </div>
);

type Props = {
  activity: ActivityWithAvailability;
};

/** Names behind the numbers: who picked each day (and at which hours, for an
 * hourly activity), who declined, and who hasn't answered at all. The grid
 * above it only has room for a count per cell — this is the part that makes
 * a booking decision possible. */
export const ResponderBreakdown = ({ activity }: Props) => {
  const members = useChannelMembersQuery();

  const { declined, noAnswer } = splitByResponse(activity.responses, members.data ?? []);

  // A one-off with suggested dates is answering a fixed question, so list
  // every candidate date even when nobody picked it — "no one can make
  // Tuesday" is itself the answer. Otherwise only dates someone offered.
  const allDates =
    activity.suggestedDates && activity.suggestedDates.length > 0
      ? [...activity.suggestedDates].sort()
      : respondedDates(activity.responses);

  // Only what's still ahead: a day that's been and gone can't be booked, and
  // a persistent activity would otherwise grow an ever-longer history here.
  // A day counts as upcoming for all of itself, matching `upcomingBookings`.
  const today = toDateStr(new Date());
  const dates = allDates.filter((date) => date >= today);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {dates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {allDates.length > 0 ? "No upcoming days." : "No one has picked a day yet."}
          </p>
        ) : (
          dates.map((date) => {
            const onDate = activity.responses.filter(
              (response) => !response.declined && response.slots.some((slot) => slot.date === date),
            );

            return (
              <div key={date} className="flex flex-col gap-1">
                <p className="text-sm">
                  {formatDate(date)}
                  <span className="text-muted-foreground">
                    {" · "}
                    {headcount(onDate)}
                  </span>
                </p>
                {onDate.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No one yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {onDate.map((response) => {
                      const ranges = rangesForDate(response.slots, date);
                      return (
                        <span
                          key={response.userId}
                          className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                        >
                          {/* The key to the grid: which color is whose. */}
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: response.color }}
                          />
                          {responderLabel(response)}
                          {ranges.length > 0 && (
                            <span className="text-muted-foreground"> {ranges.join(", ")}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {declined.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-destructive">
            Can't make it ({declined.length})
          </h3>
          <NameList names={declined.map((responder) => responder.name)} />
        </div>
      )}

      {noAnswer.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-muted-foreground">
            No answer yet ({noAnswer.length})
          </h3>
          <NameList names={noAnswer.map((responder) => responder.name)} />
        </div>
      )}
    </div>
  );
};
