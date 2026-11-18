# Compartment notes, item verification and the checklist-transfer manifest

Status: binding contract for the 2026-11-18 loadout update (lead: Opus). Extends
`docs/architecture/ai-compartment-studio.md` §4 (planner doc v2) without changing any existing field or op.

## 1. Planner doc additions (schema stays 2; strict superset)

```
notes:      { [compId]: { text: string, updatedAt: number } }   // per-compartment note, plain text
unverified: { [equipmentName]: string }                         // item needs verification; value = reason ('' allowed)
```

* Both maps are optional on read (`normalizeDoc` seeds `{}`), preserved verbatim by every op that does not target them,
  and included in the public planner projection (`projectV1` + the GET doc) and in the v1 view the app edits.
* `notes[compId].text`: 1–2000 characters after the client trims trailing whitespace; plain text only (rendered as
  text, never HTML; `\n` and `\t` allowed, other C0 control characters rejected). An empty text deletes the entry.
  `updatedAt` is set by the op engine from `ctx.now` (server clock on the Worker). No author email is stored in the
  public doc; the audit log already records the actor of every planner write.
* Every compartment, RS3 included, has notes. `NOTES_LOCKED_COMPARTMENTS` (`shared/contracts.js`) is empty; a
  compartment listed there would get no notes editor, `setNote` would be refused (`INVALID`) and the export would mark
  it `protected`.
* `unverified[name]`: reason 0–300 characters. Presence = "needs verification" (identity, model, size or itemization
  not confirmed); absence = verified. `renameEquipment` moves the key, `removeCustomTool` and `setRemoved{removed:true}`
  delete it.

## 2. New ops (added to `PLANNER_OPS`)

| op | fields | rules |
|---|---|---|
| `setNote` | `comp, text, expect` | `comp` ∈ `COMPARTMENT_IDS` and not locked, else `INVALID`/`NOT_FOUND`. `expect` = the text the client last saw (`''` if none). Current ≠ `expect` → no-op when current = `text`, else `PRECONDITION` (current text returned). `text:''` deletes. |
| `setUnverified` | `name, reason` | `reason` string ≤ 300 or `null` (= verified, delete). Setting needs `name` in the effective inventory (`NOT_FOUND`). |
| `removeSlot` | `comp, index, expect` | `expect` = the non-empty name the client saw at `index`. Unknown `comp` / `index` out of range → `NOT_FOUND`; current ≠ `expect` → `PRECONDITION` (current returned). Splices the slot out of `allocations` and `assignmentIds` and appends `''`/`null` (slot count unchanged), so items below move up **keeping their assignment ids**; that compartment's bundles drop `index` and decrement larger indices (emptied bundles are deleted). `removeCustomTool` and `setRemoved{true}` pack the same way. Clients: `diffDocs(..., {slotRemovals})` / planner-sync `hintRemoveSlot`. Old tabs keep emitting blanking `setSlot` (still valid). Deploy the Worker before Pages. |

`diffDocs` emits `setNote` (compare `text` only) and `setUnverified` after tool/qty ops and before bundle ops.
Old clients never emit these ops and keep both maps because the server applies ops to its own document.
Deploy order: Worker first (it accepts the new ops), then Pages.

## 3. Checklist-transfer manifest `l1.checklist-transfer/1`

Produced in the browser by the Excel export from the same in-memory snapshot as the workbook, downloaded as
`L1 Mid-Mount - Checklist Transfer - <YYYY-MM-DD> - rev<N>.json`. It is the only machine input to the MBFD Hub
importer; the workbook is for people.

```jsonc
{
  "schema": "l1.checklist-transfer/1",
  "source": {
    "app": "l1-compartment-builder", "origin": "https://l1.mbfdhub.com",
    "buildSha": "e1bb3ea…" , "plannerRevision": 13,
    "syncState": "confirmed" | "local_changes",   // local_changes = device has unsynced edits included
    "pendingChanges": 0,
    "exportedAt": "2026-11-18T15:04:05.000Z",
    "snapshotSha256": "<64 hex>"                   // sha256(canonicalJson(manifest minus source.exportedAt/snapshotSha256))
  },
  "apparatus": { "planId": "l1-mid-mount", "label": "L1 Mid-Mount" },
  "countingRule": "One unit per occupied planner slot. Mounting hardware and kit contents are not counted.",
  "compartments": [                                // all 11, in COMPARTMENT_IDS order
    {
      "id": "LS1", "label": "LS1", "side": "Left", "order": 2,
      "protected": false,                          // true only for NOTES_LOCKED_COMPARTMENTS (none today)
      "spec": "<COMPARTMENT_SPECS text>",
      "note": { "text": "…", "updatedAt": 1763478245000 } | null,
      "items": [                                   // one line per equipment in this compartment, first-slot order
        {
          "lineKey": "LS1:eq_3f…",                 // `${compId}:${equipmentId}` — stable across renames
          "equipmentId": "eq_3f…", "name": "DeWalt DCPS612AG2 K-Saw", "quantity": 1,
          "slots": [0], "assignmentIds": ["as_…"],
          "bundle": { "id": "…", "name": "…" } | null,   // bundle of the first slot (display)
          "bundles": [ { "id": "…", "name": "…", "slots": [0] } ], // every bundle any of the line's slots is in
          "custom": false, "description": "", "dimensions": "…",   // description = custom tool description ('' for base)
          "verification": { "status": "verified" | "needs_verification", "reason": "" }
        }
      ]
    }
  ],
  "catalog": [ { "equipmentId", "name", "quantity", "assigned", "remaining", "custom", "dimensions", "description",
                 "verification": { "status", "reason" }, "compartments": { "LS1": 1 } } ],
  "totals": { "compartments": 11, "lines": 0, "units": 0, "catalogItems": 0, "unassignedCatalogItems": 0,
              "needsVerification": 0 },
  "exceptions": [ { "type": "needs_verification" | "over_allocated" | "empty_compartment", "compartmentId"?: "RS2",
                    "equipmentId"?: "eq_…", "message": "…" } ]
}
```

Rules: integers are JSON numbers (`note.updatedAt` is epoch milliseconds, a number); names are exact planner names
(no trimming or case change); there is exactly one line per (compartment, equipment), so `lineKey` is unique, and a line
whose slots sit in several bundles (RS3's two Highrise Packs) lists each of them in `bundles` with its slots, so no
bundle membership is lost; empty compartments are present with `items: []`
and one `empty_compartment` exception; `needs_verification` lines are exceptions too. Consumers must refuse an unknown
`schema`, verify `snapshotSha256`, and treat `needs_verification` lines as blockers for publishing a complete checklist.
A `syncState: "local_changes"` export may carry provisional equipment ids for items created on that device; MBFD Hub
previews it but refuses to save it ("Export the last saved team plan to import").

## 4. Workbook (`L1 Mid-Mount - Compartment Plan - <YYYY-MM-DD> - rev<N>.xlsx`)

Sheets, in order: **Compartment Inventory** (one row per manifest line, visual compartment order), **Equipment
Catalog**, **Compartment Summary** (all 11), **Bundles and Kits** (one row per bundle member),
**Notes and Exceptions**, **Export Metadata** (schema, build, revision, UTC time, sync state, snapshot sha256, counting
rule, totals), then the legacy **Compartments** and **Inventory Status** sheets unchanged for existing users. Every
text value (including names that begin with `= + - @`) is written as a typed `String` cell, never a formula; the
round-trip test asserts the file contains no `<f>` element. Headers bold and frozen; column widths set.
