import {
  mysqlTable,
  varchar,
  mysqlEnum,
  foreignKey,
  json,
  boolean,
  unique,
  timestamp,
  int,
} from "drizzle-orm/mysql-core";
import { cuid, timestamps, timestampsNext, workspaceID } from "../util/sql";
import { stage } from "../app/app.sql";
import { workspaceIndexes } from "../workspace/workspace.sql";
import { z } from "zod";

export const Source = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cli"),
    properties: z.object({}),
  }),
  z.object({
    type: z.literal("ci"),
    properties: z.object({}),
  }),
]);
export type Source = z.infer<typeof Source>;

export const UpdateCommand = z.union([
  z.literal("deploy"),
  z.literal("refresh"),
  z.literal("remove"),
  z.literal("edit"),
]);

export const Command = ["deploy", "refresh", "remove", "edit"] as const;

export const stateUpdateTable = mysqlTable(
  "state_update",
  {
    ...workspaceID,
    stageID: cuid("stage_id").notNull(),
    command: mysqlEnum("command", Command).notNull(),
    source: json("source").$type<Source>().notNull(),
    ...timestampsNext,
    timeStarted: timestamp("time_started"),
    timeCompleted: timestamp("time_completed"),
    resourceDeleted: int("resource_deleted"),
    resourceCreated: int("resource_created"),
    resourceUpdated: int("resource_updated"),
    resourceSame: int("resource_same"),
    errors: int("errors"),
  },

  (table) => ({
    ...workspaceIndexes(table),
    stageID: foreignKey({
      columns: [table.workspaceID, table.stageID],
      foreignColumns: [stage.workspaceID, stage.id],
    }).onDelete("cascade"),
  })
);

export const stateResourceTable = mysqlTable(
  "state_resource",
  {
    ...workspaceID,
    stageID: cuid("stage_id").notNull(),
    updateID: cuid("update_id").notNull(),
    type: varchar("type", { length: 255 }).notNull(),
    urn: varchar("urn", { length: 255 }).notNull(),
    outputs: json("outputs").notNull(),
    action: mysqlEnum("action", ["created", "updated", "deleted"]).notNull(),
    inputs: json("inputs").notNull(),
    parent: varchar("parent", { length: 255 }),
    custom: boolean("custom").notNull(),
    timeCreated: timestamp("time_created").notNull(),
    timeUpdated: timestamp("time_updated").notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => ({
    ...workspaceIndexes(table),
    stageID: foreignKey({
      columns: [table.workspaceID, table.stageID],
      foreignColumns: [stage.workspaceID, stage.id],
    }).onDelete("cascade"),
    urn: unique("urn").on(
      table.workspaceID,
      table.stageID,
      table.updateID,
      table.urn
    ),
    updateID: foreignKey({
      name: "update_id",
      columns: [table.workspaceID, table.updateID],
      foreignColumns: [stateUpdateTable.workspaceID, stateUpdateTable.id],
    }).onDelete("cascade"),
  })
);
