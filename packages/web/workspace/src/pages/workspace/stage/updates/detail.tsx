import {
  For,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createSignal,
} from "solid-js";
import { useReplicache } from "$/providers/replicache";
import { Link, useParams } from "@solidjs/router";
import { StateUpdateStore, StateEventStore } from "$/data/app";
import { State } from "@console/core/state";
import { DateTime } from "luxon";
import { useStageContext } from "../context";
import {
  CMD_MAP,
  STATUS_MAP,
  countCopy,
  errorCountCopy,
  UpdateStatusIcon,
} from "./list";
import { NotFound } from "$/pages/not-found";
import { inputFocusStyles } from "$/ui/form";
import { styled } from "@macaron-css/solid";
import { formatDuration, formatSinceTime } from "$/common/format";
import { useReplicacheStatus } from "$/providers/replicache-status";
import { IconCheck, IconDocumentDuplicate } from "$/ui/icons";
import { Row, Tag, Text, Stack, theme, utility } from "$/ui";
import { sortBy } from "remeda";

const RES_LEFT_BORDER = "4px";

const Container = styled("div", {
  base: {
    ...utility.row(6),
    padding: theme.space[4],
  },
});

const Content = styled("div", {
  base: {
    minWidth: 0,
    flex: "1 1 auto",
  },
});

const PageTitle = styled("h1", {
  base: {
    ...utility.row(3.5),
    alignItems: "center",
  },
});

const PageTitleCopy = styled("h1", {
  base: {
    fontFamily: theme.font.family.code,
    fontSize: theme.font.size.mono_2xl,
    fontWeight: theme.font.weight.medium,
  },
});

const PageTitlePrefix = styled("span", {
  base: {
    marginRight: 1,
    fontFamily: theme.font.family.code,
    fontSize: theme.font.size.mono_xl,
    fontWeight: theme.font.weight.regular,
  },
});

const PageTitleStatus = styled("p", {
  base: {
    marginLeft: `calc(${theme.space[3.5]} + 12px)`,
    fontSize: theme.font.size.sm,
    color: theme.color.text.secondary.base,
  },
});

const ErrorInfo = styled("div", {
  base: {
    padding: theme.space[4],
    borderRadius: theme.borderRadius,
    backgroundColor: theme.color.background.red,
    fontSize: theme.font.size.sm,
    lineHeight: theme.font.lineHeight,
    color: `hsla(${theme.color.red.l2}, 100%)`,
  },
});

const ResourceEmpty = styled("div", {
  base: {
    height: 200,
    border: `1px solid ${theme.color.divider.base}`,
    borderRadius: theme.borderRadius,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: theme.color.text.dimmed.base,
  },
});

const ResourceRoot = styled("div", {
  base: {
    borderRadius: theme.borderRadius,
    borderStyle: "solid",
    borderWidth: `1px 1px 1px ${RES_LEFT_BORDER}`,
    borderColor: theme.color.divider.base,
  },
  variants: {
    action: {
      created: {
        borderLeftColor: `hsla(${theme.color.blue.l2}, 100%)`,
      },
      updated: {
        borderLeftColor: `hsla(${theme.color.brand.l2}, 100%)`,
      },
      deleted: {
        borderLeftColor: `hsla(${theme.color.red.l1}, 100%)`,
      },
      same: {
        borderLeftColor: theme.color.divider.base,
      },
    },
  },
});

const ResourceChild = styled("div", {
  base: {
    ...utility.row(4),
    justifyContent: "space-between",
    padding: `${theme.space[4]} ${theme.space[4]} ${theme.space[4]} calc(${theme.space[4]} - ${RES_LEFT_BORDER} + 1px)`,
    alignItems: "center",
    borderBottom: `1px solid ${theme.color.divider.base}`,
    position: "relative",
    ":last-child": {
      borderBottom: 0,
    },
    selectors: {
      "&[data-focus='true']": {
        ...inputFocusStyles,
        outlineOffset: -1,
      },
    },
  },
});

const ResourceChildEmpty = styled("div", {
  base: {
    padding: `${theme.space[4]} ${theme.space[4]} ${theme.space[4]} calc(${theme.space[4]} - ${RES_LEFT_BORDER} + 1px)`,
    color: theme.color.text.dimmed.base,
    fontSize: theme.font.size.sm,
    lineHeight: "normal",
  },
});

const ResourceKey = styled("span", {
  base: {
    ...utility.text.line,
    fontFamily: theme.font.family.code,
    fontSize: theme.font.size.mono_base,
    lineHeight: "normal",
    minWidth: "33%",
  },
});

const ResourceValue = styled("span", {
  base: {
    ...utility.text.line,
    fontFamily: theme.font.family.code,
    fontSize: theme.font.size.mono_sm,
    color: theme.color.text.dimmed.base,
    lineHeight: "normal",
  },
});

const ResourceCopyButton = styled("button", {
  base: {
    flexShrink: 0,
    height: 16,
    width: 16,
    color: theme.color.icon.dimmed,
    ":hover": {
      color: theme.color.icon.secondary,
    },
  },
  variants: {
    copying: {
      true: {
        cursor: "default",
        color: theme.color.accent,
        ":hover": {
          color: theme.color.accent,
        },
      },
    },
  },
});

const Sidebar = styled("div", {
  base: {
    flex: "0 0 auto",
    width: 300,
    paddingTop: theme.space[1.5],
  },
});

const PanelTitle = styled("span", {
  base: {
    ...utility.text.label,
    fontSize: theme.font.size.mono_sm,
    color: theme.color.text.dimmed.base,
  },
});

const PanelValueMono = styled("span", {
  base: {
    color: theme.color.text.secondary.base,
    fontFamily: theme.font.family.code,
    fontSize: theme.font.size.mono_base,
    fontWeight: theme.font.weight.medium,
  },
});

export function Detail() {
  const params = useParams();
  const rep = useReplicache();
  const ctx = useStageContext();
  const replicacheStatus = useReplicacheStatus();
  const update = StateUpdateStore.get.watch(rep, () => [
    ctx.stage.id,
    params.updateID,
  ]);
  const resources = StateEventStore.forUpdate.watch(
    rep,
    () => [ctx.stage.id, params.updateID],
    (resources) => sortBy(resources, [(r) => r.urn.split("::").at(-1)!, "asc"]),
  );

  const errors = () => (update() && update().errors ? update().errors : 0);
  const status = createMemo(() => {
    if (!update()) return;
    return update().time.completed
      ? update().errors
        ? "error"
        : "updated"
      : // : update().time.canceled
        //   ? "canceled"
        //   : update().time.queued
        //     ? "queued"
        "updating";
  });
  const deleted = createMemo(() =>
    resources().filter((r) => r.action === "deleted"),
  );
  const created = createMemo(() =>
    resources().filter((r) => r.action === "created"),
  );
  const updated = createMemo(() =>
    resources().filter((r) => r.action === "updated"),
  );
  const isEmpty = createMemo(
    () =>
      update() &&
      !deleted().length &&
      !created().length &&
      !updated().length &&
      !update().resource.same,
  );

  return (
    <Switch>
      <Match
        when={
          replicacheStatus.isSynced(rep().name) && !update() && update.ready
        }
      >
        <NotFound inset="stage" />
      </Match>
      <Match when={update()}>
        <Container>
          <Content>
            <Stack space="6">
              <Stack space="4">
                <Stack space="2.5">
                  <PageTitle>
                    <UpdateStatusIcon status={status()} />
                    <PageTitleCopy>
                      Update <PageTitlePrefix>#</PageTitlePrefix>
                      {update().index}
                    </PageTitleCopy>
                  </PageTitle>
                  <PageTitleStatus>
                    {status() === "error"
                      ? errorCountCopy(errors())
                      : STATUS_MAP[status()!]}
                  </PageTitleStatus>
                </Stack>
                <Show when={update().errors}>
                  <ErrorInfo>
                    Invalid component name "FunctionA". Component names must be
                    unique.
                  </ErrorInfo>
                </Show>
              </Stack>
              <Stack space="5">
                <Show
                  when={!isEmpty()}
                  fallback={<ResourceEmpty>No changes</ResourceEmpty>}
                >
                  <Show when={deleted().length}>
                    <Stack space="2">
                      <PanelTitle>Removed</PanelTitle>
                      <ResourceRoot action="deleted">
                        <For each={deleted()}>{(r) => <Resource {...r} />}</For>
                      </ResourceRoot>
                    </Stack>
                  </Show>
                  <Show when={created().length}>
                    <Stack space="2">
                      <PanelTitle>Added</PanelTitle>
                      <ResourceRoot action="created">
                        <For each={created()}>{(r) => <Resource {...r} />}</For>
                      </ResourceRoot>
                    </Stack>
                  </Show>
                  <Show when={updated().length}>
                    <Stack space="2">
                      <PanelTitle>Updated</PanelTitle>
                      <ResourceRoot action="updated">
                        <For each={updated()}>{(r) => <Resource {...r} />}</For>
                      </ResourceRoot>
                    </Stack>
                  </Show>
                  <Show when={update().resource.same! > 0}>
                    <Stack space="2">
                      <PanelTitle>Unchanged</PanelTitle>
                      <ResourceRoot action="same">
                        <ResourceChildEmpty>
                          {countCopy(update().resource.same!)} were not changed
                        </ResourceChildEmpty>
                      </ResourceRoot>
                    </Stack>
                  </Show>
                </Show>
              </Stack>
            </Stack>
          </Content>
          <Sidebar>
            <Stack space="7">
              <Stack space="2">
                <PanelTitle>Started</PanelTitle>
                <Text
                  color="secondary"
                  title={
                    update().time.started
                      ? DateTime.fromISO(update().time.started!).toLocaleString(
                          DateTime.DATETIME_FULL,
                        )
                      : undefined
                  }
                >
                  {update().time.started
                    ? formatSinceTime(
                        DateTime.fromISO(update().time.started!).toSQL()!,
                        true,
                      )
                    : "—"}
                </Text>
              </Stack>
              <Stack space="2">
                <PanelTitle>Duration</PanelTitle>
                <Text color="secondary">
                  {update().time.started && update().time.completed
                    ? formatDuration(
                        DateTime.fromISO(update().time.completed!)
                          .diff(DateTime.fromISO(update().time.started!))
                          .as("milliseconds"),
                        true,
                      )
                    : "—"}
                </Text>
              </Stack>
              <Stack space="2">
                <PanelTitle>Command</PanelTitle>
                <PanelValueMono>{CMD_MAP[update().command]}</PanelValueMono>
              </Stack>
            </Stack>
          </Sidebar>
        </Container>
      </Match>
    </Switch>
  );
}

function Resource(props: State.ResourceEvent) {
  const [copying, setCopying] = createSignal(false);
  const name = createMemo(() => props.urn.split("::").at(-1));
  return (
    <ResourceChild>
      <Row space="3" vertical="center">
        <ResourceKey>{name()}</ResourceKey>
        <ResourceCopyButton
          copying={copying()}
          onClick={() => {
            setCopying(true);
            navigator.clipboard.writeText(props.urn);
            setTimeout(() => setCopying(false), 2000);
          }}
        >
          <Show when={!copying()} fallback={<IconCheck />}>
            <IconDocumentDuplicate />
          </Show>
        </ResourceCopyButton>
      </Row>
      <ResourceValue>{props.type}</ResourceValue>
    </ResourceChild>
  );
}
