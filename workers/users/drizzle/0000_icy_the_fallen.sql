CREATE TABLE `room_visits` (
	`user_id` text NOT NULL,
	`room_id` text NOT NULL,
	`last_visited_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `room_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_room_visits_user_recent` ON `room_visits` (`user_id`,`last_visited_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`room_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`title` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`picture` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);