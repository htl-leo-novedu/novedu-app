CREATE TABLE "novedu_moodle_links" (
	"issuer" varchar(255),
	"user_id" varchar(64),
	"moodle_user_id" varchar(255) NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "novedu_moodle_links_pkey" PRIMARY KEY("issuer","user_id")
);
--> statement-breakpoint
CREATE TABLE "novedu_moodle_targets" (
	"issuer" varchar(255),
	"user_id" varchar(64),
	"code" varchar(32),
	"lineitem_url" text NOT NULL,
	"arrived_at" timestamp with time zone NOT NULL,
	"handed_in_at" timestamp with time zone,
	CONSTRAINT "novedu_moodle_targets_pkey" PRIMARY KEY("issuer","user_id","code")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_novedu_moodle_links_moodle_user" ON "novedu_moodle_links" ("issuer","moodle_user_id");--> statement-breakpoint
CREATE INDEX "ix_novedu_moodle_targets_code" ON "novedu_moodle_targets" ("code");