CREATE TABLE "canvas_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"email" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD COLUMN "expires_at" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_invites_canvas_email_idx" ON "canvas_invites" USING btree ("canvas_id","email");--> statement-breakpoint
CREATE INDEX "canvas_invites_email_idx" ON "canvas_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "canvas_invites_token_idx" ON "canvas_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "workspace_invites_token_idx" ON "workspace_invites" USING btree ("token_hash");