import type { ActivityWithAvailability } from "../queries/activities.ts";

/** One user's answer, as it arrives over the wire. */
export type ActivityResponse = ActivityWithAvailability["responses"][number];
type ResponseSlot = ActivityResponse["slots"][number];

/** A channel member, with no answer attached. */
export type Responder = { userId: string; name: string };

/** Someone who has answered, the color their part of a grid cell is drawn
 * in, and whether they're bringing a guest. */
export type RespondingUser = Responder & { color: string; plusOne: boolean };

/** The person looking at a grid, for drawing their own part of a cell. */
export type Viewer = { userId: string; name: string; color: string };

/** One stripe of a grid cell. `plusOne` is optional because the viewer's own
 * stripe is drawn from local state, which only sometimes knows it. */
export type CellPerson = Viewer & { plusOne?: boolean };

/** Who to draw in a cell: everyone else who picked it, plus the viewer when
 * their own selection includes it. The viewer's part comes from `selected` —
 * local, possibly unsaved state — rather than the server's copy, so a click
 * shows up before the save lands. Viewer first, so their stripe sits in the
 * same place in every cell. */
export const cellPeople = (
  people: RespondingUser[],
  viewer: CellPerson | undefined,
  selected: boolean,
): CellPerson[] => {
  const others = people.filter((person) => person.userId !== viewer?.userId);
  return selected && viewer ? [viewer, ...others] : others;
};

/** Heads rather than rows: a +1 is another person at the table, and that's
 * what gets compared against the activity's ideal headcount. */
export const headcount = (people: Pick<RespondingUser, "plusOne">[]) =>
  people.length + people.filter((person) => person.plusOne).length;

/** "Karl +1" / "Karl" — the label used wherever a responder is named. */
export const responderLabel = (person: RespondingUser) =>
  person.plusOne ? `${person.name} +1` : person.name;

const timeToMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** A slot with no `from`/`to` covers the whole day. */
const slotRange = (slot: ResponseSlot) => ({
  from: slot.from ? timeToMinutes(slot.from) : 0,
  to: slot.to ? timeToMinutes(slot.to) : 24 * 60,
});

/** Key an availability grid cell is looked up by: the date alone at day
 * granularity, `date|hour` at hourly granularity. */
export const slotKey = (date: string, hour?: number) =>
  hour === undefined ? date : `${date}|${hour}`;

/** Every key a stored slot occupies — the date alone for a whole-day slot,
 * or one key per hour cell its range overlaps. */
const keysForSlot = (slot: ResponseSlot): string[] => {
  if (!slot.from || !slot.to) return [slot.date];

  const startHour = Math.floor(timeToMinutes(slot.from) / 60);
  const endHourExclusive = Math.ceil(timeToMinutes(slot.to) / 60);
  return Array.from({ length: Math.max(0, endHourExclusive - startHour) }, (_, i) =>
    slotKey(slot.date, startHour + i),
  );
};

/** Who picked each slot, keyed by `slotKey` — everyone, the viewer included.
 * Counts shown to a user are "how many of us", not "how many besides me". */
export const respondersBySlot = (
  responses: ActivityResponse[],
): Record<string, RespondingUser[]> => {
  const bySlot: Record<string, RespondingUser[]> = {};

  for (const response of responses) {
    for (const slot of response.slots) {
      for (const key of keysForSlot(slot)) {
        const list = bySlot[key] ?? [];
        list.push({
          userId: response.userId,
          name: response.name,
          color: response.color,
          plusOne: response.plusOne,
        });
        bySlot[key] = list;
      }
    }
  }

  return bySlot;
};

/** Whether a cell has no room left for the viewer: everyone else already
 * there, plus the viewer (and their +1), would go past the activity's max.
 * Only meaningful for a cell the viewer hasn't picked — one they already
 * hold stays theirs even if the max is lowered under them. */
export const isSlotFull = (
  people: RespondingUser[],
  viewerId: string | undefined,
  viewerPlusOne: boolean,
  maxMemberCount: number | null | undefined,
) =>
  maxMemberCount != null &&
  headcount(people.filter((person) => person.userId !== viewerId)) + (viewerPlusOne ? 2 : 1) >
    maxMemberCount;

/** Whether turning on a +1 would overfill any cell the viewer has picked —
 * the guest needs a seat everywhere the viewer already has one. */
export const guestWouldExceedMax = (
  slots: ResponseSlot[],
  responders: Record<string, RespondingUser[]>,
  viewerId: string | undefined,
  maxMemberCount: number | null | undefined,
) =>
  slots
    .flatMap(keysForSlot)
    .some((key) => isSlotFull(responders[key] ?? [], viewerId, true, maxMemberCount));

/** How many of a slot's responders are bringing someone — shown as its own
 * `+N` badge rather than folded into the headline count, so "three of us, two
 * with guests" stays readable. */
export const guestCount = (people: RespondingUser[]) =>
  people.filter((person) => person.plusOne).length;

/** The hour ranges a user offered on one date, formatted for display —
 * empty for a whole-day slot, which needs no qualifier. */
export const rangesForDate = (slots: ResponseSlot[], date: string): string[] =>
  slots
    .filter((slot) => slot.date === date && slot.from && slot.to)
    .map((slot) => `${slot.from}–${slot.to}`);

/** Dates anyone offered, ascending — the rows a breakdown lists when the
 * activity has no fixed set of suggested dates to go by. */
export const respondedDates = (responses: ActivityResponse[]): string[] => {
  const dates = new Set<string>();
  for (const response of responses) {
    for (const slot of response.slots) dates.add(slot.date);
  }
  return [...dates].sort();
};

/** Who said they could make a concrete date + time window. A whole-day slot
 * counts for any window on that date; an hourly slot has to actually
 * overlap it. */
export const availableForBooking = (
  responses: ActivityResponse[],
  date: string,
  from: string,
  to: string,
): RespondingUser[] => {
  const windowFrom = timeToMinutes(from);
  const windowTo = timeToMinutes(to);

  return responses
    .filter((response) =>
      response.slots.some((slot) => {
        if (slot.date !== date) return false;
        const range = slotRange(slot);
        return range.from < windowTo && range.to > windowFrom;
      }),
    )
    .map((response) => ({
      userId: response.userId,
      name: response.name,
      color: response.color,
      plusOne: response.plusOne,
    }));
};

/** Split the channel roster by what each member answered — the three lists
 * a one-off activity's organizer actually wants to see. */
export const splitByResponse = (
  responses: ActivityResponse[],
  members: Responder[],
): { available: RespondingUser[]; declined: RespondingUser[]; noAnswer: Responder[] } => {
  const byUserId = new Map(responses.map((response) => [response.userId, response]));

  const available = responses
    .filter((response) => !response.declined)
    .map((response) => ({
      userId: response.userId,
      name: response.name,
      color: response.color,
      plusOne: response.plusOne,
    }));
  const declined = responses
    .filter((response) => response.declined)
    .map((response) => ({
      userId: response.userId,
      name: response.name,
      color: response.color,
      plusOne: response.plusOne,
    }));
  const noAnswer = members.filter((member) => !byUserId.has(member.userId));

  return { available, declined, noAnswer };
};

/** Everyone who offered something on one date, with the hour ranges they
 * offered — empty ranges meaning a whole-day slot, which needs no qualifier.
 * Unlike `availableForBooking` this doesn't narrow to a time window: it's
 * what you read *before* choosing one. */
export const offersOnDate = (
  responses: ActivityResponse[],
  date: string,
): { userId: string; name: string; ranges: string[] }[] =>
  responses
    .filter((response) => response.slots.some((slot) => slot.date === date))
    .map((response) => ({
      userId: response.userId,
      name: response.name,
      ranges: rangesForDate(response.slots, date),
    }));
