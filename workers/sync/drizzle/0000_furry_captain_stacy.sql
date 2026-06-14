CREATE TABLE `room_meta` (
	`room_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`title` text DEFAULT 'Untitled' NOT NULL,
	`rev` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL
);
