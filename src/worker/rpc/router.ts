import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import * as z from "zod";

import {
  activityHasBookings,
  announceActivitySuggestion,
  createActivity,
  decodePastBookingCursor,
  deleteActivity,
  encodePastBookingCursor,
  getActivityById,
  listActivitiesForChannel,
  listPastBookingsForActivity,
  updateActivity,
} from "../activities/activity.ts";
import { upsertAvailability, wouldExceedMax } from "../activities/availability.ts";
import {
  createBooking,
  deleteBooking,
  getBookingById,
  listBookingAttendeeNames,
  updateBooking,
} from "../activities/booking.ts";
import {
  buildBookingGoogleCalendarUrl,
  buildBookingIcs,
  type BookingEventParams,
} from "../activities/ics.ts";
import {
  archiveActivityLocation,
  createActivityLocation,
  getActivityLocationById,
} from "../activities/location.ts";
import { completeLogin } from "../auth/otp.ts";
import {
  deleteSession,
  getSessionMeta,
  SESSION_COOKIE_NAME,
  setSessionCookie,
  switchSessionChannel,
} from "../auth/session.ts";
import { addChannelMember, listChannelMembers, listChannelsForUser } from "../channels/channel.ts";
import { getChannelInfo, getChannelMembers } from "../slack/channels.ts";
import { USER_COLOR_PATTERN } from "../users/colors.ts";
import { getUserName, setUserColor } from "../users/user.ts";

const userColorSchema = z.object({
  color: z
    .string()
    .transform((color) => color.toLowerCase())
    .pipe(z.string().regex(USER_COLOR_PATTERN)),
});

const switchChannelSchema = z.object({
  channelId: z.string().min(1),
});

/** The only query parameter the history route takes. Validated rather than
 * read off `c.req.query` so the RPC client types it — an unvalidated
 * parameter is invisible to `client.…$get`. */
const bookingHistoryQuerySchema = z.object({
  cursor: z.string().optional(),
});

const loginSchema = z.object({
  otp: z
    .string()
    .length(6)
    .transform((otp) => otp.toUpperCase()),
});

const idealWithinMax = (data: { idealMemberCount: number | null; maxMemberCount: number | null }) =>
  data.idealMemberCount === null ||
  data.maxMemberCount === null ||
  data.idealMemberCount <= data.maxMemberCount;

const idealWithinMaxError = {
  message: "The ideal number of people can't be more than the maximum.",
  path: ["idealMemberCount"],
};

const createActivitySchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim(),
    /** A UTC instant. The client converts the creator's wall-clock pick
     * before sending, so this can be compared to `new Date()` directly. */
    endTime: z.iso.datetime().nullable(),
    persistent: z.boolean(),
    slotGranularity: z.enum(["day", "hourly"]),
    suggestedDates: z.array(z.iso.date()).min(1).nullable(),
    idealMemberCount: z.number().int().positive().nullable(),
    maxMemberCount: z.number().int().positive().nullable(),
  })
  .refine(idealWithinMax, idealWithinMaxError)
  .refine((data) => data.persistent || data.endTime !== null, {
    message: "End time is required unless the activity is persistent.",
    path: ["endTime"],
  })
  .refine((data) => !data.persistent || data.suggestedDates === null, {
    message: "Suggested dates are only supported for non-persistent activities.",
    path: ["suggestedDates"],
  })
  .refine(
    (data) => data.persistent || data.endTime === null || data.endTime >= new Date().toISOString(),
    {
      message: "Respond-by time can't be in the past.",
      path: ["endTime"],
    },
  )
  .refine(
    (data) => {
      if (data.persistent || !data.suggestedDates) return true;
      const today = new Date().toISOString().slice(0, 10);
      return data.suggestedDates.every((date) => date >= today);
    },
    { message: "Suggested dates can't be in the past.", path: ["suggestedDates"] },
  );

/** Only the fields an owner may edit after creation — not the type
 * (persistent vs. one-off), granularity, or deadline. `suggestedDates` is
 * ignored server-side for a persistent activity. */
const updateActivitySchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim(),
    idealMemberCount: z.number().int().positive().nullable(),
    maxMemberCount: z.number().int().positive().nullable(),
    suggestedDates: z.array(z.iso.date()).min(1).nullable(),
  })
  .refine(idealWithinMax, idealWithinMaxError)
  .refine(
    (data) => {
      if (!data.suggestedDates) return true;
      const today = new Date().toISOString().slice(0, 10);
      return data.suggestedDates.every((date) => date >= today);
    },
    { message: "Suggested dates can't be in the past.", path: ["suggestedDates"] },
  );

const activitySlotSchema = z
  .object({
    date: z.iso.date(),
    from: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
  })
  .refine((slot) => !slot.from || !slot.to || slot.from < slot.to, {
    message: "from must be before to",
    path: ["to"],
  });

const upsertAvailabilitySchema = z
  .object({
    slots: z.array(activitySlotSchema),
    declined: z.boolean(),
    /** "I'm bringing someone" — one guest at most, so a flag. */
    plusOne: z.boolean(),
  })
  .refine((data) => !data.declined || data.slots.length === 0, {
    message: "Cannot decline while slots are selected.",
    path: ["slots"],
  })
  .refine((data) => !data.declined || !data.plusOne, {
    message: "Cannot bring a guest while declining.",
    path: ["plusOne"],
  });

const addChannelMemberSchema = z.object({
  userId: z.string().min(1),
});

const createBookingSchema = z
  .object({
    date: z.iso.date(),
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
    description: z.string().trim(),
    location: z.string().trim(),
    /** One of the activity's fixed locations, or null for free text (or no
     * place at all) — picking one is never required. */
    locationId: z.string().nullable(),
    attendeeUserIds: z.array(z.string()),
    guestNames: z.array(z.string().trim().min(1)),
  })
  .refine((data) => data.from < data.to, {
    message: "from must be before to",
    path: ["to"],
  })
  .refine((data) => data.locationId === null || data.location === "", {
    message: "A booking carries either a fixed location or free text, not both.",
    path: ["location"],
  });

/** Only checked when a booking is saved: lowering an activity's max later
 * leaves bookings already over it alone until someone next edits them, and
 * that edit then has to bring the headcount down to the max. */
const exceedsMax = (
  maxMemberCount: number | null,
  attendeeUserIds: string[],
  guestNames: string[],
) => maxMemberCount !== null && attendeeUserIds.length + guestNames.length > maxMemberCount;

const createLocationSchema = z.object({
  name: z.string().trim().min(1),
  mapsUrl: z.url(),
});

const loadBookingEventParams = async (
  env: Env,
  bookingId: string,
): Promise<BookingEventParams | null> => {
  const booking = await getBookingById(env, bookingId);
  if (!booking) return null;

  const activity = await getActivityById(env, booking.activityId);
  if (!activity) return null;

  const [bookingLocation, attendeeNames, createdByName] = await Promise.all([
    booking.locationId ? getActivityLocationById(env, booking.locationId) : null,
    listBookingAttendeeNames(env, booking.id),
    getUserName(env, booking.createdBy),
  ]);

  return {
    bookingId: booking.id,
    created: booking.created,
    activityTitle: activity.title,
    activityDescription: activity.description,
    date: booking.date,
    from: booking.from,
    to: booking.to,
    description: booking.description,
    location: booking.location,
    fixedLocation: bookingLocation
      ? { name: bookingLocation.name, mapsUrl: bookingLocation.mapsUrl }
      : null,
    createdByName: createdByName ?? "someone",
    attendeeNames,
    idealMemberCount: activity.idealMemberCount,
  };
};

export const apiRouter = new Hono<{ Bindings: Env }>()
  .get("/session", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId) return c.json({ session: null });

    const session = await getSessionMeta(c.env, sessionId);
    return c.json({ session });
  })
  .delete("/session", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) await deleteSession(c.env, sessionId);

    deleteCookie(c, SESSION_COOKIE_NAME);
    return c.json({ success: true });
  })
  .get("/session/channels", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const channels = await listChannelsForUser(c.env, session.userId);
    return c.json({ channels });
  })
  .post("/session/channel", zValidator("json", switchChannelSchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId) return c.json({ error: "Unauthorized" }, 401);
    const session = await getSessionMeta(c.env, sessionId);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const { channelId } = c.req.valid("json");
    const channels = await listChannelsForUser(c.env, session.userId);
    if (!channels.some((channel) => channel.channelId === channelId)) {
      return c.json({ error: "Not a member of this channel." }, 403);
    }

    await switchSessionChannel(c.env, sessionId, channelId);
    return c.json({ success: true });
  })
  .put("/session/color", zValidator("json", userColorSchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const { color } = c.req.valid("json");
    await setUserColor(c.env, session.userId, color);
    return c.json({ color });
  })
  .post("/login", zValidator("form", loginSchema), async (c) => {
    const { otp } = c.req.valid("form");
    const result = await completeLogin(c.env, otp);

    switch (result.status) {
      case "invalid":
      case "expired":
        return c.json({ success: false }, 400);
      case "success":
        setSessionCookie(c, result.session);
        return c.json({ success: true });
    }
  })
  .post("/activities", zValidator("json", createActivitySchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const {
      title,
      description,
      endTime,
      persistent,
      slotGranularity,
      suggestedDates,
      idealMemberCount,
      maxMemberCount,
    } = c.req.valid("json");
    const activity = await createActivity(c.env, {
      channelId: session.channelId,
      createdBy: session.userId,
      title,
      description,
      endTime,
      persistent,
      slotGranularity,
      suggestedDates,
      idealMemberCount,
      maxMemberCount,
    });

    return c.json({ activity });
  })
  .get("/activities", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activities = await listActivitiesForChannel(c.env, session.channelId, session.userId);
    return c.json({ activities });
  })
  .put("/activities/:id", zValidator("json", updateActivitySchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activityId = c.req.param("id");
    const activity = await getActivityById(c.env, activityId);
    if (!activity || activity.channelId !== session.channelId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (activity.createdBy !== session.userId) {
      return c.json({ error: "Only the activity's creator can edit it." }, 403);
    }

    const { title, description, idealMemberCount, maxMemberCount, suggestedDates } =
      c.req.valid("json");
    const updated = await updateActivity(c.env, {
      activityId,
      title,
      description,
      idealMemberCount,
      maxMemberCount,
      suggestedDates,
    });

    return c.json({ activity: updated });
  })
  .delete("/activities/:id", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activityId = c.req.param("id");
    const activity = await getActivityById(c.env, activityId);
    if (!activity || activity.channelId !== session.channelId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (activity.createdBy !== session.userId) {
      return c.json({ error: "Only the activity's creator can delete it." }, 403);
    }

    // Deleting would cascade the bookings away, and with them a Slack post
    // and a set of attendees expecting to turn up. Make that a separate,
    // deliberate act rather than a side effect of this one.
    if (await activityHasBookings(c.env, activityId)) {
      return c.json({ error: "Delete this activity's bookings first." }, 400);
    }

    await deleteActivity(c.env, {
      activityId,
      channelId: activity.channelId,
      slackMessageTs: activity.slackMessageTs,
    });

    return c.json({ success: true });
  })
  .put("/activities/:id/availability", zValidator("json", upsertAvailabilitySchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activityId = c.req.param("id");
    const activity = await getActivityById(c.env, activityId);
    if (!activity || activity.channelId !== session.channelId) {
      return c.json({ error: "Not found" }, 404);
    }

    const { slots, declined, plusOne } = c.req.valid("json");

    if (activity.endTime && activity.endTime < new Date().toISOString()) {
      return c.json({ error: "This request has closed." }, 400);
    }

    if (activity.suggestedDates) {
      const allowedDates = new Set(activity.suggestedDates);
      const notSuggested = slots.some((slot) => !allowedDates.has(slot.date));
      if (notSuggested) {
        return c.json({ error: "Slot date is not one of the suggested dates." }, 400);
      }
    }

    if (
      activity.maxMemberCount !== null &&
      (await wouldExceedMax(c.env, {
        activityId,
        userId: session.userId,
        maxMemberCount: activity.maxMemberCount,
        slots,
        plusOne,
      }))
    ) {
      return c.json({ error: "That time is already full." }, 409);
    }

    const availability = await upsertAvailability(c.env, {
      activityId,
      userId: session.userId,
      declined,
      plusOne,
      slots,
    });

    return c.json({ availability });
  })
  .get("/channels/members", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const members = await listChannelMembers(c.env, session.channelId);
    return c.json({ members });
  })
  .get("/channel", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const [channel, members] = await Promise.all([
      getChannelInfo(c.env, session.channelId),
      getChannelMembers(c.env, session.channelId),
    ]);

    return c.json({ channel: channel ? { ...channel, members } : null });
  })
  .post("/channel/members", zValidator("json", addChannelMemberSchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const { userId } = c.req.valid("json");

    // Trust neither the userId nor a client-supplied name — resolve both
    // against Slack's live roster so only real channel members can be
    // pre-loaded, under their actual display name.
    const rosterMembers = await getChannelMembers(c.env, session.channelId);
    const rosterMember = rosterMembers.find((member) => member.userId === userId);
    if (!rosterMember) {
      return c.json({ error: "Not a member of this channel on Slack." }, 400);
    }

    await addChannelMember(c.env, {
      channelId: session.channelId,
      userId: rosterMember.userId,
      name: rosterMember.name,
    });

    return c.json({ success: true });
  })
  // Bookings already past, which `GET /activities` leaves out for a
  // persistent activity — loaded by the activity page a page at a time, only
  // when someone asks to see the history. The total is not returned here: the
  // page already knows it from `pastBookingCount` on the polled payload, so
  // counting again per page would be work for an answer it already has.
  //
  // `cursor` is whatever the previous page's `nextCursor` was; absent means
  // the first page.
  .get(
    "/activities/:id/bookings/history",
    zValidator("query", bookingHistoryQuerySchema),
    async (c) => {
      const sessionId = getCookie(c, SESSION_COOKIE_NAME);
      const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
      if (!session) return c.json({ error: "Unauthorized" }, 401);

      const activityId = c.req.param("id");
      const activity = await getActivityById(c.env, activityId);
      if (!activity || activity.channelId !== session.channelId) {
        return c.json({ error: "Not found" }, 404);
      }

      const { bookings, nextCursor } = await listPastBookingsForActivity(c.env, activityId, {
        after: decodePastBookingCursor(c.req.valid("query").cursor),
      });

      return c.json({
        bookings,
        nextCursor: nextCursor ? encodePastBookingCursor(nextCursor) : null,
      });
    },
  )
  .post("/activities/:id/bookings", zValidator("json", createBookingSchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activityId = c.req.param("id");
    const activity = await getActivityById(c.env, activityId);
    if (!activity || activity.channelId !== session.channelId) {
      return c.json({ error: "Not found" }, 404);
    }

    const { date, from, to, description, location, locationId, attendeeUserIds, guestNames } =
      c.req.valid("json");

    const members = await listChannelMembers(c.env, session.channelId);
    const memberIds = new Set(members.map((member) => member.userId));
    if (attendeeUserIds.some((userId) => !memberIds.has(userId))) {
      return c.json({ error: "Attendee is not a member of this channel." }, 400);
    }
    if (exceedsMax(activity.maxMemberCount, attendeeUserIds, guestNames)) {
      return c.json({ error: "Too many people for this activity." }, 400);
    }

    // A fixed location has to be one of this activity's own — never another
    // activity's, and never an arbitrary id.
    let fixedLocation: { name: string; mapsUrl: string } | null = null;
    if (locationId !== null) {
      const resolved = await getActivityLocationById(c.env, locationId);
      if (!resolved || resolved.activityId !== activityId) {
        return c.json({ error: "Location is not one of this activity's." }, 400);
      }
      fixedLocation = { name: resolved.name, mapsUrl: resolved.mapsUrl };
    }

    const booking = await createBooking(c.env, {
      activityId,
      activityTitle: activity.title,
      activityChannelId: activity.channelId,
      activityThreadTs: activity.persistent ? null : activity.slackMessageTs,
      createdBy: session.userId,
      date,
      from,
      to,
      description,
      location,
      locationId,
      fixedLocation,
      attendeeUserIds,
      guestNames,
    });

    // A one-off's suggestion post links to its bookings' posts.
    if (!activity.persistent) await announceActivitySuggestion(c.env, activityId);

    return c.json({ booking });
  })
  .put(
    "/activities/:id/bookings/:bookingId",
    zValidator("json", createBookingSchema),
    async (c) => {
      const sessionId = getCookie(c, SESSION_COOKIE_NAME);
      const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
      if (!session) return c.json({ error: "Unauthorized" }, 401);

      const activityId = c.req.param("id");
      const bookingId = c.req.param("bookingId");

      const activity = await getActivityById(c.env, activityId);
      if (!activity || activity.channelId !== session.channelId) {
        return c.json({ error: "Not found" }, 404);
      }

      const booking = await getBookingById(c.env, bookingId);
      if (!booking || booking.activityId !== activityId) {
        return c.json({ error: "Not found" }, 404);
      }
      if (booking.createdBy !== session.userId) {
        return c.json({ error: "Only the booking's creator can edit it." }, 403);
      }

      const { date, from, to, description, location, locationId, attendeeUserIds, guestNames } =
        c.req.valid("json");

      const members = await listChannelMembers(c.env, session.channelId);
      const memberIds = new Set(members.map((member) => member.userId));
      if (attendeeUserIds.some((userId) => !memberIds.has(userId))) {
        return c.json({ error: "Attendee is not a member of this channel." }, 400);
      }
      if (exceedsMax(activity.maxMemberCount, attendeeUserIds, guestNames)) {
        return c.json({ error: "Too many people for this activity." }, 400);
      }

      // A fixed location has to be one of this activity's own — never another
      // activity's, and never an arbitrary id.
      let fixedLocation: { name: string; mapsUrl: string } | null = null;
      if (locationId !== null) {
        const resolved = await getActivityLocationById(c.env, locationId);
        if (!resolved || resolved.activityId !== activityId) {
          return c.json({ error: "Location is not one of this activity's." }, 400);
        }
        fixedLocation = { name: resolved.name, mapsUrl: resolved.mapsUrl };
      }

      await updateBooking(c.env, {
        bookingId,
        activityTitle: activity.title,
        activityChannelId: activity.channelId,
        activityThreadTs: activity.persistent ? null : activity.slackMessageTs,
        createdBy: booking.createdBy,
        date,
        from,
        to,
        description,
        location,
        locationId,
        fixedLocation,
        attendeeUserIds,
        guestNames,
        slackMessageTs: booking.slackMessageTs,
      });

      // A one-off's suggestion post links to its bookings' posts.
      if (!activity.persistent) await announceActivitySuggestion(c.env, activityId);

      return c.json({ success: true });
    },
  )
  .delete("/activities/:id/bookings/:bookingId", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activityId = c.req.param("id");
    const bookingId = c.req.param("bookingId");

    const activity = await getActivityById(c.env, activityId);
    if (!activity || activity.channelId !== session.channelId) {
      return c.json({ error: "Not found" }, 404);
    }

    const booking = await getBookingById(c.env, bookingId);
    if (!booking || booking.activityId !== activityId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (booking.createdBy !== session.userId) {
      return c.json({ error: "Only the booking's creator can delete it." }, 403);
    }

    await deleteBooking(c.env, {
      bookingId,
      channelId: activity.channelId,
      slackMessageTs: booking.slackMessageTs,
    });

    // A one-off's suggestion post links to its bookings' posts.
    if (!activity.persistent) await announceActivitySuggestion(c.env, activityId);

    return c.json({ success: true });
  })
  .post("/activities/:id/locations", zValidator("json", createLocationSchema), async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activityId = c.req.param("id");
    const activity = await getActivityById(c.env, activityId);
    if (!activity || activity.channelId !== session.channelId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (activity.createdBy !== session.userId) {
      return c.json({ error: "Only the activity's creator can edit it." }, 403);
    }
    if (!activity.persistent) {
      return c.json({ error: "Only repeating activities have fixed locations." }, 400);
    }

    const { name, mapsUrl } = c.req.valid("json");

    try {
      const location = await createActivityLocation(c.env, { activityId, name, mapsUrl });
      return c.json({ location });
    } catch {
      // The only constraint that can realistically bite here is the partial
      // unique index on (activity, name).
      return c.json({ error: "There's already a location with that name." }, 400);
    }
  })
  .delete("/activities/:id/locations/:locationId", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const session = sessionId ? await getSessionMeta(c.env, sessionId) : null;
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const activityId = c.req.param("id");
    const activity = await getActivityById(c.env, activityId);
    if (!activity || activity.channelId !== session.channelId) {
      return c.json({ error: "Not found" }, 404);
    }
    if (activity.createdBy !== session.userId) {
      return c.json({ error: "Only the activity's creator can edit it." }, 403);
    }

    const locationId = c.req.param("locationId");
    const location = await getActivityLocationById(c.env, locationId);
    if (!location || location.activityId !== activityId) {
      return c.json({ error: "Not found" }, 404);
    }

    await archiveActivityLocation(c.env, locationId);
    return c.json({ success: true });
  })
  // Both calendar routes are deliberately public (no session check): the
  // bookingId is an unguessable UUID, and calendar apps/browsers fetching
  // these links (e.g. from Slack) won't have our session cookie anyway.
  .get("/bookings/:bookingId/ics", async (c) => {
    const params = await loadBookingEventParams(c.env, c.req.param("bookingId"));
    if (!params) return c.notFound();

    return c.body(buildBookingIcs(params), 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="booking.ics"`,
    });
  })
  // A redirect rather than a URL built client-side, so the web app and Slack
  // share one link and the attendee list is current at click time.
  .get("/bookings/:bookingId/google-calendar", async (c) => {
    const params = await loadBookingEventParams(c.env, c.req.param("bookingId"));
    if (!params) return c.notFound();

    return c.redirect(buildBookingGoogleCalendarUrl(params), 302);
  });

if (import.meta.env.DEV) {
  apiRouter.post("/dev/login", async (c) => {
    const { devLogin, DEV_USERS } = await import("../auth/dev-login.ts");
    const userKey = c.req.query("user");
    const key = userKey && userKey in DEV_USERS ? (userKey as keyof typeof DEV_USERS) : "a";
    const session = await devLogin(c.env, key);
    setSessionCookie(c, session);
    return c.json({ success: true });
  });
}
