# Classroom record storage contract

This document specifies data and protocol behavior. Product semantics and the
decisions behind them are maintained in the root `AGENTS.md`; installation and
the current verification record are in `README.md`.

The bookmarklet and executable are replaceable application code. User records are
stored separately under `%USERPROFILE%\.zhiyun-focus\StudyLibrary` and must survive
application and bookmark updates. Do not place user records in `dist`, `work`, a
versioned executable folder, or browser localStorage. Browser localStorage holds
view preferences and draft-resume hints. IndexedDB protects unacknowledged capture
pixels and unfinished historical crops; the native library owns acknowledged
original images, layouts and questions. Clearing browser storage must not delete
the native study library, but can lose captures not yet acknowledged by it.

The sibling `ChatGPT` folder retains the WebView login profile. Both folders use
the same user-owned base outside AppData, so an MSIX development host and a normal
desktop launch see the same data. On first use, the application copies a legacy
`%LOCALAPPDATA%\ZhiyunFocus` store or its former Codex MSIX private store into a
new staging directory. It hashes every file before and after copying, rejects
different competing legacy stores or linked paths, flushes copied files and then
renames the verified directory into place. Legacy directories are never moved or
deleted. A failed copy does not start an empty replacement library. Once the
independent directory exists, normal operation no longer reads the legacy host's
directories. `migration.txt` records the completed copy's sources and file count.

Unsubmitted library choices are stored in `selections`, scoped to the stable
lecture identity. Video DOM order does not change that scope. Legacy role-specific
files remain intact; a first canonical read resumes the latest explicit choice,
including an empty clear, and later canonical saves use their own record. Choices
retain ordered original references, per-question choices,
selection intent IDs/times and background/target options. Each mutation starts a
native save and checkpoints its unacknowledged choice, merge base and original
write ID in a temporary, per-store browser journal. A fresh viewer replays the
same write and merges later intent; acknowledged cleanup removes only the exact
journal version, never a newer viewer's entry. Closing exits immediately after
best-effort persistence, without an app-generated navigation warning. Native
records use the same durable replace and
previous-revision recovery as other documents. A write ID makes an uncertain retry
idempotent; a base revision prevents a stale window from replacing newer choices.
When two windows conflict, neither choice may silently overwrite the other.
Conflict recovery must retain the current intent and the competing revision;
it must not depend on a hidden recovery control. Hiding a panel never clears this record.
Only confirmed delivery consumes the matching selection versions; clear-selection
updates the choice record without deleting any original material or question.

Immutable `selection-writes` receipts retain each committed write ID, canonical
scope, base/accepted revision, exact choice digest and the full validated choice.
New writes protect that receipt and a same-choice backup before replacing the
mutable selection record. Reads pin valid legacy records and recover the highest
proven revision, including an empty clear or reordered choice. A newer legacy
hash-only receipt cannot authorize restoring an older choice. An exact retry that
was committed earlier can return
`conflict: true, accepted: true` together with the latest `record`. `accepted`
proves the earlier write happened; it does not mean that choice is still active.
The client advances its merge base to that submitted choice and replays only
later local changes, preserving another window's subsequent clear or removal.

Library compositions have persistent `plan-deliveries` / `plan-completed` records.
Original pages, selection intent IDs, destination, target and operation identity
are protected before dispatch. A planned attempt is checkpointed before upload;
recovery consults the same operation and original target. Confirmation precedes
consumption of matching choices. A completed plan remains recoverable until that
choice write is acknowledged, then its pending display can retire. Explicitly
choosing a new target dismisses the old pending display while retaining its data
and uncertain outcome. Reconstructable page pixels are not retained in idle jobs.

Oversized captures store content-addressed PNG assets individually, verify each
digest, and then commit immutable snapshot metadata. Original pixels are never
resized or replaced for transport. Large saved batches recover as metadata and
read each source separately. An image exceeding the upload representation budget
uses full-dimension JPEG at quality 100; its original PNG remains independently
available. If that representation still exceeds the budget, attachment fails
explicitly with the original preserved. This is separate from verified delivery.
Original images and full-dimension upload representations allow at most 16,384
pixels per edge and 33,554,432 pixels in total. PNG originals additionally retain
the 72 MiB minus 64 KiB binary budget and 96 MiB encoded-request budget. PNG header
dimensions are checked before decoding. Upload representations retain their
12 MiB encoded budget, and atlas generation keeps its existing smaller pages.

A pixel-free mark uses the normal immutable snapshot ID with `markOnly: true`,
an empty context list and a null selection. Its incomplete coverage explicitly
lists the missing panorama and every saved board. The snapshot retains time,
course and layout with an empty `items` list and `markOnly: true`; it creates no
capture delivery and supplies no image reference for composition. Screenshot
requests and context supplements cannot use this exception.

A partial capture retains its acquisition source identity and time. Its issued
snapshot is never enriched in place. A verified continuation has a fixed child
snapshot and operation, links `contextFor` to the original, stores only new
backgrounds, and reuses the original selection reference. Source, time, layout,
course and selection digest must match before acceptance. Supersession changes
pending metadata, not the old snapshot or send status.
A supplement cannot reopen an ancestor's completed or dismissed attachment task.
Its full original pixels remain selectable as archived material; a stale queued
parent is rejected after verified supersession.

A mark is a collection of moments, not proof that its backgrounds are unchanged.
The native library derives a context identity from the saved mark, course facts,
frame time, dimensions, board names/regions and original background image hashes.
The saved media identity also participates when present. Full-image aliases and
shared background removal rederive and compare this same frozen context from
the original snapshots before accepting matching pixels as reusable context.
Repeated crops from that same frozen context can reuse its backgrounds; another
moment or changed background receives a different identity. Capture recovery and
library compositions derive the same identity, including for older snapshots
without rewriting their stored contents. A helper without this proof falls back
to independent snapshot contexts. A previously confirmed mark alone must never
authorize omission of a newly captured background.

Schema 1 separates marks, immutable capture snapshots,
content-addressed original images, and question drafts / sent question records.
Each snapshot contains the original board layout, board names, crop rectangle,
video timestamp and image references. Changing the current course layout never
rewrites a previous snapshot. An image removed from one ChatGPT draft remains
available in its original snapshot. Compositions contain explicit selected
references, rather than a mutable pointer to the viewer's current boards.
Each board's `roi` is its drawn region; optional `view` remembers the latest
reading zoom/position. Both use normalized source coordinates. Missing or invalid
optional `view` falls back to `roi`; zooming does not shrink the captured board
background. Legacy records cannot reconstruct an outline overwritten by older
versions.
Stored composition pages keep their own material identity and a logical mapping
to each original snapshot/item. Removing, projecting or restoring a page must
retain that mapping; the original capture remains independently retrievable.
Identical automatic backgrounds can share one physical full-image attachment
while retaining each snapshot/item as a separate logical source. A collection
alias requires one complete PNG background on the stored page, matching frozen
context, original pixels, mark, kind, board identity, label and crop rectangle. A full board that
also has a question can supply later background references, including an undone
question, without duplicating its image or changing either question. Multi-source atlas regions
cannot authorize that reuse. Partial undo
still proves the exact removed logical references, physical page, material origin
and removal generations before rebuilding the requested source subset.

A capture retry reuses its snapshot ID only when the classroom state, item
identities, positions and original image digests match. It can repair damaged
image assets or finish a partially committed mark/receipt without rewriting the
snapshot. Direct captures have persistent ready/completed receipts and a stable
operation ID. Recovery includes the original issue timestamp and optional source
sequence; the native order describes save execution. Its counter is advanced past
all validated ready and completed receipt orders even when an older counter
backup was recovered. An attachment acknowledgement completes that receipt only
after the bridge verifies the matching attempt, target and terminal evidence.
Completed delivery lifecycles retain a separate outcome: `attached`,
`already-sent`, or `removed`. Explicitly removing all requested operation material
can resolve its pending delivery with `composer-removal` evidence. This prevents
automatic resurrection of those removed items; it neither deletes their original
capture nor marks a question as sent. A later retry of that operation consults the
durable removal before uploading. A compatible original conversation receives a
fresh removal receipt; a different conversation is rejected. The original
completion proof stays unchanged, and an explicit new selection uses a new
material/operation identity. Recovery validates completed receipts before
ignoring any obsolete ready files left by interrupted cleanup; those leftovers
cannot block pending delivery reads, order allocation or export when the terminal
record is intact.

JSON documents are replaced atomically with the previous revision retained as a
backup. Question revisions prevent late asynchronous saves from overwriting newer
text. Graceful updates stop accepting new persistence work and wait for all
already accepted writes and recovery reads, including HTTP work still waiting on
the UI dispatcher. A failed or timed-out drain leaves the service running. IDs
must not be recycled.
Readers recover a previous JSON revision when available; unreadable material must
produce an error rather than silently disappearing from the library.
Temporary file locks and access errors are reported without replacing the primary
record with an older backup. A failed draft save retains the visible editor and
offers a retry; normal shutdown remains blocked until the save is acknowledged.

Explicit helper shutdown and upgrade first disable input to the helper's own chat
window, ask its renderer to save the current editor state, and wait for all current
save acknowledgements before sealing the native write queue. Unfinished uploads,
composition, failed saves or changed editor state cancel shutdown and restore
input. A pending or unconfirmed send keeps its original question snapshot; an
empty composer after sending must not replace it with an empty draft.

Explicit viewer exit saves before releasing its embedded browser. If the exit
request is lost, a session without a heartbeat for five minutes can retire only
when its owning course tab is no longer visible. Retirement uses the same saved
draft acknowledgement, preserves rejected writes, and rechecks a reconnect before
disposal. A visible course with a temporarily lost connection is not expired by
that timeout.

Future schema migrations must preserve the original data and keep a recoverable
backup before writing a newer schema. Updates and installers must never clear this
directory. The user's explicit export action writes a complete ZIP under
`Documents\智云学习资料备份`, including original images, layouts, crops and questions.

The ChatGPT adapter operates on visible attachment and editor controls. Successful
attachment is distinct from sending a message. Only a confirmed new user message
marks the question as sent. Creating another conversation does not implicitly copy
old questions; the library selection specifies exactly which questions and
associated images to carry. Atlas pages preserve a mapping to every original item;
original images remain available independently.
Restoring a structured question keeps included image-question slots even before
text is entered, and keeps their panorama/board context in its background role.
Excluded slots stay excluded unless explicitly selected. Whole-record image
fallback applies only when no per-question image references describe those roles.
For a whole free-text question, active record refs remain its attachments even
though old structured slots are no longer included in the text. Saved material
roles distinguish background from question images; explicit choices take priority.

Quoted question parts preserve the words already selected. Requoting the same
source part with different text or references adds a separate quotation instead
of silently replacing or dropping it. Exact content duplicates are shared; a
changed quotation has a local stable key in addition to its source record/part
identity. That local key is not inherited when the record is quoted again.
Requoting an existing quotation assigns a fresh fixed-length local key, so
successive records do not grow a nested ID past the selection storage limit.
Supplementary quoted text follows the same content comparison, and attachment
receipts must prove the requested quotation content is present.

A whole-question choice retains an empty `itemIds` list without
`retainSupplementaryText`. A parts choice may set that flag to keep independent
prose when removing one or all structured parts: an empty list with the flag means
supplementary text only, with no selected part images. Structured records retain
their separate `extra`; freeform records retain `extra` or their authoritative raw
text and original reference provenance. This requires
`library-question-supplement-v1`. A whole-question choice's optional
`additionalItemIds` lists at most 300 distinct, explicitly selected source parts;
each must have its own `restorePartIntents` entry. This field is invalid on a
parts-only choice. Composition keeps the original whole-question text, extra,
included states and active free-text references, then carries only those
additional parts as separate quotations of the same source record. Their images
and restore authorizations are added individually; other excluded parts remain
excluded. Adding a part must not replace the whole question with its structured
slots or duplicate its original text and extra.

The browser's small resume index contains only IDs of acknowledged, unsent
material drafts. Recovery reads the full record from the native library and
requires nonempty composer text to match (apart from terminal newlines added by the
editor), plus a compatible conversation
route. It restores question fields and original references, reuses surviving
attachments and reloads missing images from their saved originals. Ambiguous
matches require a choice; an explicitly new, empty chat does not inherit a draft.
The manifest may retain up to four exact previous composer texts written by the
adapter. A stale platform refill that exactly matches one of those saved texts
can restore the latest native text after the same route, revision and writer
claim checks. Unrelated text is not matched by similarity or overwritten.
Its optional `metadataEditedKeys` contains distinct `school`, `course`, `teacher`
or `notes` keys, preserving deliberate edits and explicit blanks across recovery.
Attachment recovery waits up to 12 seconds for a compatible upload input owned
by the current composer, including native form-associated controls. Uploads and
durable completion share three bounded continuations under one restore target;
new input invalidates that target, and late completion cannot renew it. An
explicit same-draft reopen can renew recovery. A successful current-owner save
clears only that draft's matching recovery error. Upload diagnostics stay bound
to the draft and target and never add a visible failure panel.
Missing images block sending until recovery completes or the user explicitly
chooses to continue as free text. Old records without a resume identity, or records
whose browser hint was cleared, remain available for selection in the library.

The library's explicit Continue draft action reads the saved manifest through the
native component and uses the same writer-claim and image-recovery path. Another
nonempty composer must first be saved through the normal New chat action. Restoring
an unbound unsent draft into that fresh target can retain its ID after prior writes
settle and its saved text is verified with that same terminal-newline rule. A draft bound to a real conversation,
or still owned by another editor, opens an editable copy and preserves its source
record and conversation. Question fields, order, removed materials and pending
edits are restored together; a retry of the same active copy resumes missing images
without replacing newer text. Success requires the matching live target, actual
attachments and an acknowledged durable draft save. Opening the original remote
conversation remains a separate action.

Restoring a draft obtains one live writer claim. An ordinary reopen can retain its
identity after prior accepted writes settle; another live owner, changed revision
or different conversation receives an independent copy. An exact, solitary
provisional home draft can reattach after restart; explicit New chat cannot.
Rejected accepted saves retain their complete immutable question payload. If its
owner disappears, recovery registers persistence work before dispatch, reuses an
already identical committed record or writes a stable new question with a
`recoveryOf` link. Text, question fields, source references and removal state are
preserved. Active delivery/send identities move into provenance and cannot be
reused by the copy; the copy is never marked sent. Only a matching payload reread
from durable storage resolves its failed save. Failed recovery keeps the payload
and blocks shutdown; the existing library exposes successfully recovered text.

Every delivery carries its material, operation, attempt, conversation, page and
composer identities. A route change invalidates an in-progress delivery. An
attachment receipt is accepted only after checking the live target composer;
sending has a separate confirmed or unknown status. Matching text in older
history is not sufficient evidence that the current send succeeded.
An unknown POST result is queried using its original attempt before another
attempt is issued. Once the native receiver has verified completion, it retains
that immutable result and persists the matching acknowledgement under its
accepted work lease, even if the viewer closes meanwhile. A late UI response
may settle that original durable record, but cannot open a workspace or consume
a newer selection. A checkpoint or retained draft alone is not attachment
completion; explicit removal before dispatch dismisses that intent, while close
alone keeps it available for the original target.
Late mounting of a same-text historical message and its assistant reply also
does not establish submission ownership. The current visible adapter leaves
such sends unconfirmed and offers an optional exact-message user review across
the conversation's unresolved intents. It does not automatically select the
newest same-text intent or require its resolution before the next question.
Automatic durable-history evidence requires a submit-linked correlation with
the same send and turn IDs; legacy same-text observations cannot seed new
context keys or complete an operation as already sent. Historical files remain
unchanged. A trusted explicit user confirmation remains a separate proof type.

A failed capture save retains the fixed retry payload across viewer replacement
and protects it in IndexedDB when available. Issuance is checkpointed before the
native side effect. If an issuance checkpoint cannot replace an older explicitly
unissued record, its pixels remain in IndexedDB and native dispatch waits for a
successful checkpoint. The sole durable copy is never deleted to permit a fallback.
Ordinary viewer close protects the selection journal and attempts a bounded
flush, then closes quietly. Unprotected pixels remain in shared page memory
across viewer replacement; no navigation warning or failure panel is shown.
Browser protection and a verified native save acknowledgement are different
facts; neither is a verified attachment or Send.

Question catalogue summaries include whether a saved record contains question text and how many attachment pages its draft holds. These fields are derived from the original record; a cached summary without them is rebuilt. The library may collapse attachment-only drafts, but keeps every original record and its recovery route. A conversation action requires the saved ChatGPT URL and never invents a binding for an unsubmitted local draft.

Opening a saved draft owns its record read as well as the later native handoff.
Closing the library invalidates the read and releases that action's busy state;
its late result cannot open ChatGPT or clear the state of a newer action.
Historical location checks carry the library location intent through media
identity validation, so a newer location or tab/close action supersedes it there.

A forced plan-job refresh waits for an existing read and then reads again.
Submission also waits for an in-flight read before choosing a retained operation.
Locally confirmed retirements suppress entries from that older response; these
temporary IDs are released when the in-flight read settles. Native retirement
remains authoritative for subsequent reads.

Reordering or reviewing a different question version changes the selection ID
while retaining its original restore-authorization timestamp. A stale completion
cannot consume that new choice, and ordering alone does not authorize restoring
an image removed later. In-flight whole-mark choices also advance the local
version checked by completion. Retargeting persists these updated identities
before dismissing the old job. Completed-but-unconsumed jobs retain a continuation
action even when another operation delayed their automatic cleanup; dismissed
jobs stop before native handoff. Recovered completion messages use the durable
outcome instead of assuming an attachment was newly added.

Automatic background expansion cannot claim an earlier position for a source
already explicitly listed later in the request. Native composition preserves the
relative order of those requested refs while still adding unselected context.

Viewer replacement transfers only fullscreen that has actually entered. Pending
fullscreen work remains responsible for its late cleanup; its completion promise
is handed to the replacement so a new fullscreen request cannot race that cleanup.
This is runtime handoff state and is never persisted in the library or layouts.

After reconnecting a command, the client checks the capabilities of the new
instance for that operation before replay. Capture and draft commands retain
their question-binding and asset requirements; unrelated fullscreen and basic
guard operations do not inherit requirements from an earlier chat action.

Capture target checkpoints retain the logical draft ID separately from the six
formal bridge target fields. The initial unbound capture becomes bound before its
first delivery; a later question cannot borrow that pending operation. Original
partial snapshots remain immutable. A validated `contextFor` supplement retains
the original selection reference and queue position, supplies backgrounds for
later library composition, and can rebuild its derived supersession after receipt
backup recovery. Where the visible frame clock is unavailable, the indexed source
frame interval must contain the saved media clock; a wider time tolerance is not
used as proof.

Historical video position/layout restoration requires a saved media identity
matching the current resource. Dimensions, duration and lecture/DOM role alone
cannot establish an unknown legacy source. Such legacy records remain available
for original-image viewing, cropping, material selection and questions; they do
not silently acquire the current video's identity. Unverified inherited layouts
are not stamped with that identity until an explicit current board selection or
redraw establishes the view.

After Send clears the composer and attachments, the new logical question is
installed before its composer generation and draft ID are published. Ordinary
input, observation and an in-progress delivery wait share that transition; the
collapsed unresolved-send review remains reachable. A delivery bound to the
previous question still fails its target checks rather than following the new
question.

The `capture-question-v1` capability binds native attempts to the receiver's
logical question, in addition to the six protocol target fields. Native final
dispatch checks that the durable receipt belongs to the live question; a changed
question cancels queued/working attempts even if those six fields are unchanged.
The receiver verifies the native question ID at entry and after asynchronous
steps. Read-only reconciliation never grants a new question binding. An issued
legacy task without a provable business binding may settle from durable completion
evidence; otherwise its original images remain available for a new explicit
selection. It is not silently rebound to the current question.

An explicit keep-in-library disposition ends one pending capture delivery while
retaining its snapshot, original pixels and any uncertain delivery evidence.
`dismissed` is separate from an attached, sent or removed completion receipt;
recovery excludes that pending task and subsequent dispatch cannot reopen it.
Other windows reconcile this durable disposition. Selecting its image again
creates a distinct plan/operation rather than retargeting the ended delivery.
Dismissal first writes an independent immutable `delivery-dispositions` record,
bound to material kind, material ID and operation ID, with a same-terminal backup.
Only then is the mutable receipt updated. A ready receipt recovered from its old
backup is overlaid with this authority before listing, checkpointing or dispatch;
missing receipts recreated from capture intents receive the same overlay. Legacy
valid dismissed receipts are pinned to this authority when read. A mismatched,
unreadable or unsupported disposition fails closed rather than reopening work.
Completed receipts and verified parent/supplement termination remain independent
authorities, and archived pixels and question content are never deleted by this.
After a question changes, native reconciliation can settle an earlier delivery
from a verified persisted send record for the same canonical conversation,
operation and material. It records the actual send proof and never uploads into
the new question. Missing proof stays unknown and can be kept in the library.

Durable inactive pending captures and saved delivery pixels are loaded on demand
under separate 16 MiB encoded-pixel cache budgets. Unsaved pixels without durable
protection remain in memory across viewer replacement. If both native storage and
browser persistence fail, terminating the tab/process can lose those unprotected
pixels; no failure popup or false durable acknowledgement substitutes for storage.
Replacing a staged crop keeps the latest creation
order when old rows survive an interrupted deletion. Native-confirmed sent
question snapshots are removed from the browser send cache; completed native
records can be evicted to meet a 2 MiB cache budget or storage pressure. Unconfirmed
send evidence is retained. A local send confirmation awaiting native persistence
retries the original question record without sending a ChatGPT message.
