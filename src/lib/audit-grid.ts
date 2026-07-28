// Turning a passage's clusters into a per-chunk x per-model GRID.
//
// The audit's job is to let a reviewer judge, for one chunk of source, what each
// model made of it. The clustered shape can't do that: it renders one row per
// fact tagged with which variants produced it, so "only haiku" is a BADGE and
// what sonnet did at that spot is left to be inferred from an absence. A reviewer
// then has to hold the other columns in their head to read any single row.
//
// So the grid inverts it. Rows are the distinct facts, columns are the models,
// and EVERY model gets a cell in EVERY row - an empty cell is rendered, not
// implied. A singleton stops being a relative claim ("only haiku") and becomes a
// standalone one: haiku said X here, sonnet said nothing here, both visible in
// the same row without looking anywhere else.

import type { AuditCluster, AuditMember, AuditPassage, AuditVariant } from "$lib/api";

/** One model's output for one fact. `members` is empty when this model produced
 *  nothing here - which the UI must SHOW rather than omit. */
export interface AuditGridCell {
  variant: string;
  model: string;
  members: AuditMember[];
  /** False = this model found nothing for this fact. The explicit "nothing". */
  present: boolean;
}

export interface AuditGridRow {
  cluster: AuditCluster;
  /** One cell per variant, in the record's variant order, ALWAYS - so columns
   *  line up across rows and a gap is visible as a gap. */
  cells: AuditGridCell[];
  /** How many models produced this fact. 1 = only one model saw it. */
  producedBy: number;
  /** True when exactly one model produced it. Kept as a fact about the row, not
   *  as a label: the grid shows WHICH models were silent, so a reader doesn't
   *  need the badge to know. */
  singleton: boolean;
}

/** The distinct source quotes a passage's claims cited - the chunk's own text. */
export function passageQuotes(clusters: AuditCluster[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of clusters) {
    for (const m of c.members) {
      const q = m.quote.trim();
      // "(mock)" is a placeholder some fixtures carry; it is not source text.
      if (q && q !== "(mock)" && !seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    }
  }
  return out;
}

export function gridRow(cluster: AuditCluster, variants: AuditVariant[]): AuditGridRow {
  const byVariant = new Map<string, AuditMember[]>();
  for (const m of cluster.members) {
    const list = byVariant.get(m.variant);
    if (list) list.push(m);
    else byVariant.set(m.variant, [m]);
  }
  const cells = variants.map((v) => {
    const members = byVariant.get(v.id) ?? [];
    return { variant: v.id, model: v.model, members, present: members.length > 0 };
  });
  const producedBy = cells.filter((c) => c.present).length;
  return { cluster, cells, producedBy, singleton: producedBy === 1 };
}

export function auditGrid(passage: AuditPassage, variants: AuditVariant[]): AuditGridRow[] {
  return passage.clusters.map((c) => gridRow(c, variants));
}

/** The rows worth showing for the SELECTED models: those at least one selected
 *  model produced.
 *
 *  A row where every selected model is silent belongs entirely to models the
 *  reviewer switched off - it is a dead row that says nothing about the
 *  comparison in front of them. A row where SOME selected model is silent is the
 *  opposite: that silence is the missed-fact signal (this model found the fact,
 *  that one didn't), which is one of the few things this view computes for free,
 *  so it always stays. Empty-for-all = hide, empty-for-some = keep. */
export function visibleRows(passage: AuditPassage, variants: AuditVariant[]): AuditGridRow[] {
  return auditGrid(passage, variants).filter((r) => r.producedBy > 0);
}

/** Does this passage have anything to show for the selected models? False only
 *  when NO selected model produced a claim anywhere in it. */
export function passageHasContent(passage: AuditPassage, variants: AuditVariant[]): boolean {
  return visibleRows(passage, variants).length > 0;
}

/** Per-model claim counts for one passage, including an explicit zero - so the
 *  chunk header can say what each model did here without the reader counting
 *  cells. */
export function passageTally(
  passage: AuditPassage,
  variants: AuditVariant[],
): { variant: string; model: string; count: number }[] {
  const rows = auditGrid(passage, variants);
  return variants.map((v) => ({
    variant: v.id,
    model: v.model,
    count: rows.reduce((n, r) => n + (r.cells.find((c) => c.variant === v.id)?.present ? 1 : 0), 0),
  }));
}

/** Members sharing a wording + epistemic frame collapse to one line; a variant
 *  that flattened the fact (dropped an attestation or a ref) splits onto its
 *  own, so the difference the gold exists to catch stays visible. */
export interface MemberLine {
  text: string;
  claim_type: string;
  attestation: string;
  speaker: string;
  refs: string[];
}

export function memberLines(members: AuditMember[]): MemberLine[] {
  const by = new Map<string, MemberLine>();
  for (const m of members) {
    const key = `${m.text}|${m.claim_type}|${m.attestation}|${m.speaker}|${m.refs.join(",")}`;
    if (!by.has(key)) {
      by.set(key, {
        text: m.text,
        claim_type: m.claim_type,
        attestation: m.attestation,
        speaker: m.speaker ?? "",
        refs: m.refs,
      });
    }
  }
  return [...by.values()];
}

/** who said it · type · attestation · refs, empties dropped.
 *
 *  SPEAKER LEADS, because it is the attribution and the frame is unreadable
 *  without it. It was omitted, so a model that put the attribution in its
 *  `speaker` field and kept `text` as the bare proposition looked like it had
 *  dropped the attribution entirely, while one that baked the name into its
 *  prose looked more careful. They were doing the same thing differently, and
 *  the display was scoring them on which one it happened to render. */
export function frameLabel(line: MemberLine): string {
  const parts: string[] = [];
  if (line.speaker) parts.push(`said by ${line.speaker}`);
  parts.push(...[line.claim_type, line.attestation].filter(Boolean));
  if (line.refs.length) parts.push(`refs: ${line.refs.join(", ")}`);
  return parts.join(" · ");
}
