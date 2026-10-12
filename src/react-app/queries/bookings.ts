import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { client } from "../api.ts";
import { activitiesQueryKey } from "./activities.ts";

export const bookingHistoryQueryKey = (activityId: string) =>
  ["bookings", "history", activityId] as const;

/** An activity's bookings that have already happened — deliberately not part
 * of the polled dashboard payload (see `listPastBookingsForActivity`), so it
 * only runs once the page asks for it with `enabled`. */
export const useBookingHistoryQuery = (activityId: string, enabled: boolean) =>
  useQuery({
    queryKey: bookingHistoryQueryKey(activityId),
    queryFn: async () => {
      const res = await client.activities[":id"].bookings.history.$get({
        param: { id: activityId },
      });
      if (!res.ok) throw new Error("Failed to load past bookings.");
      const { bookings } = await res.json();
      return bookings;
    },
    enabled,
  });

/** Editing or removing a booking can change what's in the history as well as
 * what's upcoming, so both go stale together. */
const invalidateBookings = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: activitiesQueryKey });
  queryClient.invalidateQueries({ queryKey: ["bookings", "history"] });
};

export const useCreateBookingMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      activityId: string;
      date: string;
      from: string;
      to: string;
      description: string;
      location: string;
      locationId: string | null;
      attendeeUserIds: string[];
      guestNames: string[];
    }) => {
      const res = await client.activities[":id"].bookings.$post({
        param: { id: params.activityId },
        json: {
          date: params.date,
          from: params.from,
          to: params.to,
          description: params.description,
          location: params.location,
          locationId: params.locationId,
          attendeeUserIds: params.attendeeUserIds,
          guestNames: params.guestNames,
        },
      });
      if (!res.ok) throw new Error("Failed to create booking.");
      return res.json();
    },
    onSuccess: () => invalidateBookings(queryClient),
  });
};

export const useUpdateBookingMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      activityId: string;
      bookingId: string;
      date: string;
      from: string;
      to: string;
      description: string;
      location: string;
      locationId: string | null;
      attendeeUserIds: string[];
      guestNames: string[];
    }) => {
      const res = await client.activities[":id"].bookings[":bookingId"].$put({
        param: { id: params.activityId, bookingId: params.bookingId },
        json: {
          date: params.date,
          from: params.from,
          to: params.to,
          description: params.description,
          location: params.location,
          locationId: params.locationId,
          attendeeUserIds: params.attendeeUserIds,
          guestNames: params.guestNames,
        },
      });
      if (!res.ok) throw new Error("Failed to update booking.");
      return res.json();
    },
    onSuccess: () => invalidateBookings(queryClient),
  });
};

/** Removes a booking and the Slack post announcing it. Owner-only, enforced
 * server-side. */
export const useDeleteBookingMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { activityId: string; bookingId: string }) => {
      const res = await client.activities[":id"].bookings[":bookingId"].$delete({
        param: { id: params.activityId, bookingId: params.bookingId },
      });
      if (!res.ok) throw new Error("Failed to delete booking.");
      return res.json();
    },
    onSuccess: () => invalidateBookings(queryClient),
  });
};
