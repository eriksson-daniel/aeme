CREATE INDEX `activities_channel_archived_created` ON `activities` (`channel_id`,`archived`,`created`);--> statement-breakpoint
CREATE INDEX `activity_bookings_activity_date` ON `activity_bookings` (`activity_id`,`date`);--> statement-breakpoint
CREATE INDEX `channel_members_user` ON `channel_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `otp_logins_expires` ON `otp_logins` (`expires`);--> statement-breakpoint
CREATE INDEX `sessions_expires` ON `sessions` (`expires`);