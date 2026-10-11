CREATE TABLE "novedu_cloze_gap_counts" (
	"code" varchar(32),
	"gap" integer,
	"reference" text,
	"correct" integer DEFAULT 0 NOT NULL,
	"partial" integer DEFAULT 0 NOT NULL,
	"incorrect" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "novedu_cloze_gap_counts_pkey" PRIMARY KEY("code","gap","reference")
);
