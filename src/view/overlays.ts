/**
 * Everything drawn over or in place of the composer: the completion popup,
 * pickers, the approval panel, extension dialogs, the settings window, the
 * subagent transcript and toasts.
 */
import type { TextEditor } from "../editor.js";
import { EDITOR_ID } from "./dock.js";
import { h, s, type ActivateEvent, type ChangeEvent, type EditEvent, type Node, type SelectEvent, type Span } from "./h.js";

export interface Completion {
  /** Unique within the list; also the node key. */
  id: string;
  label: string;
  /** The typed prefix length to mark in the label. */
  mark?: number;
  detail?: string;
  value?: string;
  icon?: string;
}

const key = (id: string): string => id.replace(/[^\w-]/g, "_") || "_";

/** The completion popup at the composer's caret. */
export function completionPopup(items: readonly Completion[], selected: number, onPick: (index: number) => void): Node {
  const base = "layer.complete.select.list";
  const keys = items.map((item, index) => `${index}-${key(item.id)}`);
  return h("overlay", { key: "complete", anchor: { caret: EDITOR_ID }, role: "omp.autocomplete" }, [
    h("col", { key: "select", role: "omp.select" }, [
      h(
        "list",
        {
          key: "list",
          selected: keys[selected] ? `${base}.${keys[selected]}` : null,
          empty: "No items",
          max: { lines: 10 },
          actions: { click: "select", dblclick: "activate" },
          onSelect: (event: SelectEvent) => pick(event.item),
          onActivate: (event: ActivateEvent) => pick(event.item),
        },
        items.map((item, index) => {
          const marked = Math.min(item.mark ?? 0, item.label.length);
          const label: Span[] = marked > 0 ? [s(item.label.slice(0, marked), "mark"), ...(marked < item.label.length ? [s(item.label.slice(marked))] : [])] : [s(item.label)];
          return h("item", {
            key: keys[index],
            ...(item.icon ? { icon: item.icon } : {}),
            label,
            ...(item.detail ? { detail: [s(item.detail, "muted")] } : {}),
            ...(item.value ? { value: [s(item.value, "muted")] } : {}),
          });
        }),
      ),
    ]),
  ]);
  function pick(id: string | undefined): void {
    const index = keys.findIndex(k => `${base}.${k}` === id || k === id);
    if (index >= 0) onPick(index);
  }
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  mono?: boolean;
  dot?: string;
  tone?: string;
  disabled?: string | true;
  facts?: Record<string, string | number>;
  badges?: { text: string; tone?: string; title?: string }[];
  node?: "user" | "assistant" | "tool" | "marker";
  depth?: number;
  mark?: { text: string; seed?: string; icon?: string };
  /** Extra text the search matches besides the label and detail. */
  search?: string;
  /** The group this item sits under when the picker groups. */
  group?: string;
}

export interface PickerAction {
  id: string;
  label: string;
  keys?: string[];
  primary?: boolean;
  danger?: boolean;
  end?: boolean;
  on?: boolean;
  disabled?: string | true;
}

/** What a picker shows now; the controller owns filtering, selection and keys. */
export interface PickerView {
  /** Static props: title, icon, noun, size, layout, placeholder, columns, preview. */
  props: Record<string, unknown>;
  items: readonly PickerItem[];
  /** Bumped when `items` changes, so unchanged catalogues are not re-sent. */
  itemsRev: number;
  /** The filtered ids (and group headers) in order; absent shows `items` as given. */
  order?: readonly (string | { group: string; label: string; count?: number })[];
  hits?: Record<string, [number, number][]>;
  query: string | null;
  cursor: number;
  selected: string | null;
  current?: readonly string[];
  tabs?: { id: string; label: string; count?: number }[];
  tab?: string;
  scopes?: { id: string; label: string; icon?: string; count?: number; group?: string }[];
  scope?: string;
  actions: PickerAction[];
  confirm?: { text: string; act: string; label?: string } | null;
  state?: "ready" | "loading" | "error";
  message?: string;
  empty?: string;
  preview?: Node[];
}

export interface PickerHandlers {
  select(id: string): void;
  activate(id: string): void;
  change(item: string, value: unknown): void;
}

const pickerItems = new WeakMap<readonly PickerItem[], { rev: number; wire: unknown[] }>();

/**
 * A data-first picker sheet; under `layer` it is itself the modal. Its buttons,
 * tabs and scopes send `action` events no node handler takes: the controller
 * reads them from the session by this node's id (`layer.picker`).
 */
export function pickerNode(view: PickerView, on: PickerHandlers): Node {
  // The catalogue is converted once per revision; an equal list diffs to nothing while the user types.
  let wire = pickerItems.get(view.items);
  if (!wire || wire.rev !== view.itemsRev) {
    wire = { rev: view.itemsRev, wire: view.items.map(({ search: _search, group: _group, ...item }) => item) };
    pickerItems.set(view.items, wire);
  }
  return h(
    "picker",
    {
      key: "picker",
      ...view.props,
      query: view.query,
      ...(view.query !== null ? { cursor: view.cursor } : {}),
      items: wire.wire,
      ...(view.order ? { order: view.order } : {}),
      ...(view.hits && Object.keys(view.hits).length ? { hits: view.hits } : {}),
      selected: view.selected,
      ...(view.current ? { current: view.current } : {}),
      total: view.items.length,
      ...(view.tabs ? { tabs: view.tabs, tab: view.tab } : {}),
      ...(view.scopes ? { scopes: view.scopes, scope: view.scope } : {}),
      actions: view.actions,
      ...(view.confirm ? { confirm: view.confirm } : {}),
      state: view.state ?? "ready",
      ...(view.message ? { message: view.message } : {}),
      ...(view.empty ? { empty: view.empty } : {}),
      onSelect: (event: SelectEvent) => on.select(event.item),
      onActivate: (event: ActivateEvent) => on.activate(event.item),
      onChange: (event: ChangeEvent) => on.change(event.item ?? "", event.value),
    },
    view.preview ?? [],
  );
}

function actionButton(label: string, id: string, keys: string[], onClick: () => void, variant?: "primary" | "danger", title?: string): Node {
  return h("button", { key: id, role: "omp.btn", text: label, keys, size: "md", ...(variant ? { variant } : {}), title: title ?? `${label}  ${keys.join("+")}`, onClick });
}

export interface ApprovalView {
  title: string;
  details: string[];
  choices: { id: string; label: string; deny: boolean }[];
  selected: string;
  expanded: boolean;
  /** Milliseconds left before the request times out, when it has a timeout. */
  remaining?: number;
}

/** The approval panel above the composer: what is asked, the choices, Approve and Deny. */
export function approvalPanel(view: ApprovalView, on: { take(id: string): void; approve(): void; deny(): void; expand(): void }): Node {
  const long = view.details.length > 6 || view.details.some(line => line.length > 160);
  const shown = view.expanded || !long ? view.details : view.details.slice(0, 6);
  return h("col", { key: "approval", role: "omp.editor.ask.approval", gap: "md" }, [
    h("text", { key: "title", role: "omp.approval.title", tone: "accent", text: view.title }),
    shown.length
      ? h(
          "col",
          { key: "details", role: "omp.approval.details" },
          shown.map((line, index) => h("text", { key: String(index), text: line, ...(view.expanded ? { wrap: "char" } : { truncate: "end" }), spans: [s(line, "mono")] })),
        )
      : null,
    h(
      "list",
      {
        key: "choices",
        role: "omp.approval.choices",
        selected: `dock.approval.choices.${view.selected}`,
        actions: { click: "select", dblclick: "activate" },
        onSelect: (event: SelectEvent) => on.take(String(event.item).split(".").at(-1) ?? ""),
        onActivate: (event: ActivateEvent) => on.take(String(event.item).split(".").at(-1) ?? ""),
      },
      view.choices.map(choice => h("item", { key: choice.id, role: "omp.approval.choice", label: choice.label, tone: choice.deny ? "error" : "accent" })),
    ),
    h("row", { key: "actions", role: "omp.actions", gap: "sm", align: "center" }, [
      view.remaining !== undefined ? h("elapsed", { key: "timer", age: -Math.max(0, view.remaining), format: "short" }) : null,
      h("spacer", { key: "fill", grow: 1 }),
      long ? actionButton(view.expanded ? "Less" : "Details", "expand", ["ctrl", "o"], on.expand, undefined, view.expanded ? "Summarize this call  ctrl+o" : "Show every detail of this call  ctrl+o") : null,
      actionButton("Deny", "deny", ["escape"], on.deny, "danger", "Deny this call  escape"),
      actionButton("Approve", "approve", ["ctrl", "enter"], on.approve, "primary", "Approve this call  ctrl+enter"),
    ]),
  ]);
}

export interface FieldView {
  title: string;
  detail: string;
  placeholder: string;
  multiline: boolean;
  editor: TextEditor;
  remaining?: number;
}

/** An extension's `input` or `editor` request, in the composer's place. */
export function fieldDialog(view: FieldView, on: { submit(): void; cancel(): void; edit(event: EditEvent): void; undo(): void }): Node {
  const part = view.multiline ? "omp.hook-editor" : "omp.hook-input";
  const field = view.multiline
    ? h("col", { key: "field", role: `${part}.field` }, [
        h("editor", {
          key: "input",
          text: view.editor.text,
          cursor: view.editor.cursor,
          ...(view.editor.anchor !== null ? { anchor: view.editor.anchor } : {}),
          sendable: false,
          placeholder: [s(view.placeholder || "Type here")],
          maxLines: 18,
          onEdit: on.edit,
          onUndo: on.undo,
        }),
      ])
    : h("col", { key: "field", role: `${part}.field` }, [
        h("col", { key: "form", gap: "md", role: "omp.form" }, [
          h("col", { key: "f", gap: "sm", role: "omp.form.field" }, [
            h("input", {
              key: "input",
              text: view.editor.text,
              cursor: view.editor.cursor,
              ...(view.editor.anchor !== null ? { anchor: view.editor.anchor } : {}),
              sendable: false,
              prompt: "> ",
              ...(view.placeholder ? { placeholder: view.placeholder } : {}),
              onEdit: on.edit,
              onUndo: on.undo,
            }),
          ]),
        ]),
      ]);
  return h("col", { key: "field", role: view.multiline ? "omp.overlay.hook-editor" : "omp.overlay.hook-input" }, [
    h("col", { key: "head", role: `${part}.head`, gap: "xs" }, [
      h("row", { key: "line", gap: "md", align: "baseline" }, [
        h("text", { key: "title", role: `${part}.title`, wrap: "word", grow: 1, spans: [s(view.title)] }),
        view.remaining !== undefined
          ? h("row", { key: "timer", role: `${part}.timer`, title: "Cancels when the time runs out" }, [h("elapsed", { key: "0", age: -Math.max(0, view.remaining), format: "short" })])
          : null,
      ]),
      view.detail ? h("text", { key: "detail", role: `${part}.detail`, wrap: "word", spans: [s(view.detail)] }) : null,
    ]),
    field,
    h("row", { key: "actions", role: "omp.actions", gap: "sm", align: "center" }, [
      h("spacer", { key: "fill", grow: 1 }),
      actionButton("Cancel", "cancel", ["escape"], on.cancel),
      actionButton("Submit", "submit", view.multiline ? ["ctrl", "enter"] : ["enter"], on.submit, "primary", view.multiline ? "Submit  ctrl+enter · New line  enter" : "Submit  enter"),
    ]),
  ]);
}

/** The wire id of the field a dialog edits. */
export function fieldInputId(multiline: boolean): string {
  return multiline ? "dock.field.field.input" : "dock.field.field.form.f.input";
}

export interface Toast {
  id: number;
  text: string;
  sub?: string;
  tone?: "info" | "warning" | "error" | "success";
  /** An action button on the toast (Undo). */
  action?: { act: string; label?: string; run(): void };
}

export function toastNodes(toasts: readonly Toast[]): Node[] {
  return toasts.map(toast =>
    h("toast", {
      key: `toast${toast.id}`,
      text: toast.text,
      ...(toast.sub ? { sub: toast.sub } : {}),
      ...(toast.tone && toast.tone !== "info" ? { tone: toast.tone } : {}),
      ttl: toast.action ? 6000 : 2400,
      ...(toast.action ? { action: toast.action.act, ...(toast.action.label ? { label: toast.action.label } : {}), onAction: { [toast.action.act]: () => toast.action!.run() } } : {}),
    }),
  );
}

/** A modal sheet with a head, a body and a Close button. */
export function sheet(id: string, head: string, size: "sm" | "md" | "lg" | "full", body: (Node | null)[], onClose: () => void, extra: (Node | null)[] = []): Node {
  // The actions ride in the overlay's footer so a long body scrolls under them.
  const foot = h("row", { role: "omp.actions", gap: "sm", align: "center" }, [h("spacer", { key: "fill", grow: 1 }), ...extra, actionButton("Close", "close", ["escape"], onClose)]);
  return h("overlay", { key: id, anchor: "center", modal: true, size, head, role: `omp.overlay.${id}`, foot }, body);
}

export interface PrefsRow {
  id: string;
  label: string;
  hint?: string;
  changed?: boolean;
  defaultLabel?: string;
  disabled?: string;
  control: Record<string, unknown>;
}

export interface PrefsView {
  title: string;
  pages: { id: string; label: string; icon?: string }[];
  page: string;
  lead?: string;
  sections: { id: string; title: string; rows: PrefsRow[] }[];
  focus: string | null;
}

/** The settings window: pages of typed rows the terminal draws natively. */
export function prefsNode(view: PrefsView, on: { change(row: string, value: unknown): void; select(item: string): void }): Node {
  return h("prefs", {
    key: "prefs",
    title: view.title,
    pages: view.pages,
    page: view.page,
    ...(view.lead ? { lead: view.lead } : {}),
    sections: view.sections,
    focus: view.focus,
    onChange: (event: ChangeEvent) => on.change(event.item ?? "", event.value),
    onSelect: (event: SelectEvent) => on.select(event.item),
  });
}
