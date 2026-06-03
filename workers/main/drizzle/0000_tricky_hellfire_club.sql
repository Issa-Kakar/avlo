CREATE TABLE `room_meta` (
	`room_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
