import { DateTime } from "luxon";
import { useActor, useWorkspace } from "@console/core/actor";
import { user } from "@console/core/user/user.sql";
import { createTransaction } from "@console/core/util/transaction";
import { NotPublic, withApiAuth } from "../api";
import { ApiHandler, Response, useHeader, useJsonBody } from "sst/node/api";
import {
  eq,
  and,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  SQLWrapper,
  sql,
  SQL,
} from "drizzle-orm";
import { workspace } from "@console/core/workspace/workspace.sql";
import { stripe, usage } from "@console/core/billing/billing.sql";
import { app, appRepo, env, resource, stage } from "@console/core/app/app.sql";
import { awsAccount } from "@console/core/aws/aws.sql";
import {
  replicache_client,
  replicache_client_group,
  replicache_cvr,
} from "@console/core/replicache/replicache.sql";
import { lambdaPayload } from "@console/core/lambda/lambda.sql";
import { equals, groupBy, mapValues, pipe, toPairs } from "remeda";
import { log_poller, log_search } from "@console/core/log/log.sql";
import { PatchOperation, PullRequest, PullResponseV1 } from "replicache";
import { warning } from "@console/core/warning/warning.sql";
import {
  issue,
  issueSubscriber,
  issueCount,
  issueAlert,
} from "@console/core/issue/issue.sql";
import { MySqlColumn } from "drizzle-orm/mysql-core";
import { db } from "@console/core/drizzle";
import { githubOrg, githubRepo } from "@console/core/git/git.sql";
import { slackTeam } from "@console/core/slack/slack.sql";
import { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { gzipSync } from "zlib";
import {
  stateResourceTable,
  stateUpdateTable,
} from "@console/core/state/state.sql";
import { State } from "@console/core/state";

export const TABLES = {
  workspace,
  stripe,
  user,
  awsAccount,
  app,
  appRepo,
  env,
  stage,
  resource,
  log_poller,
  log_search,
  lambdaPayload,
  warning,
  issue,
  issueSubscriber,
  issueCount,
  issueAlert,
  githubOrg,
  githubRepo,
  slackTeam,
  usage,
  stateUpdate: stateUpdateTable,
  stateResource: stateResourceTable,
};

type TableName = keyof typeof TABLES;

const TABLE_KEY = {
  issue: [issue.stageID, issue.id],
  resource: [resource.stageID, resource.id],
  issueCount: [issueCount.group, issueCount.id],
  warning: [warning.stageID, warning.type, warning.id],
  usage: [usage.stageID, usage.id],
  stateUpdate: [stateUpdateTable.stageID, stateUpdateTable.id],
  stripe: [],
} as {
  [key in TableName]?: MySqlColumn[];
};

const TABLE_PROJECTION = {
  stateUpdate(input) {
    return State.serializeUpdate(input);
  },
} as {
  [key in TableName]?: (input: (typeof TABLES)[key]["$inferSelect"]) => any;
};

export const handler = ApiHandler(
  withApiAuth(async () => {
    NotPublic();
    const actor = useActor();
    console.log("actor", actor);

    const req: PullRequest = useJsonBody();
    console.log("request", req);
    if (req.pullVersion !== 1) {
      throw new Response({
        statusCode: 307,
        headers: {
          location: "/replicache/pull",
        },
      });
    }

    await db.insert(replicache_client_group).ignore().values({
      id: req.clientGroupID,
      cvrVersion: 0,
      actor,
      clientVersion: 0,
    });
    const resp = await createTransaction(
      async (tx): Promise<PullResponseV1 | undefined> => {
        const patch: PatchOperation[] = [];

        const group = await tx
          .select({
            id: replicache_client_group.id,
            cvrVersion: replicache_client_group.cvrVersion,
            clientVersion: replicache_client_group.clientVersion,
            actor: replicache_client_group.actor,
          })
          .from(replicache_client_group)
          .for("update")
          .where(and(eq(replicache_client_group.id, req.clientGroupID)))
          .execute()
          .then((rows) => rows.at(0)!);

        if (!equals(group.actor, actor)) {
          console.log("compare failed", group.actor, actor);
          return;
        }

        const oldCvr = await tx
          .select({
            data: replicache_cvr.data,
            clientVersion: replicache_cvr.clientVersion,
          })
          .from(replicache_cvr)
          .where(
            and(
              eq(replicache_cvr.clientGroupID, req.clientGroupID),
              eq(replicache_cvr.id, req.cookie as number)
            )
          )
          .execute()
          .then((rows) => rows.at(0));
        const cvr = oldCvr ?? {
          data: {},
          clientVersion: 0,
        };

        const toPut: Record<string, { id: string; key: string }[]> = {};
        const nextCvr = {
          data: {} as Record<string, number>,
          version: Math.max(req.cookie as number, group.cvrVersion) + 1,
        };

        if (!oldCvr) {
          patch.push({
            op: "clear",
          });
          patch.push({
            op: "put",
            key: "/init",
            value: true,
          });
        }

        const results: [
          string,
          { id: string; version: string; key: string }[]
        ][] = [];

        if (actor.type === "user") {
          console.log("syncing user");

          const tableFilters = {
            log_search: eq(log_search.userID, actor.properties.userID),
            usage: gte(
              usage.day,
              DateTime.now().toUTC().startOf("month").toSQLDate()!
            ),
            issueCount: gte(
              issueCount.hour,
              DateTime.now()
                .toUTC()
                .startOf("hour")
                .minus({ day: 1 })
                .toSQL({ includeOffset: false })!
            ),
            issue: isNull(issue.timeDeleted),
          } satisfies {
            [key in keyof typeof TABLES]?: SQLWrapper;
          };

          const workspaceID = useWorkspace();

          for (const [name, table] of Object.entries(TABLES)) {
            const key = TABLE_KEY[name as TableName] ?? [table.id];
            const query = tx
              .select({
                name: sql`${name}`,
                id: table.id,
                version: table.timeUpdated,
                key: sql.join([
                  sql`concat_ws(`,
                  sql.join([sql`'/'`, sql`''`, sql`${name}`, ...key], sql`, `),
                  sql.raw(`)`),
                ]) as SQL<string>,
              })
              .from(table)
              .where(
                and(
                  eq(
                    "workspaceID" in table ? table.workspaceID : table.id,
                    workspaceID
                  ),
                  ...(name in tableFilters
                    ? [tableFilters[name as keyof typeof tableFilters]]
                    : [])
                )
              );
            console.log("getting updated from", name);
            const rows = await query.execute();
            results.push([name, rows]);
          }
        }

        if (actor.type === "account") {
          console.log("syncing account");

          const [users] = await Promise.all([
            await tx
              .select({
                id: user.id,
                key: sql<string>`concat('/user/', ${user.id})`,
                version: user.timeUpdated,
              })
              .from(user)
              .innerJoin(workspace, eq(user.workspaceID, workspace.id))
              .where(
                and(
                  eq(user.email, actor.properties.email),
                  isNull(user.timeDeleted),
                  isNull(workspace.timeDeleted)
                )
              )
              .execute(),
          ]);
          results.push(["user", users]);

          const workspaces = await tx
            .select({
              id: workspace.id,
              version: workspace.timeUpdated,
              key: sql<string>`concat('/workspace/', ${workspace.id})`,
            })
            .from(workspace)
            .leftJoin(user, eq(user.workspaceID, workspace.id))
            .where(
              and(
                eq(user.email, actor.properties.email),
                isNull(user.timeDeleted),
                isNull(workspace.timeDeleted)
              )
            )
            .execute();
          results.push(["workspace", workspaces]);
        }

        for (const [name, rows] of results) {
          const arr = [];
          for (const row of rows) {
            const version = new Date(row.version).getTime();
            if (cvr.data[row.key] !== version) {
              arr.push(row);
            }
            delete cvr.data[row.key];
            nextCvr.data[row.key] = version;
          }
          toPut[name] = arr;
        }

        console.log(
          "toPut",
          mapValues(toPut, (value) => value.length)
        );

        console.log("toDel", cvr.data);

        // new data
        for (const [name, items] of Object.entries(toPut)) {
          console.log(name);
          const ids = items.map((item) => item.id);
          const keys = Object.fromEntries(
            items.map((item) => [item.id, item.key])
          );

          if (!ids.length) continue;
          const table = TABLES[name as keyof typeof TABLES];
          let offset = 0;
          const page = 10_000;
          while (true) {
            console.log("fetching", name, "offset", offset);
            const rows = await tx
              .select()
              .from(table)
              .where(
                and(
                  "workspaceID" in table && actor.type === "user"
                    ? eq(table.workspaceID, useWorkspace())
                    : undefined,
                  inArray(table.id, ids)
                )
              )
              .offset(offset)
              .limit(page)
              .execute();
            const projection =
              TABLE_PROJECTION[name as keyof typeof TABLE_PROJECTION];

            for (const row of rows) {
              const key = keys[row.id]!;
              patch.push({
                op: "put",
                key,
                value: projection ? projection(row as any) : row,
              });
            }
            if (rows.length < page) break;
            offset += rows.length;
          }
        }

        // remove deleted data
        for (const [key] of Object.entries(cvr.data)) {
          patch.push({
            op: "del",
            key,
          });
        }

        const clients = await tx
          .select({
            id: replicache_client.id,
            mutationID: replicache_client.mutationID,
            clientVersion: replicache_client.clientVersion,
          })
          .from(replicache_client)
          .where(
            and(
              eq(replicache_client.clientGroupID, req.clientGroupID),
              gt(replicache_client.clientVersion, cvr.clientVersion)
            )
          )
          .execute();

        const lastMutationIDChanges = Object.fromEntries(
          clients.map((c) => [c.id, c.mutationID] as const)
        );
        if (patch.length > 0 || Object.keys(lastMutationIDChanges).length > 0) {
          console.log("inserting", req.clientGroupID);
          await tx
            .update(replicache_client_group)
            .set({
              cvrVersion: nextCvr.version,
            })
            .where(eq(replicache_client_group.id, req.clientGroupID))
            .execute();

          await tx
            .insert(replicache_cvr)
            .values({
              id: nextCvr.version,
              data: nextCvr.data,
              clientGroupID: req.clientGroupID,
              clientVersion: group.clientVersion,
            })
            .onDuplicateKeyUpdate({
              set: {
                data: nextCvr.data,
              },
            })
            .execute();

          await tx
            .delete(replicache_cvr)
            .where(
              and(
                eq(replicache_cvr.clientGroupID, req.clientGroupID),
                lt(replicache_cvr.id, nextCvr.version - 10)
              )
            );

          return {
            patch,
            cookie: nextCvr.version,
            lastMutationIDChanges,
          };
        }

        return {
          patch: [],
          cookie: req.cookie,
          lastMutationIDChanges,
        };
      }
    );

    const response: APIGatewayProxyStructuredResultV2 = {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(resp),
    };

    const isGzip = useHeader("accept-encoding");
    if (isGzip) {
      console.log("gzipping");
      response.headers!["content-encoding"] = "gzip";
      const buff = gzipSync(response.body || "");
      response.body = buff.toString("base64");
      response.isBase64Encoded = true;
      console.log("done gzip");
    }

    return response;
  })
);
