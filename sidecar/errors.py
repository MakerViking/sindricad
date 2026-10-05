"""Machine-readable error codes for the sidecar wire protocol.

Errors used to be PROSE ONLY. That is fine for a human reading a toast and
useless for anything that has to branch — and the app already depends on one
de-facto code today: `repickReference.ambiguousDiagFor` matches the exact string
"ambiguous nearest pick" across the language boundary, so rewording a message in
Python silently kills the Re-pick affordance in TypeScript. A `code` field makes
that dependency explicit and reworded-message-proof.

WHY A SEPARATE MODULE: `builder` imports `geom_select`, so a shared exception
cannot live in `geom_select` without a cycle, and `builder` raises non-selector
errors so it cannot live there either. Nothing in here imports OCCT, so it is
free to import from a worker.

ADDING A CODE is a pure addition — every consumer treats an unrecognised code as
"unclassified" (the TS type carries a `(string & {})` member for exactly this),
so a new code never breaks an older frontend. REMOVING or RENAMING one is a
breaking change to the wire contract.

Deliberately NOT coded yet, because nothing branches on them: nothingToExport,
booleanNoOp, and the per-feature geometry failures (filletFailed and friends).
Trigger to add them: the first caller — agent, UI or test — that wants to treat
one differently from a generic failure.
"""

# --- the vocabulary ----------------------------------------------------------
# Flat lowerCamel, matching the shipped `ResolveDiag.kind` value "edgeOpFailed".

AMBIGUOUS_REFERENCE = "ambiguousReference"  # a selector matched several candidates
REFERENCE_NOT_FOUND = "referenceNotFound"   # a selector matched nothing
CANCELLED = "cancelled"                     # the user pressed Cancel
TIMED_OUT = "timedOut"                      # a hard wall-clock job timeout
STALLED = "stalled"                         # no worker heartbeat; the pool was restarted
KERNEL_CRASHED = "kernelCrashed"            # the geometry worker died
STOPPED_BY_OTHER = "stoppedByOther"         # another op's cancel, stall or timeout killed the worker this op was on
ENGINE_UNAVAILABLE = "engineUnavailable"    # the worker pool could not be started
REPLY_TOO_LARGE = "replyTooLarge"           # the whole reply exceeded the frame cap
BODY_TOO_LARGE = "bodyTooLarge"             # one body exceeded the frame cap
UNKNOWN_OP = "unknownOp"                    # no such op (the capability-probe answer)
BAD_REQUEST = "badRequest"                  # malformed/oversized input, refused up front
EXPECT_FAILED = "expectFailed"              # a query item's `expect` assertion did not hold
BUDGET_EXHAUSTED = "budgetExhausted"        # a query ran out of its time budget
MATCH_IMPLAUSIBLE = "matchImplausible"      # a by:"match" resolved to something it cannot be
PLANE_TILTED = "planeTilted"                # a face-anchored plane's face is no longer parallel
SEALED_VOID = "sealedVoid"                  # a cut closed a cavity inside the body
CLEAN_UP_FITTED = "cleanUpFitted"           # Clean Up recognised curved surfaces on a body (advisory)
FONT_MISSING_GLYPHS = "fontMissingGlyphs"   # the chosen font cannot draw some of the text
FONT_UNUSABLE = "fontUnusable"              # the chosen font has no outlines to emboss at all
# Split. Errors (the feature changed nothing, so it is red):
SPLIT_MISSED = "splitMissed"                # the plane does not reach {body}; on several bodies also a per-body diagnostic
SPLIT_ON_FACE = "splitOnFace"               # the plane lies on a face of {body} and cuts no material
SPLIT_DAMAGED = "splitDamaged"              # the plane crosses only damaged parts of {body}, left whole
SPLIT_MISSED_ALL = "splitMissedAll"         # cut-all: the plane cuts none of the selected bodies
SPLIT_DAMAGED_ALL = "splitDamagedAll"       # several bodies: nothing cut; `count` damaged parts of {body}, the only one crossed
SPLIT_DAMAGED_ALL_MORE = "splitDamagedAllMore"  # same, `count` bodies with damaged parts crossed ({body} first), `parts` in all
SPLIT_FAILED = "splitFailed"                # the kernel failed on {body}; nothing was changed
SPLIT_NO_PLANE = "splitNoPlane"              # the plane it cuts along is not there at this point in the timeline
SPLIT_FACE_GONE = "splitFaceGone"           # the face its plane is anchored to belongs to a body not there
SPLIT_CRASHED = "splitCrashed"              # the worker died while a split was cutting
SPLIT_NO_BODY = "splitNoBody"               # none of the bodies it names exists at its place in the timeline
SPLIT_LEGACY_FAILED = "splitLegacyFailed"   # a split saved by an older version, whose way of cutting fails on {body}
# Split warnings (diagnostics on a split that DID change something):
SPLIT_SEPARATED = "splitSeparated"          # no solid was cut through; the parts on each side were separated
SPLIT_SEPARATED_KEPT = "splitSeparatedKept"  # same, with keep=top/bottom: the other side's parts were removed
SPLIT_DAMAGED_PARTS = "splitDamagedParts"   # `count` damaged parts of {body} cross the plane and were left whole
SPLIT_BODIES_GONE = "splitBodiesGone"       # `count` of the bodies it names do not exist here; the rest were cut
SPLIT_LEGACY_VOLUME = "splitLegacyVolume"   # an older version's split of {body} does not add up to the body it cut
# Merge Solids. Errors (the feature changed nothing, so it is red):
MERGE_NOTHING = "mergeNothing"              # {body} is already one sound solid and nothing else
MERGE_NOTHING_APART = "mergeNothingApart"   # {body} is already `count` sound solids that do not touch, and nothing else
MERGE_NO_SOLID = "mergeNoSolid"             # {body} has only surfaces, no solid to merge
MERGE_ALL_DAMAGED = "mergeAllDamaged"       # every solid of {body} (`count` of them) is damaged
MERGE_FAILED = "mergeFailed"                # the fuse of {body} failed or failed its checks; nothing was changed
MERGE_NO_BODY = "mergeNoBody"               # the body it names does not exist at its place in the timeline
# Merge Solids warnings (diagnostics on a merge that DID change something):
MERGE_DROPPED_SURFACES = "mergeDroppedSurfaces"  # `count` loose surfaces of {body} were left out
MERGE_DAMAGED_LEFT_OUT = "mergeDamagedLeftOut"   # `count` damaged solids of {body} were left out, not repaired
MERGE_SEPARATE_PIECES = "mergeSeparatePieces"    # the merged {body} is `count` pieces that do not touch, all kept
# Separate warnings:
SEPARATE_DROPPED_SURFACES = "separateDroppedSurfaces"  # `count` loose surfaces beside {body}'s solids have no thickness and were left out
SEPARATE_DROPPED_FACES = "separateDroppedFaces"  # `count` loose faces of the surface body {body} are in none of its shells and were left out
# Insert > Part from File (the other document, not the open one):
INSERT_NOTHING_BUILT = "insertNothingBuilt"  # none of the other document's bodies built
INSERT_NO_BODIES = "insertNoBodies"         # the other document has no visible bodies
# Boolean warnings (diagnostics on an extrude/revolve/loft/sweep/thicken):
CUT_ONLY_HIDDEN = "cutOnlyHidden"           # a Cut removed nothing because the only bodies it reaches ({body}, `count` in all) were hidden when it was made
# Boolean errors (the feature changed nothing, so it is red):
CUT_LOST_PROJECTION = "cutLostProjection"   # an extrude Cut removed nothing, and its profile is placed by a projected edge in its sketch that lost its source
# Join warning (a Combine join, or a join-mode extrude/revolve/sweep/loft/thicken):
JOIN_PIECES_LEFT_OUT = "joinPiecesLeftOut"  # `count` pieces going into the join do not touch {body} and were left out (the debris rule)
JOIN_PIECES_APART = "joinPiecesApart"  # `count` pieces of a `joinTouchingOnly` join do not touch the rest of {body} and stay in it as pieces of their own

ALL = frozenset({
    AMBIGUOUS_REFERENCE, REFERENCE_NOT_FOUND, CANCELLED, TIMED_OUT, STALLED,
    KERNEL_CRASHED, STOPPED_BY_OTHER, ENGINE_UNAVAILABLE, REPLY_TOO_LARGE, BODY_TOO_LARGE,
    UNKNOWN_OP, BAD_REQUEST, EXPECT_FAILED, BUDGET_EXHAUSTED, MATCH_IMPLAUSIBLE,
    PLANE_TILTED, SEALED_VOID, CLEAN_UP_FITTED, FONT_MISSING_GLYPHS,
    FONT_UNUSABLE, SPLIT_MISSED, SPLIT_ON_FACE, SPLIT_DAMAGED, SPLIT_MISSED_ALL,
    SPLIT_DAMAGED_ALL, SPLIT_FAILED, SPLIT_NO_PLANE, SPLIT_CRASHED, SPLIT_SEPARATED,
    SPLIT_SEPARATED_KEPT, SPLIT_DAMAGED_PARTS, SPLIT_NO_BODY, SPLIT_LEGACY_FAILED,
    SPLIT_BODIES_GONE, SPLIT_LEGACY_VOLUME, SPLIT_DAMAGED_ALL_MORE, SPLIT_FACE_GONE,
    MERGE_NOTHING, MERGE_NOTHING_APART, MERGE_NO_SOLID, MERGE_ALL_DAMAGED, MERGE_FAILED, MERGE_NO_BODY,
    MERGE_DROPPED_SURFACES, MERGE_DAMAGED_LEFT_OUT, MERGE_SEPARATE_PIECES,
    SEPARATE_DROPPED_SURFACES, SEPARATE_DROPPED_FACES, CUT_ONLY_HIDDEN, CUT_LOST_PROJECTION,
    JOIN_PIECES_LEFT_OUT, JOIN_PIECES_APART, INSERT_NOTHING_BUILT, INSERT_NO_BODIES,
})

# --- the body slot -----------------------------------------------------------

# A message that is ABOUT a body no longer interpolates that body's name: the
# name came out of the document (on an import, out of the STEP file), and prose
# is the one place untrusted text cannot be told apart from the sidecar's own
# words. The message carries this slot instead, and rides beside `body_id` (ours,
# safe) and `subject` (the name, sanitised).
#
# Word order is why this is a slot and not a suffix the reader appends: "Fillet
# failed on {body}: BOPAlgo_Alert..." puts the name mid-sentence, and no
# append-the-name rule reproduces that.
#
# A consumer that does not substitute shows the literal "{body}", which is
# honest — for an agent it is arguably better than a name, because it is
# obviously a slot and not something to act on. Contract lives in PROTOCOL.md.
BODY_SLOT = "{body}"


class GeomError(ValueError):
    """A geometry error carrying a machine-readable `code` beside its prose.

    Subclasses ValueError SO THAT `rebuild`'s existing per-feature
    `except ValueError` keeps catching it unchanged — every raise site can be
    upgraded in place without touching the handler.

    `code`, `body_id` and `subject` MUST keep their None defaults. These cross a
    ProcessPoolExecutor boundary, and `BaseException.__reduce__` returns
    `(cls, self.args)` — so an exception whose __init__ requires a second
    positional raises TypeError while being UNPICKLED in the parent, replacing a
    clear geometry message with CPython noise at the worst possible moment.
    Covered by a round-trip test.

    They survive that boundary all the same, and it is worth knowing why rather
    than trusting it: CPython's reduce returns a THREE-tuple
    `(cls, self.args, self.__dict__)` when the instance dict is non-empty, so
    plain attributes ride along while a required constructor argument would not.

    `subject` is UNTRUSTED DOCUMENT TEXT — a body or feature name, which on an
    imported assembly is whatever the STEP file's author called it. It is a
    separate field precisely so it never has to be dug back out of a sentence:
    see untrusted.py. `body_id` is ours and is safe to branch on.

    `count` and `parts` are numbers the coded sentence counts (how many damaged
    parts a split left whole, and in how many bodies). The app passes them to
    the translation, where `count` also picks the plural form. Ours, ints only.
    """

    def __init__(self, message, code=None, body_id=None, subject=None, count=None, parts=None):
        super().__init__(message)
        self.code = code
        self.body_id = body_id
        self.subject = subject
        self.count = count
        self.parts = parts


def code_of(ex, default=None):
    """The code carried by an exception, or `default`. Tolerates any exception
    type, so callers do not have to know whether a raise site was upgraded."""
    c = getattr(ex, "code", None)
    return c if c else default


def body_id_of(ex, default=None):
    """The body id an exception is about, or `default`."""
    b = getattr(ex, "body_id", None)
    return b if b else default


def subject_of(ex, default=None):
    """The untrusted document text an exception is about, or `default`.

    Sanitise before it reaches a reply — `untrusted.clean(subject_of(ex))`.
    """
    s = getattr(ex, "subject", None)
    return s if s else default
