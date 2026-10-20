PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`user_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created` text NOT NULL,
	CONSTRAINT "users_color_hex" CHECK("color" GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
);
--> statement-breakpoint
-- Existing users get the palette (`USER_COLOR_PALETTE`) dealt out in sign-up order, so people
-- who joined around the same time - likely the same channel - don't share a color.
INSERT INTO `__new_users`(`user_id`, `name`, `color`, `created`) SELECT `user_id`, `name`, json_extract('["#2563eb","#e11d48","#059669","#ea580c","#7c3aed","#ca8a04","#0891b2","#c026d3","#65a30d","#92400e","#f472b6","#475569"]', '$[' || ((row_number() OVER (ORDER BY `created`, `user_id`) - 1) % 12) || ']'), `created` FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;