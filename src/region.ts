/**
 * A region reconciled block by block.
 *
 * The SDK diffs a whole view on every frame, which costs time in proportion
 * to the transcript's length even when one word arrived. Here the transcript
 * is a list of keyed blocks: a block whose node is the same object as last
 * frame is skipped outright, a changed one is diffed alone, and the SDK's
 * child diff runs over the list only when a block is added, removed or
 * moved. A frame then costs what changed.
 *
 * The ids are the ones the SDK would give (`main.<key>.…`), so `reveal`,
 * `settle` and events address these nodes as any other.
 */
import { Node, View, type Op, type Tree, type TspEvent } from "@stencil-hq/tern";

interface Block {
  key: string;
  node: Node;
  /** The block alone under the region root: its subtree with the ids it has in the whole. */
  view: View;
}

const keyOf = (node: Node): string => String(node.props["key"]);

export class BlockRegion {
  readonly id: string;
  #blocks: Block[] = [];
  #byKey = new Map<string, Block>();
  #sent = false;

  constructor(id: "main" | "dock" | "layer") {
    this.id = id;
  }

  #alone(node: Node): View {
    return View.from({ [this.id]: new Node("col", {}, [node]) });
  }

  #tree(block: Block): Tree {
    return block.view.find(`${this.id}.${block.key}`)!;
  }

  /** Forgets what was sent: the next `ops` drops the region and sends it whole. */
  reset(): void {
    this.#blocks = [];
    this.#byKey.clear();
  }

  /** The ops turning the region as last sent into `nodes`, each with a unique string `key`. */
  ops(nodes: readonly Node[], surface: string): Op[] {
    const ops: Op[] = [];
    const old = this.#blocks;
    const next: Block[] = new Array(nodes.length);
    let sameShape = this.#sent && old.length === nodes.length;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const was = old[index];
      // The common case by far: the same node in the same place.
      if (was && was.node === node) {
        next[index] = was;
        continue;
      }
      const key = keyOf(node);
      const known = was && was.key === key ? was : this.#byKey.get(key);
      if (!known || known !== was || known.node.kind !== node.kind) sameShape = false;
      next[index] = known && known.node === node ? known : { key, node, view: this.#alone(node) };
    }

    if (!this.#sent || !old.length) {
      // First frame, or after a reset: the region whole.
      if (this.#sent) ops.push(["del", this.id]);
      ops.push(["add", this.id, surface, null, { id: this.id, k: "col", c: next.map(block => this.#tree(block).wire()) }]);
    } else if (sameShape) {
      for (let index = 0; index < next.length; index += 1) {
        if (next[index] !== old[index]) ops.push(...old[index]!.view.ops(next[index]!.view, surface));
      }
    } else {
      // Blocks came, went or moved: the SDK's child diff over stand-ins places
      // them, then each kept block that changed is diffed on its own.
      const stub = (blocks: readonly Block[]): View => View.from({ [this.id]: new Node("col", {}, blocks.map(block => new Node(block.node.kind, { key: block.key }))) });
      const fresh = new Map(next.map(block => [`${this.id}.${block.key}`, block]));
      for (const op of stub(old).ops(stub(next), surface)) {
        if (op[0] === "add") ops.push(["add", op[1], op[2], op[3], this.#tree(fresh.get(op[1])!).wire()]);
        else ops.push(op);
      }
      for (const block of next) {
        const was = this.#byKey.get(block.key);
        if (was && was !== block && was.node.kind === block.node.kind) ops.push(...was.view.ops(block.view, surface));
      }
    }

    this.#sent = true;
    this.#blocks = next;
    this.#byKey = new Map(next.map(block => [block.key, block]));
    if (this.#byKey.size !== next.length) throw new Error(`${this.id}: two blocks share a key`);
    return ops;
  }

  /** The node with wire id `id`, if the region holds it. */
  find(id: string): Tree | undefined {
    const key = id.slice(this.id.length + 1).split(".", 1)[0] ?? "";
    return this.#byKey.get(key)?.view.find(id);
  }

  /** The wire id of the node keyed `key`: a block itself, or a node one level inside a grouped block. */
  locate(key: string): string | undefined {
    if (this.#byKey.has(key)) return `${this.id}.${key}`;
    for (const block of this.#blocks) {
      const id = `${this.id}.${block.key}.${key}`;
      if (block.view.find(id)) return id;
    }
    return undefined;
  }

  /**
   * Runs the handler a node of this region carries for `event`, as the SDK
   * does for the views it renders. False when no node or handler takes it.
   */
  dispatch(event: TspEvent): boolean {
    if (!("id" in event) || typeof event.id !== "string") return false;
    const tree = this.find(event.id);
    const handlers = tree?.node.handlers;
    if (!tree || !handlers) return false;
    let run: (() => unknown) | undefined;
    switch (event.ev) {
      case "action": {
        const full = typeof event.value === "string" ? `${event.act}=${event.value}` : event.act;
        const actions = tree.props["actions"] as Record<string, unknown> | undefined;
        const named = (gesture: string): boolean => actions?.[gesture] === full;
        const fn = handlers.onAction?.[full] ?? handlers.onAction?.[event.act] ?? handlers.onMenu?.[full] ?? handlers.onMenu?.[event.act] ?? (named("click") ? handlers.onClick : undefined) ?? (named("dblclick") ? handlers.onDblClick : undefined);
        run = fn && (() => fn(event));
        break;
      }
      case "toggle":
        run = handlers.onToggle && (() => handlers.onToggle!(event));
        break;
      case "select":
        run = handlers.onSelect && (() => handlers.onSelect!(event));
        break;
      case "activate":
        run = handlers.onActivate && (() => handlers.onActivate!(event));
        break;
      default:
        break;
    }
    if (!run) return false;
    void run();
    return true;
  }
}
